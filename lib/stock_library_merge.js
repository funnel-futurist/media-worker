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
