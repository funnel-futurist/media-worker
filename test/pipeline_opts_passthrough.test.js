/**
 * test/pipeline_opts_passthrough.test.js
 *
 * Regression test for the bug where per-job broll overrides
 * (brollStockBlendRatio, brollMaxStockRatio, brollClientPreference,
 * brollMaxClientCount) were validated by the route, accepted by the
 * portal, sent across the wire, BUT silently dropped at the pipeline
 * entrypoint because buildPipelineOpts didn't copy them from
 * `req.options` into `opts`.
 *
 * Symptom in production: Phil's row 0056ba10 fired with
 *   { brollClientPreference: 'minimal', brollMaxClientCount: 2,
 *     brollMaxStockRatio: 0.85 }
 * returned 5 client + 3 stock — identical Gemini-variance run to a no-
 * override invocation, the hard-cap rebalancer never trimmed.
 *
 * This test asserts two things:
 *
 *   1. PASS-THROUGH: every documented per-job override field surfaces on
 *      the returned opts object with the exact value from `req.options`.
 *      If a future PR adds a new override and forgets the write half of
 *      the wire, this test breaks.
 *
 *   2. INTEGRATION WITH REBALANCER: opts.brollMaxClientCount=2 fed into
 *      rebalanceClientFirst (the exact downstream consumer) trims a
 *      5-client + 3-stock pick set down to 2 client + 3 stock. This
 *      proves the value actually drives the cap behavior, not just that
 *      the field exists on the object.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPipelineOpts } from '../lib/clean_mode_pipeline.js';
import { rebalanceClientFirst } from '../lib/stock_library_merge.js';

// ── 1. PASS-THROUGH ──────────────────────────────────────────────────

test('buildPipelineOpts: passes brollStockBlendRatio through from req.options', () => {
  const opts = buildPipelineOpts({ options: { brollStockBlendRatio: 0.75 } });
  assert.equal(opts.brollStockBlendRatio, 0.75);
});

test('buildPipelineOpts: passes brollMaxStockRatio through from req.options', () => {
  const opts = buildPipelineOpts({ options: { brollMaxStockRatio: 0.85 } });
  assert.equal(opts.brollMaxStockRatio, 0.85);
});

test('buildPipelineOpts: passes brollClientPreference through from req.options', () => {
  const opts = buildPipelineOpts({ options: { brollClientPreference: 'minimal' } });
  assert.equal(opts.brollClientPreference, 'minimal');
});

test('buildPipelineOpts: passes brollMaxClientCount through from req.options', () => {
  const opts = buildPipelineOpts({ options: { brollMaxClientCount: 2 } });
  assert.equal(opts.brollMaxClientCount, 2);
});

test('buildPipelineOpts: passes all four overrides simultaneously (Phil-style body)', () => {
  const opts = buildPipelineOpts({
    options: {
      brollStockBlendRatio: 0.75,
      brollMaxStockRatio: 0.85,
      brollClientPreference: 'minimal',
      brollMaxClientCount: 2,
    },
  });
  assert.equal(opts.brollStockBlendRatio, 0.75);
  assert.equal(opts.brollMaxStockRatio, 0.85);
  assert.equal(opts.brollClientPreference, 'minimal');
  assert.equal(opts.brollMaxClientCount, 2);
});

test('buildPipelineOpts: missing overrides remain undefined (so use-site defaults apply)', () => {
  const opts = buildPipelineOpts({ options: {} });
  assert.equal(opts.brollStockBlendRatio, undefined);
  assert.equal(opts.brollMaxStockRatio, undefined);
  assert.equal(opts.brollClientPreference, undefined);
  assert.equal(opts.brollMaxClientCount, undefined);
});

test('buildPipelineOpts: handles missing req.options entirely', () => {
  const opts = buildPipelineOpts({});
  assert.equal(opts.brollStockBlendRatio, undefined);
  assert.equal(opts.brollMaxStockRatio, undefined);
  assert.equal(opts.brollClientPreference, undefined);
  assert.equal(opts.brollMaxClientCount, undefined);
  // Sanity: legacy fields still resolve to their defaults
  assert.equal(opts.outputWidth, 1080);
  assert.equal(opts.outputHeight, 1920);
});

// ── 2. INTEGRATION WITH REBALANCER ───────────────────────────────────
// The exact failure mode that motivated this PR: route accepts a body,
// pipeline builds opts, opts.brollMaxClientCount flows into the
// rebalancer, rebalancer trims. If any link breaks, this test breaks.

test('integration: brollMaxClientCount=2 in req.options trims 5c+3s pick set down to 2c+3s', () => {
  // Step 1: route hands the body to runCleanModePipeline; we exercise
  // the opts builder directly because the full pipeline does ffmpeg I/O.
  const opts = buildPipelineOpts({
    options: { brollMaxClientCount: 2 },
  });

  // Step 2: clean_mode_pipeline.js calls rebalanceClientFirst with
  // opts.brollMaxClientCount. Mirror that wiring here.
  const insertions = [
    { asset_id: 'c-1', provenance: 'client', startSec: 5 },
    { asset_id: 'c-2', provenance: 'client', startSec: 12 },
    { asset_id: 'c-3', provenance: 'client', startSec: 20 },
    { asset_id: 'c-4', provenance: 'client', startSec: 35 },
    { asset_id: 'c-5', provenance: 'client', startSec: 48 },
    { asset_id: 's-1', provenance: 'pixabay', startSec: 28 },
    { asset_id: 's-2', provenance: 'pixabay', startSec: 42 },
    { asset_id: 's-3', provenance: 'pixabay', startSec: 60 },
  ];

  const rebalanced = rebalanceClientFirst({
    insertions,
    usableClientCount: 8,
    maxStockRatio: 0.85,
    stockCandidatesAvailable: 10,
    maxClientCount: opts.brollMaxClientCount,
  });

  const finalClient = rebalanced.insertions.filter((i) => i.provenance !== 'pixabay').length;
  const finalStock = rebalanced.insertions.filter((i) => i.provenance === 'pixabay').length;

  // The cap fired: 5 client → 2 client (3 dropped tail-first), stock untouched.
  assert.equal(finalClient, 2, 'should trim client picks down to the brollMaxClientCount cap');
  assert.equal(finalStock, 3, 'stock picks should not be trimmed by the client cap');
  assert.equal(rebalanced.droppedClientCount, 3, 'should record 3 client picks dropped');

  // The kept client picks are the EARLIEST two (brand-anchor moments).
  const keptClientIds = rebalanced.insertions
    .filter((i) => i.provenance !== 'pixabay')
    .map((i) => i.asset_id);
  assert.deepEqual(keptClientIds, ['c-1', 'c-2'], 'should keep the earliest client picks');
});

test('integration: brollMaxClientCount omitted → no client trim (legacy behavior preserved)', () => {
  const opts = buildPipelineOpts({ options: {} });
  // Confirm the field is undefined — this is what every prod job
  // looked like BEFORE per-job overrides existed.
  assert.equal(opts.brollMaxClientCount, undefined);

  const insertions = [
    { asset_id: 'c-1', provenance: 'client', startSec: 5 },
    { asset_id: 'c-2', provenance: 'client', startSec: 12 },
    { asset_id: 'c-3', provenance: 'client', startSec: 20 },
    { asset_id: 'c-4', provenance: 'client', startSec: 35 },
    { asset_id: 'c-5', provenance: 'client', startSec: 48 },
    { asset_id: 's-1', provenance: 'pixabay', startSec: 28 },
    { asset_id: 's-2', provenance: 'pixabay', startSec: 42 },
    { asset_id: 's-3', provenance: 'pixabay', startSec: 60 },
  ];

  const rebalanced = rebalanceClientFirst({
    insertions,
    usableClientCount: 8,
    maxStockRatio: 0.85,
    stockCandidatesAvailable: 10,
    maxClientCount: opts.brollMaxClientCount,
  });

  // No cap → no client trim. Stock ratio is 3/8 = 0.375 < 0.85 → no stock trim either.
  // All 8 picks preserved.
  assert.equal(rebalanced.insertions.length, 8, 'with no cap, all picks preserved');
  assert.equal(rebalanced.droppedClientCount, 0);
  assert.equal(rebalanced.droppedStockCount, 0);
});
