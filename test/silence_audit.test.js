/**
 * test/silence_audit.test.js
 *
 * PR-AC: per-span audit pairing every detected silence with the
 * classifier's decision. Lockdown so a future regression can't silently
 * stop emitting `decision: 'cut'` for the spans Shannon's been
 * complaining about.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSilenceCoverage, formatSilenceAuditLine } from '../lib/silence_audit.js';

// ── auditSilenceCoverage ─────────────────────────────────────────────

test('audit: a detected silence that overlaps an applied cut → decision=cut', () => {
  const { rows, summary } = auditSilenceCoverage({
    mergedSilences: [{ start: 10.0, end: 12.5 }],
    applied: [{ start: 10.15, end: 12.35, safetyReason: 'post_sentence_dead_air' }],
    skipped: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'cut');
  assert.equal(rows[0].reason, 'post_sentence_dead_air');
  assert.deepEqual(rows[0].span, [10.0, 12.5]);
  assert.equal(rows[0].durSec, 2.5);
  assert.equal(summary.spansDetected, 1);
  assert.equal(summary.spansCut, 1);
  assert.equal(summary.cutSilenceSec, 2.5);
  assert.equal(summary.survivingSilenceSec, 0);
});

test('audit: a detected silence that overlaps a skipped (risky) cut → decision=preserved', () => {
  const { rows, summary } = auditSilenceCoverage({
    mergedSilences: [{ start: 45.0, end: 45.9 }],
    applied: [],
    skipped: [
      { start: 45.1, end: 45.85, safetyReason: 'mid_sentence_long_pause_0.88s' },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'preserved');
  assert.equal(rows[0].reason, 'mid_sentence_long_pause_0.88s');
  assert.equal(summary.spansPreserved, 1);
  assert.equal(summary.spansDropped, 0);
  assert.ok(summary.survivingSilenceSec > 0);
  assert.equal(summary.cutSilenceSec, 0);
});

test('audit: a detected silence with NO overlapping cut → decision=dropped, reason=subthreshold', () => {
  // Models the failure mode this PR is built around: a 0.7s silence
  // that's detected by silencedetect but the classifier dropped because
  // retain + preserve ate the whole span. Should surface as 'dropped'
  // so the operator can see the reel kept it.
  const { rows, summary } = auditSilenceCoverage({
    mergedSilences: [{ start: 78.0, end: 78.7 }],
    applied: [],
    skipped: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'dropped');
  assert.equal(rows[0].reason, 'subthreshold');
  assert.equal(summary.spansDropped, 1);
  assert.equal(summary.survivingSilenceSec, 0.7);
});

test('audit: mixed bag — all three decision types in one pass, summary tallies correctly', () => {
  const { rows, summary } = auditSilenceCoverage({
    mergedSilences: [
      { start: 5.0, end: 7.0 },     // 2.0s — applied
      { start: 30.0, end: 30.9 },   // 0.9s — skipped (risky)
      { start: 55.0, end: 55.7 },   // 0.7s — dropped (no cut at all)
      { start: 80.0, end: 81.3 },   // 1.3s — applied
    ],
    applied: [
      { start: 5.15, end: 6.85, safetyReason: 'leading_silence' },
      { start: 80.15, end: 81.15, safetyReason: 'post_sentence_dead_air' },
    ],
    skipped: [
      { start: 30.1, end: 30.85, safetyReason: 'mid_sentence_short' },
    ],
  });
  assert.equal(rows.length, 4);
  assert.equal(rows[0].decision, 'cut');
  assert.equal(rows[1].decision, 'preserved');
  assert.equal(rows[2].decision, 'dropped');
  assert.equal(rows[3].decision, 'cut');

  assert.equal(summary.spansDetected, 4);
  assert.equal(summary.spansCut, 2);
  assert.equal(summary.spansPreserved, 1);
  assert.equal(summary.spansDropped, 1);
  // Detected = 2 + 0.9 + 0.7 + 1.3 = 4.9
  // Cut = 2 + 1.3 = 3.3
  // Surviving = 0.9 + 0.7 = 1.6
  assert.ok(Math.abs(summary.detectedSilenceSec - 4.9) < 0.01);
  assert.ok(Math.abs(summary.cutSilenceSec - 3.3) < 0.01);
  assert.ok(Math.abs(summary.survivingSilenceSec - 1.6) < 0.01);
});

test('audit: malformed silence span (missing start/end) is silently skipped, not crashed on', () => {
  // We trust the detector but defend against an empty/garbled span
  // sneaking through — auditing should never throw.
  const { rows, summary } = auditSilenceCoverage({
    mergedSilences: [
      { start: 5.0, end: 6.0 },
      { start: 10.0 },          // no end
      null,
      { start: 12.0, end: 12.0 }, // zero-length
    ],
    applied: [{ start: 5.0, end: 6.0, safetyReason: 'leading_silence' }],
    skipped: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(summary.spansDetected, 1);
});

test('audit: cut/preserved match prefers safetyReason over cut.reason when both exist', () => {
  // safetyReason is the classifier slug ('post_sentence_dead_air'),
  // reason is the detector slug ('silence 0.78s'). Operator reading
  // logs cares about the classifier verdict — that's the actionable
  // information when investigating "why did this survive".
  const { rows } = auditSilenceCoverage({
    mergedSilences: [{ start: 10.0, end: 12.5 }],
    applied: [{
      start: 10.15, end: 12.35,
      safetyReason: 'post_sentence_dead_air',
      reason: 'silence 2.20s',
    }],
    skipped: [],
  });
  assert.equal(rows[0].reason, 'post_sentence_dead_air');
});

// ── formatSilenceAuditLine ──────────────────────────────────────────

test('formatSilenceAuditLine: grep-friendly stable format', () => {
  const line = formatSilenceAuditLine({
    span: [12.34, 13.12],
    durSec: 0.78,
    decision: 'cut',
    reason: 'post_sentence_dead_air',
  });
  assert.equal(
    line,
    '[silence-audit] [12.340, 13.120] (0.780s) → CUT (post_sentence_dead_air)',
  );
});

test('formatSilenceAuditLine: dropped / subthreshold reads cleanly', () => {
  const line = formatSilenceAuditLine({
    span: [78.0, 78.62],
    durSec: 0.62,
    decision: 'dropped',
    reason: 'subthreshold',
  });
  assert.equal(
    line,
    '[silence-audit] [78.000, 78.620] (0.620s) → DROPPED (subthreshold)',
  );
});

// ── PR-AD: capDropped distinguishes max_cut_fraction_cap from subthreshold ─

test('PR-AD: silence overlapping a capDropped cut → decision=dropped, reason=max_cut_fraction_cap', () => {
  // Simulates the jobId 7082844a failure mode: a 4s silence that the
  // classifier would have happily cut, but the global cap evicted.
  const { rows, summary } = auditSilenceCoverage({
    mergedSilences: [{ start: 228.381, end: 232.509 }],
    applied: [],
    skipped: [],
    capDropped: [{ start: 228.681, end: 232.359, safetyReason: 'post_sentence_dead_air' }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'dropped');
  assert.equal(rows[0].reason, 'max_cut_fraction_cap');
  assert.equal(summary.spansDropped, 1);
});

test('PR-AD: silence with NO overlapping capDropped cut → reason=subthreshold (catch-all)', () => {
  // No cuts anywhere — true subthreshold case.
  const { rows } = auditSilenceCoverage({
    mergedSilences: [{ start: 78.0, end: 78.7 }],
    applied: [],
    skipped: [],
    capDropped: [],
  });
  assert.equal(rows[0].decision, 'dropped');
  assert.equal(rows[0].reason, 'subthreshold');
});

test('PR-AD: capDropped defaults to [] when omitted (backwards compat)', () => {
  // PR-AC callers that haven't been updated yet still work — the old
  // 'subthreshold' fallback applies.
  const { rows } = auditSilenceCoverage({
    mergedSilences: [{ start: 78.0, end: 78.7 }],
    applied: [],
    skipped: [],
  });
  assert.equal(rows[0].reason, 'subthreshold');
});

test('PR-AD: applied wins over capDropped when both overlap', () => {
  // Defence: if a span somehow overlaps both an applied cut and a
  // capDropped cut, the applied decision wins (it's what actually
  // happens on the timeline).
  const { rows } = auditSilenceCoverage({
    mergedSilences: [{ start: 10.0, end: 13.0 }],
    applied: [{ start: 10.5, end: 12.5, safetyReason: 'sentence_boundary' }],
    skipped: [],
    capDropped: [{ start: 11.0, end: 12.0, safetyReason: 'post_sentence_dead_air' }],
  });
  assert.equal(rows[0].decision, 'cut');
  assert.equal(rows[0].reason, 'sentence_boundary');
});

// ── PR-AK: transcript context (prev/next) ────────────────────────────

test('PR-AK: audit row carries prev/next words around the silence span', () => {
  // Realistic talking-head fixture: post-sentence pause between two
  // sentences. The audit row should show the last words ending before
  // the silence and the first words starting after it.
  const words = [
    { word: 'the', start_ms: 11000, end_ms: 11200 },
    { word: 'right', start_ms: 11300, end_ms: 11500 },
    { word: 'plan.', start_ms: 11600, end_ms: 12000 },
    // silence at [12.0, 12.8]
    { word: 'And', start_ms: 12900, end_ms: 13100 },
    { word: 'so', start_ms: 13200, end_ms: 13400 },
    { word: 'I', start_ms: 13500, end_ms: 13600 },
  ];
  const { rows } = auditSilenceCoverage({
    mergedSilences: [{ start: 12.0, end: 12.8 }],
    applied: [{ start: 12.15, end: 12.65, safetyReason: 'sentence_boundary' }],
    skipped: [],
    capDropped: [],
    words,
  });
  assert.equal(rows[0].decision, 'cut');
  assert.equal(rows[0].prev, 'the right plan.');
  assert.equal(rows[0].next, 'And so I');
});

test('PR-AK: context truncates to ≤4 words on each side', () => {
  const words = [
    { word: 'a', start_ms: 100, end_ms: 200 },
    { word: 'b', start_ms: 300, end_ms: 400 },
    { word: 'c', start_ms: 500, end_ms: 600 },
    { word: 'd', start_ms: 700, end_ms: 800 },
    { word: 'e', start_ms: 900, end_ms: 1000 },
    // silence at 1.0–1.5
    { word: 'f', start_ms: 1600, end_ms: 1700 },
    { word: 'g', start_ms: 1800, end_ms: 1900 },
    { word: 'h', start_ms: 2000, end_ms: 2100 },
    { word: 'i', start_ms: 2200, end_ms: 2300 },
    { word: 'j', start_ms: 2400, end_ms: 2500 },
  ];
  const { rows } = auditSilenceCoverage({
    mergedSilences: [{ start: 1.0, end: 1.5 }],
    applied: [{ start: 1.15, end: 1.35, safetyReason: 'sentence_boundary' }],
    skipped: [],
    capDropped: [],
    words,
  });
  // Last 4 of [a,b,c,d,e] = "b c d e"
  assert.equal(rows[0].prev, 'b c d e');
  // First 4 of [f,g,h,i,j] = "f g h i"
  assert.equal(rows[0].next, 'f g h i');
});

test('PR-AK: words parameter omitted → prev/next empty (backwards compat)', () => {
  const { rows } = auditSilenceCoverage({
    mergedSilences: [{ start: 10.0, end: 12.5 }],
    applied: [{ start: 10.15, end: 12.35, safetyReason: 'post_sentence_dead_air' }],
    skipped: [],
  });
  assert.equal(rows[0].decision, 'cut');
  assert.equal(rows[0].prev, '');
  assert.equal(rows[0].next, '');
});

test('PR-AK: formatSilenceAuditLine includes context when present', () => {
  const line = formatSilenceAuditLine({
    span: [12.34, 13.12],
    durSec: 0.78,
    decision: 'cut',
    reason: 'post_sentence_dead_air',
    prev: 'the right plan.',
    next: 'And so I',
  });
  assert.equal(
    line,
    '[silence-audit] [12.340, 13.120] (0.780s) → CUT (post_sentence_dead_air) | "the right plan." → "And so I"',
  );
});

test('PR-AK: formatSilenceAuditLine omits context segment when prev+next empty', () => {
  // Backwards compat — pre-PR-AK rows have no prev/next; the line
  // should still format cleanly without a dangling pipe.
  const line = formatSilenceAuditLine({
    span: [78.0, 78.62],
    durSec: 0.62,
    decision: 'dropped',
    reason: 'subthreshold',
  });
  assert.equal(
    line,
    '[silence-audit] [78.000, 78.620] (0.620s) → DROPPED (subthreshold)',
  );
});

test('PR-AK: format renders preserved row with context for QC scanning', () => {
  // Operator's main use case: scan the log for PRESERVED rows and
  // see at a glance whether they were preserved correctly. Context
  // words make the "is this dead air or natural delivery?" judgment
  // possible without opening the source.
  const line = formatSilenceAuditLine({
    span: [45.10, 46.20],
    durSec: 1.10,
    decision: 'preserved',
    reason: 'mid_sentence_no_boundary',
    prev: 'we want to',
    next: 'help families',
  });
  assert.match(line, /PRESERVED/);
  assert.match(line, /mid_sentence_no_boundary/);
  assert.match(line, /"we want to"/);
  assert.match(line, /"help families"/);
});
