import { Router } from 'express';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getDuration } from '../lib/media.js';

const execAsync = promisify(exec);

/**
 * POST /assemble-ad-variation
 *
 * Stitch the section clips of ONE approved ad variation (Hook -> Opener ->
 * Body -> CTA) into a single 1080x1350 video. v1 is a review-quality stitch:
 * each clip is normalised to the target frame (scale-to-fit + pad — nothing is
 * cropped, so faces are never cut) and concatenated in order. No captions /
 * banner / music yet — that's a follow-up.
 *
 * Memory-safe: clips are normalised ONE AT A TIME (Railway OOMs if it decodes
 * several large files at once), then concatenated with a cheap stream-copy.
 *
 * Auth: Bearer WORKER_SECRET (global middleware).
 *
 * Body:
 *   {
 *     variationId: string,
 *     clientId: string,
 *     clips: Array<{ url: string, section?: string }>,   // in play order
 *     output?: { width?: number, height?: number },      // default 1080x1350
 *     callback?: { url: string, apiKey: string }         // opt-in async mode
 *   }
 *
 * Sync (no callback):  200 { variationId, renderedUrl, duration, clipCount }
 * Async (callback):    202 { variationId, accepted: true, mode: 'async' }
 *   Eventual POST to <callback.url> with `x-api-key: <callback.apiKey>`:
 *     success → { variationId, clientId, status: 'success', renderedUrl, duration }
 *     failure → { variationId, clientId, status: 'failed', error }
 */
export const assembleAdVariationRouter = Router();

const DEFAULT_W = 1080;
const DEFAULT_H = 1350;
const RENDERED_URL_TTL_SEC = 60 * 60 * 24 * 365; // 1y — matches edit_file_url

/** True if the file has at least one audio stream. */
async function hasAudio(path) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "${path}"`,
      { timeout: 30000 },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Normalise one clip to a canonical format so concat -c copy is safe:
 * exactly 1 video (H.264, yuv420p, WxH, 30fps, fixed timescale) + 1 stereo
 * 48k AAC audio (silent track injected when the source has none).
 */
async function normaliseClip(srcPath, outPath, w, h) {
  const vf =
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p`;
  const common =
    `-c:v libx264 -preset veryfast -c:a aac -ar 48000 -ac 2 ` +
    `-video_track_timescale 30000 -movflags +faststart -y`;
  if (await hasAudio(srcPath)) {
    await execAsync(`ffmpeg -i "${srcPath}" -vf "${vf}" ${common} "${outPath}"`, { timeout: 300000 });
  } else {
    // No audio stream — inject a silent stereo track so every normalised clip
    // has matching stream layout for the concat.
    await execAsync(
      `ffmpeg -i "${srcPath}" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 ` +
        `-vf "${vf}" -map 0:v:0 -map 1:a -shortest ${common} "${outPath}"`,
      { timeout: 300000 },
    );
  }
  if (!existsSync(outPath)) throw new Error(`normalise produced no output for ${srcPath}`);
}

/** Upload the rendered mp4 to Supabase Storage and return a 1-year signed URL. */
async function uploadAndSign(filePath, clientId, variationId) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('Supabase env vars not set for storage upload');

  const date = new Date().toISOString().split('T')[0];
  const path = `ad-variations/${clientId || 'unknown'}/${date}/${variationId}_${randomUUID()}.mp4`;
  const buffer = readFileSync(filePath);

  await axios.post(`${base}/storage/v1/object/video-modules/${path}`, buffer, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const signRes = await axios.post(
    `${base}/storage/v1/object/sign/video-modules/${path}`,
    { expiresIn: RENDERED_URL_TTL_SEC },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } },
  );
  const signed = signRes.data?.signedURL || signRes.data?.signedUrl;
  if (!signed) throw new Error('Supabase sign returned no signedURL');
  return `${base}/storage/v1${signed}`;
}

