import { Router } from 'express';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { uploadVideo } from '../lib/storage.js';

const execAsync = promisify(exec);

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
async function pollProject(projectId, targetStatus, intervalMs = 10000, maxMs = 900000) {
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
 *   templateName?: string     — caption style preset name (default: "Sara")
 *   removeSilencePace?: string — "natural" | "fast" | "extra-fast" (default: "natural")
 *   removeBadTakes?: boolean  — AI removes bad takes (default: true)
 *   clientBrolls?: Array<{ url: string, startTime: number, endTime: number }>
 * }
 *
 * Returns: { videoUrl, duration }
 */
// ── Supabase helpers (mirror of classify.js) ─────────────────────────────
function getSupabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_KEY not set');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'marketing',
    'Content-Profile': 'marketing',
  };
}

function getSupabaseUrl() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL not set');
  return url;
}

async function supabasePatch(table, id, data) {
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: getSupabaseHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} failed: ${await res.text()}`);
}

async function supabaseInsertEvent(clientId, eventType, metadata) {
  await fetch(`${getSupabaseUrl()}/rest/v1/content_pipeline_events`, {
    method: 'POST',
    headers: getSupabaseHeaders(),
    body: JSON.stringify({ client_id: clientId, event_type: eventType, source_module: 'railway/submagic-async', metadata }),
  });
}

/**
 * POST /submagic-edit-async
 *
 * Fire-and-forget version of /submagic-edit.
 * Accepts the job, responds immediately with { accepted: true },
 * then processes in background and updates ad_ingestion in Supabase directly.
 * Eliminates Vercel 300s timeout risk for long Submagic jobs.
 *
 * Extra body fields: ingestionId, clientId (for Supabase callback)
 */
submagicRouter.post('/submagic-edit-async', async (req, res) => {
  const { ingestionId, clientId, ...editParams } = req.body;
  if (!ingestionId || !clientId) {
    return res.status(400).json({ error: 'ingestionId and clientId are required' });
  }
  if (!editParams.videoUrl) {
    return res.status(400).json({ error: 'videoUrl is required' });
  }

  // Respond immediately — Vercel won't time out waiting
  res.json({ accepted: true, ingestionId });

  // Process in background — Railway has no serverless timeout
  setImmediate(async () => {
    try {
      console.log(`[submagic-async] starting job for ingestion ${ingestionId}`);

      // ── Attempt 1 ─────────────────────────────────────────────────────
      const result = await runSubmagicEdit(editParams);
      const qc1 = await runEditQc(result.videoUrl, ingestionId);

      if (qc1.pass) {
        // QC passed first time — normal delivery
        await supabasePatch('ad_ingestion', ingestionId, {
          status: 'rendered',
          file_url: result.videoUrl,
          last_error: null,
        });
        await supabaseInsertEvent(clientId, 'render_complete', {
          ingestion_id: ingestionId,
          final_url: result.videoUrl,
          duration: result.duration,
          preview_url: result.previewUrl,
          edit_qc_pass: true,
          edit_qc_note: qc1.note,
          edit_qc_attempt: 1,
        });
        console.log(`[submagic-async] done (attempt 1, QC pass) for ${ingestionId}`);
        return;
      }

      // ── QC failed — auto-retry with adjusted params ───────────────────
      console.log(`[submagic-async] QC failed attempt 1 for ${ingestionId}: ${qc1.note} — retrying`);

      // If b-roll was flagged as the issue, disable all stock b-roll on retry
      const hasBrollIssue = qc1.issues.some(issue =>
        /b.?roll|stock footage|cutaway|irrelevant|random/i.test(issue)
      );
      const retryParams = {
        ...editParams,
        forceMagicBrolls: false, // always disable stock b-roll on retry
        ...(hasBrollIssue && { clientBrolls: [] }), // also remove client b-rolls if b-roll flagged
      };

      console.log(`[submagic-async] retry params — forceMagicBrolls: false, hasBrollIssue: ${hasBrollIssue}`);
      const result2 = await runSubmagicEdit(retryParams);
      const qc2 = await runEditQc(result2.videoUrl, `${ingestionId}-retry`);

      if (qc2.pass) {
        // QC passed on retry — use the retry result
        await supabasePatch('ad_ingestion', ingestionId, {
          status: 'rendered',
          file_url: result2.videoUrl,
          last_error: null,
        });
        await supabaseInsertEvent(clientId, 'render_complete', {
          ingestion_id: ingestionId,
          final_url: result2.videoUrl,
          duration: result2.duration,
          preview_url: result2.previewUrl,
          edit_qc_pass: true,
          edit_qc_note: qc2.note,
          edit_qc_attempt: 2,
          edit_qc_attempt1_issues: qc1.issues,
        });
        console.log(`[submagic-async] done (attempt 2, QC pass) for ${ingestionId}`);
        return;
      }

      // ── Both attempts failed — hold for manual review ─────────────────
      const issueList1 = qc1.issues.map((i, n) => `${n + 1}. ${i}`).join('\n') || 'None listed';
      const issueList2 = qc2.issues.map((i, n) => `${n + 1}. ${i}`).join('\n') || 'None listed';

      await supabasePatch('ad_ingestion', ingestionId, {
        status: 'edit_qc_review',
        file_url: result2.videoUrl,
        last_error: `Edit QC failed after 2 attempts. Attempt 2: ${qc2.note}`,
      });

      await supabaseInsertEvent(clientId, 'render_complete', {
        ingestion_id: ingestionId,
        final_url: result2.videoUrl,
        duration: result2.duration,
        edit_qc_pass: false,
        edit_qc_note: qc2.note,
        edit_qc_attempt: 2,
        edit_qc_attempt1_issues: qc1.issues,
        edit_qc_attempt2_issues: qc2.issues,
      });

      await postToSlackOps(
        `🔴 *Edit QC hold — 2 attempts failed* — manual review required\n` +
        `*Attempt 1 issues:*\n${issueList1}\n\n` +
        `*Attempt 2 issues (b-roll disabled):*\n${issueList2}\n\n` +
        `*Best version:* ${result2.videoUrl}\n\n` +
        `*Options:*\n` +
        `• Set status to \`rendered\` in Supabase to approve and deliver as-is\n` +
        `• Ask client to re-record if the raw performance was the issue\n` +
        `• Set status to \`rejected\` to discard`
      );

      console.log(`[submagic-async] QC failed both attempts for ${ingestionId} — held for review`);
    } catch (err) {
      const message = err?.message ?? String(err);
      const responseBody = err?.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : null;
      console.error(`[submagic-async] failed for ${ingestionId}:`, message, responseBody ? `| Submagic response: ${responseBody}` : '');

      await supabasePatch('ad_ingestion', ingestionId, {
        status: 'classified',
        last_error: message,
      }).catch(e => console.error('[submagic-async] failed to revert status:', e));

      await supabaseInsertEvent(clientId, 'error', {
        ingestion_id: ingestionId,
        error: message,
      }).catch(() => {});
    }
  });
});

