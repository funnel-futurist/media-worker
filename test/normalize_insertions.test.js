/**
 * test/normalize_insertions.test.js
 *
 * Pure-function tests for lib/clean_mode_pipeline.js:normalizeInsertions —
 * the sort/clamp/dedupe step that runs between the picker and ffmpeg compose.
 *
 * No I/O, no ffmpeg, no real network. The compose step itself is exercised
 * end-to-end by the deploy-time E2E since it requires real video assets.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInsertions } from '../lib/clean_mode_pipeline.js';

// NOTE (PR-K): the legacy tests below test sort/clamp/overlap behavior with
// short fixture durations (1–5s) that pre-dated the 6s minimum-duration
// floor introduced in PR-K. Each pre-PR-K test opts out of the floor via
// `{ brollMinDurationSec: 0 }` so it continues to exercise the specific
// behavior it was written for. The PR-K-specific tests at the bottom
// exercise the floor directly.

const NO_MIN = { brollMinDurationSec: 0 };

test('normalize: sorts insertions by startSec', () => {
  const warnings = [];
  const out = normalizeInsertions(
    [
      { asset_id: 'b', startSec: 5.0, endSec: 7.0 },
      { asset_id: 'a', startSec: 1.0, endSec: 3.0 },
      { asset_id: 'c', startSec: 10.0, endSec: 12.0 },
    ],
    20,
    warnings,
    NO_MIN,
  );
  assert.deepEqual(out.map((i) => i.asset_id), ['a', 'b', 'c']);
  assert.deepEqual(warnings, []);
});

test('normalize: clamps endSec past cutDuration with a warning', () => {
  const warnings = [];
  const out = normalizeInsertions(
    [{ asset_id: 'tail', startSec: 8.0, endSec: 15.0 }],
    10,
    warnings,
    NO_MIN,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].endSec, 10);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /clamped endSec/);
});

test('normalize: drops empty windows after clamp', () => {
  // startSec >= cutDuration → clamped end ≤ start → window empty → drop
  const warnings = [];
  const out = normalizeInsertions(
    [
      { asset_id: 'past-end', startSec: 11.0, endSec: 12.0 },
      { asset_id: 'inverted', startSec: 5.0, endSec: 4.0 },
    ],
    10,
    warnings,
    NO_MIN,
  );
  assert.equal(out.length, 0);
  assert.equal(warnings.length, 2);
  for (const w of warnings) assert.match(w, /dropped/);
});

test('normalize: drops overlapping later insertion, keeps earlier', () => {
  const warnings = [];
  const out = normalizeInsertions(
    [
      { asset_id: 'first', startSec: 1.0, endSec: 5.0 },
      { asset_id: 'overlap', startSec: 3.0, endSec: 7.0 },        // overlaps first
      { asset_id: 'gap', startSec: 8.0, endSec: 10.0 },           // clean gap, kept
    ],
    20,
    warnings,
    NO_MIN,
  );
  assert.deepEqual(out.map((i) => i.asset_id), ['first', 'gap']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /overlaps with/);
});

test('normalize: drops back-to-back insertions only when they truly overlap (not when they touch)', () => {
  // 5.0 == 5.0 — touching but not overlapping. Keep both.
  const warnings = [];
  const out = normalizeInsertions(
    [
      { asset_id: 'a', startSec: 1.0, endSec: 5.0 },
      { asset_id: 'b', startSec: 5.0, endSec: 7.0 },
    ],
    10,
    warnings,
    NO_MIN,
  );
  assert.equal(out.length, 2);
  assert.deepEqual(warnings, []);
});

test('normalize: NaN/non-numeric start/end → drop with warning', () => {
  const warnings = [];
  const out = normalizeInsertions(
    [
      { asset_id: 'bad-start', startSec: 'oops', endSec: 5 },
      { asset_id: 'bad-end', startSec: 0, endSec: NaN },
      { asset_id: 'ok', startSec: 1, endSec: 2 },
    ],
    10,
    warnings,
    NO_MIN,
  );
  assert.deepEqual(out.map((i) => i.asset_id), ['ok']);
  assert.equal(warnings.filter((w) => /non-numeric/.test(w)).length, 2);
});

test('normalize: null/non-array input → empty result, no throw', () => {
  const warnings = [];
  assert.deepEqual(normalizeInsertions(null, 10, warnings, NO_MIN), []);
  assert.deepEqual(normalizeInsertions(undefined, 10, warnings, NO_MIN), []);
  assert.deepEqual(normalizeInsertions('not an array', 10, warnings, NO_MIN), []);
  assert.deepEqual(warnings, []);
});

test('normalize: preserves non-startSec/endSec fields on each row', () => {
  const warnings = [];
  const out = normalizeInsertions(
    [{ asset_id: 'a', startSec: 1, endSec: 2, reason: 'because', matchedPhrase: 'foo bar', extraField: 42 }],
    10,
    warnings,
    NO_MIN,
  );
  assert.equal(out[0].reason, 'because');
  assert.equal(out[0].matchedPhrase, 'foo bar');
  assert.equal(out[0].extraField, 42);
});

test('normalize: triple overlap chain — first wins, both later ones dropped', () => {
  const warnings = [];
  const out = normalizeInsertions(
    [
      { asset_id: 'a', startSec: 0, endSec: 6 },
      { asset_id: 'b', startSec: 2, endSec: 4 },
      { asset_id: 'c', startSec: 5, endSec: 7 },     // also overlaps a (a.end=6 > c.start=5)
    ],
    10,
    warnings,
    NO_MIN,
  );
  assert.deepEqual(out.map((i) => i.asset_id), ['a']);
  assert.equal(warnings.length, 2);
});

// ── PR-K: brollMinDurationSec floor ──────────────────────────────────
// Drop+warn behavior for sub-floor insertions. Picker is asked to aim
// for ~7s but may emit shorter spans on edge cases; the floor catches
// those before they reach ffmpeg compose as 2-3s flashes.

test('PR-K: insertion of 5.9s with min=6.0 → dropped with structured warning', () => {
  const warnings = [];
  const out = normalizeInsertions(
    [{ asset_id: 'short', startSec: 10.0, endSec: 15.9 }],   // 5.9s
    100,
    warnings,
    { brollMinDurationSec: 6.0 },
  );
  assert.equal(out.length, 0, 'sub-floor insertion must be dropped');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /min-duration: dropped short/);
  assert.match(warnings[0], /5\.90s < 6\.0s/);
});

test('PR-K: insertion of exactly 6.0s with min=6.0 → kept (boundary inclusive)', () => {
  const warnings = [];
  const out = normalizeInsertions(
    [{ asset_id: 'floor', startSec: 10.0, endSec: 16.0 }],   // exactly 6.0s
    100,
    warnings,
    { brollMinDurationSec: 6.0 },
  );
  assert.equal(out.length, 1, 'duration equal to floor must be kept');
  assert.equal(out[0].asset_id, 'floor');
  assert.deepEqual(warnings, []);
});

test('PR-K: insertion of 7.0s (target) → kept', () => {
  const warnings = [];
  const out = normalizeInsertions(
    [{ asset_id: 'target', startSec: 10.0, endSec: 17.0 }],
    100,
    warnings,
    { brollMinDurationSec: 6.0 },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].asset_id, 'target');
  assert.deepEqual(warnings, []);
});

test('PR-K: insertion of 8.0s (max) → kept', () => {
  const warnings = [];
  const out = normalizeInsertions(
    [{ asset_id: 'max', startSec: 10.0, endSec: 18.0 }],
    100,
    warnings,
    { brollMinDurationSec: 6.0 },
  );
  assert.equal(out.length, 1);
});

test('PR-K: insertion of 8.5s (above picker max) → still kept by normalize', () => {
  // Normalize does NOT clamp the upper bound; picker prompt discipline
  // owns the [6, 8] ceiling. Anything past 8s is the picker over-shooting,
  // not the normalizer's job to reject. Compose-time loop/trim handles
  // long requests against short source clips.
  const warnings = [];
  const out = normalizeInsertions(
    [{ asset_id: 'long', startSec: 10.0, endSec: 18.5 }],
    100,
    warnings,
    { brollMinDurationSec: 6.0 },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].endSec, 18.5);
  assert.deepEqual(warnings, []);
});

test('PR-K: cutDuration clamp can push duration below floor → drop AFTER clamp', () => {
  // Picker emits [120, 128] (8s) but cutDuration=121, so endSec clamps to 121,
  // leaving a 1s window. Should drop with the min-duration warning, NOT the
  // clamp warning alone — the floor applies post-clamp so we don't ship
  // 1-second flashes just because the source happened to be short.
  const warnings = [];
  const out = normalizeInsertions(
    [{ asset_id: 'clamped-short', startSec: 120.0, endSec: 128.0 }],
    121,                                                       // cutDuration
    warnings,
    { brollMinDurationSec: 6.0 },
  );
  assert.equal(out.length, 0);
  // We expect both warnings: clamp ran AND min-duration dropped.
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /clamped endSec/);
  assert.match(warnings[1], /min-duration: dropped clamped-short \(1\.00s < 6\.0s\)/);
});

test('PR-K: default (no opts) uses the 6.0s floor', () => {
  // Sanity check: pipeline call sites can omit the opts object entirely
  // and still get the new default behavior — the floor protects every
  // production job out of the box.
  const warnings = [];
  const out = normalizeInsertions(
    [
      { asset_id: 'short', startSec: 10.0, endSec: 13.0 },     // 3s — drop
      { asset_id: 'ok',    startSec: 30.0, endSec: 37.0 },     // 7s — keep
    ],
    100,
    warnings,
    // no opts argument at all
  );
  assert.deepEqual(out.map((i) => i.asset_id), ['ok']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /min-duration: dropped short/);
});

test('PR-K: custom floor of 8.0s drops 7s insertions', () => {
  // The floor is per-job overridable. Operators who want unusually long
  // b-roll can pass a higher value.
  const warnings = [];
  const out = normalizeInsertions(
    [
      { asset_id: 'a', startSec: 0, endSec: 7 },               // 7s, below 8s floor
      { asset_id: 'b', startSec: 20, endSec: 30 },             // 10s, above
    ],
    100,
    warnings,
    { brollMinDurationSec: 8.0 },
  );
  assert.deepEqual(out.map((i) => i.asset_id), ['b']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /min-duration: dropped a \(7\.00s < 8\.0s\)/);
});

test('PR-K: brollMinDurationSec: 0 disables the floor (back-compat path)', () => {
  // Explicit 0 keeps the pre-PR-K behavior available for tests or
  // legacy clients that want to ship short flashes intentionally.
  const warnings = [];
  const out = normalizeInsertions(
    [{ asset_id: 'tiny', startSec: 0, endSec: 0.5 }],
    100,
    warnings,
    { brollMinDurationSec: 0 },
  );
  assert.equal(out.length, 1);
  assert.deepEqual(warnings, []);
});
