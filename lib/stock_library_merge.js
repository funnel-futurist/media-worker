/**
 * lib/stock_library_merge.js
 *
 * Pure helpers that bridge Pixabay video search results into the
 * `marketing.broll_library` row shape that `lib/broll_picker.js` and
 * `lib/clean_mode_pipeline.js downloadBrollAssets` already understand.
 *
 * Two functions:
 *
 *   1. shouldFetchStock({clientLibrarySize, durationSec})
 *      Coverage heuristic. Trigger Pixabay only when the client library is
 *      thin relative to the cut.mp4 duration. Per Shannon's plan-mode
 *      approval, threshold = `clientLibrarySize < ceil(durationSec / 8)`,
 *      which is roughly "fewer than one usable broll per 8 seconds".
 *
 *   2. mergeStockIntoLibrary(clientRows, stockHits)
 *      Concatenates client rows + stock hits into a single array shaped
 *      like the library the broll picker receives. Adapts Pixabay hits
 *      (from `searchPixabayVideos` + `downloadPixabayVideo` + ffprobe) to
 *      the library row schema, with synthetic asset_id (`px-video-<id>`)
 *      and a `provenance: 'pixabay'` tag. Pre-downloaded `localPath` and
 *      pre-probed `sourceDurSec`/`hasVideo`/`hasAudio`/`width`/`height`
 *      are passed through so `downloadBrollAssets` can short-circuit.
 *
 * No network, no I/O — fully unit-testable.
 */

/**
 * Coverage heuristic — should we trigger Pixabay search at all?
 *
 * @param {Object} args
 * @param {number} args.clientLibrarySize  count of usable client rows AFTER
 *   the existing PR #110 HEIC/HEIF + URL-presence filter
 * @param {number} args.durationSec        cut.mp4 duration in seconds
 * @returns {{trigger: boolean, target: number, gap: number, reason: string}}
 *   `target` = ceil(durationSec / 8) = the desired client-row count.
 *   `gap`    = max(0, target - clientLibrarySize)
 *   `reason` is a short operator-facing string for the response log.
 */
export function shouldFetchStock({ clientLibrarySize, durationSec }) {
  if (typeof clientLibrarySize !== 'number' || !Number.isFinite(clientLibrarySize) || clientLibrarySize < 0) {
    return { trigger: false, target: 0, gap: 0, reason: 'invalid_client_size' };
  }
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    return { trigger: false, target: 0, gap: 0, reason: 'invalid_duration' };
  }
  const target = Math.ceil(durationSec / 8);
  const gap = Math.max(0, target - clientLibrarySize);
  if (gap === 0) {
    return { trigger: false, target, gap: 0, reason: 'client_coverage_sufficient' };
  }
  return { trigger: true, target, gap, reason: `client_below_target_${clientLibrarySize}_lt_${target}` };
}

/**
 * Adapt one downloaded+probed Pixabay hit to a broll-library row shape.
 * Synthesises `asset_id` so the picker's selection-by-id flow works.
 *
 * Input shape (output of `downloadPixabayVideo` + ffprobe wrapping):
 *   {
 *     id, pageURL, tags, duration, videoUrl, width, height, sizeBytes, tier, searchKeyword,
 *     localPath, bytes,
 *     sourceDurSec, hasVideo, hasAudio
 *   }
 *
 * Output shape (broll-library row + extras downstream code reads):
 *   {
 *     asset_id: 'px-video-<id>',
 *     asset_title, asset_type: 'video', content_strategy_type: null,
 *     context, emotion, insight, when_to_use,
 *     file_url: <video URL>, storage_url: null, drive_file_id: null,
 *     provenance: 'pixabay',
 *     pixabayVideoId, pixabayPageURL, searchKeyword,
 *     localPath, sourceDurSec, hasVideo, hasAudio, width, height
 *   }
 */
function adaptStockHitToLibraryRow(hit) {
  if (!hit || typeof hit.id !== 'number') return null;
  const tagsStr = typeof hit.tags === 'string' ? hit.tags : '';
  const tagList = tagsStr.split(',').map((t) => t.trim()).filter(Boolean);
  const title = tagList.length > 0
    ? `Pixabay stock: ${tagList.slice(0, 3).join(', ')}`
    : `Pixabay stock asset ${hit.id}`;
  // Synthesise the metadata fields the picker prompt expects. We don't have
  // real client-curated context/emotion/insight/when_to_use for stock —
  // describe the visual content from tags so Gemini can still match by
  // semantic relevance.
  const context = tagsStr || 'stock footage';
  const insight = `Visual depicting: ${tagsStr || 'unknown'}`;
  const whenToUse = `Generic supportive imagery for moments aligned with: ${tagsStr || 'the topic'}`;
  return {
    asset_id: `px-video-${hit.id}`,
    asset_title: title,
    asset_type: 'video',
    content_strategy_type: null,
    context,
    emotion: null,
    insight,
    when_to_use: whenToUse,
    file_url: hit.videoUrl ?? null,
    storage_url: null,
    drive_file_id: null,
    // PR-A additions ↓
    provenance: 'pixabay',
    pixabayVideoId: hit.id,
    pixabayPageURL: hit.pageURL ?? null,
    searchKeyword: hit.searchKeyword ?? null,
    // Pre-downloaded + pre-probed fields so `downloadBrollAssets` can short-circuit.
    localPath: hit.localPath ?? null,
    sourceDurSec: typeof hit.sourceDurSec === 'number' ? hit.sourceDurSec : null,
    hasVideo: hit.hasVideo === true,
    hasAudio: hit.hasAudio === true,
    width: typeof hit.width === 'number' ? hit.width : 0,
    height: typeof hit.height === 'number' ? hit.height : 0,
  };
}