/**
 * If the URL is a Supabase Storage URL, download it from Railway and re-upload to
 * Cloudinary so Submagic's ingest pipeline can reach it.
 * Supabase Storage public URLs are not reliably accessible from Submagic's servers
 * (Submagic's project stays stuck in "processing" forever when given one).
 */
async function ensureCloudinaryUrl(videoUrl) {
  if (!videoUrl.includes('/storage/v1/object/')) return videoUrl;

  const tmpId = randomUUID();
  const inputPath = join('/tmp', `${tmpId}_supabase_relay.mp4`);

  try {
    console.log('[submagic] Supabase URL detected — relaying through Cloudinary for Submagic access');
    const { data } = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120000 });
    writeFileSync(inputPath, Buffer.from(data));
    const { url } = await uploadVideo(inputPath, 'submagic-intake');
    console.log(`[submagic] Cloudinary relay URL: ${url}`);
    return url;
  } finally {
    if (existsSync(inputPath)) unlinkSync(inputPath);
  }
}

/**
 * If the video is H.265/HEVC, transcode to H.264 and upload to Cloudinary.
 * Submagic's ingest pipeline rejects H.265 with "Virus scan failed".
 * Returns the original URL if already H.264, or a new Cloudinary URL if transcoded.
 */
async function ensureH264(videoUrl) {
  const tmpId = randomUUID();
  const inputPath = join('/tmp', `${tmpId}_in.mp4`);
  const outputPath = join('/tmp', `${tmpId}_out.mp4`);

  try {
    // Probe codec from URL — ffprobe only downloads the container header
    let codec = 'unknown';
    try {
      const { stdout } = await execAsync(
        `ffprobe -v quiet -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${videoUrl}"`,
        { timeout: 30000 }
      );
      codec = stdout.trim().toLowerCase();
    } catch {
      console.warn('[submagic] ffprobe failed — assuming H.264, skipping transcode');
      return videoUrl;
    }

    console.log(`[submagic] codec detected: ${codec}`);
    if (codec !== 'hevc' && codec !== 'h265') return videoUrl;

    console.log('[submagic] H.265 detected — transcoding to H.264 for Submagic compatibility');

    // Download the full file for transcoding
    const { data } = await axios.get(videoUrl, { responseType: 'arraybuffer' });
    writeFileSync(inputPath, Buffer.from(data));

    await execAsync(
      `ffmpeg -i "${inputPath}" -c:v libx264 -preset fast -crf 23 -c:a aac -movflags +faststart -y "${outputPath}"`,
      { timeout: 300000 } // 5 min max
    );

    const { url } = await uploadVideo(outputPath, 'submagic-intake');
    console.log(`[submagic] transcoded H.264 uploaded: ${url}`);
    return url;
  } finally {
    if (existsSync(inputPath)) unlinkSync(inputPath);
    if (existsSync(outputPath)) unlinkSync(outputPath);
  }
}

