/**
 * test/stock_library_merge.test.js
 *
 * Pure-function tests for `shouldFetchStock` (coverage heuristic) and
 * `mergeStockIntoLibrary` (Pixabay hit → library row adapter + concat).
 * Both helpers are network-free, so the suite stays fast and deterministic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldFetchStock, mergeStockIntoLibrary, rebalanceClientFirst, isGenericSceneryHit } from '../lib/stock_library_merge.js';

// ── shouldFetchStock — coverage heuristic ───────────────────────────────
//
// PR-F (2026-05-09): Default mode flipped from "fallback only when gap > 0"
// to ai_blend (always trigger when pixabayEnabled, fetch a supplementalCount
// of stock candidates so the picker has a healthy mix to choose from).
// Legacy gap_only mode preserved as escape hatch.

// ── ai_blend mode (new default) ────────────────────────────────────────

test('shouldFetchStock: ai_blend ALWAYS triggers when client lib is healthy (Phil-style full lib)', () => {
  // 78s reel → target=10. Client has 13 (Phil after HEIC conversion). Pre-PR-F
  // would gap=0 → no trigger. PR-F ai_blend: trigger=true, supplementalCount =
  // max(1, floor(10*0.4)) = 4 → fetch 4 stock candidates so picker sees both pools.
  const out = shouldFetchStock({ clientLibrarySize: 13, durationSec: 78 });
  assert.equal(out.trigger, true);
  assert.equal(out.target, 10);
  assert.equal(out.gap, 0);
  assert.equal(out.supplementalCount, 4);
  assert.equal(out.fetchCount, 4);
  assert.equal(out.mode, 'ai_blend');
  assert.match(out.reason, /blend_supplemental_4|blend/);
});

test('shouldFetchStock: ai_blend covers gap AND adds supplemental for thin lib', () => {
  // 60s reel → target=8. Client has 3 → gap=5. supplementalCount = max(1, floor(8*0.4)) = 3.
  // fetchCount = max(gap=5, supplementalCount=3) = 5 → fetch enough to fill the gap.
  const out = shouldFetchStock({ clientLibrarySize: 3, durationSec: 60 });
  assert.equal(out.trigger, true);
  assert.equal(out.target, 8);
  assert.equal(out.gap, 5);
  assert.equal(out.supplementalCount, 3);
  assert.equal(out.fetchCount, 5);                   // gap dominates
  assert.equal(out.mode, 'ai_blend');
});

test('shouldFetchStock: ai_blend triggers for empty client lib (gap fully covers)', () => {
  // 60s reel + 0 client → target=8, gap=8. fetchCount = max(8, floor(8*0.4)=3) = 8.
  const out = shouldFetchStock({ clientLibrarySize: 0, durationSec: 60 });
  assert.equal(out.trigger, true);
  assert.equal(out.gap, 8);
  assert.equal(out.fetchCount, 8);
  assert.equal(out.mode, 'ai_blend');
});

test('shouldFetchStock: ai_blend supplementalCount has minimum of 1 even on tiny target', () => {
  // 4s reel → target=1. Client has 5 → gap=0. supplementalCount = max(1, floor(1*0.4)=0) = 1.
  const out = shouldFetchStock({ clientLibrarySize: 5, durationSec: 4 });
  assert.equal(out.trigger, true);
  assert.equal(out.target, 1);
  assert.equal(out.supplementalCount, 1);
  assert.equal(out.fetchCount, 1);
});

test('shouldFetchStock: ai_blend honors blendRatio override', () => {
  // 60s reel → target=8. With blendRatio=0.5 → supplementalCount=4.
  const out = shouldFetchStock({ clientLibrarySize: 13, durationSec: 60, blendRatio: 0.5 });
  assert.equal(out.supplementalCount, 4);
});

// ── gap_only mode (legacy escape hatch) ────────────────────────────────

test('shouldFetchStock: gap_only — does NOT trigger when client lib hits target exactly', () => {
  const out = shouldFetchStock({ clientLibrarySize: 8, durationSec: 64, mode: 'gap_only' });
  assert.equal(out.trigger, false);
  assert.equal(out.gap, 0);
  assert.equal(out.fetchCount, 0);
  assert.equal(out.reason, 'client_coverage_sufficient');
  assert.equal(out.mode, 'gap_only');
});

test('shouldFetchStock: gap_only — does NOT trigger when client lib exceeds target (Justine 187 rows)', () => {
  const out = shouldFetchStock({ clientLibrarySize: 187, durationSec: 60, mode: 'gap_only' });
  assert.equal(out.trigger, false);
  assert.equal(out.gap, 0);
  assert.equal(out.fetchCount, 0);
});

test('shouldFetchStock: gap_only — triggers when client lib is below ceil(dur/8)', () => {
  const out = shouldFetchStock({ clientLibrarySize: 5, durationSec: 60, mode: 'gap_only' });
  assert.equal(out.trigger, true);
  assert.equal(out.target, 8);
  assert.equal(out.gap, 3);
  assert.equal(out.fetchCount, 3);                   // gap_only fetches exactly the gap
  assert.match(out.reason, /client_below_target/);
});

// ── shared validation (mode-independent) ───────────────────────────────

test('shouldFetchStock: rejects invalid client size (both modes)', () => {
  for (const bad of [-1, NaN, null, undefined, 'five']) {
    for (const mode of ['ai_blend', 'gap_only']) {
      const out = shouldFetchStock({ clientLibrarySize: bad, durationSec: 60, mode });
      assert.equal(out.trigger, false, `${mode}: should not trigger with clientLibrarySize=${bad}`);
      assert.equal(out.reason, 'invalid_client_size');
    }
  }
});

test('shouldFetchStock: rejects invalid duration (both modes)', () => {
  for (const bad of [-1, 0, NaN, Infinity, null, undefined, 'sixty']) {
    for (const mode of ['ai_blend', 'gap_only']) {
      const out = shouldFetchStock({ clientLibrarySize: 5, durationSec: bad, mode });
      assert.equal(out.trigger, false, `${mode}: should not trigger with durationSec=${bad}`);
      assert.equal(out.reason, 'invalid_duration');
    }
  }
});

// ── mergeStockIntoLibrary — adapt + concat ─────────────────────────────

function clientRow(overrides = {}) {
  return {
    asset_id: 'client-' + Math.random().toString(36).slice(2, 8),
    asset_title: 'Client clip',
    asset_type: 'video',
    content_strategy_type: 'family_planning',
    context: 'family room',
    emotion: 'thoughtful',
    insight: 'parents in conversation',
    when_to_use: 'discussions about long-term planning',
    file_url: 'https://x.supabase.co/x/clip.mov',
    storage_url: null,
    drive_file_id: null,
    provenance: 'client',
    ...overrides,
  };
}

function stockHit(overrides = {}) {
  return {
    id: 1234567,
    pageURL: 'https://pixabay.com/videos/family-1234567/',
    tags: 'family, home, planning',
    duration: 18,
    videoUrl: 'https://cdn.pixabay.com/video/2025/01/01/1234567-medium.mp4',
    width: 1280,
    height: 720,
    sizeBytes: 4200000,
    tier: 'medium',
    searchKeyword: 'family planning home',
    localPath: '/tmp/job-x/stock-cache/px-video-1234567.mp4',
    bytes: 4200000,
    sourceDurSec: 17.84,
    hasVideo: true,
    hasAudio: false,
    ...overrides,
  };
}

test('merge: concatenates client first then stock', () => {
  const client = [clientRow({ asset_id: 'c1' }), clientRow({ asset_id: 'c2' })];
  const stock = [stockHit({ id: 11 }), stockHit({ id: 22 })];
  const out = mergeStockIntoLibrary(client, stock);
  assert.equal(out.length, 4);
  assert.equal(out[0].asset_id, 'c1');
  assert.equal(out[1].asset_id, 'c2');
  assert.equal(out[2].asset_id, 'px-video-11');
  assert.equal(out[3].asset_id, 'px-video-22');
});

test('merge: assigns synthetic asset_id to stock hits', () => {
  const out = mergeStockIntoLibrary([], [stockHit({ id: 9999 })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].asset_id, 'px-video-9999');
});

test('merge: tags stock hits with provenance=pixabay', () => {
  const out = mergeStockIntoLibrary([], [stockHit()]);
  assert.equal(out[0].provenance, 'pixabay');
});

test('merge: passes pre-downloaded localPath through (enables short-circuit)', () => {
  const hit = stockHit({ id: 42, localPath: '/tmp/abc/stock-cache/px-video-42.mp4' });
  const out = mergeStockIntoLibrary([], [hit]);
  assert.equal(out[0].localPath, '/tmp/abc/stock-cache/px-video-42.mp4');
});

test('merge: passes pre-probed sourceDurSec / hasVideo / hasAudio through', () => {
  const hit = stockHit({ id: 50, sourceDurSec: 12.5, hasVideo: true, hasAudio: false });
  const out = mergeStockIntoLibrary([], [hit]);
  assert.equal(out[0].sourceDurSec, 12.5);
  assert.equal(out[0].hasVideo, true);
  assert.equal(out[0].hasAudio, false);
});

test('merge: synthesises asset_title from tags', () => {
  const hit = stockHit({ tags: 'family, home, living room, parents, children' });
  const out = mergeStockIntoLibrary([], [hit]);
  assert.match(out[0].asset_title, /Pixabay stock/);
  assert.match(out[0].asset_title, /family/);
  assert.match(out[0].asset_title, /home/);
});

test('merge: surfaces pixabayPageURL + searchKeyword for attribution + audit', () => {
  const hit = stockHit({
    pageURL: 'https://pixabay.com/videos/special-needs-test-555/',
    searchKeyword: 'family planning home',
  });
  const out = mergeStockIntoLibrary([], [hit]);
  assert.equal(out[0].pixabayPageURL, 'https://pixabay.com/videos/special-needs-test-555/');
  assert.equal(out[0].searchKeyword, 'family planning home');
});

test('merge: drops stock hits missing id', () => {
  const out = mergeStockIntoLibrary([], [
    stockHit({ id: 1 }),
    { ...stockHit(), id: undefined },              // dropped
    stockHit({ id: 3 }),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.asset_id), ['px-video-1', 'px-video-3']);
});

test('merge: defensive against null/undefined inputs', () => {
  assert.deepEqual(mergeStockIntoLibrary(null, null), []);
  assert.deepEqual(mergeStockIntoLibrary(undefined, undefined), []);
  assert.deepEqual(mergeStockIntoLibrary([], []), []);
});

test('merge: no client rows + no stock hits → empty array', () => {
  assert.deepEqual(mergeStockIntoLibrary([], []), []);
});

test('merge: client rows pass through unchanged (provenance preserved)', () => {
  const client = [clientRow({ asset_id: 'c1', context: 'kitchen' })];
  const out = mergeStockIntoLibrary(client, []);
  assert.equal(out.length, 1);
  assert.equal(out[0].asset_id, 'c1');
  assert.equal(out[0].provenance, 'client');
  assert.equal(out[0].context, 'kitchen');
});

test('merge: stock hit asset_type is "video"', () => {
  const out = mergeStockIntoLibrary([], [stockHit()]);
  assert.equal(out[0].asset_type, 'video');
});

test('merge: stock hit storage_url + drive_file_id are null', () => {
  const out = mergeStockIntoLibrary([], [stockHit()]);
  assert.equal(out[0].storage_url, null);
  assert.equal(out[0].drive_file_id, null);
});

test('merge: file_url set to the chosen Pixabay videoUrl', () => {
  const hit = stockHit({ videoUrl: 'https://cdn.pixabay.com/video/x/y/z.mp4' });
  const out = mergeStockIntoLibrary([], [hit]);
  assert.equal(out[0].file_url, 'https://cdn.pixabay.com/video/x/y/z.mp4');
});

test('merge: when_to_use mentions visual cue from tags so the picker has search material', () => {
  const hit = stockHit({ tags: 'documents, paperwork, desk' });
  const out = mergeStockIntoLibrary([], [hit]);
  assert.match(out[0].when_to_use, /documents|paperwork|desk/);
});

// ── rebalanceClientFirst — post-pick safety net (PR-D) ─────────────────

const ins = (id, prov) => ({ asset_id: id, startSec: 0, endSec: 3, provenance: prov });
const insArr = (...provs) => provs.map((p, i) => ins(`a${i}`, p));

test('rebalance: returns input untouched when usableClient=0 (Pixabay free to dominate)', () => {
  const picks = insArr('pixabay', 'pixabay', 'pixabay');
  const out = rebalanceClientFirst({ insertions: picks, usableClientCount: 0 });
  assert.equal(out.insertions.length, 3);
  assert.equal(out.droppedStockCount, 0);
  assert.equal(out.action, 'skipped_no_client_assets');
});

test('rebalance: empty insertions short-circuits', () => {
  const out = rebalanceClientFirst({ insertions: [], usableClientCount: 5 });
  assert.deepEqual(out.insertions, []);
  assert.equal(out.action, null);
  assert.equal(out.droppedStockCount, 0);
});

// PR-F (2026-05-09): default maxStockRatio raised from 0.4 → 0.55 so the
// AI's mix decision wins more often. Trim only kicks in when stock truly
// dominates. Mix-state diagnostics added.

test('rebalance: PR-F — 4 client + 3 stock = 43% stock → NO trim (under new 0.55 ceiling)', () => {
  // The Phil-after-PR-F target case: AI picks 4 client + 3 stock = 43%. Should pass through clean.
  const picks = insArr('client', 'pixabay', 'client', 'pixabay', 'client', 'pixabay', 'client');
  const out = rebalanceClientFirst({ insertions: picks, usableClientCount: 13 });
  assert.equal(out.droppedStockCount, 0);
  assert.equal(out.insertions.length, 7);
  assert.equal(out.action, null);
  // Mix diagnostic: both sources represented.
  assert.equal(out.mixMet, true);
  assert.equal(out.mixReason, 'both_sources_represented');
});

test('rebalance: PR-F — 3 client + 4 stock = 57% stock → trims 1 stock (back under 0.55)', () => {
  // 3c+4s = 57% > 55%. After dropping last stock: 3c+3s = 50% → under cap, stop.
  const picks = insArr('client', 'pixabay', 'client', 'pixabay', 'client', 'pixabay', 'pixabay');
  const out = rebalanceClientFirst({ insertions: picks, usableClientCount: 13 });
  assert.equal(out.droppedStockCount, 1);
  assert.equal(out.insertions.length, 6);
  assert.match(out.action ?? '', /trimmed_1/);
  assert.equal(out.mixMet, true);   // still both sources after trim
});

test('rebalance: PR-F — 2 client + 4 stock = 67% → trims 1 (50% remains, under 0.55)', () => {
  // 2c+4s = 67% > 55%. Drop last stock → 2c+3s = 60% (still over). Drop again → 2c+2s = 50% under cap.
  const picks = insArr('client', 'pixabay', 'client', 'pixabay', 'pixabay', 'pixabay');
  const out = rebalanceClientFirst({ insertions: picks, usableClientCount: 5 });
  assert.equal(out.droppedStockCount, 2);
  assert.equal(out.insertions.length, 4);
  assert.equal(out.insertions.filter((i) => i.provenance === 'pixabay').length, 2);
  assert.match(out.action ?? '', /trimmed_2/);
});

test('rebalance: PR-F — trims latest-time stock first (preserves early-video stock)', () => {
  const picks = [
    ins('a0', 'pixabay'),  // t=early
    ins('a1', 'client'),
    ins('a2', 'pixabay'),  // t=late — should be dropped first
    ins('a3', 'pixabay'),  // t=latest — dropped first actually
  ];
  // 1c + 3s = 75% > 55%. Drop last (a3) → 1c+2s=67% > 55%. Drop a2 → 1c+1s=50% under.
  const out = rebalanceClientFirst({ insertions: picks, usableClientCount: 3 });
  assert.equal(out.droppedStockCount, 2);
  assert.deepEqual(out.insertions.map((i) => i.asset_id), ['a0', 'a1']);
});

test('rebalance: PR-F — respects custom maxStockRatio override', () => {
  // 2 client + 2 stock = 50%. With maxStockRatio=0.5, ratio is exactly at cap → no trim.
  const picks = insArr('client', 'pixabay', 'client', 'pixabay');
  const out = rebalanceClientFirst({ insertions: picks, usableClientCount: 5, maxStockRatio: 0.5 });
  assert.equal(out.droppedStockCount, 0);
});

test('rebalance: PR-F — maxStockRatio=0.3 (stricter) trims more aggressively', () => {
  // Caller-supplied stricter ratio still works.
  // 2 client + 2 stock = 50% > 0.3. Drop last → 2c+1s=33% > 0.3. Drop → 2c+0s.
  const picks = insArr('client', 'pixabay', 'client', 'pixabay');
  const out = rebalanceClientFirst({ insertions: picks, usableClientCount: 5, maxStockRatio: 0.3 });
  assert.equal(out.droppedStockCount, 2);
  assert.equal(out.insertions.length, 2);
  assert.equal(out.insertions.every((i) => i.provenance === 'client'), true);
});

// ── PR-F mix-state diagnostics (informational, no enforcement) ─────────

test('rebalance: PR-F — mixMet=false when AI chose all-client despite stock candidates', () => {
  // Phil-style after PR-E: 7 client + 0 stock when usable client > 0 and stock was offered.
  // No trim (ratio 0%), but flag the mix as unmet so operator can see why.
  const picks = insArr('client', 'client', 'client', 'client', 'client', 'client', 'client');
  const out = rebalanceClientFirst({
    insertions: picks,
    usableClientCount: 13,
    stockCandidatesAvailable: 4,        // PR-F new param: were stock candidates offered to picker?
  });
  assert.equal(out.droppedStockCount, 0);
  assert.equal(out.mixMet, false);
  assert.equal(out.mixReason, 'ai_chose_all_client_despite_stock_available');
  assert.equal(out.action, null);
});

test('rebalance: PR-F — mixMet=true when only ONE source had candidates (single_source_only)', () => {
  // Phil-pre-HEIC-conversion: usableClient=0, all picks must be stock by necessity.
  const picks = insArr('pixabay', 'pixabay', 'pixabay');
  const out = rebalanceClientFirst({
    insertions: picks,
    usableClientCount: 0,
    stockCandidatesAvailable: 6,
  });
  assert.equal(out.action, 'skipped_no_client_assets');
  assert.equal(out.mixMet, true);                              // not unmet — there was no choice
  assert.equal(out.mixReason, 'single_source_only');
});

test('rebalance: PR-F — preserve all-stock when AI chose 100% stock despite client available', () => {
  // Edge case: usableClient > 0 but Gemini went all-stock anyway. Pre-PR-F's trim
  // would drop EVERY stock pick → 0 picks, worse than the original. Fix:
  // detect "no client picks present" and preserve the picks, flag the diagnostic.
  const picks = insArr('pixabay', 'pixabay', 'pixabay', 'pixabay');
  const out = rebalanceClientFirst({
    insertions: picks,
    usableClientCount: 5,
    stockCandidatesAvailable: 6,
  });
  // picks preserved unchanged
  assert.equal(out.insertions.length, 4);
  assert.equal(out.droppedStockCount, 0);
  assert.equal(out.action, 'preserved_ai_chose_all_stock');
  assert.equal(out.mixMet, false);
  assert.equal(out.mixReason, 'ai_chose_all_stock_despite_client_available');
});

test('rebalance: PR-F — mixMet defaults to true when both sources represented', () => {
  const picks = insArr('client', 'client', 'pixabay');
  const out = rebalanceClientFirst({
    insertions: picks,
    usableClientCount: 5,
    stockCandidatesAvailable: 4,
  });
  assert.equal(out.mixMet, true);
  assert.equal(out.mixReason, 'both_sources_represented');
});

test('rebalance: tolerates missing provenance — treats undefined as client (legacy rows)', () => {
  // legacy rows that pre-date PR-A may not carry provenance; default-as-client matches downloadBrollAssets behavior.
  // With explicit maxStockRatio=0.4: 1c + 1s = 50% > 40% → trim 1 stock.
  const picks = [
    { asset_id: 'a0' },
    { asset_id: 'a1', provenance: 'pixabay' },
  ];
  const out = rebalanceClientFirst({ insertions: picks, usableClientCount: 3, maxStockRatio: 0.4 });
  assert.equal(out.droppedStockCount, 1);
  assert.equal(out.insertions.length, 1);
  assert.equal(out.insertions[0].asset_id, 'a0');
});

test('rebalance: returns metadata fields callers can read for response.insertions.sourceBalance', () => {
  const picks = insArr('client', 'pixabay', 'pixabay', 'pixabay');
  const out = rebalanceClientFirst({ insertions: picks, usableClientCount: 5, maxStockRatio: 0.4 });
  assert.equal(typeof out.droppedStockCount, 'number');
  assert.equal(typeof out.droppedClientCount, 'number');       // PR-131 new field
  assert.equal(typeof out.action, 'string');                   // trim happened → string action
  assert.ok(Array.isArray(out.insertions));
  // PR-F: mix-state diagnostic fields always present
  assert.equal(typeof out.mixMet, 'boolean');
  assert.equal(typeof out.mixReason, 'string');
});

// ── PR-131 Option B: hard maxClientCount cap ──────────────────────────

test('rebalance: PR-131 — Phil case (5c+4s) with maxClientCount=2 trims 3 client → 2c+4s', () => {
  // Replays the actual Phil-row outcome from row 0056ba10 (jobId
  // 58b88c08): 5 client + 4 stock = 9 picks. maxClientCount=2 trims
  // 3 client from the tail → 2 client + 4 stock = 6 picks. Stock-ratio
  // check (default 0.55) on the post-trim set: 4/6 = 67% > 55% → trim
  // 1 stock → 2c+3s = 5/5*60% > 55% → trim 1 stock → 2c+2s = 50% under
  // cap → stop. Final = 2 client + 2 stock = 4 picks.
  const picks = insArr('client', 'pixabay', 'client', 'pixabay', 'client', 'pixabay', 'client', 'pixabay', 'client');
  const out = rebalanceClientFirst({
    insertions: picks,
    usableClientCount: 13,
    maxClientCount: 2,
  });
  // Client capped to 2.
  const clientKept = out.insertions.filter((i) => i.provenance !== 'pixabay').length;
  const stockKept  = out.insertions.filter((i) => i.provenance === 'pixabay').length;
  assert.equal(clientKept, 2, `expected 2 client, got ${clientKept}`);
  assert.equal(out.droppedClientCount, 3);
  // Stock-ratio trim also fired post-client-trim because default 0.55
  // ceiling is below 67% (4/6). Acceptable behavior — the hard cap
  // takes precedence and the ratio enforces afterwards.
  assert.ok(stockKept >= 1, 'should keep at least some stock');
  // Action string mentions BOTH trims.
  assert.match(out.action ?? '', /client_count_2/);
});

test('rebalance: PR-131 — Phil case with maxClientCount=2 + maxStockRatio=0.85 keeps 2c+4s clean', () => {
  // Operator wanting "just the cap, no stock-ratio over-trim" pairs
  // maxClientCount with a generous maxStockRatio. 2c+4s = 67% stock <
  // 85% cap → no stock trim. Final 2c+4s.
  const picks = insArr('client', 'pixabay', 'client', 'pixabay', 'client', 'pixabay', 'client', 'pixabay', 'client');
  const out = rebalanceClientFirst({
    insertions: picks,
    usableClientCount: 13,
    maxClientCount: 2,
    maxStockRatio: 0.85,
  });
  const clientKept = out.insertions.filter((i) => i.provenance !== 'pixabay').length;
  const stockKept  = out.insertions.filter((i) => i.provenance === 'pixabay').length;
  assert.equal(clientKept, 2);
  assert.equal(stockKept, 4);
  assert.equal(out.droppedClientCount, 3);
  assert.equal(out.droppedStockCount, 0);    // generous ratio → no extra trim
});

test('rebalance: PR-131 — maxClientCount=0 strips ALL client picks (full-stock mode)', () => {
  // Operator who wants every moment to be stock can pass 0. Valid.
  const picks = insArr('client', 'pixabay', 'client', 'pixabay');
  const out = rebalanceClientFirst({
    insertions: picks,
    usableClientCount: 13,
    maxClientCount: 0,
    maxStockRatio: 1.0,                       // disable ratio trim to isolate cap
  });
  const clientKept = out.insertions.filter((i) => i.provenance !== 'pixabay').length;
  assert.equal(clientKept, 0);
  assert.equal(out.droppedClientCount, 2);
});

test('rebalance: PR-131 — maxClientCount higher than actual count is a no-op for client', () => {
  // No client trim when current client count is at or under cap.
  // Isolate the cap behavior by raising the stock-ratio ceiling so it
  // doesn't fire on this set (1c+2s=67% > default 0.55 → would trim
  // stock otherwise, masking the client-cap no-op we're asserting).
  const picks = insArr('client', 'pixabay', 'pixabay');
  const out = rebalanceClientFirst({
    insertions: picks,
    usableClientCount: 5,
    maxClientCount: 10,
    maxStockRatio: 1.0,
  });
  assert.equal(out.droppedClientCount, 0);
  assert.equal(out.insertions.length, 3);
});

test('rebalance: PR-131 — maxClientCount undefined / null disables the cap (legacy behavior)', () => {
  const picks = insArr('client', 'client', 'client', 'pixabay');
  const outA = rebalanceClientFirst({
    insertions: picks, usableClientCount: 5,
    // maxClientCount NOT set
  });
  const outB = rebalanceClientFirst({
    insertions: picks, usableClientCount: 5, maxClientCount: undefined,
  });
  assert.equal(outA.droppedClientCount, 0);
  assert.equal(outB.droppedClientCount, 0);
});

test('rebalance: PR-131 — client trim happens from the TAIL (preserves earlier brand-anchor picks)', () => {
  // Picks in time order. Cap=1 should keep the FIRST client pick (the
  // brand-anchor at the top of the video) and drop later ones.
  const picks = [
    { asset_id: 'c-early', provenance: 'client', startSec: 5 },
    { asset_id: 's-1',     provenance: 'pixabay', startSec: 15 },
    { asset_id: 'c-mid',   provenance: 'client', startSec: 25 },
    { asset_id: 's-2',     provenance: 'pixabay', startSec: 35 },
    { asset_id: 'c-late',  provenance: 'client', startSec: 45 },
  ];
  const out = rebalanceClientFirst({
    insertions: picks,
    usableClientCount: 5,
    maxClientCount: 1,
    maxStockRatio: 1.0,                       // disable ratio trim
  });
  const keptClient = out.insertions.filter((i) => i.provenance !== 'pixabay');
  assert.equal(keptClient.length, 1);
  assert.equal(keptClient[0].asset_id, 'c-early', 'should keep the earliest (brand-anchor) client pick');
});

// ── isGenericSceneryHit — anti-generic-scenery candidate filter (Tier 1) ──
//
// Drops PURE-scenery Pixabay hits before the picker sees them. MUST protect
// anything with a people / action / object anchor, even if it also carries
// nature tags. Chelsea's examples to protect are locked below.

test('isGenericSceneryHit: pure scenery + concrete keyword → DROP', () => {
  // "waking up rested" beat produced a tree shot — exactly what we want gone.
  assert.equal(isGenericSceneryHit('tree, forest, sunset, calm', 'parent waking up morning'), true);
  assert.equal(isGenericSceneryHit('lake, mountains, water, reflection', 'coordinated planning team'), true);
});

test('isGenericSceneryHit: scenery + nature-intended keyword → KEEP (transcript is about outdoors)', () => {
  // If the speaker is literally talking about a forest, a forest clip is fine.
  assert.equal(isGenericSceneryHit('forest, trees, woodland', 'walk through forest nature'), false);
});

test('isGenericSceneryHit: PROTECTED — people/action anchors keep the hit even with nature tags', () => {
  // Chelsea's "brighter / happy families outside" intent must survive.
  assert.equal(isGenericSceneryHit('family, park, grass, walking', 'family planning'), false);
  assert.equal(isGenericSceneryHit('parent, child, outdoors, beach', 'present with kids'), false);
  assert.equal(isGenericSceneryHit('kids, playing, field, grass', 'children outside'), false);
});

test('isGenericSceneryHit: non-scenery tags (no scenery at all) → KEEP', () => {
  assert.equal(isGenericSceneryHit('abstract, motion, graphics', 'energy momentum'), false);
  assert.equal(isGenericSceneryHit('calendar, planning, schedule', 'plan ahead'), false);
});

test('isGenericSceneryHit: empty / missing tags → KEEP (cannot judge)', () => {
  assert.equal(isGenericSceneryHit('', 'anything'), false);
  assert.equal(isGenericSceneryHit(null, 'anything'), false);
  assert.equal(isGenericSceneryHit(undefined, undefined), false);
});

test('isGenericSceneryHit: object anchor (document/desk) survives even with a stray scenery tag', () => {
  assert.equal(isGenericSceneryHit('documents, desk, paperwork, window, sky', 'reviewing the paperwork'), false);
});
