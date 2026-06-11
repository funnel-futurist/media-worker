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
// ffmpeg/ffprobe stderr can be large; the exec default (1MB) silently kills the
// process with a useless "Command failed" — give it real headroom.
const EXEC_MAXBUFFER = 64 * 1024 * 1024;
// How many variations render concurrently. Auto-render-on-build can dispatch
// 18+ at once; ffmpeg is CPU+memory heavy, so cap to avoid Railway OOM.
const MAX_CONCURRENT_RENDERS = 2;

/**
 * Run an ffmpeg/ffprobe command and, on failure, throw an Error whose message
 * is the REAL ffmpeg stderr tail (not just "Command failed: <cmd>"). This is
 * what makes render failures diagnosable end-to-end.
 */
async function runFfmpeg(cmd, { timeout = 300000 } = {}) {
  try {
    return await execAsync(cmd, { timeout, maxBuffer: EXEC_MAXBUFFER });
  } catch (err) {
    const stderr = (err?.stderr ?? '').toString();
    const tail = stderr.split('\n').filter(Boolean).slice(-8).join(' | ').trim();
    const reason = tail || err?.message || 'unknown ffmpeg error';
    throw new Error(`ffmpeg failed: ${reason}`.slice(0, 600));
  }
}

/** True if the file has at least one audio stream. */
async function hasAudio(path) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "${path}"`,
      { timeout: 30000, maxBuffer: EXEC_MAXBUFFER },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Validate a downloaded clip is actually a decodable video before we try to
 * normalise it. Catches the common failure where a signed URL returned an error
 * page / JSON instead of video bytes (→ a clear message instead of a cryptic
 * ffmpeg dump).
 */
async function assertValidVideo(path, label) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "${path}"`,
      { timeout: 30000, maxBuffer: EXEC_MAXBUFFER },
    );
    if (!stdout.trim()) throw new Error('no video stream');
  } catch (err) {
    const msg = (err?.stderr ?? err?.message ?? '').toString().split('\n').filter(Boolean).slice(-3).join(' | ');
    throw new Error(`${label} is not a valid video (${msg || 'unreadable'}). Check the clip's raw footage URL.`);
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
    `-c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 ` +
    `-video_track_timescale 30000 -movflags +faststart -y`;
  if (await hasAudio(srcPath)) {
    await runFfmpeg(`ffmpeg -i "${srcPath}" -vf "${vf}" ${common} "${outPath}"`);
  } else {
    // No audio stream — inject a silent stereo track so every normalised clip
    // has matching stream layout for the concat.
    await runFfmpeg(
      `ffmpeg -i "${srcPath}" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 ` +
        `-vf "${vf}" -map 0:v:0 -map 1:a -shortest ${common} "${outPath}"`,
    );
  }
  if (!existsSync(outPath)) throw new Error(`normalise produced no output for ${srcPath}`);
}

// ── Render concurrency gate ───────────────────────────────────────────────
// Simple in-process semaphore: at most MAX_CONCURRENT_RENDERS renders run the
// heavy ffmpeg work at once; the rest queue. Keeps auto-render-on-build (many
// variations dispatched together) from OOMing Railway.
let activeRenders = 0;
const renderWaiters = [];
async function acquireRenderSlot() {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders++;
    return;
  }
  await new Promise((resolve) => renderWaiters.push(resolve));
  activeRenders++;
}
function releaseRenderSlot() {
  activeRenders--;
  const next = renderWaiters.shift();
  if (next) next();
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
      let resp;
      try {
        resp = await axios.get(clips[i].url, { responseType: 'arraybuffer', maxContentLength: Infinity, timeout: 120000 });
      } catch (err) {
        throw new Error(`failed to download clip ${i} (${clips[i].section ?? '?'}): ${err?.response?.status ?? err?.message ?? 'download error'}`);
      }
      writeFileSync(rawPath, Buffer.from(resp.data));
      await assertValidVideo(rawPath, `clip ${i} (${clips[i].section ?? '?'})`);
      const normPath = join(tmpDir, `norm_${i}.mp4`);
      await normaliseClip(rawPath, normPath, width, height);
      rmSync(rawPath, { force: true });
      normPaths.push(normPath);
    }

    const listPath = join(tmpDir, 'filelist.txt');
    writeFileSync(listPath, normPaths.map((p) => `file '${p}'`).join('\n'));

    const outputPath = join(tmpDir, 'output.mp4');
    await runFfmpeg(`ffmpeg -f concat -safe 0 -i "${listPath}" -c copy -movflags +faststart -y "${outputPath}"`);
    if (!existsSync(outputPath)) throw new Error('concat produced no output file');

    const duration = await getDuration(outputPath);
    const renderedUrl = await uploadAndSign(outputPath, clientId, variationId);
    return { renderedUrl, duration };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Concurrency-gated wrapper: queues behind the render semaphore. */
async function renderVariationQueued(args) {
  await acquireRenderSlot();
  try {
    return await renderVariation(args);
  } finally {
    releaseRenderSlot();
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
      const { renderedUrl, duration } = await renderVariationQueued({ clips, clientId, variationId, width, height });
      return res.json({ variationId, renderedUrl, duration, clipCount: clips.length });
    } catch (err) {
      console.error(`[assemble-ad-variation] sync render failed variationId=${variationId}:`, err?.message ?? err);
      return res.status(500).json({ variationId, error: err?.message ?? 'render failed' });
    }
  }

  // Async mode — accept, then render + callback in the background (queued so
  // many concurrent dispatches from auto-render-on-build don't OOM Railway).
  res.status(202).json({ variationId, accepted: true, mode: 'async' });
  renderVariationQueued({ clips, clientId, variationId, width, height })
    .then(({ renderedUrl, duration }) =>
      postCallback(callback, { variationId, clientId, status: 'success', renderedUrl, duration }),
    )
    .catch((err) => {
      console.error(`[assemble-ad-variation] async render failed variationId=${variationId}:`, err?.message ?? err);
      return postCallback(callback, {
        variationId,
        clientId,
        status: 'failed',
        error: (err?.message ?? 'render failed').slice(0, 500),
      });
    });
});