/**
 * Probe the width/height of a video URL without downloading the full file.
 * Returns { w, h } or null if probe fails.
 */
async function probeVideoDimensions(videoUrl) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${videoUrl}"`,
      { timeout: 30000 }
    );
    const [w, h] = stdout.trim().split(',').map(Number);
    if (w && h) return { w, h };
    return null;
  } catch {
    return null;
  }
}

/**
 * Fit a b-roll clip into a 1080x1920 (9:16) frame without cropping.
 * - Already vertical (9:16): pass through unchanged.
 * - Landscape (16:9) or square (1:1): scale to fit, pad sides/top-bottom with black.
 * This respects the source asset's framing instead of aggressively cropping it.
 * Returns the original URL if already vertical, or a new Cloudinary URL.
 */
async function fitToVertical(videoUrl) {
  const dims = await probeVideoDimensions(videoUrl);
  if (!dims) {
    console.warn('[submagic] could not probe b-roll dimensions — using as-is');
    return videoUrl;
  }

  const { w, h } = dims;
  const ratio = w / h;
  console.log(`[submagic] b-roll dimensions: ${w}x${h} (ratio ${ratio.toFixed(2)})`);

  // Already portrait/vertical — no processing needed
  if (ratio <= 0.75) return videoUrl;

  const tmpId = randomUUID();
  const inputPath = join('/tmp', `${tmpId}_broll_in.mp4`);
  const outputPath = join('/tmp', `${tmpId}_broll_fit.mp4`);

  try {
    console.log(`[submagic] fitting ${w}x${h} b-roll to 1080x1920 with crop-to-fill`);
    const { data } = await axios.get(videoUrl, { responseType: 'arraybuffer' });
    writeFileSync(inputPath, Buffer.from(data));

    // Scale to fill 1080x1920 then crop center — b-roll must be full-screen, no black bars
    await execAsync(
      `ffmpeg -i "${inputPath}" ` +
      `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" ` +
      `-c:v libx264 -preset fast -crf 23 -c:a aac -movflags +faststart -y "${outputPath}"`,
      { timeout: 180000 }
    );

    const { url } = await uploadVideo(outputPath, 'submagic-broll');
    console.log(`[submagic] b-roll fitted to vertical: ${url}`);
    return url;
  } finally {
    if (existsSync(inputPath)) unlinkSync(inputPath);
    if (existsSync(outputPath)) unlinkSync(outputPath);
  }
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

function isImageUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const ext = pathname.match(/\.[^./?]+$/)?.[0] ?? '';
    return IMAGE_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

/**
 * Convert a static photo to a 4-second vertical MP4 with a subtle Ken Burns zoom.
 * Required because Submagic /user-media only accepts video, not images.
 */
async function convertImageToBroll(imageUrl) {
  const tmpId = randomUUID();
  const extMatch = imageUrl.match(/\.(jpg|jpeg|png|webp)/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
  const inputPath = join('/tmp', `${tmpId}_photo.${ext}`);
  const outputPath = join('/tmp', `${tmpId}_photo.mp4`);

  try {
    console.log(`[submagic] converting photo to b-roll video: ${imageUrl}`);
    const { data } = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    writeFileSync(inputPath, Buffer.from(data));

    // Scale to fill 1080x1920 (9:16 vertical), apply slow Ken Burns zoom-in over 4s
    await execAsync(
      `ffmpeg -loop 1 -i "${inputPath}" ` +
      `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
      `zoompan=z='min(zoom+0.0015,1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=120:s=1080x1920" ` +
      `-t 4 -c:v libx264 -pix_fmt yuv420p -preset fast -r 30 -y "${outputPath}"`,
      { timeout: 120000 }
    );

    const { url } = await uploadVideo(outputPath, 'submagic-broll');
    console.log(`[submagic] photo → b-roll video: ${url}`);
    return url;
  } finally {
    if (existsSync(inputPath)) unlinkSync(inputPath);
    if (existsSync(outputPath)) unlinkSync(outputPath);
  }
}

// ── Edit QC ───────────────────────────────────────────────────────────────

async function postToSlackOps(text) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_OPS;
  if (!token || !channel) return;
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, text }),
  }).catch(err => console.error('[submagic-qc] Slack notify failed:', err.message));
}

