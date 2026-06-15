/**
 * test/options_validation.test.js
 *
 * Pure tests on the cut-affecting options validators extracted from
 * routes/clean-mode-compose.js into lib/options_validation.js so the
 * new /clean-mode-classify dry-run route can share them. These guard
 * against drift between the two routes' option-gate semantics.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCutSafetyMode,
  validateRetainSec,
  validateSilenceNoiseDb,
  validateSilenceMinDur,
  validateSlateHint,
  validateSkipSlate,
  validateDeepgramKeywords,
  validateClassifyOptions,
} from '../lib/options_validation.js';

// ── cutSafetyMode ─────────────────────────────────────────────────────

test('validateCutSafetyMode: null/undefined → pass', () => {
  assert.equal(validateCutSafetyMode(undefined), null);
  assert.equal(validateCutSafetyMode(null), null);
});

test('validateCutSafetyMode: valid enums → pass', () => {
  for (const v of ['safe_only', 'safe_and_soft', 'all']) {
    assert.equal(validateCutSafetyMode(v), null, `valid value ${v}`);
  }
});

test('validateCutSafetyMode: rejects unknown string / non-string', () => {
  for (const v of ['safe', 'aggressive', '', 42, true, [], {}]) {
    const err = validateCutSafetyMode(v);
    assert.match(err ?? '', /cutSafetyMode/, `should reject ${JSON.stringify(v)}`);
  }
});

// ── retainSec ─────────────────────────────────────────────────────────

test('validateRetainSec: null/undefined → pass', () => {
  assert.equal(validateRetainSec(undefined), null);
  assert.equal(validateRetainSec(null), null);
});

test('validateRetainSec: valid range (0, 1] → pass', () => {
  for (const v of [0.001, 0.1, 0.15, 0.25, 0.5, 1.0]) {
    assert.equal(validateRetainSec(v), null);
  }
});

test('validateRetainSec: rejects out of range / non-number', () => {
  for (const v of [0, -0.1, 1.01, '0.25', NaN, Infinity, true, [], {}]) {
    const err = validateRetainSec(v);
    assert.match(err ?? '', /retainSec/, `should reject ${JSON.stringify(v)}`);
  }
});

// ── silenceNoiseDb ────────────────────────────────────────────────────

test('validateSilenceNoiseDb: valid [-60, -10] → pass', () => {
  for (const v of [-60, -45, -30, -10]) assert.equal(validateSilenceNoiseDb(v), null);
});

test('validateSilenceNoiseDb: rejects out-of-range', () => {
  for (const v of [-60.1, -9.9, 0, -100]) {
    assert.match(validateSilenceNoiseDb(v) ?? '', /silenceNoiseDb/);
  }
});

// ── silenceMinDur ─────────────────────────────────────────────────────

test('validateSilenceMinDur: valid (0, 5] → pass', () => {
  for (const v of [0.001, 0.4, 1.0, 5.0]) assert.equal(validateSilenceMinDur(v), null);
});

test('validateSilenceMinDur: rejects 0 / negative / >5 / non-number', () => {
  for (const v of [0, -0.1, 5.01, '0.4']) {
    assert.match(validateSilenceMinDur(v) ?? '', /silenceMinDur/);
  }
});

// ── slateHint ─────────────────────────────────────────────────────────

test('validateSlateHint: null/undefined → pass', () => {
  assert.equal(validateSlateHint(undefined), null);
  assert.equal(validateSlateHint(null), null);
});

test('validateSlateHint: valid string ≤ 200 chars → pass', () => {
  assert.equal(validateSlateHint(''), null);
  assert.equal(validateSlateHint('a hint'), null);
  assert.equal(validateSlateHint('x'.repeat(200)), null);
});

test('validateSlateHint: rejects non-string / over 200 chars', () => {
  assert.match(validateSlateHint(42) ?? '', /slateHint must be a string/);
  assert.match(validateSlateHint('x'.repeat(201)) ?? '', /slateHint must be ≤ 200/);
});

// ── skipSlate ─────────────────────────────────────────────────────────

test('validateSkipSlate: null/undefined/boolean → pass', () => {
  assert.equal(validateSkipSlate(undefined), null);
  assert.equal(validateSkipSlate(null), null);
  assert.equal(validateSkipSlate(true), null);
  assert.equal(validateSkipSlate(false), null);
});

test('validateSkipSlate: rejects non-boolean', () => {
  assert.match(validateSkipSlate('true') ?? '', /skipSlate/);
  assert.match(validateSkipSlate(1) ?? '', /skipSlate/);
});

// ── deepgramKeywords ──────────────────────────────────────────────────

test('validateDeepgramKeywords: null/undefined/empty array → pass', () => {
  assert.equal(validateDeepgramKeywords(undefined), null);
  assert.equal(validateDeepgramKeywords(null), null);
  assert.equal(validateDeepgramKeywords([]), null);
});

test('validateDeepgramKeywords: ≤ 20 non-empty strings → pass', () => {
  assert.equal(validateDeepgramKeywords(['special needs', 'wondered']), null);
  assert.equal(validateDeepgramKeywords(Array.from({ length: 20 }, (_, i) => `term${i}`)), null);
});

test('validateDeepgramKeywords: rejects non-array / >20 / empty entry / non-string entry / overlong', () => {
  assert.match(validateDeepgramKeywords('term') ?? '', /must be an array/);
  assert.match(validateDeepgramKeywords(Array.from({ length: 21 }, (_, i) => `t${i}`)) ?? '', /may not exceed 20/);
  assert.match(validateDeepgramKeywords(['ok', '   ']) ?? '', /\[1\] must be a non-empty/);
  assert.match(validateDeepgramKeywords(['ok', 42]) ?? '', /\[1\] must be a non-empty/);
  assert.match(validateDeepgramKeywords(['ok', 'x'.repeat(201)]) ?? '', /too long/);
});

// ── validateClassifyOptions (aggregator) ──────────────────────────────

test('validateClassifyOptions: null/undefined → pass', () => {
  assert.equal(validateClassifyOptions(undefined), null);
  assert.equal(validateClassifyOptions(null), null);
});

test('validateClassifyOptions: non-object → fail', () => {
  assert.match(validateClassifyOptions('options') ?? '', /options must be an object/);
});

test('validateClassifyOptions: clean options → pass', () => {
  assert.equal(validateClassifyOptions({
    cutSafetyMode: 'safe_and_soft',
    retainSec: 0.25,
    silenceNoiseDb: -30,
    silenceMinDur: 0.4,
    slateHint: 'a hint',
    skipSlate: false,
    deepgramKeywords: ['special needs'],
  }), null);
});

test('validateClassifyOptions: returns the first failing field', () => {
  const err = validateClassifyOptions({
    cutSafetyMode: 'safe_only',
    retainSec: 5, // bad
    silenceNoiseDb: 0, // also bad — but retainSec comes first
  });
  assert.match(err ?? '', /retainSec/);
});

test('validateClassifyOptions: ignores unknown / non-cut-affecting fields', () => {
  // The dry-run validator should NOT trip on b-roll / banner / hook fields —
  // they're orthogonal to cut classification. Confirms the dry-run accepts
  // a body with the full reel-config blob and simply ignores the irrelevant
  // parts.
  assert.equal(validateClassifyOptions({
    cutSafetyMode: 'safe_only',
    pixabayEnabled: true,
    bannerEnabled: true,
    aiEditMode: 'hook_subtitles_broll',
    skipBroll: false,
    introHookEnabled: true,
  }), null);
});
