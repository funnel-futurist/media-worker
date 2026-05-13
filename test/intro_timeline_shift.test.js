/**
 * test/intro_timeline_shift.test.js
 *
 * PR-L regression guard for the +introOffsetSec timeline shift.
 *
 * Two systems get shifted forward when the intro hook applies:
 *   1. b-roll insertions (offsetInsertions in clean_mode_pipeline.js)
 *   2. subtitle word events (remapWordsThroughCuts in subtitle_burn.js,
 *      via the new introOffsetSec opts arg)
 *
 * The critical regression risk (per the approved plan): PR #127 just
 * fixed a 2-second subtitle drift caused by `remapWordsThroughCuts` not
 * merging overlapping cuts. PR-L adds an additive +introOffsetSec to the
 * same function. The shift is mathematically trivial (single addition
 * at the end), but the test fixture below combines BOTH overlapping cuts
 * AND an intro offset in the same scenario so:
 *
 *   - if a future PR re-introduces the overlap bug, the intro offset
 *     will MASK the regression because both adjust the same field
 *   - this test exercises the composition explicitly and asserts the
 *     final timestamp is overlap-merged-shift PLUS intro-offset
 *
 * Plus standard unit tests for offsetInsertions (pure helper) and
 * remapWordsThroughCuts (with the new opts.introOffsetSec).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { offsetInsertions } from '../lib/clean_mode_pipeline.js';
import { remapWordsThroughCuts } from '../lib/subtitle_burn.js';

// ── offsetInsertions: pure helper ────────────────────────────────────

test('offsetInsertions: shifts every insertion startSec/endSec by offsetSec', () => {
  const input = [
    { asset_id: 'a', startSec: 5,  endSec: 12, provenance: 'client' },
    { asset_id: 'b', startSec: 20, endSec: 27, provenance: 'pixabay' },
  ];
  const out = offsetInsertions(input, 5);
  assert.deepEqual(out, [
    { asset_id: 'a', startSec: 10, endSec: 17, provenance: 'client' },
    { asset_id: 'b', startSec: 25, endSec: 32, provenance: 'pixabay' },
  ]);
});

test('offsetInsertions: does NOT mutate the input array', () => {
  const input = [{ asset_id: 'a', startSec: 5, endSec: 12 }];
  const out = offsetInsertions(input, 5);
  // Input untouched.
  assert.equal(input[0].startSec, 5);
  assert.equal(input[0].endSec, 12);
  // Output is a new array of new objects.
  assert.notEqual(out, input);
  assert.notEqual(out[0], input[0]);
});

test('offsetInsertions: preserves all non-time fields on each insertion', () => {
  const out = offsetInsertions([
    { asset_id: 'a', startSec: 5, endSec: 12, reason: 'because', provenance: 'client', extraField: { nested: 42 } },
  ], 5);
  assert.equal(out[0].asset_id, 'a');
  assert.equal(out[0].reason, 'because');
  assert.equal(out[0].provenance, 'client');
  assert.deepEqual(out[0].extraField, { nested: 42 });
});

test('offsetInsertions: 0 offset is a no-op (returns a copy unchanged)', () => {
  const input = [{ asset_id: 'a', startSec: 5, endSec: 12 }];
  const out = offsetInsertions(input, 0);
  assert.deepEqual(out, input);
  assert.notEqual(out, input); // still a copy
});

test('offsetInsertions: negative offset is also a no-op (legacy-safe)', () => {
  const input = [{ asset_id: 'a', startSec: 5, endSec: 12 }];
  const out = offsetInsertions(input, -3);
  assert.deepEqual(out, input);
});

test('offsetInsertions: non-array input returns []', () => {
  assert.deepEqual(offsetInsertions(null, 5), []);
  assert.deepEqual(offsetInsertions(undefined, 5), []);
  assert.deepEqual(offsetInsertions('not an array', 5), []);
});

test('offsetInsertions: NaN/Infinity offset is a no-op (defensive)', () => {
  const input = [{ asset_id: 'a', startSec: 5, endSec: 12 }];
  assert.deepEqual(offsetInsertions(input, NaN), input);
  assert.deepEqual(offsetInsertions(input, Infinity), input);
});

// ── remapWordsThroughCuts with introOffsetSec ────────────────────────

test('remapWordsThroughCuts: introOffsetSec=0 (default) preserves pre-PR-L behavior exactly', () => {
  const words = [
    { word: 'A', start_ms: 100,  end_ms: 200 },
    { word: 'B', start_ms: 2000, end_ms: 2100 },
  ];
  const cuts = [{ start: 1.0, end: 1.5 }];
  // Pre-PR-L behavior: B shifts back by 500ms (the cut duration).
  const out = remapWordsThroughCuts(words, cuts);
  assert.equal(out[0].word, 'A');
  assert.equal(out[0].start_ms, 100);
  assert.equal(out[1].word, 'B');
  assert.equal(out[1].start_ms, 1500);
});

test('remapWordsThroughCuts: introOffsetSec=5 shifts every word forward by 5000ms on top of the cut-back-shift', () => {
  const words = [
    { word: 'A', start_ms: 100,  end_ms: 200 },
    { word: 'B', start_ms: 2000, end_ms: 2100 },
  ];
  const cuts = [{ start: 1.0, end: 1.5 }];
  const out = remapWordsThroughCuts(words, cuts, { introOffsetSec: 5 });
  // A was at 100ms, no cuts before it → backshift=0, forward shift=5000.
  assert.equal(out[0].start_ms, 100 + 5000);
  // B was at 2000ms, backshift=500 (cut from 1000-1500), then +5000.
  assert.equal(out[1].start_ms, 1500 + 5000);
});

test('remapWordsThroughCuts: words inside a cut span are still DROPPED, even with intro offset', () => {
  const words = [
    { word: 'A',     start_ms: 100,  end_ms: 200 },
    { word: 'DROP',  start_ms: 1200, end_ms: 1300 }, // inside [1.0, 1.5]
    { word: 'C',     start_ms: 2000, end_ms: 2100 },
  ];
  const cuts = [{ start: 1.0, end: 1.5 }];
  const out = remapWordsThroughCuts(words, cuts, { introOffsetSec: 5 });
  assert.equal(out.length, 2, 'word inside cut should be dropped');
  assert.equal(out[0].word, 'A');
  assert.equal(out[1].word, 'C');
});

// ── CRITICAL: PR #127 overlap-merge + PR-L intro offset COMPOSED ────
// This is the regression guard the approved plan called out as the
// top risk. The two fixes must compose: overlap-merge happens first
// (so the cut sum is correct), THEN the intro offset is added.

test('PR-L regression guard: overlapping cuts merge first, THEN intro offset applies (PR #127 + PR-L composed)', () => {
  // The exact fixture pattern from PR #127's repro: slate [0, 5.76]
  // + silence [0.15, 0.912] + silence [4.45, 5.71]. Before PR #127
  // these summed to 5.76 + 0.762 + 1.26 = 7.78s and shifted every
  // word ~2s too far back. After PR #127 they merge to a single
  // [0, 5.76] (5.76s removed), which is the canonical span.
  //
  // PR-L adds +introOffsetSec on top. If a future change re-introduces
  // the PR #127 overcount, the final timestamp would be off by ~2s
  // EVEN WITH the intro offset applied — this test catches that.
  const words = [
    { word: 'FIRST',  start_ms: 5800,  end_ms: 5900 },   // just after the merged cut
    { word: 'SECOND', start_ms: 8000,  end_ms: 8100 },
  ];
  const cuts = [
    { start: 0,    end: 5.76 },   // slate
    { start: 0.15, end: 0.912 },  // overlaps slate
    { start: 4.45, end: 5.71 },   // overlaps slate
  ];

  // Expected (PR #127 merge → single [0, 5.76]):
  //   FIRST  at 5800ms - 5760ms backshift = 40ms post-merge
  //   SECOND at 8000ms - 5760ms backshift = 2240ms post-merge
  // PR-L adds +5000ms:
  //   FIRST  at 40   + 5000 = 5040ms
  //   SECOND at 2240 + 5000 = 7240ms
  //
  // If overlap-merge bug returns (sum=7780ms instead of 5760ms):
  //   FIRST  would clamp to max(0, 5800-7780)+5000 = 0+5000 = 5000ms (off by 40)
  //   SECOND would be max(0, 8000-7780)+5000 = 220+5000 = 5220ms (off by 2020!)
  // The 2020ms drift would be the regression — this test would catch it.

  const out = remapWordsThroughCuts(words, cuts, { introOffsetSec: 5 });

  assert.equal(out.length, 2);
  assert.equal(out[0].word, 'FIRST');
  assert.equal(out[0].start_ms, 5040, 'FIRST should be at merged-cut-shift (40ms) + intro (5000ms) = 5040ms');
  assert.equal(out[1].word, 'SECOND');
  assert.equal(out[1].start_ms, 7240, 'SECOND should be at merged-cut-shift (2240ms) + intro (5000ms) = 7240ms');
});

// ── Integration: offset + remap produce aligned timelines ───────────
// Sanity that an insertion at picker-time t and a word at picker-time t
// land at the SAME post-offset time after both shifts are applied.
// This is the "did the two shifts compose cleanly?" test.

test('PR-L integration: insertion at t=10s on cut.mp4 and word at t=10s on cut.mp4 align at t=15s after both shifts', () => {
  // Picker emits an insertion at startSec=10 on cut.mp4.
  // Subtitle has a word at start_ms=10000 on cut.mp4 (post-remap).
  // After offset by +5s, both should land at the same point on the
  // cut_with_intro timeline.

  // Insertion side: cut.mp4 timeline. No cuts to apply in this fixture.
  const insertion = [{ asset_id: 'a', startSec: 10, endSec: 17 }];
  const shiftedInsertion = offsetInsertions(insertion, 5);

  // Subtitle side: same cut.mp4 timeline. No cuts to apply.
  const words = [{ word: 'HERE', start_ms: 10000, end_ms: 10500 }];
  const shiftedWords = remapWordsThroughCuts(words, [], { introOffsetSec: 5 });

  // Both should map to 15s on the cut_with_intro timeline.
  assert.equal(shiftedInsertion[0].startSec, 15);
  assert.equal(shiftedWords[0].start_ms, 15000);
});
