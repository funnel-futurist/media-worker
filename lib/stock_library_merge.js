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

// ── Anti-generic-scenery filter (Tier 1, 2026-05-27) ──────────────────────
// Chelsea/Phil EnableSNP feedback: generic tree/lake/mountain stock kept
// winning emotional/abstract beats ("waking up rested", "planning in place")
// because (a) stock_keyword_gen was told to emit scenery-metaphor keywords and
// (b) the picker's EMOTIONAL tier green-lights "calm outdoor scene". This
// helper drops PURE-scenery Pixabay hits before the picker ever sees them, so
// the candidate pool itself stops offering empty landscape.
//
// PROTECTED — never dropped: any hit with a people / action / object / human-
// setting anchor. "family walking in park", "parent and child outdoors",
// "kids playing in field" all carry anchors (family/walking/park,
// parent/child, kids/playing) and pass through untouched, even though they
// also carry scenery tags.

const SCENERY_TAGS = new Set([
  'nature', 'landscape', 'scenery', 'scenic', 'forest', 'woods', 'tree', 'trees',
  'mountain', 'mountains', 'hill', 'hills', 'lake', 'river', 'stream', 'waterfall',
  'ocean', 'sea', 'wave', 'waves', 'beach', 'coast', 'sky', 'clouds', 'cloud',
  'sunset', 'sunrise', 'dawn', 'dusk', 'horizon', 'field', 'fields', 'meadow',
  'grass', 'valley', 'desert', 'snow', 'wilderness', 'outdoors', 'outdoor',
  'countryside', 'panorama', 'aerial', 'drone',
]);

const ANCHOR_TAGS = new Set([
  // people
  'family', 'families', 'parent', 'parents', 'mother', 'father', 'mom', 'dad',
  'child', 'children', 'kid', 'kids', 'baby', 'people', 'person', 'man', 'woman',
  'men', 'women', 'boy', 'girl', 'couple', 'group', 'team', 'crowd', 'student',
  // body / interaction
  'hands', 'hand', 'face', 'smile',
  // activities
  'walking', 'running', 'playing', 'talking', 'meeting', 'working', 'writing',
  'reading', 'cooking', 'signing', 'laughing', 'hugging', 'teaching', 'planning',
  // objects / human settings
  'document', 'documents', 'paper', 'paperwork', 'calendar', 'clock', 'phone',
  'laptop', 'computer', 'desk', 'office', 'home', 'room', 'kitchen', 'table', 'book',
  'notebook', 'pen', 'car', 'school', 'classroom', 'park', 'playground',
]);

/**
 * Decide whether a Pixabay hit is generic scenery that should be dropped from
 * the candidate pool. Returns true ONLY when all three hold:
 *   1. the hit carries at least one scenery tag,
 *   2. it carries NO people/action/object/setting anchor, and
 *   3. the search keyword itself did not ask for nature (so we don't strip
 *      legitimately-wanted scenery when the transcript is about the outdoors).
 *
 * Conservative by design: anything with an anchor, or no scenery at all, or an
 * unrecognised tag set, is KEPT. We only drop the clear-cut empty-landscape case.
 *
 * @param {string|null|undefined} tags     Pixabay comma-separated tag string
 * @param {string|null|undefined} keyword  the search keyword that returned it
 * @returns {boolean}  true → drop as generic scenery
 */
