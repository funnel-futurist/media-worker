import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPipelineOpts } from '../lib/clean_mode_pipeline.js';

test('buildPipelineOpts: skipSlate defaults to false when omitted', () => {
  const opts = buildPipelineOpts({ options: {} });
  assert.equal(opts.skipSlate, false);
});

test('buildPipelineOpts: skipSlate is true when options.skipSlate === true', () => {
  const opts = buildPipelineOpts({ options: { skipSlate: true } });
  assert.equal(opts.skipSlate, true);
});

test('buildPipelineOpts: skipSlate is false for non-boolean truthy values (defensive coercion)', () => {
  // The pipeline reads `opts.skipSlate === true`, so any non-strict-true
  // value should normalize to false. Matches the skipBroll / skipPixabay /
  // skipSubtitles convention.
  for (const v of ['true', 1, 'yes', {}, []]) {
    const opts = buildPipelineOpts({ options: { skipSlate: v } });
    assert.equal(opts.skipSlate, false, `value ${JSON.stringify(v)} should coerce to false`);
  }
});

test('buildPipelineOpts: skipSlate=false stays false', () => {
  const opts = buildPipelineOpts({ options: { skipSlate: false } });
  assert.equal(opts.skipSlate, false);
});

test('buildPipelineOpts: no req.options entirely → skipSlate is false', () => {
  const opts = buildPipelineOpts({});
  assert.equal(opts.skipSlate, false);
});
