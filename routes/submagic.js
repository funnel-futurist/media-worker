import { Router } from 'express';
import axios from 'axios';

export const submagicRouter = Router();

const BASE = 'https://api.submagic.co/v1';

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
      bgmUrl = process.env.SUBMAGIC_BGM_URL ?? null,
      bgmVolume = 20,
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

    // ── Step 1b: Upload BGM to Submagic user-media (if provided) ─────────
    let music = undefined;
    if (bgmUrl) {
      try {
        console.log(`[submagic] uploading BGM: ${bgmUrl}`);
        const { data: bgmMedia } = await axios.post(
          `${BASE}/user-media`,
          { url: bgmUrl },
          { headers: headers() }
        );
        music = { userMediaId: bgmMedia.userMediaId, volume: bgmVolume };
        console.log(`[submagic] BGM registered: ${bgmMedia.userMediaId}`);
      } catch (bgmErr) {
        console.warn(`[submagic] BGM upload failed (non-fatal): ${bgmErr.message}`);
      }
    }

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
