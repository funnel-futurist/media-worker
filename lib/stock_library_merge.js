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
 * Two modes (PR-F):
 *   - 'ai_blend' (DEFAULT): always trigger when args are valid. Fetch a
 *     supplementalCount of stock candidates so the picker can choose a mix
 *     of client + stock based on what fits the script. Even when the client
 *     library is full (gap=0), fetch enough stock to give Gemini a real
 *     choice. supplementalCount = max(1, floor(target * blendRatio)).
 *   - 'gap_only': legacy PR-D semantics — trigger only when the client
 *     library is under-target (gap > 0). Pixabay fills gaps only.
 *
 * `fetchCount` is the number the orchestrator should pass as the per-job
 * candidate cap — it covers BOTH the gap (when thin) and the supplemental
 * blend (when full). For thin libs, gap dominates; for full libs, the
 * supplemental count alone drives.
 *
 * @param {Object} args
 * @param {number} args.clientLibrarySize  count of usable client rows AFTER
 *   the existing PR #110 HEIC/HEIF + URL-presence filter (post-PR-E,
 *   includes converted HEIC photos)
 * @param {number} args.durationSec        cut.mp4 duration in seconds
 * @param {'ai_blend'|'gap_only'} [args.mode='ai_blend']
 * @param {number} [args.blendRatio=0.4]   ai_blend supplemental fraction;
 *   tunable via BROLL_STOCK_BLEND_RATIO env at the orchestrator layer.
 * @returns {{
 *   trigger: boolean,
 *   target: number,
 *   gap: number,
 *   supplementalCount: number,    // ai_blend's calculated supplemental fetch
 *   fetchCount: number,           // candidate cap to pass to stockSearch
 *   mode: 'ai_blend'|'gap_only',
 *   reason: string
 * }}
 */
