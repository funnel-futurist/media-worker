import { Router } from 'express';
import axios from 'axios';

export const submagicRouter = Router();

const BASE = 'https://api.submagic.co/v1';

// ── Emotion → Submagic library track ID ──────────────────────────────────
// These are internal Submagic media library IDs — no upload needed.
// Sourced from auto_submagic.ts on Vercel side (keep in sync).
const EMOTION_MUSIC_MAP = {
  confidence:    'ad8fafb7-ce41-4c90-8895-666251f73dd7',
  authority:     'b007ac0d-fb65-4860-9d02-7a242b7accba',
  urgency:       '61507c96-4141-47db-8d1c-aa3748d6b846',
  excitement:    'c61f881c-0699-45f7-8bb1-023f61e6b76c',
  defiance:      'dd5f90f4-e939-45db-a422-f58535c69185',
  frustration:   'f1b18266-9fe2-4d84-abf3-3f859ab94203',
  curiosity:     '75440ec4-b109-4d56-a6cc-4ac283202473',
  calm:          '6a76513d-41e8-47e2-b87d-1a64d2a3bcee',
  trust:         '4bb76b8a-d152-40f6-b010-08755341dc85',
  relief:        '415b2522-f14e-4e74-96d5-f04647a9165d',
  hope:          'd0a8080b-a898-4f0a-9e93-13fea23b88a6',
  vulnerability: '95cb3570-9a73-4b21-b7a8-b41276f58726',
  empathy:       '2f536439-cccc-44cc-9ad9-19662c1958f6',
  fear:          '522bb662-cd49-428c-acfb-7a2178e78870',
};
const DEFAULT_MUSIC_ID = '1e12ddf5-0f34-492b-b112-6bfcad9a87f7'; // smart-corporate-identity

function pickMusicId(emotionTags = []) {
  for (const tag of emotionTags) {
    if (EMOTION_MUSIC_MAP[tag]) return EMOTION_MUSIC_MAP[tag];
  }
  return DEFAULT_MUSIC_ID;
}

function headers() {
  const key = process.env.SUBMAGIC_API_KEY;
  if (!key) throw new Error('SUBMAGIC_API_KEY is not set in Railway env vars');
  return { 'x-api-key': key, 'Content-Type': 'application/json' };
}

/**
 * Poll a Submagic project until it reaches a target status or fails.
 * Returns the final project object.
 */
async function pollProject(projectId, targetStatus, intervalMs = 10000, maxMs = 300000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    const { data } = await axios.get(`${BASE}/projects/${projectId}`, { headers: headers() });
    console.log(`[submagic] project ${projectId} status: ${data.status}`);
    if (data.status === 'failed') throw new Error(`Submagic project failed: ${JSON.stringify(data.error ?? data)}`);
    if (data.status === targetStatus || data.downloadUrl) return data;
  }
  throw new Error(`Submagic polling timed out after ${maxMs / 1000}s for project ${projectId}`);
}

/**
 * POST /submagic-edit
 *
 * Full pipeline: create Submagic project → poll until processed →
 * trigger export → poll until download URL available.
 *
 * Body: {
 *   videoUrl: string          — direct-download public URL (MP4/MOV, max 2 GB)
 *   language?: string         — transcription language code (default: "en")
 *   templateName?: string     — caption style (default: "Hormozi 1")
 *   removeSilencePace?: string — "natural" | "fast" | "extra-fast" (default: "natural")
 *   removeBadTakes?: boolean  — AI removes bad takes (default: true)
 *   clientBrolls?: Array<{ url: string, startTime: number, endTime: number }>
 * }
 *
 * Returns: { videoUrl, duration }
 */
submagicRouter.post('/submagic-edit', async (req, res, next) => {
  try {
    const {
      videoUrl,
      language = 'en',
      templateName = 'Hormozi 1',
      removeSilencePace = 'natural',
      removeBadTakes = true,
      clientBrolls = [],
      emotionTags = [],
    } = req.body;

    if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required' });

    // ── Step 1: Register client b-roll clips (if any) ─────────────────────
    const items = [];
    for (const broll of clientBrolls) {
      console.log(`[submagic] registering client b-roll: ${broll.url}`);
      const { data: mediaData } = await axios.post(
        `${BASE}/user-media`,
        { url: broll.url },
        { headers: headers() }
      );
      items.push({
        type: 'user-media',
        userMediaId: mediaData.userMediaId,
        startTime: broll.startTime,
        endTime: broll.endTime,
        layout: 'cover',
      });
    }

    // Fall back to AI stock b-roll if no client clips provided
    const magicBrolls = items.length === 0;

    // ── Step 1b: Pick BGM from Submagic library based on emotion tags ────
    const musicId = pickMusicId(emotionTags);
    const music = { userMediaId: musicId, volume: 10 };
    console.log(`[submagic] BGM selected: ${musicId} (emotions: ${emotionTags.join(', ') || 'none → default'})`);


    // ── Step 2: Create Submagic project ───────────────────────────────────
    console.log(`[submagic] creating project for: ${videoUrl}`);
    const projectBody = {
      title: `pipeline-${Date.now()}`,
      videoUrl,
      language,
      templateName,
      removeSilencePace,
      removeBadTakes,
      magicBrolls,
      cleanAudio: true,
      ...(items.length > 0 && { items }),
      ...(music && { music }),
    };

    const { data: project } = await axios.post(`${BASE}/projects`, projectBody, {
      headers: headers(),
    });

    console.log(`[submagic] project created: ${project.id}`);

    // ── Step 3: Poll until processing complete ────────────────────────────
    const processed = await pollProject(project.id, 'completed');

    // ── Step 4: Use downloadUrl if already present, otherwise trigger export ──
    let exported = processed;
    if (!processed.downloadUrl) {
      console.log(`[submagic] triggering export for project ${project.id}`);
      try {
        await axios.post(`${BASE}/projects/${project.id}/export`, {}, { headers: headers() });
      } catch (exportErr) {
        // Some Submagic plans auto-export — 404 here is non-fatal, poll anyway
        console.warn(`[submagic] export endpoint returned ${exportErr?.response?.status ?? exportErr.message}, polling for downloadUrl anyway`);
      }

      // ── Step 5: Poll until download URL available ─────────────────────────
      exported = await pollProject(project.id, 'completed', 10000, 180000);
    }

    if (!exported.downloadUrl) {
      throw new Error('Submagic export completed but no downloadUrl returned');
    }

    console.log(`[submagic] done: ${exported.downloadUrl}`);

    res.json({
      videoUrl: exported.downloadUrl,
      previewUrl: exported.previewUrl ?? null,
      duration: exported.videoMetaData?.duration ?? processed.videoMetaData?.duration ?? null,
      words: exported.words ?? [],
    });
  } catch (err) {
    if (err.response) {
      console.error(`[submagic] API error ${err.response.status}:`, JSON.stringify(err.response.data));
      err.message = `Submagic API ${err.response.status}: ${JSON.stringify(err.response.data)}`;
    }
    next(err);
  }
});
