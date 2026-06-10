/**
 * lib/face_detect.js
 *
 * Node-side wrapper that spawns python/face_detect_offset.py to estimate the
 * speaker's median face-center X position as a fraction of source width.
 * The orchestrator passes the result into composeFaceAndBrolls so the
 * production fill-crop reframe centers on the speaker instead of using a
 * naive midpoint that pushed Phil's face to the right edge on B10.
 *
 * The Python script is responsible for:
 *   - Sampling N frames from the cut.mp4
 *   - Running OpenCV Haar cascade face detection
 *   - Picking the largest face per frame (avoids background TV faces)
 *   - Returning the median x-fraction (or 0.5 if no faces found)
 *
 * This wrapper:
 *   - Spawns python3 with the script path
 *   - Pipes stderr to console for operator audit
 *   - Parses stdout as a single float in [0.0, 1.0]
 *   - Falls back to 0.5 (center) on ANY failure mode (spawn error, parse
 *     error, out-of-range value, non-zero exit). This is intentional —
 *     a broken face detector should NEVER prevent the pipeline from
 *     producing a video; the worst case is we ship a center-cropped
 *     output (the pre-PR-#114 behavior).
 *
 * Tests (test/face_detect.test.js) inject a mock spawn function via
 * `opts.spawnImpl` so the suite stays fast + offline + cross-platform.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, '..', 'python', 'face_detect_offset.py');

const FALLBACK_OFFSET = 0.5;
const DEFAULT_SAMPLES = 8;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Vertical headroom bias for the face crop, as a fraction of the output height.
 * The crop window is shifted UP by this much so a talking head's hair / top of
 * head isn't clipped when a tall 9:16 source is cropped to a shorter 4:5 ad.
 * Pure centering (0) clipped the top — partly because face_detect reads the
 * face-center slightly LOW on bearded / glasses faces, pushing the window to
 * the bottom. 0.10 ≈ 135px of extra headroom on a 1350-tall ad. TUNABLE —
 * first pass (2026-06-10, SupportED "You're Not Alone" clip); eyeball a
 * re-render and dial in. No-op for same-aspect reframes (no vertical room).
 */
const HEADROOM_FRACTION = 0.10;

/**
 * Run face detection on a video file and return the median face-center X
 * as a fraction of the source frame width. Always resolves — never throws.
 *
 * @param {string} videoPath  absolute path to the video file
 * @param {Object} [opts]
 * @param {number} [opts.samples=8]                   frame samples to take
 * @param {number} [opts.timeoutMs=30000]             kill the spawn after this many ms
 * @param {(...args: any[]) => any} [opts.spawnImpl]  inject for tests
 * @returns {Promise<{ offsetX: number, offsetY: number, source: 'detected'|'fallback', detail: string }>}
 *   `offsetX`/`offsetY` are always in [0.0, 1.0] (median face-center X/Y as a
 *   fraction of source width/height; 0.5 = center fallback). `source` indicates
 *   whether the values came from real face detection or the fallback. `detail`
 *   is a short operator-facing string for the response log.
 */