async function uploadToGeminiFiles(buffer, mimeType, displayName) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const initRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buffer.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });

  const uploadUrl = initRes.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) throw new Error('Failed to get Gemini upload URL');

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'Content-Length': String(buffer.length),
    },
    body: new Uint8Array(buffer),
  });

  if (!uploadRes.ok) throw new Error(`Gemini file upload failed: ${await uploadRes.text()}`);

  const fileData = await uploadRes.json();
  let fileState = fileData.file.state;
  const fileName = fileData.file.name;

  const deadline = Date.now() + 120_000;
  while (fileState === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error('Gemini file processing timed out');
    await new Promise(r => setTimeout(r, 5000));
    const checkRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`);
    const checkData = await checkRes.json();
    fileState = checkData.state;
    if (fileState === 'ACTIVE') return checkData.uri;
    if (fileState === 'FAILED' || fileState === 'ERROR') throw new Error(`Gemini file processing failed: ${fileState}`);
  }

  return fileData.file.uri;
}

/**
 * Run a lightweight Gemini QC check on the rendered/edited video.
 * Checks captions, b-roll context, edit quality, and overall client-readiness.
 * Returns { pass, issues, note }.
 * Defaults to pass=true on error so Gemini failures never block delivery.
 */
async function runEditQc(videoUrl, ingestionId) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[submagic-qc] GEMINI_API_KEY not set, skipping QC');
    return { pass: true, issues: [], note: 'QC skipped (no API key)' };
  }

  const tmpId = randomUUID();
  const inputPath = join('/tmp', `${tmpId}_qc_in.mp4`);
  const trimPath = join('/tmp', `${tmpId}_qc_trim.mp4`);

  try {
    console.log(`[submagic-qc] running edit QC for ${ingestionId}`);

    const { data } = await axios.get(videoUrl, { responseType: 'arraybuffer' });
    writeFileSync(inputPath, Buffer.from(data));

    // Trim to 90s max — enough to assess quality without uploading a huge file
    await execAsync(
      `ffmpeg -i "${inputPath}" -t 90 -c copy -y "${trimPath}"`,
      { timeout: 60000 }
    ).catch(() => execAsync(`cp "${inputPath}" "${trimPath}"`));

    const qcPath = existsSync(trimPath) ? trimPath : inputPath;
    const fileBuffer = readFileSync(qcPath);
    const fileUri = await uploadToGeminiFiles(fileBuffer, 'video/mp4', `qc-${ingestionId}.mp4`);

    const prompt = `You are doing quality control on an AI-edited social media short-form video before it is sent to a client for review.

Analyze this video across 4 criteria:
1. CAPTIONS — Readable? Well-positioned? Not covering the speaker's face? Timing feels natural?
2. B-ROLL — Does the b-roll make contextual sense for what the speaker is saying, or is it random/jarring/irrelevant?
3. EDIT QUALITY — Are cuts smooth? Does the pacing feel natural? No abrupt jumps or dead air?
4. CLIENT-READY — Is this polished enough to present to a paying client as a finished product?

Be strict but fair. Minor imperfections are fine. Fail only if there is a clear problem that would embarrass the team or confuse the client.

Return valid JSON only:
{
  "pass": true|false,
  "issues": ["specific issue if any", "another issue if any"],
  "note": "one sentence overall assessment"
}`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { file_data: { mime_type: 'video/mp4', file_uri: fileUri } },
            { text: prompt },
          ]}],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
        }),
      }
    );

    if (!res.ok) throw new Error(`Gemini QC API error: ${await res.text()}`);

    const geminiData = await res.json();
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty QC response from Gemini');

    const result = JSON.parse(text);
    console.log(`[submagic-qc] ${ingestionId}: pass=${result.pass} — ${result.note}`);
    return result;
  } catch (err) {
    console.error(`[submagic-qc] failed for ${ingestionId}:`, err.message);
    // Default to pass on error — never block delivery due to a Gemini failure
    return { pass: true, issues: [], note: `QC check errored: ${err.message}` };
  } finally {
    if (existsSync(inputPath)) unlinkSync(inputPath);
    if (existsSync(trimPath)) unlinkSync(trimPath);
  }
}

/**
 * Core Submagic edit logic — shared by /submagic-edit and /submagic-edit-async.
 *
 * Caption placement notes (Submagic API constraints):
 *   - The Submagic API has no top-level caption position field.
 *   - Caption position is determined entirely by the selected templateName.
 *   - When a hookTitle text overlay occupies the top region, we select a template
 *     that keeps captions in the lower portion to prevent collision.
 *   - When no hookTitle is present, the standard template handles placement.
 *   - True PPX/percentage-based dynamic positioning is a Remotion feature only.
 */
// Caption template defaults by content type:
//   Talking head reels → 'Sara' (built-in, confirmed working; 'Phil April' custom preset was removed from account)
//   YouTube clips      → 'Sara' (built-in, smaller/cleaner, works without a custom preset)
// Callers can override either by passing templateName explicitly.
const TEMPLATE_TALKING_HEAD = 'Jack';
const TEMPLATE_YOUTUBE      = 'Jack';

async function runSubmagicEdit({
  videoUrl,
  language = 'en',
  templateName = null,       // null → auto-pick from TEMPLATE_* constants based on skipHook
  removeSilencePace = 'natural',
  removeBadTakes = true,
  clientBrolls = [],
  emotionTags = [],
  skipHook = false,
  forceMagicBrolls = null,  // null = auto (true unless skipHook), false = always off
  captionsPosition = null,  // reserved — Submagic API has no caption position field; ignored for now
  hookText = null,          // Gemini-generated hook sentence — displayed as on-screen text overlay
}) {
    // ── Step 0a: Relay Supabase URLs through Cloudinary ──────────────────
    // Submagic's ingest pipeline cannot reach Supabase Storage URLs — the project
    // gets created but stays stuck in "processing" until timeout. Download from
    // Supabase on Railway (which CAN reach it) and re-upload to Cloudinary first.
    videoUrl = await ensureCloudinaryUrl(videoUrl);

    // ── Step 0b: Ensure H.264 — Submagic rejects H.265 with "Virus scan failed" ──
    videoUrl = await ensureH264(videoUrl);

    // ── Step 1: Register client b-roll clips in parallel ─────────────────
    const items = await Promise.all(clientBrolls.map(async (broll) => {
      // Photos must be converted to short video clips — Submagic /user-media rejects images.
      // Check both URL extension and asset_type (existing photos were stored with .mp4 extension by mistake).
      const isPhoto = isImageUrl(broll.url) || (broll.assetType ?? '').toLowerCase().includes('photo');
      let brollVideoUrl = broll.url;
      if (isPhoto) {
        brollVideoUrl = await convertImageToBroll(broll.url);
      } else {
        // Fit non-vertical video to 1080x1920 with padding — avoids aggressive crop on 16:9 assets
        brollVideoUrl = await fitToVertical(broll.url);
      }
      console.log(`[submagic] registering client b-roll: ${brollVideoUrl}`);
      const { data: mediaData } = await axios.post(
        `${BASE}/user-media`,
        { url: brollVideoUrl },
        { headers: headers() }
      );
      return {
        type: 'user-media',
        userMediaId: mediaData.userMediaId,
        startTime: broll.startTime,
        endTime: broll.endTime,
        layout: 'cover',
      };
    }));

    // Stock b-roll disabled by default — Submagic's AI picks contextually irrelevant footage
    // (random screen recordings, unrelated visuals). Client b-roll is handled via items[].
    // forceMagicBrolls can still override this explicitly (e.g. for future opt-in).
    const magicBrolls = forceMagicBrolls !== null ? forceMagicBrolls : false;

    let music = null;
    if (!skipHook) {
      const musicId = pickMusicId(emotionTags);
      music = { userMediaId: musicId, volume: 5 };
      console.log(`[submagic] BGM selected: ${musicId} (emotions: ${emotionTags.join(', ') || 'none → default'})`);
    }

    // ── Caption template selection ─────────────────────────────────────────
    // Auto-pick based on content type when no explicit template is given.
    // Both types now default to 'Sara' — built-in, confirmed working.
    // 'Phil April' was a custom preset that was removed from the Submagic account (caused 400).
    // Explicit templateName (from client_content_config.submagic_preset_id) always wins.
    const resolvedTemplateName = templateName ?? (skipHook ? TEMPLATE_YOUTUBE : TEMPLATE_TALKING_HEAD);
    console.log(`[submagic] template: ${resolvedTemplateName} (${skipHook ? 'youtube' : 'talking-head'})`);

    // ── Hook title overlay ────────────────────────────────────────────────
    // hookText is a Gemini-generated hook sentence displayed as an animated opening caption.
    // API schema: { text (max 100 chars), template? (default: 'tiktok'), top?: 0-80, size?: 0-80 }
    // Valid hookTitle templates: tiktok, laura, steph, kevin, kelly, mark, logan, enrico, mike, devin, hormozi, masi, ali
    // 'subtitle' is NOT a valid template — causes 400. 'hormozi' = white text + shadow, no colored background.
    // Previously used 'steph' custom preset (deleted) and 'position: top' (wrong field name) — both 400'd.
    const hookTitlePayload = (hookText && !skipHook)
      ? { hookTitle: { text: hookText.trim().slice(0, 100), top: 5, template: 'hormozi' } }
      : {};

    if (hookText && !skipHook) {
      console.log(`[submagic] hook title: "${hookText.trim().slice(0, 100)}"`);
    }

    const projectBody = {
      title: `pipeline-${Date.now()}`,
      videoUrl,
      language,
      templateName: resolvedTemplateName,
      removeSilencePace,
      removeBadTakes,
      magicBrolls,
      cleanAudio: true,
      // NOTE: Submagic API has no top-level caption position field.
      // Caption placement is controlled by templateName only.
      // captionsPosition param is accepted by our API but silently ignored until Submagic adds support.
      ...hookTitlePayload,
      ...(items.length > 0 && { items }),
      ...(music && { music }),
    };

    console.log(`[submagic] creating project for: ${videoUrl}`);
    console.log(`[submagic] project body: ${JSON.stringify(projectBody)}`);
    const { data: project } = await axios.post(`${BASE}/projects`, projectBody, { headers: headers() });
    console.log(`[submagic] project created: ${project.id}`);

    const processed = await pollProject(project.id, 'completed');

    let exported = processed;
    if (!processed.downloadUrl) {
      console.log(`[submagic] triggering export for project ${project.id}`);
      try {
        await axios.post(`${BASE}/projects/${project.id}/export`, {}, { headers: headers() });
      } catch (exportErr) {
        console.warn(`[submagic] export endpoint returned ${exportErr?.response?.status ?? exportErr.message}, polling anyway`);
      }
      exported = await pollProject(project.id, 'completed', 10000, 600000);
    }

    if (!exported.downloadUrl) throw new Error('Submagic export completed but no downloadUrl returned');

    console.log(`[submagic] done: ${exported.downloadUrl}`);
    return {
      videoUrl: exported.downloadUrl,
      previewUrl: exported.previewUrl ?? null,
      duration: exported.videoMetaData?.duration ?? processed.videoMetaData?.duration ?? null,
      words: exported.words ?? [],
    };
}

submagicRouter.post('/submagic-edit', async (req, res, next) => {
  try {
    if (!req.body.videoUrl) return res.status(400).json({ error: 'videoUrl is required' });
    const result = await runSubmagicEdit(req.body);
    res.json(result);
  } catch (err) {
    if (err.response) {
      console.error(`[submagic] API error ${err.response.status}:`, JSON.stringify(err.response.data));
      err.message = `Submagic API ${err.response.status}: ${JSON.stringify(err.response.data)}`;
    }
    next(err);
  }
});
