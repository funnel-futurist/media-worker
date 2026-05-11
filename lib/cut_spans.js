/**
 * lib/cut_spans.js
 *
 * Pure-function helper for normalizing a list of cut spans.
 *
 * Why this exists (2026-05-11):
 *   `lib/ffmpeg_trim_concat.js buildKeepSegments()` merges overlapping cut
 *   spans before passing them to ffmpeg trim — so when slate_intro [0, 5.76]
 *   and silence [0.15, 0.912] both fire, ffmpeg removes a single merged
 *   span [0, 5.76] (5.76s of source audio).
 *
 *   But `lib/subtitle_burn.js remapWordsThroughCuts()` was summing those
 *   same cuts INDIVIDUALLY (5.76 + 0.762 + 1.26 = 7.78s), so every word
 *   after the overlap region got its timestamp shifted left by ~2s more
 *   than the audio actually moved. Subtitles ended up ~2s ahead of the
 *   speaker for the entire clip.
 *
 *   Repro: content_item 5d69189c-be10-43d0-b4ff-0277cb2052e3, jobId
 *   4c95b2a1-17f8-4621-866e-b6e4bda13d4a. See response in
 *   tmp/b-subtitle-debug-response.json.
 *
 * Both call sites now route through `mergeCutSpans` so they agree on
 * exactly how much time each cut removed. The merge logic was previously
 * inlined in `buildKeepSegments` — extracted here to a single source of
 * truth.
 */

/**
 * Sort + merge overlapping/touching cut spans.
 *
 * Two spans are merged when the second starts at or before the first
 * ends (`b.start <= a.end`). Touching spans (e.g. [0, 5] and [5, 10])
 * are also merged — that's the same convention buildKeepSegments uses,
 * and it's what we want for the remap math (a touching cut doesn't
 * add any extra removal beyond the previous one's end).
 *
 * Defensive validation:
 *   - non-array input throws (callers should sanitize upstream, but
 *     this is the canonical place to enforce)
 *   - individual spans must have numeric start + end with end > start
 *
 * @param {Array<{ start: number, end: number }>} cuts
 * @returns {Array<{ start: number, end: number }>}  sorted + merged
 */
export function mergeCutSpans(cuts) {
  if (!Array.isArray(cuts)) {
    throw new Error('mergeCutSpans: cuts must be an array');
  }
  const valid = cuts.filter(
    (c) => c && typeof c.start === 'number' && typeof c.end === 'number' && c.end > c.start,
  );
  const sorted = [...valid].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end);
    } else {
      merged.push({ start: c.start, end: c.end });
    }
  }
  return merged;
}

/**
 * Compute the total seconds removed by a set of cut spans, accounting
 * for overlap. Equivalent to summing the durations of `mergeCutSpans(cuts)`.
 *
 * Used by `remapWordsThroughCuts` and any future caller that needs to
 * know "how much real time disappears from the source if I apply these
 * cuts."
 *
 * @param {Array<{ start: number, end: number }>} cuts
 * @returns {number}  total seconds removed (>= 0)
 */
export function totalRemovedSec(cuts) {
  return mergeCutSpans(cuts).reduce((s, c) => s + (c.end - c.start), 0);
}
