/**
 * test/ffmpeg_trim_concat.test.js
 *
 * Covers the cut-step trim+concat helper:
 *   - buildKeepSegments (pure): inverse-of-cuts, merge, clamp, throw-on-empty
 *   - 2026-06-10 OOM fix (source-snapshot, matching the repo's no-ffmpeg test
 *     convention): BATCH_THRESHOLD lowered to 10, the single-pass→batched
 *     FALLBACK wiring, and _batchedTrimConcat's configurable batchSize.
 *
 * Why the snapshot half: the batching/fallback paths shell out to ffmpeg, so
 * they can't run in CI. These lock the wiring that stops long, many-segment
 * ads (SupportED "You're Not Alone" BODY 3) from killing the cut step.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildKeepSegments } from '../lib/ffmpeg_trim_concat.js';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'ffmpeg_trim_concat.js'),
  'utf8',
);

// ── buildKeepSegments (pure) ─────────────────────────────────────────────

test('buildKeepSegments: single mid cut → keep the two surrounding windows', () => {
  assert.deepEqual(buildKeepSegments([{ start: 10, end: 20 }], 100), [
    { start: 0, end: 10 },
    { start: 20, end: 100 },
  ]);
});

test('buildKeepSegments: cut at 0 → keep only the tail', () => {
  assert.deepEqual(buildKeepSegments([{ start: 0, end: 15 }], 60), [{ start: 15, end: 60 }]);
});

test('buildKeepSegments: overlapping/adjacent cuts merge before inverting', () => {
  assert.deepEqual(buildKeepSegments([{ start: 10, end: 20 }, { start: 20, end: 30 }], 50), [
    { start: 0, end: 10 },
    { start: 30, end: 50 },
  ]);
});

test('buildKeepSegments: many cuts → many keep-segments (engages batching)', () => {
  // 12 evenly-spaced 1s cuts → 13 keep-segments → well over BATCH_THRESHOLD(10).
  const cuts = Array.from({ length: 12 }, (_, i) => ({ start: i * 10 + 4, end: i * 10 + 5 }));
  const keep = buildKeepSegments(cuts, 130);
  assert.equal(keep.length, 13);
});

test('buildKeepSegments: cuts covering the whole source throw', () => {
  assert.throws(() => buildKeepSegments([{ start: 0, end: 100 }], 100), /nothing to keep/);
});

// ── 2026-06-10 OOM fix wiring (source-snapshot) ──────────────────────────

test('cut step: BATCH_THRESHOLD lowered to 10 + FALLBACK_BATCH_SIZE defined', () => {
  assert.match(SRC, /const BATCH_THRESHOLD = 10;/, 'BATCH_THRESHOLD must be 10 (lowered from 20 to halve per-pass memory)');
  assert.match(SRC, /const FALLBACK_BATCH_SIZE = 5;/, 'fallback batch size must be defined');
});

test('cut step: runTrimConcat falls back to batched on single-pass failure', () => {
  // try { _singlePassTrimConcat } catch { _batchedTrimConcat(..., FALLBACK_BATCH_SIZE) }
  assert.match(
    SRC,
    /try \{\s*await _singlePassTrimConcat\([\s\S]*?\} catch \(err\) \{[\s\S]*?_batchedTrimConcat\([\s\S]*?FALLBACK_BATCH_SIZE\)/,
    'single-pass cut must fall back to small-batch on failure instead of hard-failing the job',
  );
});

test('cut step: _batchedTrimConcat takes a configurable batchSize (default BATCH_THRESHOLD)', () => {
  assert.match(
    SRC,
    /async function _batchedTrimConcat\([^)]*batchSize = BATCH_THRESHOLD\)/,
    '_batchedTrimConcat must accept a batchSize param so the fallback can use a smaller size',
  );
  assert.match(SRC, /i \+= batchSize/, 'batch splitting must use the batchSize param, not the constant');
});
