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
  );
  assert.deepEqual(out.map((i) => i.asset_id), ['ok']);
  assert.equal(warnings.filter((w) => /non-numeric/.test(w)).length, 2);
});

test('normalize: null/non-array input → empty result, no throw', () => {
  const warnings = [];
  assert.deepEqual(normalizeInsertions(null, 10, warnings), []);
  assert.deepEqual(normalizeInsertions(undefined, 10, warnings), []);
  assert.deepEqual(normalizeInsertions('not an array', 10, warnings), []);
  assert.deepEqual(warnings, []);
});

test('normalize: preserves non-startSec/endSec fields on each row', () => {
  const warnings = [];
  const out = normalizeInsertions(
    [{ asset_id: 'a', startSec: 1, endSec: 2, reason: 'because', matchedPhrase: 'foo bar', extraField: 42 }],
    10,
    warnings,
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
  );
  assert.deepEqual(out.map((i) => i.asset_id), ['a']);
  assert.equal(warnings.length, 2);
});
