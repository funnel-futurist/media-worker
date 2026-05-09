/**
 * lib/broll_filter.js
 *
 * Pure-function classification helpers for `marketing.broll_library` rows.
 * Extracted from `fetchBrollLibrary` in lib/clean_mode_pipeline.js so the
 * URL-class logic is unit-testable without mocking Supabase REST.
 *
 * History:
 *   PR #110 (2026-05-08): introduced this filter to HARD-DROP HEIC/HEIF rows
 *     because the worker had no way to convert them. Phil's library was
 *     6 .mov + 7 .heic; without the filter, Gemini picked an HEIC ~50% of
 *     the time and brollDownload crashed at ffprobe.
 *
 *   PR-E (2026-05-09): flipped to TAG instead of drop. We now do real
 *     HEIC→JPG conversion at brollDownload via `lib/heic_to_jpg.js`
 *     (heic-convert npm package, pure-JS / WASM, no native deps). Rows
 *     whose URL ends in `.heic`/`.heif` pass through with
 *     `needsHeicConversion: true` so the picker sees them in the library
 *     and the download step routes them through conversion.
 *
 *     Backward-compat: the return shape preserves `droppedHeicCount` (now
 *     always 0 — pre-conversion drops no longer happen here). The
 *     orchestrator-level "actually skipped" count comes from
 *     `steps.heicConvert.failed` after download + conversion attempts.
 */

const HEIC_OR_HEIF_RE = /\.(heic|heif)(\?|$)/i;

/**
 * Classify broll-library rows for downstream processing.
 *
 * Rules:
 *   - HEIC/HEIF rows are tagged `needsHeicConversion: true` and PASSED THROUGH
 *     so the picker can choose them and `downloadBrollAssets` can convert.
 *   - All other rows pass through unchanged.
 *
 * Looks at `file_url` first, then `storage_url` (matches the `file_url ??
 * storage_url` resolve order downstream in `downloadBrollAssets`).
 *
 * @param {Array<{file_url?: string|null, storage_url?: string|null, [k: string]: any}>} rows
 *   raw rows as returned from the marketing.broll_library REST query
 * @returns {{
 *   rows: Array<typeof rows[number] & { needsHeicConversion?: boolean }>,
 *   warnings: string[],
 *   droppedHeicCount: number,        // PR-E: kept for backward compat; always 0 now.
 *   convertibleHeicCount: number,    // PR-E: count of rows tagged for conversion.
 * }}
 */
export function filterUnsupportedBrollAssets(rows) {
  if (!Array.isArray(rows)) {
    return { rows: [], warnings: [], droppedHeicCount: 0, convertibleHeicCount: 0 };
  }

  const out = [];
  let convertibleHeicCount = 0;

  for (const row of rows) {
    if (!row) continue;
    const url = (row.file_url || row.storage_url) || '';
    if (HEIC_OR_HEIF_RE.test(url)) {
      out.push({ ...row, needsHeicConversion: true });
      convertibleHeicCount += 1;
      continue;
    }
    out.push(row);
  }

  return {
    rows: out,
    warnings: [],                 // PR-E: no longer skipped → no warning here
    droppedHeicCount: 0,          // PR-E: kept for backward compat
    convertibleHeicCount,
  };
}
