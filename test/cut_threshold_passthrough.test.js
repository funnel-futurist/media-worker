/**
 * test/cut_threshold_passthrough.test.js
 *
 * 2026-06-10: lock in the per-job cut-precision tunables that were
 * previously hardcoded in clean_mode_pipeline.js, silently no-op'ing any
 * editing_defaults / optionsOverride attempt to tune them. Chelsea flagged
 * 3 cut-precision symptoms in the Jun 8-14 EnableSNP batch; the experiment
 * proving these options weren't reaching the pipeline is what produced
 * this fix.
 *
 * Pure tests on buildPipelineOpts — full pipeline integration runs on
 * Railway when a job fires.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPipelineOpts } from '../lib/clean_mode_pipeline.js';

test('buildPipelineOpts: cutSafetyMode defaults to undefined when omitted', () => {
  const opts = buildPipelineOpts({ options: {} });
  assert.equal(opts.cutSafetyMode, undefined);
});

test('buildPipelineOpts: cutSafetyMode forwards string values verbatim', () => {
  for (const v of ['safe_only', 'safe_and_soft', 'all']) {
    const opts = buildPipelineOpts({ options: { cutSafetyMode: v } });
    assert.equal(opts.cutSafetyMode, v);
  }
});

test('buildPipelineOpts: cutSafetyMode rejects non-string', () => {
  // Non-string values resolve to undefined (defense — route should 400 first,
  // but the helper is conservative).
  const opts = buildPipelineOpts({ options: { cutSafetyMode: 42 } });
  assert.equal(opts.cutSafetyMode, undefined);
});

test('buildPipelineOpts: retainSec defaults to undefined when omitted', () => {
  const opts = buildPipelineOpts({ options: {} });
  assert.equal(opts.retainSec, undefined);
});

test('buildPipelineOpts: retainSec forwards a positive number', () => {
  for (const v of [0.10, 0.15, 0.20, 0.25, 0.50]) {
    const opts = buildPipelineOpts({ options: { retainSec: v } });
    assert.equal(opts.retainSec, v);
  }
});

test('buildPipelineOpts: retainSec rejects non-number', () => {
  for (const v of ['0.25', null, true, {}]) {
    const opts = buildPipelineOpts({ options: { retainSec: v } });
    assert.equal(opts.retainSec, undefined, `value ${JSON.stringify(v)} should coerce to undefined`);
  }
});

test('buildPipelineOpts: omitting options entirely leaves both tunables undefined', () => {
  const opts = buildPipelineOpts({});
  assert.equal(opts.cutSafetyMode, undefined);
  assert.equal(opts.retainSec, undefined);
});
