/**
 * test/silence_merge.test.js
 *
 * Pure-function tests for lib/clean_mode_pipeline.js:mergeAdjacentSilences
 * — the PR #102 fix for the "trailing-off → tiny blip → restart → stops
 * again" stumble pattern. The cut detector sees one continuous low-energy
 * region after merge instead of two sub-spans, so it correctly produces a
 * single cut covering the full silence.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAdjacentSilences } from '../lib/clean_mode_pipeline.js';

test('merge: empty / non-array input → empty result', () => {
  assert.deepEqual(mergeAdjacentSilences([]), []);
  assert.deepEqual(mergeAdjacentSilences(null), []);
  assert.deepEqual(mergeAdjacentSilences(undefined), []);
  assert.deepEqual(mergeAdjacentSilences('not an array'), []);
});

test('merge: single span passes through untouched', () => {
  const out = mergeAdjacentSilences([{ start: 1.0, end: 3.0 }]);
  assert.deepEqual(out, [{ start: 1.0, end: 3.0 }]);
});

test('merge: spans with gap <= tolerance get merged (B3 1:11-1:13 case)', () => {
  // Real B3 fixture: silenceMap [84.62-87.25] + [87.31-89.75] separated
  // by 0.06s. Should merge into one [84.62-89.75] span (5.13s).
  const out = mergeAdjacentSilences([
    { start: 84.62, end: 87.25 },
    { start: 87.31, end: 89.75 },
  ], 0.4);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 84.62);
  assert.equal(out[0].end, 89.75);
});

test('merge: spans with gap > tolerance stay separate', () => {
  // 0.5s gap is wider than 0.4s tolerance — keep separate
  const out = mergeAdjacentSilences([
    { start: 1.0, end: 3.0 },
    { start: 3.5, end: 5.0 },
  ], 0.4);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { start: 1.0, end: 3.0 });
  assert.deepEqual(out[1], { start: 3.5, end: 5.0 });
});

test('merge: gap exactly equal to tolerance counts as adjacent (≤)', () => {
  // gap = 0.4s → merge (uses ≤, not <)
  const out = mergeAdjacentSilences([
    { start: 1.0, end: 3.0 },
    { start: 3.4, end: 5.0 },
  ], 0.4);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 1.0);
  assert.equal(out[0].end, 5.0);
});

test('merge: chain of close spans collapses into one', () => {
  // 4 spans, each gap 0.1s — should all collapse into one
  const out = mergeAdjacentSilences([
    { start: 1.0, end: 2.0 },
    { start: 2.1, end: 3.0 },
    { start: 3.1, end: 4.0 },
    { start: 4.1, end: 5.0 },
  ], 0.4);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 1.0);
  assert.equal(out[0].end, 5.0);
});

test('merge: mixed close-and-far spans produce mixed result', () => {
  // [1-2] gap 0.1 [2.1-3] | gap 1.0 (FAR) | [4-5] gap 0.2 [5.2-6] gap 0.3 [6.3-7]
  // First two merge → [1-3]. Big gap 1.0s → boundary. Then [4-5] [5.2-6] [6.3-7]
  // all chain-merge (each gap ≤ 0.4) into [4-7].
  // Expect 2 spans: [[1, 3], [4, 7]]
  const out = mergeAdjacentSilences([
    { start: 1.0, end: 2.0 },
    { start: 2.1, end: 3.0 },
    { start: 4.0, end: 5.0 },
    { start: 5.2, end: 6.0 },
    { start: 6.3, end: 7.0 },
  ], 0.4);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { start: 1.0, end: 3.0 });
  assert.deepEqual(out[1], { start: 4.0, end: 7.0 });
});

test('merge: unsorted input gets sorted internally', () => {
  // Same as previous test but reverse-ordered input
  const out = mergeAdjacentSilences([
    { start: 6.3, end: 7.0 },
    { start: 5.2, end: 6.0 },
    { start: 4.0, end: 5.0 },
    { start: 2.1, end: 3.0 },
    { start: 1.0, end: 2.0 },
  ], 0.4);
  assert.deepEqual(out, [
    { start: 1.0, end: 3.0 },
    { start: 4.0, end: 7.0 },
  ]);
});

test('merge: overlapping spans are merged (start of next < end of prev)', () => {
  const out = mergeAdjacentSilences([
    { start: 1.0, end: 5.0 },
    { start: 3.0, end: 7.0 },     // overlaps
  ], 0.4);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 1.0);
  assert.equal(out[0].end, 7.0);
});

test('merge: invalid spans (end <= start) are filtered out', () => {
  const out = mergeAdjacentSilences([
    { start: 1.0, end: 3.0 },
    { start: 4.0, end: 4.0 },          // end == start
    { start: 5.0, end: 4.5 },          // end < start
    { start: 6.0, end: 7.0 },
  ], 0.4);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { start: 1.0, end: 3.0 });
  assert.deepEqual(out[1], { start: 6.0, end: 7.0 });
});

test('merge: custom gapTolSec respected', () => {
  // gap 0.8s with tolerance 1.0 → merge
  const merged = mergeAdjacentSilences([
    { start: 1.0, end: 2.0 },
    { start: 2.8, end: 4.0 },
  ], 1.0);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], { start: 1.0, end: 4.0 });
  // Same fixture with tolerance 0.5 → stay separate
  const separate = mergeAdjacentSilences([
    { start: 1.0, end: 2.0 },
    { start: 2.8, end: 4.0 },
  ], 0.5);
  assert.equal(separate.length, 2);
});

test('merge: returns plain {start, end} only — strips other fields', () => {
  // Defensive: even if caller passes objects with extra fields (e.g. from
  // detectAudioSilences), the merge output is normalized.
  const out = mergeAdjacentSilences([
    { start: 1.0, end: 2.0, extra: 'ignored', dur: 1.0 },
    { start: 2.1, end: 3.0, extra: 'also ignored' },
  ], 0.4);
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]).sort(), ['end', 'start']);
});