export async function detectFaceOffsetX(videoPath, opts = {}) {
  const samples = opts.samples ?? DEFAULT_SAMPLES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnImpl = opts.spawnImpl ?? spawn;

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawnImpl('python3', [SCRIPT_PATH, videoPath, '--samples', String(samples)]);
    } catch (err) {
      resolve({
        offsetX: FALLBACK_OFFSET,
        offsetY: FALLBACK_OFFSET,
        source: 'fallback',
        detail: `spawn error: ${err.message}`,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) { /* noop */ }
      finish({
        offsetX: FALLBACK_OFFSET,
        offsetY: FALLBACK_OFFSET,
        source: 'fallback',
        detail: `timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      clearTimeout(timer);
      finish({
        offsetX: FALLBACK_OFFSET,
        offsetY: FALLBACK_OFFSET,
        source: 'fallback',
        detail: `process error: ${err.message}`,
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (stderr.trim()) {
        // Surface the python script's diagnostic line so Railway logs show
        // "no faces found" / sample counts / etc. without a separate trip.
        console.log(`[face_detect] ${stderr.trim()}`);
      }
      const trimmed = stdout.trim();
      // Script now emits two space-separated floats: "<x> <y>". parseFloat on
      // the first token gives x; split for y. Older single-value output still
      // parses x fine and y falls back to center below.
      const partsXY = trimmed.split(/\s+/);
      const value = parseFloat(partsXY[0]);
      const rawY = parseFloat(partsXY[1]);
      if (!Number.isFinite(value)) {
        finish({
          offsetX: FALLBACK_OFFSET,
          offsetY: FALLBACK_OFFSET,
          source: 'fallback',
          detail: `non-numeric stdout="${trimmed}" (exit ${code})`,
        });
        return;
      }
      if (value < 0 || value > 1) {
        finish({
          offsetX: FALLBACK_OFFSET,
          offsetY: FALLBACK_OFFSET,
          source: 'fallback',
          detail: `out-of-range value=${value} (exit ${code})`,
        });
        return;
      }
      // Vertical face-center Y. Best-effort + independent: if it's missing or
      // out of range, fall back to 0.5 (center) for the y-axis only, so a
      // valid x is never discarded over a bad y.
      const offsetY = (Number.isFinite(rawY) && rawY >= 0 && rawY <= 1) ? rawY : FALLBACK_OFFSET;
      // 0.5 from the script means "no faces / fallback". We pass that through
      // as fallback so the orchestrator can report it transparently.
      const isExactCenter = Math.abs(value - 0.5) < 1e-6;
      finish({
        offsetX: value,
        offsetY,
        source: isExactCenter ? 'fallback' : 'detected',
        detail: isExactCenter
          ? 'no faces detected — using center crop'
          : `median face center x=${value.toFixed(4)} y=${offsetY.toFixed(4)}`,
      });
    });
  });
}

/**
 * Build the ffmpeg `crop=W:H:x:y` x-expression that centers a `cropWidth`-wide
 * crop on the detected face. Uses ffmpeg expression syntax so `iw` (the
 * post-scale input width) is computed at filter-graph time — we don't need
 * to predict the scaled dimensions in JS.
 *
 * Math (source → scale=cropWidth:cropHeight:increase → effective WxH):
 *   - face_x_in_scaled = offsetX * iw
 *   - We want face at output center → crop_x + cropWidth/2 = face_x_in_scaled
 *   - crop_x = offsetX * iw - cropWidth/2
 *   - Clamp to [0, iw - cropWidth] so we never crop outside the scaled frame
 *
 * cropWidth is parameterized so 9:16 reels (1080) and 4:5 ads (also 1080)
 * share the same code path; future non-1080 widths (e.g. 720 for previews)
 * work without changes. cropHeight is irrelevant for the x-expression.
 *
 * Inside the ffmpeg filter graph, commas are filter-arg separators, so we
 * escape commas inside the function call with a backslash.
 *
 * @param {number} offsetX  fraction in [0, 1]
 * @param {number} [cropWidth=1080]  target crop width in pixels
 * @returns {string}  ffmpeg expression suitable for `crop=<cropWidth>:H:<expr>:0`
 */
export function buildCropXExpression(offsetX, cropWidth = 1080) {
  // Defensive — caller should already have clamped, but make the helper
  // robust against accidental misuse.
  const safe = Math.max(0, Math.min(1, offsetX));
  // Use a fixed-precision decimal to keep the filter string deterministic.
  const f = safe.toFixed(4);
  const half = Math.round(cropWidth / 2);
  return `max(0\\,min(iw-${cropWidth}\\,${f}*iw-${half}))`;
}

/**
 * Build the ffmpeg `crop=W:H:x:y` y-expression that centers a `cropHeight`-tall
 * crop on the detected face's vertical position. Mirrors buildCropXExpression
 * but on the Y axis using `ih` (post-scale input height).
 *
 * Math (source → scale=cropWidth:cropHeight:increase → effective WxH):
 *   - face_y_in_scaled = offsetY * ih
 *   - We want the face a touch BELOW center so the head keeps HEADROOM →
 *     crop_y = offsetY * ih - (0.5 + HEADROOM_FRACTION) * cropHeight
 *     (shifting the window UP by HEADROOM_FRACTION keeps the hair in frame
 *     instead of clipping it — see the constant for why centering wasn't enough)
 *   - Clamp to [0, ih - cropHeight] so we never crop outside the scaled frame
 *
 * For same-aspect reframes (e.g. 9:16 source → 9:16 output) ih === cropHeight,
 * so the clamp pins crop_y to 0 and this is a no-op — only taller-than-output
 * sources (e.g. a 9:16 selfie → 4:5 ad) actually shift vertically. offsetY=0.5
 * (the fallback) yields a headroom-biased crop, strictly better than both the
 * old hardcoded top crop (clipped low faces) and pure centering (clipped hair).
 *
 * @param {number} offsetY  fraction in [0, 1]
 * @param {number} [cropHeight=1920]  target crop height in pixels
 * @returns {string}  ffmpeg expression suitable for `crop=W:<cropHeight>:X:<expr>`
 */
export function buildCropYExpression(offsetY, cropHeight = 1920) {
  const safe = Math.max(0, Math.min(1, offsetY));
  const f = safe.toFixed(4);
  // Shift the window UP by HEADROOM_FRACTION (face sits a touch below center)
  // so the top of the head/hair stays in frame instead of being clipped.
  const offset = Math.round(cropHeight * (0.5 + HEADROOM_FRACTION));
  return `max(0\\,min(ih-${cropHeight}\\,${f}*ih-${offset}))`;
}
