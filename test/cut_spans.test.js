/**
 * test/cut_spans.test.js
 *
 * Pure-function tests for the shared cut-span merger that
 * lib/ffmpeg_trim_concat.js (buildKeepSegments) and
 * lib/subtitle_burn.js (remapWordsThroughCuts) both consume.
 *
 * Includes the EXACT cut spans from the 2026-05-11 subtitle-drift bug
 * (content_item 5d69189c-be10-43d0-b4ff-0277cb2052e3, jobId
 * 4c95b2a1-17f8-4621-866e-b6e4bda13d4a, Phil's Well_Handle_It_This_Summer
 * clip) as a real-world regression case.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCutSpans, totalRemovedSec } from '../lib/cut_spans.js';

// ── mergeCutSpans — happy path ────────────────────────────────────────

test('mergeCutSpans: empty input → empty output', () => {
  assert.deepEqual(mergeCutSpans([]), []);
});

test('mergeCutSpans: single span passes through unchanged', () => {
  assert.deepEqual(mergeCutSpans([{ start: 1, end: 2 }]), [{ start: 1, end: 2 }]);
});

test('mergeCutSpans: non-overlapping spans pass through sorted', () => {
  const out = mergeCutSpans([
    { start: 10, end: 12 },
    { start: 1, end: 2 },
    { start: 5, end: 7 },
  ]);
  assert.deepEqual(out, [
    { start: 1, end: 2 },
    { start: 5, end: 7 },
    { start: 10, end: 12 },
  ]);
});

// ── mergeCutSpans — overlap handling (THE BUG) ────────────────────────

test('mergeCutSpans: two overlapping spans merge into one', () => {
  const out = mergeCutSpans([
    { start: 0, end: 5 },
    { start: 3, end: 8 },
  ]);
  assert.deepEqual(out, [{ start: 0, end: 8 }]);
});

test('mergeCutSpans: span fully contained in another → outer span only', () => {
  const out = mergeCutSpans([
    { start: 0, end: 10 },
    { start: 3, end: 5 },   // contained
  ]);
  assert.deepEqual(out, [{ start: 0, end: 10 }]);
});

test('mergeCutSpans: touching spans (b.start === a.end) merge', () => {
  // [0, 5] and [5, 10] touch at t=5. Convention from buildKeepSegments:
  // touching spans merge. A word AT t=5 in original is removed since it
  // falls in the cut region; remapping treats this as a single 0..10 cut.
  const out = mergeCutSpans([
    { start: 0, end: 5 },
    { start: 5, end: 10 },
  ]);
  assert.deepEqual(out, [{ start: 0, end: 10 }]);
});

test('mergeCutSpans: chain of overlaps collapses into one', () => {
  const out = mergeCutSpans([
    { start: 0, end: 3 },
    { start: 2, end: 5 },
    { start: 4, end: 7 },
    { start: 6, end: 10 },
  ]);
  assert.deepEqual(out, [{ start: 0, end: 10 }]);
});

test('mergeCutSpans: mixed overlapping + isolated groups', () => {
  const out = mergeCutSpans([
    { start: 0, end: 5 },
    { start: 3, end: 7 },   // overlaps with first → merge to [0, 7]
    { start: 20, end: 25 }, // isolated
    { start: 22, end: 30 }, // overlaps third → merge to [20, 30]
    { start: 50, end: 51 }, // isolated
  ]);
  assert.deepEqual(out, [
    { start: 0, end: 7 },
    { start: 20, end: 30 },
    { start: 50, end: 51 },
  ]);
});

// ── mergeCutSpans — validation ─────────────────────────────────────────

test('mergeCutSpans: throws on non-array input', () => {
  assert.throws(() => mergeCutSpans(null), /must be an array/);
  assert.throws(() => mergeCutSpans(undefined), /must be an array/);
  assert.throws(() => mergeCutSpans('not-an-array'), /must be an array/);
});

test('mergeCutSpans: silently drops invalid entries (start/end missing or NaN or zero-len)', () => {
  // Defensive — callers that need a hard error should use buildKeepSegments
  // which validates upstream. This helper is the canonical "normalize" path.
  const out = mergeCutSpans([
    { start: 0, end: 1 },
    null,
    { start: 'x', end: 5 },       // non-numeric
    { start: 10, end: 10 },        // zero-length
    { start: 8, end: 5 },          // end < start
    { start: 100, end: 110 },
  ]);
  assert.deepEqual(out, [
    { start: 0, end: 1 },
    { start: 100, end: 110 },
  ]);
});

test('mergeCutSpans: does NOT mutate caller input', () => {
  const input = [
    { start: 10, end: 20 },
    { start: 15, end: 25 },
  ];
  const snapshot = JSON.parse(JSON.stringify(input));
  mergeCutSpans(input);
  assert.deepEqual(input, snapshot, 'caller array should be unchanged');
});

// ── totalRemovedSec — derived helper ──────────────────────────────────

test('totalRemovedSec: matches what ffmpeg trim actually removes', () => {
  assert.equal(totalRemovedSec([{ start: 0, end: 5 }, { start: 10, end: 12 }]), 7);
  // Overlap shouldn't double-count.
  assert.equal(totalRemovedSec([{ start: 0, end: 5 }, { start: 3, end: 8 }]), 8);
  // Empty → 0.
  assert.equal(totalRemovedSec([]), 0);
});

// ── Real-world repro — Phil's Well_Handle_It_This_Summer clip ─────────

test('mergeCutSpans: regression — Phil 2026-05-11 (slate + 21 silence cuts)', () => {
  // Copied EXACTLY from response.cuts.appliedDetail in the sync-debug run
  // (tmp/b-subtitle-debug-response.json). Slate spans 0..5.76 and overlaps
  // with two silence cuts inside it.
  const cuts = [
    { start: 0,       end: 5.76  },   // slate_intro
    { start: 0.15,    end: 0.912 },   // silence INSIDE slate
    { start: 4.45,    end: 5.71  },   // silence INSIDE slate
    { start: 12.033,  end: 13.705 },
    { start: 20.525,  end: 22.218 },
    { start: 38.72,   end: 40.006 },
    { start: 41.872,  end: 43.155 },
    { start: 46.302,  end: 47.985 },
    { start: 56.079,  end: 58.505 },
    { start: 62.6,    end: 64.051 },
    { start: 69.624,  end: 70.357 },
    { start: 72.532,  end: 72.982 },
    { start: 81.624,  end: 83.99  },
    { start: 98.885,  end: 100.837 },
    { start: 103.525, end: 105.445 },
    { start: 109.02,  end: 110.84 },
    { start: 117.98,  end: 119.913 },
    { start: 128.155, end: 130.423 },
    { start: 132.475, end: 132.678 },
    { start: 147.096, end: 148.744 },
    { start: 155.167, end: 156.283 },
    { start: 157.975, end: 160.305 },
  ];
  // Pre-fix bug: shift sum = 5.76 + 0.762 + 1.26 + <rest>...
  //              = 7.782 + <rest> = WRONG.
  // Post-fix:    merged slate region = [0, 5.76] → 5.76s removed from slate;
  //              all other cuts non-overlapping → sum normally.
  const merged = mergeCutSpans(cuts);
  // The first 3 cuts collapse to 1.
  assert.equal(merged.length, cuts.length - 2);
  assert.deepEqual(merged[0], { start: 0, end: 5.76 });
  // Total removed: pre-fix bug would sum to ~38.0s; merged correct value is
  // 5.76 + sum-of-rest. Let's just verify the merged total is LESS than
  // the naive sum (proves overlap was deduped).
  const naiveSum = cuts.reduce((s, c) => s + (c.end - c.start), 0);
  const mergedSum = merged.reduce((s, c) => s + (c.end - c.start), 0);
  assert.ok(mergedSum < naiveSum, `merged ${mergedSum.toFixed(3)}s should be < naive ${naiveSum.toFixed(3)}s`);
  // The exact over-count from the bug was 2.022s (0.762 + 1.26 — the two
  // silence cuts entirely inside the slate region):
  const overCount = naiveSum - mergedSum;
  assert.ok(
    Math.abs(overCount - 2.022) < 0.001,
    `over-count should be ~2.022s (the two silence durations inside slate); got ${overCount.toFixed(3)}s`,
  );
});