export function shouldFetchStock({ clientLibrarySize, durationSec, mode = 'ai_blend', blendRatio = 0.4 }) {
  if (typeof clientLibrarySize !== 'number' || !Number.isFinite(clientLibrarySize) || clientLibrarySize < 0) {
    return { trigger: false, target: 0, gap: 0, supplementalCount: 0, fetchCount: 0, mode, reason: 'invalid_client_size' };
  }
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    return { trigger: false, target: 0, gap: 0, supplementalCount: 0, fetchCount: 0, mode, reason: 'invalid_duration' };
  }
  const target = Math.ceil(durationSec / 8);
  const gap = Math.max(0, target - clientLibrarySize);

  if (mode === 'gap_only') {
    if (gap === 0) {
      return { trigger: false, target, gap: 0, supplementalCount: 0, fetchCount: 0, mode, reason: 'client_coverage_sufficient' };
    }
    return {
      trigger: true,
      target,
      gap,
      supplementalCount: 0,
      fetchCount: gap,
      mode,
      reason: `client_below_target_${clientLibrarySize}_lt_${target}`,
    };
  }

  // ai_blend (default): always fetch some supplemental stock so the picker
  // sees both pools. Floor of (target * blendRatio) capped at >= 1 so even
  // tiny targets get one stock candidate.
  const supplementalCount = Math.max(1, Math.floor(target * blendRatio));
  const fetchCount = Math.max(gap, supplementalCount);
  const reason = gap > 0
    ? `blend_with_gap_fill_${gap}_plus_supplemental_${supplementalCount}`
    : `blend_supplemental_${supplementalCount}`;
  return { trigger: true, target, gap, supplementalCount, fetchCount, mode, reason };
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
 * PR-D + PR-F: source-balance safety net + mix-state diagnostics.
 *
 * Trim excess stock picks when `usableClientCount > 0` AND the picked stock
 * ratio exceeds `maxStockRatio` (default 0.55 in PR-F, was 0.4 in PR-D —
 * higher ceiling so the AI's mix decision wins more often). Trim-only: never
 * replaces a stock pick with a client pick (that would need a second LLM
 * call). Pre-pick library shaping (`shouldFetchStock` ai_blend mode) plus
 * the picker prompt do the heavy lifting; this is the cap, not the lever.
 *
 * **Mix-state diagnostic (PR-F)**: also reports whether both sources made
 * it into the final picks. Informational only — we do NOT re-pick or
 * force-add to satisfy a mix target. The picker prompt is the only
 * mechanism that asks Gemini to mix; this fn just surfaces what happened.
 *
 * Edge cases:
 *   - usableClientCount === 0 → can't have client picks. action =
 *     'skipped_no_client_assets', mixMet = true (with reason
 *     'single_source_only'), no trim.
 *   - usableClientCount > 0 but picker chose 100% stock → trimming would
 *     drop everything (no client to fall back to). PRESERVE the picks
 *     instead. action = 'preserved_ai_chose_all_stock', mixMet = false.
 *   - stockCandidatesAvailable = 0 (no stock was offered) and picker chose
 *     all client → mixMet = true ('single_source_only'); not a real
 *     mix-failure since picker had nothing to mix with.
 *   - stockCandidatesAvailable > 0 but picker chose 0 stock → mixMet =
 *     false ('ai_chose_all_client_despite_stock_available'). Pure
 *     diagnostic; no trim/replacement.
 *
 * Pure function — no I/O.
 *
 * @param {Object} args
 * @param {Array<{provenance?: string}>} args.insertions  picker output, time-ordered
 * @param {number} args.usableClientCount                 client lib size AFTER HEIC + URL filter
 * @param {number} [args.maxStockRatio=0.55]              trim threshold; values >= this trigger
 * @param {number} [args.stockCandidatesAvailable=0]      stock candidates offered to the picker
 *   (used to compute mixReason — distinguishes "AI chose to skip stock"
 *   from "no stock was available to choose")
 * @returns {{
 *   insertions: Array,
 *   action: string|null,
 *   droppedStockCount: number,
 *   mixMet: boolean,
 *   mixReason: 'both_sources_represented'|'ai_chose_all_client_despite_stock_available'|'ai_chose_all_stock_despite_client_available'|'single_source_only',
 * }}
 */
export function rebalanceClientFirst({
  insertions,
  usableClientCount,
  maxStockRatio = 0.55,
  stockCandidatesAvailable = 0,
}) {
  const safeIns = Array.isArray(insertions) ? insertions : [];
  const isStock = (i) => i?.provenance === 'pixabay';

  // ── degenerate / empty input ────────────────────────────────────────
  if (safeIns.length === 0) {
    return { insertions: safeIns, action: null, droppedStockCount: 0, mixMet: true, mixReason: 'single_source_only' };
  }

  // ── usableClient === 0 → can't have client picks; preserve ────────
  if (typeof usableClientCount !== 'number' || !Number.isFinite(usableClientCount) || usableClientCount <= 0) {
    return {
      insertions: safeIns,
      action: 'skipped_no_client_assets',
      droppedStockCount: 0,
      mixMet: true,                             // not a mix failure — there was no client to mix with
      mixReason: 'single_source_only',
    };
  }

  const stockCount = safeIns.filter(isStock).length;
  const clientCount = safeIns.length - stockCount;

  // ── edge case: usableClient > 0 but picker chose 100% stock ────────
  // Trim would zero out the picks (no client to fall back to). PRESERVE.
  // Surface mixMet=false so the operator can see the AI made an unusual
  // choice. Trust the AI; flag the diagnostic.
  if (clientCount === 0 && stockCount > 0) {
    return {
      insertions: safeIns,
      action: 'preserved_ai_chose_all_stock',
      droppedStockCount: 0,
      mixMet: false,
      mixReason: 'ai_chose_all_stock_despite_client_available',
    };
  }

  // ── trim path ──────────────────────────────────────────────────────
  let kept = safeIns;
  let dropped = 0;
  let actionStr = null;
  const stockRatio = stockCount / safeIns.length;
  if (stockRatio > maxStockRatio) {
    kept = [...safeIns];
    while (kept.length > 0) {
      const stockNow = kept.filter(isStock).length;
      if (stockNow === 0) break;
      const clientNow = kept.length - stockNow;
      if (clientNow === 0) break;                // safety: don't trim past 100% client-or-empty
      if (stockNow / kept.length <= maxStockRatio) break;
      let dropIdx = -1;
      for (let i = kept.length - 1; i >= 0; i--) {
        if (isStock(kept[i])) { dropIdx = i; break; }
      }
      if (dropIdx === -1) break;
      kept.splice(dropIdx, 1);
      dropped += 1;
    }
    actionStr = `trimmed_${dropped}_stock_pick(s)_to_enforce_max_${maxStockRatio}`;
  }

  // ── mix-state diagnostic (recompute on the kept set after any trim)
  const keptStockCount = kept.filter(isStock).length;
  const keptClientCount = kept.length - keptStockCount;
  let mixMet;
  let mixReason;
  if (keptStockCount > 0 && keptClientCount > 0) {
    mixMet = true;
    mixReason = 'both_sources_represented';
  } else if (keptStockCount === 0 && keptClientCount > 0) {
    // All client. Was stock offered to the picker?
    if (stockCandidatesAvailable > 0) {
      mixMet = false;
      mixReason = 'ai_chose_all_client_despite_stock_available';
    } else {
      mixMet = true;
      mixReason = 'single_source_only';
    }
  } else {
    // All stock — already handled above unless trimming sent us here.
    mixMet = false;
    mixReason = 'ai_chose_all_stock_despite_client_available';
  }

  return {
    insertions: kept,
    action: actionStr,
    droppedStockCount: dropped,
    mixMet,
    mixReason,
  };
}
