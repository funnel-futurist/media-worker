/**
 * test/cuts_report.test.js
 *
 * Lock down the bucketing + slate/camera-shutoff convenience fields of
 * lib/clean_mode_pipeline.js:buildCutsReport. Pure-function tests; no I/O.
 *
 * Drives the cut detector with synthetic fixtures that exercise:
 *   - slate intro detection (multi-signal: April + option A.)
 *   - camera-shutoff trim (last word + pad < sourceDuration)
 *   - leading silence + trailing silence
 *   - filler / repeat / bad-take classification
 *   - skipped risky cuts (mid-sentence with no boundary)
 *
 * Then asserts that buildCutsReport buckets, counts, and surfaces the
 * slate/cameraShutoff convenience fields correctly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAndClassifyCuts } from '../lib/cut_detection.js';
import { bucketCut, buildCutsReport } from '../lib/clean_mode_pipeline.js';

function w(word, startSec, endSec) {
  return { word, start_ms: Math.round(startSec * 1000), end_ms: Math.round(endSec * 1000) };
}

function totalSec(cuts) {
  return cuts.reduce((s, c) => s + (c.end - c.start), 0);
}

test('bucketCut: classifies all detector reasons into operator-facing buckets', () => {
  // Synthetic per-bucket cuts with reasons matching the detector's output strings
  const cases = [
    [{ category: 'silence', reason: 'slate_intro: [date_month_day,option_take] via multi_signal' }, 'slate'],
    [{ category: 'silence', reason: 'camera_shutoff: 4.50s past speech end + 0.5s pad' }, 'cameraShutoff'],
    [{ category: 'silence', reason: 'silence 1.70s (leading)' }, 'leadingSilence'],
    [{ category: 'silence', reason: 'silence 8.70s (trailing)' }, 'trailingSilence'],
    [{ category: 'silence', reason: 'silence 1.30s (audio)' }, 'deadAir'],
    [{ category: 'silence', reason: 'silence 0.85s' }, 'deadAir'],
    [{ category: 'filler', reason: 'filler: um' }, 'filler'],
    [{ category: 'repeat_word', reason: 'repeat: the' }, 'repeat'],
    [{ category: 'bad_take', reason: 'bad_take: wait' }, 'badTake'],
    [{ category: 'bad_take', reason: 'silent_restart: 4/5 head-tokens repeat' }, 'badTake'],
  ];
  for (const [cut, expectedBucket] of cases) {
    assert.equal(bucketCut(cut), expectedBucket, `expected ${expectedBucket} for "${cut.reason}"`);
  }
});

test('buildCutsReport: enriched fields + backwards-compat summary on slate+camera-shutoff fixture', () => {
  // Justine-style fixture: slate intro ("April 18, option A.") + body + trailing silence
  const words = [
    w('April', 0.20, 0.50),
    w('18,', 0.55, 0.85),
    w('option', 0.95, 1.30),
    w('A.', 1.35, 1.65),
    w('Before', 2.65, 3.00),                 // 1.0s gap after slate
    w('a', 3.05, 3.10),
    w('CyberVA', 3.15, 3.55),
    w('steps', 3.60, 3.85),
    w('in.', 3.90, 4.20),
    w('end.', 4.50, 5.00),
  ];
  const cutResult = detectAndClassifyCuts(words, {
    sourceDuration: 10,
    detectSlateFromTranscript: true,
    cutBeyondLastWordPadSec: 0.5,
    cutSafetyMode: 'safe_only',
    maxCutFraction: 0.99,
  });
  const report = buildCutsReport(cutResult, totalSec(cutResult.applied));

  // Backwards-compat summary
  assert.equal(typeof report.applied, 'number');
  assert.equal(typeof report.skipped, 'number');
  assert.equal(typeof report.secondsRemoved, 'number');
  assert.equal(report.applied, cutResult.applied.length);
  assert.equal(report.skipped, cutResult.skipped.length);

  // Enriched fields
  assert.ok(Array.isArray(report.appliedDetail));
  assert.ok(Array.isArray(report.skippedDetail));
  assert.equal(report.appliedDetail.length, cutResult.applied.length);
  assert.equal(report.skippedDetail.length, cutResult.skipped.length);

  // byCategory present, both applied and skipped
  assert.ok(report.byCategory && report.byCategory.applied && report.byCategory.skipped);
  for (const k of ['slate', 'cameraShutoff', 'leadingSilence', 'trailingSilence', 'deadAir', 'filler', 'repeat', 'badTake', 'other']) {
    assert.equal(typeof report.byCategory.applied[k], 'number', `applied.${k} missing`);
    assert.equal(typeof report.byCategory.skipped[k], 'number', `skipped.${k} missing`);
  }

  // Slate convenience: detector should fire on multi-signal April + option A.
  assert.equal(report.slate.detected, true, `slate not detected; appliedDetail=${JSON.stringify(report.appliedDetail)}`);
  assert.equal(report.slate.startSec, 0);
  assert.ok(report.slate.endSec >= 1.65, `slate.endSec should cover through "A." (1.65), got ${report.slate.endSec}`);
  assert.match(report.slate.reason, /slate_intro/);

  // Camera-shutoff: lastWord ends 5.0s, sourceDuration=10, pad=0.5 → cut ~5.5..10
  assert.equal(report.cameraShutoff.detected, true);
  assert.ok(report.cameraShutoff.startSec >= 5.0 && report.cameraShutoff.startSec < 6.0);
  assert.ok(report.cameraShutoff.endSec === 10);

  // applied bucket counts: at minimum 1 slate + 1 cameraShutoff
  assert.ok(report.byCategory.applied.slate >= 1);
  assert.ok(report.byCategory.applied.cameraShutoff >= 1);
});

test('buildCutsReport: no slate / no shutoff → convenience fields read { detected: false }', () => {
  // No slate signals; no shutoff option (cutBeyondLastWordPadSec omitted)
  const words = [
    w('Hello', 0.0, 0.4),
    w('world.', 0.5, 1.0),
    w('How', 1.2, 1.5),
    w('are', 1.6, 1.8),
    w('you.', 1.9, 2.2),
  ];
  const cutResult = detectAndClassifyCuts(words, {
    sourceDuration: 3,
    cutSafetyMode: 'safe_only',
  });
  const report = buildCutsReport(cutResult, totalSec(cutResult.applied));
  assert.equal(report.slate.detected, false);
  assert.equal(report.cameraShutoff.detected, false);
  assert.equal(report.byCategory.applied.slate, 0);
  assert.equal(report.byCategory.applied.cameraShutoff, 0);
});

test('buildCutsReport: skipped risky cuts populate skippedDetail with safetyReason', () => {
  // "I want to ___ build a thing" — 'to' is dependent_trailing_word → risky.
  const words = [
    w('I', 0.0, 0.1),
    w('want', 0.2, 0.4),
    w('to', 0.5, 0.6),
    w('build', 1.5, 1.7),    // 0.9s gap, no punct, prev word 'to' is STRONG_DEPENDENT
    w('a', 1.8, 1.9),
    w('thing.', 2.0, 2.3),
  ];
  const cutResult = detectAndClassifyCuts(words, {
    sourceDuration: 3,
    minGapSec: 0.5,
    cutSafetyMode: 'safe_only',
  });
  const report = buildCutsReport(cutResult, totalSec(cutResult.applied));
  // The risky cut should be in skippedDetail with a meaningful safetyReason
  const risky = report.skippedDetail.find((c) => c.safety === 'risky');
  assert.ok(risky, 'expected at least one risky-skipped cut');
  assert.match(risky.safetyReason ?? '', /dependent_trailing_word|mid_sentence|comma_then_continuation/);
  assert.equal(typeof risky.contextBefore, 'string');
  assert.equal(typeof risky.contextAfter, 'string');
});

test('buildCutsReport: appliedDetail rows include all required fields', () => {
  const words = [
    w('Hello.', 0.0, 0.5),
    w('Then', 2.5, 2.7),    // 2.0s gap → safe (post-sentence dead air)
    w('we.', 2.8, 3.2),
  ];
  const cutResult = detectAndClassifyCuts(words, {
    sourceDuration: 4,
    minGapSec: 0.5,
    cutSafetyMode: 'safe_only',
    maxCutFraction: 0.99,    // bypass the default 40% cap (4s source × 0.4 = 1.6s budget)
  });
  const report = buildCutsReport(cutResult, totalSec(cutResult.applied));
  assert.ok(report.appliedDetail.length >= 1, 'expected at least one applied cut');
  for (const c of report.appliedDetail) {
    for (const k of ['startSec', 'endSec', 'durSec', 'category', 'bucket', 'reason', 'safety', 'safetyReason']) {
      assert.ok(k in c, `applied row missing field ${k}`);
    }
    assert.equal(c.safety, 'safe');
  }
});
