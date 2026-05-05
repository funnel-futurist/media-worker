/**
 * lib/ffmpeg_trim_concat.js
 *
 * Shared helpers for ffmpeg trim+concat — extracted so routes/audio-loudnorm-trim.js
 * (Hyperframes path: trim + concat + EBU R128 loudnorm) and the M2 clean-mode
 * pipeline (cut step: trim + concat only) can both reuse the same primitives.
 *
 * Two exports:
 *   1. buildKeepSegments(cuts, sourceDuration) — pure function, returns the
 *      inverse of the cuts list (the windows we KEEP).
 *   2. runTrimConcat(inputPath, outputPath, opts) — runs ffmpeg with a
 *      filter_complex that trims each keep-segment and concats them. Optional
 *      loudnorm tail and configurable encoder args.
 */

import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Build the keep-segments list (the inverse of cuts) for a given source.
 *
 * Steps:
 *   1. Sort cuts by start.
 *   2. Merge overlapping / adjacent cuts so no two cuts overlap.
 *   3. Walk a cursor from 0 to sourceDuration emitting keep-segments in the
 *      gaps between merged cuts.
 *
 * Throws if cuts cover the entire source — no segments to keep means there
 * is nothing to encode, which is always a caller bug.
 *
 * @param {Array<{ start: number, end: number }>} cuts
 * @param {number} sourceDuration
 * @returns {Array<{ start: number, end: number }>}
 */
export function buildKeepSegments(cuts, sourceDuration) {
  if (typeof sourceDuration !== 'number' || sourceDuration <= 0) {
    throw new Error('sourceDuration must be a positive number');
  }
  if (!Array.isArray(cuts)) {
    throw new Error('cuts must be an array');
  }

  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const c of sorted) {
    if (typeof c?.start !== 'number' || typeof c?.end !== 'number' || c.end <= c.start) {
      throw new Error(`each cut must be { start, end } with end > start (got ${JSON.stringify(c)})`);
    }
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end);
    } else {
      merged.push({ start: c.start, end: c.end });
    }
  }

  const keep = [];
  let cursor = 0;
  for (const c of merged) {
    if (c.start > cursor) keep.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < sourceDuration) keep.push({ start: cursor, end: sourceDuration });

  if (keep.length === 0) {
    throw new Error('cuts cover the entire source — nothing to keep');
  }
  return keep;
}

/**
 * Run ffmpeg trim+concat on the input MP4 → outputPath.
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {Object} opts
 * @param {Array<{ start: number, end: number }>} opts.keepSegments
 *        Required. Use buildKeepSegments() to derive.
 * @param {boolean} [opts.applyLoudnorm=false]
 *        When true, appends `loudnorm=I=-16:TP=-1.5:LRA=11` to the audio
 *        chain after concat (matches the Hyperframes/audio-loudnorm-trim
 *        path). Default false (M2 cut step doesn't loudnorm — the source
 *        is already at speaking level).
 * @param {string[]} [opts.encoderArgs]
 *        ffmpeg encoder args between filter and output. Default
 *        ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
 *         '-c:a', 'aac', '-b:a', '192k'] (matches the clean-mode CLI script).
 * @param {number} [opts.timeoutMs=600_000]
 * @returns {Promise<void>}
 */
export async function runTrimConcat(inputPath, outputPath, opts = {}) {
  const { keepSegments } = opts;
  if (!Array.isArray(keepSegments) || keepSegments.length === 0) {
    throw new Error('keepSegments is required and must have at least 1 segment');
  }
  const applyLoudnorm = opts.applyLoudnorm === true;
  const encoderArgs = Array.isArray(opts.encoderArgs) && opts.encoderArgs.length > 0
    ? opts.encoderArgs
    : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '192k'];
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 600_000;

  // Build filter_complex: per-segment video + audio trims, then concat with
  // separate video/audio output streams. The audio-loudnorm-trim variant
  // appends a `loudnorm` filter to the audio chain.
  const videoTrims = keepSegments
    .map((k, i) => `[0:v]trim=${k.start.toFixed(3)}:${k.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`)
    .join(';');
  const audioTrims = keepSegments
    .map((k, i) => `[0:a]atrim=${k.start.toFixed(3)}:${k.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`)
    .join(';');
  const concatV = keepSegments.map((_, i) => `[v${i}]`).join('') + `concat=n=${keepSegments.length}:v=1:a=0[outv]`;
  const audioConcatLabel = applyLoudnorm ? '[araw]' : '[outa]';
  const concatA = keepSegments.map((_, i) => `[a${i}]`).join('') + `concat=n=${keepSegments.length}:v=0:a=1${audioConcatLabel}`;
  const filterParts = [videoTrims, audioTrims, concatV, concatA];
  if (applyLoudnorm) {
    filterParts.push(`[araw]loudnorm=I=-16:TP=-1.5:LRA=11[outa]`);
  }
  const filterComplex = filterParts.join(';');

  // Use `exec` with a single command string so the Windows-vs-Linux quoting is
  // consistent with the existing routes. Filter complex is quoted; encoder
  // args are joined unquoted (they don't contain shell metacharacters).
  const cmd =
    `ffmpeg -y -i "${inputPath}" ` +
    `-filter_complex "${filterComplex}" ` +
    `-map "[outv]" -map "[outa]" ` +
    encoderArgs.join(' ') + ' ' +
    `"${outputPath}"`;

  await execAsync(cmd, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 });

  if (!existsSync(outputPath)) {
    throw new Error('ffmpeg produced no output');
  }
}