/** POST the result back to the portal. Best-effort; logs on failure. */
async function postCallback(callback, payload) {
  if (!callback?.url || !callback?.apiKey) return;
  try {
    await axios.post(callback.url, payload, {
      headers: { 'Content-Type': 'application/json', 'x-api-key': callback.apiKey },
      timeout: 20000,
    });
    console.log(`[assemble-ad-variation] callback delivered variationId=${payload.variationId} status=${payload.status}`);
  } catch (err) {
    console.error(
      `[assemble-ad-variation] callback FAILED variationId=${payload.variationId}:`,
      err?.response?.status ?? err?.message ?? err,
    );
  }
}

/** Core work: download → normalise each → concat → upload. Returns { renderedUrl, duration }. */
async function renderVariation({ clips, clientId, variationId, width, height }) {
  const tmpDir = join('/tmp', `adv-${randomUUID()}`);
  try {
    mkdirSync(tmpDir, { recursive: true });
    const normPaths = [];
    for (let i = 0; i < clips.length; i++) {
      const rawPath = join(tmpDir, `raw_${i}.mp4`);
      const resp = await axios.get(clips[i].url, { responseType: 'arraybuffer', maxContentLength: Infinity });
      writeFileSync(rawPath, Buffer.from(resp.data));
      const normPath = join(tmpDir, `norm_${i}.mp4`);
      await normaliseClip(rawPath, normPath, width, height);
      rmSync(rawPath, { force: true });
      normPaths.push(normPath);
    }

    const listPath = join(tmpDir, 'filelist.txt');
    writeFileSync(listPath, normPaths.map((p) => `file '${p}'`).join('\n'));

    const outputPath = join(tmpDir, 'output.mp4');
    await execAsync(
      `ffmpeg -f concat -safe 0 -i "${listPath}" -c copy -movflags +faststart -y "${outputPath}"`,
      { timeout: 300000 },
    );
    if (!existsSync(outputPath)) throw new Error('concat produced no output file');

    const duration = await getDuration(outputPath);
    const renderedUrl = await uploadAndSign(outputPath, clientId, variationId);
    return { renderedUrl, duration };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

assembleAdVariationRouter.post('/assemble-ad-variation', async (req, res) => {
  const body = req.body || {};
  const { variationId, clientId, clips = [], output = {}, callback } = body;
  const width = Number(output.width) || DEFAULT_W;
  const height = Number(output.height) || DEFAULT_H;

  // Synchronous validation (always 400 immediately, even in async mode).
  if (typeof variationId !== 'string' || !variationId) {
    return res.status(400).json({ error: 'variationId is required' });
  }
  if (typeof clientId !== 'string' || !clientId) {
    return res.status(400).json({ variationId, error: 'clientId is required' });
  }
  if (!Array.isArray(clips) || clips.length === 0 || clips.some((c) => !c || typeof c.url !== 'string')) {
    return res.status(400).json({ variationId, error: 'clips must be a non-empty array of { url }' });
  }

  const isAsync = !!(callback?.url && callback?.apiKey);

  if (!isAsync) {
    // Sync mode (manual testing) — run inline and return the result.
    try {
      const { renderedUrl, duration } = await renderVariation({ clips, clientId, variationId, width, height });
      return res.json({ variationId, renderedUrl, duration, clipCount: clips.length });
    } catch (err) {
      console.error(`[assemble-ad-variation] sync render failed variationId=${variationId}:`, err?.stack ?? err);
      return res.status(500).json({ variationId, error: err?.message ?? 'render failed' });
    }
  }

  // Async mode — accept, then render + callback in the background.
  res.status(202).json({ variationId, accepted: true, mode: 'async' });
  renderVariation({ clips, clientId, variationId, width, height })
    .then(({ renderedUrl, duration }) =>
      postCallback(callback, { variationId, clientId, status: 'success', renderedUrl, duration }),
    )
    .catch((err) => {
      console.error(`[assemble-ad-variation] async render failed variationId=${variationId}:`, err?.stack ?? err);
      return postCallback(callback, {
        variationId,
        clientId,
        status: 'failed',
        error: (err?.message ?? 'render failed').slice(0, 500),
      });
    });
});
