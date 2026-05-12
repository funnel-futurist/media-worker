/**
 * test/av_sync_boundary.test.js
 *
 * Regression test for the A/V sync check failing at the EXACT tolerance
 * boundary due to IEEE 754 float precision.
 *
 * Real-world failure 2026-05-12: Phil's row 5d69189c (jobId 0203feba) and
 * row f61cd594 (jobId a2a70609) both died at the cutApply A/V sync gate
 * with `|video-audio|=0.200s, tolerance=0.2s`. Mathematically the drift
 * equals the tolerance — should pass — but Math.abs(124.200 - 124.400)
 * evaluates to 0.20000000000000284 in IEEE 754, which is > 0.2 in raw
 * float comparison.
 *
 * Fix: round drift values to milliseconds (matching the .toFixed(3)
 * precision used in the error message and ffprobe's native ms-level
 * reporting) before comparing to tolerance.
 *
 * checkStreamSyncDurations is the pure-arithmetic core extracted from
 * verifyMP4StreamSync so this can be tested without an ffmpeg binary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStreamSyncDurations } from '../lib/clean_mode_pipeline.js';

// ── PRIMARY REGRESSION: exact-boundary float-precision bug ──────────

test('checkStreamSyncDurations: drift exactly equals tolerance → passes (Phil row 5d69189c case)', () => {
  // The ACTUAL failure: video=124.200s, audio=124.400s, tolerance=0.2s.
  // Math.abs(124.200 - 124.400) = 0.20000000000000284 in JS (verify:
  // node -e "console.log(Math.abs(124.200 - 124.400))" → 0.20000000000000284)
  // Without the fix, raw comparison 0.20000000000000284 > 0.2 returns
  // true and the check throws. With ms-rounding it becomes 0.200 > 0.2
  // which is false — the row passes through.
  const result = checkStreamSyncDurations({
    videoSec: 124.200,
    audioSec: 124.400,
    containerSec: 124.400,
    toleranceSec: 0.2,
  });
  assert.equal(result.withinTolerance, true, 'drift exactly at tolerance must pass (real-world Phil failure)');
  assert.equal(result.va, 0.200, 'rounded |v-a| should display as 0.200');
});

test('checkStreamSyncDurations: drift exactly equals tolerance → passes (Phil row f61cd594 case)', () => {
  // Second real-world failure same day, different clip:
  // video=109.200s, audio=109.400s, tolerance=0.2s.
  const result = checkStreamSyncDurations({
    videoSec: 109.200,
    audioSec: 109.400,
    containerSec: 109.400,
    toleranceSec: 0.2,
  });
  assert.equal(result.withinTolerance, true);
});

// ── BOUNDARY MATRIX ─────────────────────────────────────────────────

test('checkStreamSyncDurations: drift just under tolerance → passes', () => {
  const result = checkStreamSyncDurations({
    videoSec: 100.000,
    audioSec: 100.199,
    containerSec: 100.199,
    toleranceSec: 0.2,
  });
  assert.equal(result.withinTolerance, true);
  assert.equal(result.va, 0.199);
});

test('checkStreamSyncDurations: drift just over tolerance → fails', () => {
  // 201ms drift: genuinely outside the 200ms tolerance and should be caught.
  const result = checkStreamSyncDurations({
    videoSec: 100.000,
    audioSec: 100.201,
    containerSec: 100.201,
    toleranceSec: 0.2,
  });
  assert.equal(result.withinTolerance, false);
  assert.equal(result.va, 0.201);
});

test('checkStreamSyncDurations: large drift (m2-e2e-004 case, ~1s) → fails loudly', () => {
  // The original failure mode this check was built to catch: ffmpeg compose
  // producing video stream 1+ seconds shorter than audio.
  const result = checkStreamSyncDurations({
    videoSec: 100.000,
    audioSec: 101.230,
    containerSec: 101.230,
    toleranceSec: 0.2,
  });
  assert.equal(result.withinTolerance, false);
  assert.equal(result.va, 1.230);
});

test('checkStreamSyncDurations: all streams identical → passes', () => {
  const result = checkStreamSyncDurations({
    videoSec: 100.000,
    audioSec: 100.000,
    containerSec: 100.000,
    toleranceSec: 0.2,
  });
  assert.equal(result.withinTolerance, true);
  assert.equal(result.va, 0);
  assert.equal(result.vc, 0);
  assert.equal(result.ac, 0);
});

// ── PER-PAIR EXCEEDS COVERAGE ───────────────────────────────────────

test('checkStreamSyncDurations: video<>container drift exceeds → fails (vc)', () => {
  // Audio matches container exactly, but video diverges from both.
  const result = checkStreamSyncDurations({
    videoSec: 100.000,
    audioSec: 100.500,
    containerSec: 100.500,
    toleranceSec: 0.2,
  });
  assert.equal(result.withinTolerance, false);
  assert.equal(result.va, 0.500);
  assert.equal(result.vc, 0.500);
  assert.equal(result.ac, 0);
});

test('checkStreamSyncDurations: audio<>container drift exceeds → fails (ac)', () => {
  // Video matches container exactly, but audio diverges from both.
  const result = checkStreamSyncDurations({
    videoSec: 100.000,
    audioSec: 100.500,
    containerSec: 100.000,
    toleranceSec: 0.2,
  });
  assert.equal(result.withinTolerance, false);
  assert.equal(result.va, 0.500);
  assert.equal(result.vc, 0);
  assert.equal(result.ac, 0.500);
});

// ── CUSTOM TOLERANCE ────────────────────────────────────────────────

test('checkStreamSyncDurations: custom toleranceSec=0.5 → 0.4s drift passes', () => {
  const result = checkStreamSyncDurations({
    videoSec: 100.000,
    audioSec: 100.400,
    containerSec: 100.400,
    toleranceSec: 0.5,
  });
  assert.equal(result.withinTolerance, true);
});

// ── FLOAT-NOISE FUZZ ────────────────────────────────────────────────
// Cover other realistic ffmpeg outputs that produce IEEE 754 noise at
// the 3rd decimal. These should ALL pass at 0.2 tolerance with ms-
// rounding; without rounding several would spuriously fail.

test('checkStreamSyncDurations: float-noise cases at exact boundary all pass', () => {
  const cases = [
    { videoSec: 78.700, audioSec: 78.900 },                // 0.200 nominal
    { videoSec: 152.300, audioSec: 152.500 },              // 0.200 nominal
    { videoSec: 0.100, audioSec: 0.300 },                  // 0.200 nominal at small scale
    { videoSec: 1234.000, audioSec: 1234.200 },            // 0.200 nominal at large scale
  ];
  for (const c of cases) {
    const result = checkStreamSyncDurations({
      videoSec: c.videoSec,
      audioSec: c.audioSec,
      containerSec: c.audioSec,
      toleranceSec: 0.2,
    });
    assert.equal(result.withinTolerance, true,
      `case v=${c.videoSec} a=${c.audioSec} should pass at 0.2 tolerance`);
    assert.equal(result.va, 0.200, `rounded drift should be 0.200`);
  }
});