/**
 * Merge client library rows with adapted Pixabay stock hits into a single
 * array the broll picker can iterate. Client rows always come first so that
 * order-sensitive picker behavior (if any) prefers them.
 *
 * @param {Array<object>} clientRows  rows from `fetchBrollLibrary` (already
 *   tagged `provenance: 'client'` by the orchestrator)
 * @param {Array<object>} stockHits   pre-downloaded + pre-probed Pixabay hits
 * @returns {Array<object>}  merged library, client-first, stock-second
 */
export function mergeStockIntoLibrary(clientRows, stockHits) {
  const safeClient = Array.isArray(clientRows) ? clientRows : [];
  const safeStock = Array.isArray(stockHits) ? stockHits : [];
  const adaptedStock = safeStock
    .map((hit) => adaptStockHitToLibraryRow(hit))
    .filter((row) => row !== null);
  return [...safeClient, ...adaptedStock];
}

/**
 * PR-D: client-first source-balance safety net.
 *
 * After Gemini returns insertions, enforce the rule "client b-roll dominates
 * when usable client assets exist". If `usableClientCount > 0` AND the picked
 * stock ratio exceeds `maxStockRatio` (default 0.4 from `BROLL_MAX_STOCK_RATIO`),
 * drop excess stock picks from the tail of the timeline until the ratio is
 * satisfied.
 *
 * Trim-only — never replaces a stock pick with a client pick (that would
 * require a second LLM call). Pre-pick library shaping (`stockSearch` cap =
 * `min(pixabayMaxClips, coverage.gap)`) does the heavy lifting; this is the
 * safety net for the edge case where Gemini still over-picks stock.
 *
 * If `usableClientCount === 0` (Phil's HEIC-only run), client b-roll cannot
 * exist regardless of ratio — short-circuit with `action='skipped_no_client_assets'`
 * so the orchestrator can surface "stock dominated because all client assets
 * were skipped (HEIC)" in the response without trimming the only picks we have.
 *
 * Pure function — no I/O.
 *
 * @param {Object} args
 * @param {Array<{provenance?: string}>} args.insertions  picker output, time-ordered
 * @param {number} args.usableClientCount                 client lib size AFTER HEIC + URL filter
 * @param {number} [args.maxStockRatio=0.4]               trim threshold; values >= this trigger
 * @returns {{insertions: Array, action: string|null, droppedStockCount: number}}
 *   `action`:
 *     - `null` when no trim happened (and usableClient > 0)
 *     - `'skipped_no_client_assets'` when usableClient === 0 (Pixabay free)
 *     - `'trimmed_<N>_stock_pick(s)_to_enforce_max_<R>'` when trim ran
 */
export function rebalanceClientFirst({ insertions, usableClientCount, maxStockRatio = 0.4 }) {
  const safeIns = Array.isArray(insertions) ? insertions : [];
  if (safeIns.length === 0) {
    return { insertions: safeIns, action: null, droppedStockCount: 0 };
  }
  if (typeof usableClientCount !== 'number' || !Number.isFinite(usableClientCount) || usableClientCount <= 0) {
    return { insertions: safeIns, action: 'skipped_no_client_assets', droppedStockCount: 0 };
  }
  const isStock = (i) => i?.provenance === 'pixabay';
  const stockRatio = safeIns.filter(isStock).length / safeIns.length;
  if (stockRatio <= maxStockRatio) {
    return { insertions: safeIns, action: null, droppedStockCount: 0 };
  }

  const kept = [...safeIns];
  let dropped = 0;
  while (kept.length > 0) {
    const stockCount = kept.filter(isStock).length;
    if (stockCount === 0) break;
    if (stockCount / kept.length <= maxStockRatio) break;
    let dropIdx = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (isStock(kept[i])) { dropIdx = i; break; }
    }
    if (dropIdx === -1) break;
    kept.splice(dropIdx, 1);
    dropped += 1;
  }
  return {
    insertions: kept,
    action: `trimmed_${dropped}_stock_pick(s)_to_enforce_max_${maxStockRatio}`,
    droppedStockCount: dropped,
  };
}
