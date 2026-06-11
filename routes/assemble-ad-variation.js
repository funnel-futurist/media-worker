import { Router } from 'express';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getDuration } from '../lib/media.js';
// Ad-format stages reused from the clean-mode ad pipeline so the assembled
// variation looks like a real ad (face-aware 1080x1350 crop, gold ad captions,
// SupportED-style banner).
import { detectFaceOffsetX } from '../lib/face_detect.js';
import { composeFaceAndBrolls } from '../lib/clean_mode_pipeline.js';
import { overlayBanner } from '../lib/banner_overlay.js';
import { callDeepgramWithRetry, mapDeepgramResponse } from '../lib/deepgram_transcribe.js';
import { groupIntoLines, writeAssAndBurn } from '../lib/subtitle_burn.js';
import { qcAdVariation } from '../lib/ad_variation_qc.js';

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

/** Probe a clip's pixel width/height (null on failure). */
async function probeDims(path) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "${path}"`,
      { timeout: 30000, maxBuffer: EXEC_MAXBUFFER },
    );
    const [w, h] = stdout.trim().split('x').map((n) => parseInt(n, 10));
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : null;
  } catch {
    return null;
  }
}

/**
 * Normalise one clip to the canonical WxH (portrait) so concat -c copy is safe:
 * 1 video (H.264, yuv420p, WxH, 30fps, fixed timescale) + 1 stereo 48k AAC
 * (silent track injected when the source has none).
 *
 * Aspect handling:
 *   - Source WIDER than the portrait target (16:9, 1:1, 4:5 — would letterbox):
 *     scale-to-COVER + centre-crop → FILLS the frame, no black bars. Keeps full
 *     height (no head clipping); crops background left/right. A centred
 *     talking-head survives; an off-centre one is caught later by QC (wrong_crop).
 *   - Source 9:16 or taller: fit + pad (unchanged) — never crops a portrait take.
 */
async function normaliseClip(srcPath, outPath, w, h) {
  const dims = await probeDims(srcPath);
  // Wider than the portrait canonical → fit would add bars, so cover instead.
  const wider = dims ? dims.w / dims.h > w / h : false;
  const geom = wider
    ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}` // cover (fill)
    : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`; // fit (pad)
  const vf = `${geom},setsar=1,fps=30,format=yuv420p`;
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

// Pre-concat canonical: a vertical 1080x1920 frame so heterogeneous clips
// concat cleanly, then the face-aware reframe crops down to the ad's 1080x1350
// (cropping top/bottom, NOT adding bars). Mirrors the clean-mode ad path which
// face-crops a portrait talking-head into 1080x1350.
const NORM_W = 1080;
const NORM_H = 1920;

/**
 * Fallback reframe when face detect / composeFaceAndBrolls fails: scale-to-fit
 * + pad to the output dims (the old v1 behaviour). Keeps output dims correct so
 * downstream banner/subtitles still land right; just may have bars.
 */
async function padReframe(srcPath, outPath, w, h) {
  await runFfmpeg(
    `ffmpeg -i "${srcPath}" -vf "scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p" ` +
      `-c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 -movflags +faststart -y "${outPath}"`,
  );
}

/**
 * Core work: download → normalise → concat → face-aware reframe (1080x1350,
 * no bars) → banner (optional) → burned ad captions → upload.
 * Returns { renderedUrl, duration, warnings }. Each ad-format stage degrades
 * gracefully (logs a warning, keeps the best video so far) so a styling hiccup
 * never turns a stitchable variation into a hard failure.
 */
async function renderVariation({ clips, clientId, variationId, width, height, banner }) {
  const tmpDir = join('/tmp', `adv-${randomUUID()}`);
  const warnings = [];
  try {
    mkdirSync(tmpDir, { recursive: true });

    // 1. Download + validate + normalise each clip to the vertical canonical.
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
      await normaliseClip(rawPath, normPath, NORM_W, NORM_H);
      rmSync(rawPath, { force: true });
      normPaths.push(normPath);
    }

    // 2. Concat the normalised clips (all identical params → stream copy).
    const listPath = join(tmpDir, 'filelist.txt');
    writeFileSync(listPath, normPaths.map((p) => `file '${p}'`).join('\n'));
    const stitchedPath = join(tmpDir, 'stitched.mp4');
    await runFfmpeg(`ffmpeg -f concat -safe 0 -i "${listPath}" -c copy -movflags +faststart -y "${stitchedPath}"`);
    if (!existsSync(stitchedPath)) throw new Error('concat produced no output file');

    // 3. Face-aware reframe to the ad frame (1080x1350) — fill, no bars.
    let formattedPath = stitchedPath;
    const reframedPath = join(tmpDir, 'reframed.mp4');
    try {
      const face = await detectFaceOffsetX(stitchedPath, { samples: 4 });
      await composeFaceAndBrolls({
        facePath: stitchedPath,
        brolledPath: reframedPath,
        insertions: [],
        totalDuration: await getDuration(stitchedPath),
        faceCropOffsetX: face.offsetX,
        faceCropOffsetY: face.offsetY,
        outputWidth: width,
        outputHeight: height,
      });
      if (existsSync(reframedPath)) formattedPath = reframedPath;
      else throw new Error('reframe produced no output');
    } catch (err) {
      warnings.push(`reframe_failed: ${(err?.message ?? err).toString().slice(0, 200)}`);
      // Keep correct output dims via the pad fallback (bars, but right size).
      const padPath = join(tmpDir, 'padded.mp4');
      try {
        await padReframe(stitchedPath, padPath, width, height);
        if (existsSync(padPath)) formattedPath = padPath;
      } catch (e2) {
        warnings.push(`pad_fallback_failed: ${(e2?.message ?? e2).toString().slice(0, 120)}`);
      }
    }

    // 4. Banner (optional) — AFTER reframe, BEFORE subtitles (banner_overlay.js
    //    contract). Only when a headline is supplied.
    let bannerApplied = false;
    if (banner && typeof banner.headline === 'string' && banner.headline.trim()) {
      const banneredPath = join(tmpDir, 'bannered.mp4');
      try {
        await overlayBanner({
          inputPath: formattedPath,
          outputPath: banneredPath,
          bannerConfig: {
            text: banner.headline.trim(),
            ...(banner.eyebrow ? { eyebrow: String(banner.eyebrow).trim() } : {}),
            ...(banner.subtext ? { subtext: String(banner.subtext).trim() } : {}),
            ...(typeof banner.height === 'number' ? { height: banner.height } : {}),
          },
        });
        if (existsSync(banneredPath)) {
          formattedPath = banneredPath;
          bannerApplied = true;
        }
      } catch (err) {
        warnings.push(`banner_failed: ${(err?.message ?? err).toString().slice(0, 200)}`);
      }
    }

    // 5. Burned ad captions — transcribe the (reframed) video, group, burn.
    //    Degrades to no-captions on any failure / missing key.
    const dgKey = process.env.DEEPGRAM_API_KEY?.trim();
    if (dgKey) {
      try {
        const dgRaw = await callDeepgramWithRetry(dgKey, formattedPath, {});
        const { word_timestamps } = mapDeepgramResponse(dgRaw);
        if (word_timestamps.length > 0) {
          const lines = groupIntoLines(word_timestamps);
          const subPath = join(tmpDir, 'final.mp4');
          await writeAssAndBurn({
            lines,
            assPath: join(tmpDir, 'subs.ass'),
            inputPath: formattedPath,
            outputPath: subPath,
            assOpts: {
              playResX: width,
              playResY: height,
              captionStyle: 'ad', // gold fill + black outline
              marginV: 80, // lower-third (banner reserves the top)
            },
          });
          if (existsSync(subPath)) formattedPath = subPath;
        } else {
          warnings.push('subtitles_skipped: no words transcribed');
        }
      } catch (err) {
        warnings.push(`subtitles_failed: ${(err?.message ?? err).toString().slice(0, 200)}`);
      }
    } else {
      warnings.push('subtitles_skipped: DEEPGRAM_API_KEY not set');
    }

    console.log(
      `[assemble-ad-variation] variationId=${variationId} reframed=${formattedPath !== stitchedPath} ` +
        `banner=${bannerApplied} warnings=${warnings.length ? warnings.join(' ; ') : 'none'}`,
    );

    const duration = await getDuration(formattedPath);

    // Gemini QC (advisory) on the finished ad — run on the local file before
    // upload/cleanup. Non-fatal: null on any failure, render still ships.
    let qc = null;
    try {
      qc = await qcAdVariation(formattedPath);
    } catch (err) {
      warnings.push(`qc_failed: ${(err?.message ?? err).toString().slice(0, 160)}`);
    }

    // Fold DETERMINISTIC render defects (we know these for certain from the
    // pipeline) into the QC issue list — more reliable than asking Gemini.
    // Any such defect also forces the variation out of "green" so it stays in
    // Deliverables with the reason rather than auto-promoting to Review.
    const detIssues = [];
    if (warnings.some((w) => w.startsWith('reframe_failed'))) detIssues.push('black_bars');
    if (warnings.some((w) => w.startsWith('banner_failed'))) detIssues.push('banner_missing');
    if (warnings.some((w) => w.startsWith('subtitles_failed') || w.startsWith('subtitles_skipped'))) detIssues.push('missing_subtitles');
    if (warnings.some((w) => w.startsWith('pad_fallback_failed') || w.startsWith('qc_failed'))) detIssues.push('render_issue');
    if (detIssues.length > 0) {
      if (!qc) qc = { verdict: 'red', quality: 50, energy: null, issues: [], why: 'Automatic checks found a defect.', action: 'redo' };
      qc.issues = [...new Set([...(qc.issues ?? []), ...detIssues])];
      if (qc.verdict === 'green') qc.verdict = 'yellow';
    }
    if (qc) {
      console.log(`[assemble-ad-variation] variationId=${variationId} qc=${qc.verdict} quality=${qc.quality} issues=[${(qc.issues ?? []).join(',')}]`);
    }

    const renderedUrl = await uploadAndSign(formattedPath, clientId, variationId);
    return { renderedUrl, duration, warnings, qc };
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
  const { variationId, clientId, clips = [], output = {}, callback, banner = null } = body;
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
      const { renderedUrl, duration, warnings, qc } = await renderVariationQueued({ clips, clientId, variationId, width, height, banner });
      return res.json({ variationId, renderedUrl, duration, clipCount: clips.length, warnings, qc });
    } catch (err) {
      console.error(`[assemble-ad-variation] sync render failed variationId=${variationId}:`, err?.message ?? err);
      return res.status(500).json({ variationId, error: err?.message ?? 'render failed' });
    }
  }

  // Async mode — accept, then render + callback in the background (queued so
  // many concurrent dispatches from auto-render-on-build don't OOM Railway).
  res.status(202).json({ variationId, accepted: true, mode: 'async' });
  renderVariationQueued({ clips, clientId, variationId, width, height, banner })
    .then(({ renderedUrl, duration, qc }) =>
      postCallback(callback, { variationId, clientId, status: 'success', renderedUrl, duration, qc }),
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
