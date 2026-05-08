/**
 * lib/broll_filter.js
 *
 * Pure-function filter helpers for `marketing.broll_library` rows.
 * Extracted from `fetchBrollLibrary` in lib/clean_mode_pipeline.js so the
 * URL-class filtering logic can be unit-tested without mocking Supabase
 * REST or the network layer.
 *
 * Why this exists (PR #110):
 *   - 2026-05-08: B7 (m2-e2e-013-enablesnp) failed at brollDownload because
 *     Gemini's broll picker selected a `.heic` asset from Chelsea & Phil's
 *     migrated library. The worker's static-image broll path runs
 *     `ffprobe` on the downloaded file, but ffprobe doesn't understand
 *     HEIC containers — Phil's library mixes 6 `.mov` videos and 7 `.heic`
 *     iPhone photos, all 13 reachable via Supabase Storage URLs.
 *
 *   - Short-term unblock: drop HEIC/HEIF rows at the library-fetch step so
 *     the picker never sees them. The library effectively becomes the
 *     6 `.mov` files; broll insertion still works.
 *
 *   - Follow-up (separate PR): add libheif/imagemagick to the Dockerfile
 *     and a HEIC→JPG conversion step at brollDownload, then drop this
 *     filter. Tracked as a project follow-up.
 */

/**
 * Detect a HEIC/HEIF asset URL.
 *
 * Matches `.heic` or `.heif` (case-insensitive) immediately before the
 * end of the URL OR before a query string `?...`. Doesn't match if the
 * extension appears mid-path (e.g. `/uploads/heic_demo/foo.mp4` is fine).
 */
const HEIC_OR_HEIF_RE = /\.(heic|heif)(\?|$)/i;

/**
 * Filter broll-library rows down to assets the worker can currently process.
 *
 * Rules:
 *   - HEIC/HEIF assets (URL ends in `.heic`/`.heif`) are dropped — the worker
 *     cannot ffprobe or convert them today (PR #110 short-term scope).
 *   - All other rows pass through unchanged.
 *
 * Looks at `file_url` first, then `storage_url` (matches the `file_url ??
 * storage_url` resolve order downstream in `downloadBrollAssets`).
 *
 * @param {Array<{file_url?: string|null, storage_url?: string|null, [k: string]: any}>} rows
 *   raw rows as returned from the marketing.broll_library REST query
 * @returns {{
 *   rows: Array<typeof rows[number]>,
 *   warnings: string[],
 *   droppedHeicCount: number,
 * }}
 *   `rows` is the kept set in input order. `warnings` is populated only
 *   when at least one HEIC/HEIF row was dropped (operator-facing message
 *   shape matches the rest of the pipeline's warnings[] convention).
 */
export function filterUnsupportedBrollAssets(rows) {
  if (!Array.isArray(rows)) {
    return { rows: [], warnings: [], droppedHeicCount: 0 };
  }

  const supported = [];
  let droppedHeicCount = 0;

  for (const row of rows) {
    const url = (row && (row.file_url || row.storage_url)) || '';
    if (HEIC_OR_HEIF_RE.test(url)) {
      droppedHeicCount += 1;
      continue;
    }
    supported.push(row);
  }

  const warnings = [];
  if (droppedHeicCount > 0) {
    const plural = droppedHeicCount === 1 ? 'asset' : 'assets';
    warnings.push(
      `Skipped ${droppedHeicCount} HEIC/HEIF broll ${plural} because image conversion ` +
        `is not supported yet (only .mov/.mp4/.jpg/.png broll assets are processed). ` +
        `Tracked as a follow-up to add libheif/imagemagick + HEIC→JPG conversion at brollDownload.`,
    );
  }

  return { rows: supported, warnings, droppedHeicCount };
}