export function isGenericSceneryHit(tags, keyword) {
  const raw = String(tags ?? '').toLowerCase();
  const tagWords = new Set();
  for (const piece of raw.split(',')) {
    for (const w of piece.trim().split(/\s+/)) {
      if (w) tagWords.add(w);
    }
  }
  if (tagWords.size === 0) return false; // nothing to judge → keep

  // Anchor present → real subject/action/object → always keep.
  for (const w of tagWords) {
    if (ANCHOR_TAGS.has(w)) return false;
  }

  // No anchor. Is there scenery at all?
  let hasScenery = false;
  for (const w of tagWords) {
    if (SCENERY_TAGS.has(w)) { hasScenery = true; break; }
  }
  if (!hasScenery) return false; // not scenery (unknown tags) → keep

  // Scenery, no anchor. Drop UNLESS the keyword explicitly wanted nature.
  const kwWords = String(keyword ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const w of kwWords) {
    if (SCENERY_TAGS.has(w)) return false; // keyword asked for scenery → keep
  }
  return true;
}

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
 * **Option B (PR-131, 2026-05-12)**: hard `maxClientCount` cap. When the
 * caller passes `maxClientCount`, client picks are trimmed from the tail
 * BEFORE the stock-ratio trim runs, so the post-trim insertion set has
 * at most `maxClientCount` client picks. Used for clients whose b-roll
 * library is repetitive/weak (Phil's family photos) where the prompt
 * bias alone (`brollClientPreference: 'minimal'`) doesn't push Gemini
 * hard enough — PR #130's bias trimmed only 1 client on Phil's clip
 * (6c+3s → 5c+4s); operator wanted ≤2 client. Hard cap delivers it
 * deterministically.
 *
 * @param {Object} args
 * @param {Array<{provenance?: string}>} args.insertions  picker output, time-ordered
 * @param {number} args.usableClientCount                 client lib size AFTER HEIC + URL filter
 * @param {number} [args.maxStockRatio=0.55]              trim threshold; values >= this trigger
 * @param {number} [args.stockCandidatesAvailable=0]      stock candidates offered to the picker
 *   (used to compute mixReason — distinguishes "AI chose to skip stock"
 *   from "no stock was available to choose")
 * @param {number} [args.maxClientCount]                  HARD cap on client picks.
 *   When set AND clientCount > maxClientCount, trim client picks from
 *   the timeline tail down to the cap. Stock-ratio trim runs after on
 *   the reduced set. Omit / set null to disable (legacy behavior).
 * @returns {{
 *   insertions: Array,
 *   action: string|null,
 *   droppedStockCount: number,
 *   droppedClientCount: number,
 *   mixMet: boolean,
 *   mixReason: 'both_sources_represented'|'ai_chose_all_client_despite_stock_available'|'ai_chose_all_stock_despite_client_available'|'single_source_only',
 * }}
 */
export function rebalanceClientFirst({
  insertions,
  usableClientCount,
  maxStockRatio = 0.55,
  stockCandidatesAvailable = 0,
  maxClientCount,
}) {
  const safeIns = Array.isArray(insertions) ? insertions : [];
  const isStock = (i) => i?.provenance === 'pixabay';

  // ── degenerate / empty input ────────────────────────────────────────
  if (safeIns.length === 0) {
    return { insertions: safeIns, action: null, droppedStockCount: 0, droppedClientCount: 0, mixMet: true, mixReason: 'single_source_only' };
  }

  // ── usableClient === 0 → can't have client picks; preserve ────────
  if (typeof usableClientCount !== 'number' || !Number.isFinite(usableClientCount) || usableClientCount <= 0) {
    return {
      insertions: safeIns,
      action: 'skipped_no_client_assets',
      droppedStockCount: 0,
      droppedClientCount: 0,
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
      droppedClientCount: 0,
      mixMet: false,
      mixReason: 'ai_chose_all_stock_despite_client_available',
    };
  }

  let kept = [...safeIns];
  let droppedStock = 0;
  let droppedClient = 0;
  const actions = [];

  // ── Option B: hard client cap (PR-131) ─────────────────────────────
  // Runs BEFORE stock-ratio trim so the ratio is evaluated against the
  // post-cap pick set. Trim from the timeline tail (latest client pick
  // first) — earlier-in-video client picks are usually the brand-anchor
  // moments we want to keep.
  if (
    typeof maxClientCount === 'number' &&
    Number.isFinite(maxClientCount) &&
    maxClientCount >= 0 &&
    clientCount > maxClientCount
  ) {
    while (true) {
      const clientNow = kept.filter((i) => !isStock(i)).length;
      if (clientNow <= maxClientCount) break;
      let dropIdx = -1;
      for (let i = kept.length - 1; i >= 0; i--) {
        if (!isStock(kept[i])) { dropIdx = i; break; }
      }
      if (dropIdx === -1) break;
      kept.splice(dropIdx, 1);
      droppedClient += 1;
    }
    if (droppedClient > 0) {
      actions.push(`trimmed_${droppedClient}_client_pick(s)_to_enforce_max_client_count_${maxClientCount}`);
    }
  }

  // ── stock-ratio trim (PR-D/PR-F) ───────────────────────────────────
  // Evaluated against the post-client-cap set so an aggressive
  // brollMaxStockRatio doesn't double-penalise after the cap already
  // trimmed clients.
  const ratioStockNow = kept.filter(isStock).length;
  const ratioStockRatio = kept.length > 0 ? ratioStockNow / kept.length : 0;
  if (ratioStockRatio > maxStockRatio) {
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
      droppedStock += 1;
    }
    if (droppedStock > 0) {
      actions.push(`trimmed_${droppedStock}_stock_pick(s)_to_enforce_max_${maxStockRatio}`);
    }
  }
  const actionStr = actions.length > 0 ? actions.join('; ') : null;

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
    droppedStockCount: droppedStock,
    droppedClientCount: droppedClient,
    mixMet,
    mixReason,
  };
}
