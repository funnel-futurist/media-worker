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
 * Run face detection on a video file and return the median face-center X
 * as a fraction of the source frame width. Always resolves — never throws.
 *
 * @param {string} videoPath  absolute path to the video file
 * @param {Object} [opts]
 * @param {number} [opts.samples=8]                   frame samples to take
 * @param {number} [opts.timeoutMs=30000]             kill the spawn after this many ms
 * @param {(...args: any[]) => any} [opts.spawnImpl]  inject for tests
 * @returns {Promise<{ offsetX: number, source: 'detected'|'fallback', detail: string }>}
 *   `offsetX` is always in [0.0, 1.0]. `source` indicates whether the value
 *   came from a real face detection or the fallback. `detail` is a short
 *   operator-facing string for the response log.
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
      const value = parseFloat(trimmed);
      if (!Number.isFinite(value)) {
        finish({
          offsetX: FALLBACK_OFFSET,
          source: 'fallback',
          detail: `non-numeric stdout="${trimmed}" (exit ${code})`,
        });
        return;
      }
      if (value < 0 || value > 1) {
        finish({
          offsetX: FALLBACK_OFFSET,
          source: 'fallback',
          detail: `out-of-range value=${value} (exit ${code})`,
        });
        return;
      }
      // 0.5 from the script means "no faces / fallback". We pass that through
      // as fallback so the orchestrator can report it transparently.
      const isExactCenter = Math.abs(value - 0.5) < 1e-6;
      finish({
        offsetX: value,
        source: isExactCenter ? 'fallback' : 'detected',
        detail: isExactCenter
          ? 'no faces detected — using center crop'
          : `median face center x=${value.toFixed(4)}`,
      });
    });
  });
}

/**
 * Build the ffmpeg `crop=W:H:x:y` x-expression that centers a 1080-wide crop
 * on the detected face. Uses ffmpeg expression syntax so `iw` (the post-scale
 * input width) is computed at filter-graph time — we don't need to predict
 * the scaled dimensions in JS.
 *
 * Math (1920×1080 source → scale=1080:1920:increase → 3413×1920 effective):
 *   - face_x_in_scaled = offsetX * iw
 *   - We want face at output center → crop_x + 540 = face_x_in_scaled
 *   - crop_x = offsetX * iw - 540
 *   - Clamp to [0, iw - 1080] so we never crop outside the scaled frame
 *
 * Inside the ffmpeg filter graph, commas are filter-arg separators, so we
 * escape commas inside the function call with a backslash.
 *
 * @param {number} offsetX  fraction in [0, 1]
 * @returns {string}  ffmpeg expression suitable for `crop=1080:1920:<expr>:0`
 */
export function buildCropXExpression(offsetX) {
  // Defensive — caller should already have clamped, but make the helper
  // robust against accidental misuse.
  const safe = Math.max(0, Math.min(1, offsetX));
  // Use a fixed-precision decimal to keep the filter string deterministic.
  const f = safe.toFixed(4);
  return `max(0\\,min(iw-1080\\,${f}*iw-540))`;
}
