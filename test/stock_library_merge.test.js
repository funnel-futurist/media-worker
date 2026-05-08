/**
 * test/stock_library_merge.test.js
 *
 * Pure-function tests for `shouldFetchStock` (coverage heuristic) and
 * `mergeStockIntoLibrary` (Pixabay hit → library row adapter + concat).
 * Both helpers are network-free, so the suite stays fast and deterministic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldFetchStock, mergeStockIntoLibrary, rebalanceClientFirst } from '../lib/stock_library_merge.js';

// ── shouldFetchStock — coverage heuristic ───────────────────────────────

test('shouldFetchStock: triggers when client lib is below ceil(dur/8)', () => {
  // 60s reel → target 8 rows. Client has 5 → gap 3 → trigger.
  const out = shouldFetchStock({ clientLibrarySize: 5, durationSec: 60 });
  assert.equal(out.trigger, true);
  assert.equal(out.target, 8);
  assert.equal(out.gap, 3);
  assert.match(out.reason, /client_below_target/);
});

test('shouldFetchStock: does NOT trigger when client lib hits target exactly', () => {
  // 64s reel → target 8 rows. Client has exactly 8 → gap 0 → no trigger.
  const out = shouldFetchStock({ clientLibrarySize: 8, durationSec: 64 });
  assert.equal(out.trigger, false);
  assert.equal(out.gap, 0);
  assert.equal(out.reason, 'client_coverage_sufficient');
});

test('shouldFetchStock: does NOT trigger when client lib exceeds target', () => {
  // Justine has 187 rows; should never trigger Pixabay.
  const out = shouldFetchStock({ clientLibrarySize: 187, durationSec: 60 });
  assert.equal(out.trigger, false);
  assert.equal(out.gap, 0);
});

test('shouldFetchStock: triggers aggressively for empty client lib', () => {
  // 60s reel + zero client rows → target 8, gap 8 → trigger with full gap.
  const out = shouldFetchStock({ clientLibrarySize: 0, durationSec: 60 });
  assert.equal(out.trigger, true);
  assert.equal(out.target, 8);
  assert.equal(out.gap, 8);
});

test('shouldFetchStock: ceiling math — short reel still has minimum target of 1', () => {
  // 4s reel → target 1 row. Client has 0 → gap 1 → trigger.
  const out = shouldFetchStock({ clientLibrarySize: 0, durationSec: 4 });
  assert.equal(out.target, 1);
  assert.equal(out.gap, 1);
  assert.equal(out.trigger, true);
});

test('shouldFetchStock: rejects invalid client size', () => {
  for (const bad of [-1, NaN, null, undefined, 'five']) {
    const out = shouldFetchStock({ clientLibrarySize: bad, durationSec: 60 });
    assert.equal(out.trigger, false, `should not trigger with clientLibrarySize=${bad}`);
    assert.equal(out.reason, 'invalid_client_size');
  }
});

test('shouldFetchStock: rejects invalid duration', () => {
  for (const bad of [-1, 0, NaN, Infinity, null, undefined, 'sixty']) {
    const out = shouldFetchStock({ clientLibrarySize: 5, durationSec: bad });
    assert.equal(out.trigger, false, `should not trigger with durationSec=${bad}`);
    assert.equal(out.reason, 'invalid_duration');
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

test('rebalance: leaves insertions alone when stock ratio already <= max', () => {
  // 2 client + 1 stock = 33% stock, default cap 0.4 → no trim
  const picks = insArr('client', 'client', 'pixabay');
  const out = rebalanceClientFirst({ insertions: picks, usableClientCount: 5 });
  assert.equal(out.insertions.length, 3);
  assert.equal(out.droppedStockCount, 0);
  assert.equal(out.action, null);
});

test('rebalance: trims stock from the tail when ratio exceeds max', () => {
  // 2 client + 4 stock = 67% stock, default cap 0.4. Need stock <= 0.4*total.
  // After dropping last stock: 2 client + 3 stock = 60% stock (still over).
  // After 2 drops: 2 client + 2 stock = 50% (still over).
  // After 3 drops: 2 client + 1 stock = 33% (under cap) → stop.
  const picks = insArr('client', 'pixabay', 'client', 'pixabay', 'pixabay', 'pixabay');
  const out = rebalanceClientFirst({ insertions: picks, usableClientCount: 5 });
  assert.equal(out.droppedStockCount, 3);
  assert.equal(out.insertions.length, 3);
  assert.equal(out.insertions.filter((i) => i.provenance === 'pixabay').length, 1);
  assert.match(out.action ?? '', /trimmed_3/);
});

test('rebalance: trims latest-time stock first (preserves early-video stock)', () => {
  // ordered chronologically; expect the LAST stock pick to be removed first
  const picks = [
    ins('a0', 'pixabay'),  // t=early
    ins('a1', 'client'),
    ins('a2', 'pixabay'),  // t=late — should be dropped
  ];
  // 1 client + 2 stock = 67% > 0.4. Drop last stock → 1c+1s=50% > 0.4. Drop next stock (now last) → 1c+0s.
  const out = rebalanceClientFirst({ insertions: picks, usableClientCount: 3 });
  assert.equal(out.droppedStockCount, 2);
  assert.equal(out.insertions.length, 1);
  assert.equal(out.insertions[0].asset_id, 'a1');
});

test('rebalance: respects custom maxStockRatio override', () => {
  // 2 client + 2 stock = 50% stock. With maxStockRatio=0.5, ratio is exactly at cap → no trim.
  const picks = insArr('client', 'pixabay', 'client', 'pixabay');
  const out = rebalanceClientFirst({ insertions: picks, usableClientCount: 5, maxStockRatio: 0.5 });
  assert.equal(out.droppedStockCount, 0);
});

test('rebalance: maxStockRatio=0.3 (stricter) trims more aggressively', () => {
  // 2 client + 2 stock = 50% > 0.3. Drop last stock → 2c+1s=33% > 0.3. Drop again → 2c+0s=0%.
  const picks = insArr('client', 'pixabay', 'client', 'pixabay');
  const out = rebalanceClientFirst({ insertions: picks, usableClientCount: 5, maxStockRatio: 0.3 });
  assert.equal(out.droppedStockCount, 2);
  assert.equal(out.insertions.length, 2);
  assert.equal(out.insertions.every((i) => i.provenance === 'client'), true);
});

test('rebalance: tolerates missing provenance — treats undefined as client (legacy rows)', () => {
  // legacy rows that pre-date PR-A may not carry provenance; default-as-client matches downloadBrollAssets behavior.
  const picks = [
    { asset_id: 'a0' },
    { asset_id: 'a1', provenance: 'pixabay' },
  ];
  const out = rebalanceClientFirst({ insertions: picks, usableClientCount: 3 });
  assert.equal(out.droppedStockCount, 1);
  assert.equal(out.insertions.length, 1);
  assert.equal(out.insertions[0].asset_id, 'a0');
});

test('rebalance: returns metadata fields callers can read for response.insertions.sourceBalance', () => {
  const picks = insArr('client', 'pixabay', 'pixabay', 'pixabay');
  const out = rebalanceClientFirst({ insertions: picks, usableClientCount: 5, maxStockRatio: 0.4 });
  assert.equal(typeof out.droppedStockCount, 'number');
  assert.equal(typeof out.action, 'string');
  assert.ok(Array.isArray(out.insertions));
});
