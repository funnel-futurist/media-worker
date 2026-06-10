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

import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { dirname, join } from 'path';
import { mergeCutSpans } from './cut_spans.js';

const execAsync = promisify(exec);

/**
 * PR-Q: max segments per ffmpeg filter_complex pass. Above this, we batch
 * into multiple passes to avoid OOM on Railway. 46-segment HEVC videos
 * were getting killed at the cut step.
 *
 * 2026-06-10: lowered 20 → 10. Long slow-read ads (SupportED "You're Not
 * Alone" BODY 3) with many silence/bad-take cuts were still getting the cut
 * pass killed at ~15-20 segments on hi-res sources — 20 trim chains wasn't as
 * comfortable as hoped for hi-res HEVC. 10 roughly halves the per-pass decode
 * footprint. Combined with the single-pass→batched FALLBACK in runTrimConcat
 * (auto-recovers if a pass still dies), the cut step no longer hard-fails on
 * segment count.
 */
const BATCH_THRESHOLD = 10;

// Smaller batch size used by the single-pass→batched fallback in runTrimConcat
// when even a <=BATCH_THRESHOLD single pass dies (rare hi-res edge). Halving
// again keeps the per-pass memory minimal at the cost of a few more concat
// joins.
const FALLBACK_BATCH_SIZE = 5;

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
  // Defensive validation: any malformed entry → throw with the offending
  // shape. (mergeCutSpans silently filters invalid entries; ffmpeg-bound
  // callers want a hard error so a picker bug doesn't produce a misaligned
  // trim.)
  if (!Array.isArray(cuts)) {
    throw new Error('cuts must be an array');
  }
  for (const c of cuts) {
    if (typeof c?.start !== 'number' || typeof c?.end !== 'number' || c.end <= c.start) {
      throw new Error(`each cut must be { start, end } with end > start (got ${JSON.stringify(c)})`);
    }
  }

  // Shared canonical merge (see lib/cut_spans.js). buildKeepSegments and
  // remapWordsThroughCuts MUST see identical merged spans, otherwise
  // subtitles drift relative to the trimmed audio. Bug fixed 2026-05-11.
  const merged = mergeCutSpans(cuts);

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

  // PR-Q: batch when segment count exceeds BATCH_THRESHOLD to prevent OOM.
  // Single-pass for small segment counts (most reels), multi-pass for long
  // videos with many cuts (46-segment HEVC was getting killed on Railway).
  // 2026-06-10: single-pass→batched FALLBACK. If a single pass still dies
  // (e.g. hi-res HEVC OOM/kill under the threshold), retry with small batches
  // instead of hard-failing the whole job at the cut step. This is what was
  // killing the SupportED "You're Not Alone" BODY 3 ads (long slow reads, many
  // silence cuts).
  if (keepSegments.length <= BATCH_THRESHOLD) {
    try {
      await _singlePassTrimConcat(inputPath, outputPath, keepSegments, applyLoudnorm, encoderArgs, timeoutMs);
    } catch (err) {
      console.warn(
        `[ffmpeg_trim_concat] single-pass cut failed for ${keepSegments.length} segment(s) ` +
        `(${(err?.message ?? String(err)).slice(0, 160)}); retrying with ${FALLBACK_BATCH_SIZE}-segment batches`,
      );
      await _batchedTrimConcat(inputPath, outputPath, keepSegments, applyLoudnorm, encoderArgs, timeoutMs, FALLBACK_BATCH_SIZE);
    }
  } else {
    console.log(`[ffmpeg_trim_concat] ${keepSegments.length} segments > ${BATCH_THRESHOLD} threshold — using batched approach`);
    await _batchedTrimConcat(inputPath, outputPath, keepSegments, applyLoudnorm, encoderArgs, timeoutMs);
  }

  if (!existsSync(outputPath)) {
    throw new Error('ffmpeg produced no output');
  }
}

/**
 * Original single-pass approach — one filter_complex with all segments.
 * Used when segment count <= BATCH_THRESHOLD.
 */
async function _singlePassTrimConcat(inputPath, outputPath, keepSegments, applyLoudnorm, encoderArgs, timeoutMs) {
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

  const cmd =
    `ffmpeg -y -i "${inputPath}" ` +
    `-filter_complex "${filterComplex}" ` +
    `-map "[outv]" -map "[outa]" ` +
    encoderArgs.join(' ') + ' ' +
    `"${outputPath}"`;

  await execAsync(cmd, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 });
}

/**
 * PR-Q: batched approach for high segment counts. Splits segments into
 * chunks of BATCH_THRESHOLD, processes each chunk with its own
 * filter_complex, then joins with concat demuxer + optional loudnorm.
 *
 * Memory profile: each batch decodes ~20 segments (not 46+), concat
 * demuxer is sequential (near-zero memory overhead), loudnorm is a
 * single-stream pass.
 */
async function _batchedTrimConcat(inputPath, outputPath, keepSegments, applyLoudnorm, encoderArgs, timeoutMs, batchSize = BATCH_THRESHOLD) {
  const outDir = dirname(outputPath);
  const batchDir = join(outDir, '_trim_batches');
  mkdirSync(batchDir, { recursive: true });

  // Split segments into batches.
  const batches = [];
  for (let i = 0; i < keepSegments.length; i += batchSize) {
    batches.push(keepSegments.slice(i, i + batchSize));
  }
  console.log(`[ffmpeg_trim_concat] splitting ${keepSegments.length} segments into ${batches.length} batches`);

  // Pass 1: process each batch into a temp file (no loudnorm yet).
  const batchFiles = [];
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const batchPath = join(batchDir, `batch_${b}.mp4`);
    batchFiles.push(batchPath);
    console.log(`[ffmpeg_trim_concat] batch ${b + 1}/${batches.length}: ${batch.length} segments`);
    await _singlePassTrimConcat(inputPath, batchPath, batch, false, encoderArgs, timeoutMs);
  }

  // Pass 2: concat all batch files + optional loudnorm in one step.
  // Re-encode audio (not -c copy) to force A/V realignment — concat
  // demuxer with -c copy accumulates per-batch frame/sample boundary
  // drift (0.252s over 188s on the first test). Audio re-encode is
  // cheap and guarantees sync. Video stays -c:v copy (no quality loss).
  const concatListPath = join(batchDir, 'concat_list.txt');
  const concatListContent = batchFiles.map((f) => `file '${f}'`).join('\n');
  writeFileSync(concatListPath, concatListContent, 'utf8');

  const audioFilter = applyLoudnorm
    ? '-af "loudnorm=I=-16:TP=-1.5:LRA=11"'
    : '';
  const concatCmd =
    `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" ` +
    `-c:v copy ${audioFilter} -c:a aac -b:a 192k ` +
    `"${outputPath}"`;
  await execAsync(concatCmd, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 });
}
