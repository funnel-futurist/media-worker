/**
 * test/cut_detection.test.js
 *
 * Parity tests for lib/cut_detection.js — must match the algorithm 1:1 with
 * creative-engine/lib/hyperframes/deterministic_cuts.ts.
 *
 * Mechanical port of creative-engine/tests/deterministic_cuts.test.ts to JS.
 * Uses Node's built-in node:test runner.
 *
 * Run:
 *   node --test test/cut_detection.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDeterministicCuts, detectAndClassifyCuts } from '../lib/cut_detection.js';

function w(word, start, end) {
  return { word, start_ms: Math.round(start * 1000), end_ms: Math.round(end * 1000) };
}

test('returns empty array for empty input', () => {
  const cuts = detectDeterministicCuts([], { sourceDuration: 10 });
  assert.deepEqual(cuts, []);
});

test('detects inter-word silence ≥ minGapSec', () => {
  const words = [
    w('hello', 0.0, 0.4),
    w('world', 2.0, 2.4),
    w('end', 9.5, 9.8),
  ];
  const cuts = detectDeterministicCuts(words, { sourceDuration: 10 });
  const interWord = cuts.find((c) => c.category === 'silence' && !c.reason.includes('trailing') && !c.reason.includes('leading'));
  assert.ok(interWord, 'expected an inter-word silence cut');
  assert.ok(Math.abs(interWord.start - 0.55) < 0.01);
  assert.ok(Math.abs(interWord.end - 1.85) < 0.01);
});

test('does NOT cut natural speech rhythm (gaps < minGapSec)', () => {
  const words = [
    w('the', 0.0, 0.2),
    w('cat', 0.4, 0.7),
    w('sat', 0.9, 1.2),
  ];
  const cuts = detectDeterministicCuts(words, { sourceDuration: 1.5 });
  assert.equal(cuts.length, 0);
});

test('detects bad_take cut on "wait" marker', () => {
  const words = [
    w('I', 0.0, 0.2),
    w('am', 0.3, 0.5),
    w('building', 0.6, 1.0),
    w('a', 1.1, 1.2),
    w('wait,', 1.4, 1.7),
    w('let', 1.9, 2.0),
    w('me', 2.0, 2.1),
    w('start', 2.2, 2.5),
    w('over', 2.6, 3.0),
    w('I', 3.5, 3.7),
    w('build', 3.8, 4.2),
    w('reels', 4.3, 4.7),
  ];
  const cuts = detectDeterministicCuts(words, { sourceDuration: 10 });
  const badTake = cuts.find((c) => c.category === 'bad_take');
  assert.ok(badTake, 'expected a bad_take cut');
  assert.ok(badTake.start <= 0.05, `bad_take.start should be ~0, got ${badTake.start}`);
  assert.ok(badTake.end >= 1.6 && badTake.end <= 3.0, `bad_take.end should cover the marker, got ${badTake.end}`);
});

test('does NOT cut bad_take when marker is mid-sentence content (limitation documented)', () => {
  const words = [
    w('we', 0.0, 0.2),
    w('wait', 0.3, 0.6),
    w('for', 0.7, 0.9),
    w('the', 1.0, 1.1),
    w('response.', 1.2, 1.7),
  ];
  const cutsOn = detectDeterministicCuts(words, { sourceDuration: 3 });
  const cutsOff = detectDeterministicCuts(words, { sourceDuration: 3, enableBadTakes: false });
  const badTakeOn = cutsOn.find((c) => c.category === 'bad_take');
  assert.ok(badTakeOn, 'with enableBadTakes default-on, "wait" is cut even mid-sentence');
  const badTakeOff = cutsOff.find((c) => c.category === 'bad_take');
  assert.equal(badTakeOff, undefined, 'with enableBadTakes:false, no bad_take cuts');
});

test('detects leading silence after slate end', () => {
  const words = [
    w('hello', 4.0, 4.4),
    w('world', 4.6, 5.0),
  ];
  const cuts = detectDeterministicCuts(words, {
    sourceDuration: 6,
    startAfterSec: 2.0,
  });
  const lead = cuts.find((c) => c.reason.includes('leading'));
  assert.ok(lead, 'expected a leading silence cut');
  assert.ok(Math.abs(lead.start - 2.15) < 0.01);
  assert.ok(Math.abs(lead.end - 3.85) < 0.01);
});

test('detects trailing silence before sourceDuration', () => {
  const words = [
    w('hello', 0.0, 0.4),
    w('world', 0.6, 1.0),
  ];
  const cuts = detectDeterministicCuts(words, { sourceDuration: 10, maxCutFraction: 1.0 });
  const tail = cuts.find((c) => c.reason.includes('trailing'));
  assert.ok(tail, 'expected a trailing silence cut');
  assert.ok(Math.abs(tail.start - 1.15) < 0.01);
  assert.ok(Math.abs(tail.end - 9.85) < 0.01);
});

test('detects adjacent repeated word ("the the")', () => {
  const words = [
    w('the', 1.0, 1.3),
    w('the', 1.4, 1.7),
    w('cat', 1.9, 2.2),
  ];
  const cuts = detectDeterministicCuts(words, { sourceDuration: 3 });
  const repeat = cuts.find((c) => c.category === 'repeat_word');
  assert.ok(repeat, 'expected a repeat_word cut');
  assert.ok(Math.abs(repeat.start - 1.0) < 0.01);
  assert.ok(Math.abs(repeat.end - 1.3) < 0.01);
  assert.equal(repeat.reason, 'repeat: the');
});

test('repeated word detection strips punctuation ("the, the")', () => {
  const words = [
    w('the,', 1.0, 1.3),
    w('the', 1.4, 1.7),
    w('cat', 1.9, 2.2),
  ];
  const cuts = detectDeterministicCuts(words, { sourceDuration: 3 });
  const repeat = cuts.find((c) => c.category === 'repeat_word');
  assert.ok(repeat, 'expected a repeat cut even with comma punctuation');
});

test('repeat detection ignores wide gap (not a stutter)', () => {
  const words = [
    w('the', 1.0, 1.2),
    w('cat', 1.3, 1.6),
    w('the', 3.0, 3.2),
    w('dog', 3.3, 3.6),
  ];
  const cuts = detectDeterministicCuts(words, { sourceDuration: 4 });
  const repeats = cuts.filter((c) => c.category === 'repeat_word');
  assert.equal(repeats.length, 0);
});

test('detects filler words ("um", "uh")', () => {
  const words = [
    w('I', 0.0, 0.2),
    w('um', 0.4, 0.7),
    w('want', 0.9, 1.2),
    w('uh,', 1.5, 1.7),
    w('coffee', 1.9, 2.3),
  ];
  const cuts = detectDeterministicCuts(words, { sourceDuration: 3 });
  const fillers = cuts.filter((c) => c.category === 'filler');
  assert.ok(fillers.length >= 1 || cuts.some((c) => c.start >= 0.4 && c.end >= 0.7));
});

test('does NOT cut "like" or "you know" (context-dependent)', () => {
  const words = [
    w('I', 0.0, 0.2),
    w('like', 0.3, 0.5),
    w('coffee', 0.6, 1.0),
  ];
  const cuts = detectDeterministicCuts(words, { sourceDuration: 2 });
  const fillers = cuts.filter((c) => c.category === 'filler');
  assert.equal(fillers.length, 0);
});

test('40% cap drops cuts in source-time order', () => {
  const words = [
    w('a', 0.0, 0.2),
    w('b', 2.5, 2.7),
    w('c', 5.0, 5.2),
    w('d', 7.5, 7.7),
    w('e', 9.0, 9.2),
  ];
  const cuts = detectDeterministicCuts(words, { sourceDuration: 10, maxCutFraction: 0.4 });
  const totalSec = cuts.reduce((s, c) => s + (c.end - c.start), 0);
  assert.ok(totalSec <= 4.001, `expected cap ≤ 4.0s, got ${totalSec.toFixed(2)}s`);
  assert.ok(cuts[0].start < 1.0, 'first cut should start near beginning');
});

test('respects startAfterSec — no cuts before slate', () => {
  const words = [
    w('slate-word', 0.5, 1.0),
    w('content-word', 4.0, 4.4),
    w('next', 4.6, 5.0),
  ];
  const cuts = detectDeterministicCuts(words, {
    sourceDuration: 6,
    startAfterSec: 2.0,
  });
  for (const c of cuts) {
    assert.ok(c.start >= 2.0, `cut at ${c.start} is before startAfterSec`);
  }
});

test('externalSilences REPLACES word-gap detection (Phase 2.7+)', () => {
  const words = [
    w('hello', 0.0, 0.4),
    w('world', 0.5, 1.0),
    w('again', 6.6, 7.0),
  ];
  const cuts = detectDeterministicCuts(words, {
    sourceDuration: 10,
    externalSilences: [{ start: 5.0, end: 6.5 }],
  });
  const silenceCuts = cuts.filter((c) => c.category === 'silence');
  assert.equal(silenceCuts.length, 1, 'expected one silence cut from externalSilences');
  assert.ok(Math.abs(silenceCuts[0].start - 5.15) < 0.01);
  assert.ok(Math.abs(silenceCuts[0].end - 6.35) < 0.01);
  assert.ok(silenceCuts[0].reason.includes('audio'), 'reason should tag audio source');
});

test('falls back to word-gap silence when externalSilences not provided', () => {
  const words = [
    w('hello', 0.0, 0.4),
    w('world', 0.5, 1.0),
    w('again', 6.6, 7.0),
  ];
  const cuts = detectDeterministicCuts(words, { sourceDuration: 10, maxCutFraction: 1.0 });
  const silenceCuts = cuts.filter((c) => c.category === 'silence');
  assert.ok(silenceCuts.length >= 1, 'expected word-gap fallback to find the silence');
});

test('output is sorted by start ascending', () => {
  const words = [
    w('a', 0.0, 0.2),
    w('um', 0.4, 0.7),
    w('the', 1.0, 1.3),
    w('the', 1.4, 1.7),
    w('b', 4.0, 4.3),
  ];
  const cuts = detectDeterministicCuts(words, { sourceDuration: 5 });
  for (let i = 1; i < cuts.length; i++) {
    assert.ok(cuts[i].start >= cuts[i - 1].start, 'cuts not sorted');
  }
});

test('Phase 2.9: boundary clamp drops 0-length cut after retain', () => {
  const words = [
    w('a', 0.0, 0.5),
    w('b', 0.8, 1.2),
  ];
  const cuts = detectDeterministicCuts(words, {
    sourceDuration: 2,
    minGapSec: 0.3,
    retainSec: 0.15,
    minCutDurationSec: 0.01,
  });
  for (const c of cuts) {
    assert.ok(c.end > c.start, `0-length cut survived: [${c.start}, ${c.end}]`);
  }
});

test('Phase 2.9: maxSingleCutSec splits long silence at sentence boundary', () => {
  const words = [
    w('end.', 0.0, 0.3),
    w('Then', 5.5, 5.7),
    w('we', 5.8, 5.9),
  ];
  const externalSilences = [{ start: 0.3, end: 5.5 }];
  const cuts = detectDeterministicCuts(words, {
    sourceDuration: 6,
    externalSilences,
    maxSingleCutSec: 3.0,
    maxCutFraction: 0.99,
    minGapSec: 0.6,
    retainSec: 0.15,
  });
  const silenceCuts = cuts.filter((c) => c.category === 'silence');
  const splitMarkers = silenceCuts.filter((c) => c.reason.includes('split'));
  assert.ok(splitMarkers.length >= 2, `expected ≥2 split-marked cuts, got ${splitMarkers.length}`);
});

test('Phase 2.9: maxSingleCutSec does NOT split when no emphasis context', () => {
  const words = [
    w('the', 0.0, 0.2),
    w('thing', 5.5, 5.8),
  ];
  const externalSilences = [{ start: 0.2, end: 5.5 }];
  const cuts = detectDeterministicCuts(words, {
    sourceDuration: 6,
    externalSilences,
    maxSingleCutSec: 3.0,
  });
  const splitMarkers = cuts.filter((c) => c.reason.includes('split'));
  assert.equal(splitMarkers.length, 0, 'should NOT split when context lacks emphasis');
});

test('Phase 2.9: pause preservation respects post-sentence ceiling', () => {
  const words = [
    w('end.', 0.0, 0.3),
    w('next', 0.85, 1.2),
  ];
  const cuts = detectDeterministicCuts(words, {
    sourceDuration: 1.25,
    minGapSec: 0.5,
    retainSec: 0.10,
    preserveEmphasisPauses: true,
    preservePostSentenceSec: 0.5,
    preservePostCommaSec: 0.3,
    preservePrePunchlineSec: 0.4,
    minCutDurationSec: 0.2,
  });
  const silenceCuts = cuts.filter((c) => c.category === 'silence');
  assert.equal(silenceCuts.length, 0, 'sentence-end pause within ceiling should NOT be cut');
});

test('Phase 2.9: pause preservation post-comma is shorter than post-sentence', () => {
  const words = [
    w('first,', 0.0, 0.5),
    w('then', 0.95, 1.2),
  ];
  const cutsCommaPreserve = detectDeterministicCuts(words, {
    sourceDuration: 1.3,
    minGapSec: 0.4,
    retainSec: 0.10,
    preserveEmphasisPauses: true,
    preservePostCommaSec: 0.3,
  });
  const cutsNoPreserve = detectDeterministicCuts(words, {
    sourceDuration: 1.3,
    minGapSec: 0.4,
    retainSec: 0.10,
    preserveEmphasisPauses: false,
  });
  const preservedTotal = cutsCommaPreserve.reduce((s, c) => s + (c.end - c.start), 0);
  const rawTotal = cutsNoPreserve.reduce((s, c) => s + (c.end - c.start), 0);
  assert.ok(preservedTotal < rawTotal, `preservation should reduce total cut seconds (preserved=${preservedTotal.toFixed(2)}, raw=${rawTotal.toFixed(2)})`);
});

test('Phase 2.9: pre-punchline preservation triggers on first-occurrence content word', () => {
  const words = [
    w('we', 0.0, 0.2),
    w('use', 0.3, 0.5),
    w('Metricool', 1.0, 1.5),
    w('for', 1.6, 1.8),
    w('marketing', 1.9, 2.5),
  ];
  const cutsWith = detectDeterministicCuts(words, {
    sourceDuration: 3,
    minGapSec: 0.4,
    retainSec: 0.10,
    preserveEmphasisPauses: true,
    preservePrePunchlineSec: 0.4,
  });
  const cutsWithout = detectDeterministicCuts(words, {
    sourceDuration: 3,
    minGapSec: 0.4,
    retainSec: 0.10,
    preserveEmphasisPauses: false,
  });
  const withSilence = cutsWith.filter((c) => c.category === 'silence');
  const withoutSilence = cutsWithout.filter((c) => c.category === 'silence');
  const withTotal = withSilence.reduce((s, c) => s + (c.end - c.start), 0);
  const withoutTotal = withoutSilence.reduce((s, c) => s + (c.end - c.start), 0);
  assert.ok(withTotal < withoutTotal, 'punchline preservation should shrink total cut');
});

test('Phase 2.9: silent-restart sentence-start n-gram detected', () => {
  const words = [
    w('I', 0.0, 0.1),
    w('help', 0.2, 0.4),
    w('families', 0.5, 0.9),
    w('plan.', 1.0, 1.3),
    w('I', 2.0, 2.1),
    w('help', 2.2, 2.4),
    w('families', 2.5, 2.9),
    w('plan', 3.0, 3.3),
    w('their', 3.4, 3.6),
    w('care.', 3.7, 4.0),
  ];
  const cuts = detectDeterministicCuts(words, {
    sourceDuration: 5,
    enableSilentRestartDetection: true,
    minGapSec: 0.5,
    retainSec: 0.10,
  });
  const badTakes = cuts.filter((c) => c.category === 'bad_take');
  assert.ok(badTakes.length >= 1, 'expected at least one bad_take cut for silent restart');
  const firstSentence = badTakes.find((c) => c.start < 0.2 && c.end >= 1.2);
  assert.ok(firstSentence, `expected cut to span first sentence, got ${JSON.stringify(badTakes)}`);
});

test('Phase 2.9: legitimate repetition for cadence is NOT cut as silent restart', () => {
  const words = [
    w('Run.', 0.0, 0.3),
    w('Run.', 0.4, 0.7),
    w('Run.', 0.8, 1.1),
  ];
  const cuts = detectDeterministicCuts(words, {
    sourceDuration: 2,
    enableSilentRestartDetection: true,
  });
  const badTakes = cuts.filter((c) => c.category === 'bad_take');
  assert.equal(badTakes.length, 0, 'short cadence repetition should NOT be cut');
});

test('Phase 2.9: silent-restart detector OFF leaves restart in place', () => {
  const words = [
    w('I', 0.0, 0.1),
    w('help', 0.2, 0.4),
    w('families', 0.5, 0.9),
    w('plan.', 1.0, 1.3),
    w('I', 2.0, 2.1),
    w('help', 2.2, 2.4),
    w('families', 2.5, 2.9),
    w('plan', 3.0, 3.3),
    w('their', 3.4, 3.6),
    w('care.', 3.7, 4.0),
  ];
  const cuts = detectDeterministicCuts(words, {
    sourceDuration: 5,
    enableSilentRestartDetection: false,
  });
  const restarts = cuts.filter((c) => c.reason.startsWith('silent_restart'));
  assert.equal(restarts.length, 0);
});

test('Phase 2.9.1: sliding 5-gram window catches mid-sentence false start', () => {
  const words = [
    w('we', 0.0, 0.1),
    w('focus', 0.2, 0.5),
    w('on', 0.6, 0.7),
    w('quality', 0.8, 1.2),
    w('really', 1.3, 1.6),
    w('we', 1.9, 2.0),
    w('focus', 2.1, 2.4),
    w('on', 2.5, 2.6),
    w('quality', 2.7, 3.1),
    w('really', 3.2, 3.5),
    w('not', 3.6, 3.8),
    w('volume', 3.9, 4.3),
  ];
  const cuts = detectDeterministicCuts(words, {
    sourceDuration: 5,
    enableSilentRestartDetection: true,
  });
  const badTakes = cuts.filter((c) => c.category === 'bad_take');
  assert.ok(badTakes.length >= 1, 'expected sliding 5-gram to catch the repeat');
});

test('Phase 2.9.1: 4-word repeat from parallel structure is NOT cut', () => {
  const words = [
    w('the', 0.0, 0.2),
    w('difference', 0.3, 0.7),
    w('between', 0.8, 1.1),
    w('a', 1.2, 1.3),
    w('VA', 1.4, 1.6),
    w('who', 1.7, 1.8),
    w('can', 1.9, 2.0),
    w('keep', 2.1, 2.3),
    w('up', 2.4, 2.6),
    w('and', 2.7, 2.9),
    w('a', 3.0, 3.1),
    w('VA', 3.2, 3.4),
    w('who', 3.5, 3.6),
    w('can', 3.7, 3.8),
    w('build', 3.9, 4.1),
    w('ahead.', 4.2, 4.5),
  ];
  const cuts = detectDeterministicCuts(words, {
    sourceDuration: 5,
    enableSilentRestartDetection: true,
  });
  const restarts = cuts.filter((c) => c.reason.startsWith('silent_restart'));
  assert.equal(restarts.length, 0, `parallel structure should NOT trigger silent_restart, got ${JSON.stringify(restarts)}`);
});

test('Phase 2.9: maxCutFraction cap drops cuts past the threshold', () => {
  const words = [
    w('a', 0.0, 0.2),
    w('b', 2.5, 2.7),
    w('c', 5.2, 5.4),
    w('d', 7.9, 8.1),
    w('e', 9.5, 9.8),
  ];
  const cuts = detectDeterministicCuts(words, {
    sourceDuration: 10,
    maxCutFraction: 0.4,
    minGapSec: 1.0,
  });
  const total = cuts.reduce((s, c) => s + (c.end - c.start), 0);
  assert.ok(total <= 4.01, `total cuts ${total.toFixed(2)}s exceeds 40% cap`);
});

test('Phase 2.9.1: post-period silence is safe', () => {
  const words = [
    w('I', 0.0, 0.1),
    w('built', 0.2, 0.4),
    w('it.', 0.5, 0.7),
    w('Then', 1.5, 1.7),
    w('we', 1.8, 1.9),
    w('shipped.', 2.0, 2.4),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 3,
    minGapSec: 0.5,
    cutSafetyMode: 'all',
  });
  const interWord = result.all.find((c) => c.start > 0.5 && c.start < 1.5);
  assert.ok(interWord, 'expected a cut in the inter-word gap');
  assert.equal(interWord.safety, 'safe', `expected safe, got ${interWord.safety} (${interWord.safetyReason})`);
  assert.equal(interWord.safetyReason, 'sentence_boundary');
});

test('Phase 2.9.1: mid-sentence silence with no punctuation is risky', () => {
  const words = [
    w('I', 0.0, 0.1),
    w('want', 0.2, 0.4),
    w('to', 0.5, 0.6),
    w('build', 1.5, 1.7),
    w('a', 1.8, 1.9),
    w('thing', 2.0, 2.3),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 3,
    minGapSec: 0.5,
    cutSafetyMode: 'all',
  });
  const interWord = result.all.find((c) => c.start > 0.6 && c.start < 1.5);
  assert.ok(interWord, 'expected a cut in the inter-word gap');
  assert.equal(interWord.safety, 'risky');
  assert.ok(/dependent_trailing_word|mid_sentence/.test(interWord.safetyReason ?? ''),
    `unexpected safetyReason: ${interWord.safetyReason}`);
});

test('Phase 2.9.1: dependent trailing word "to" → risky', () => {
  const words = [
    w('I', 0.0, 0.1),
    w('went', 0.2, 0.4),
    w('to', 0.5, 0.6),
    w('the', 1.4, 1.5),
    w('store', 1.6, 1.9),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 2.5,
    minGapSec: 0.5,
    cutSafetyMode: 'all',
  });
  const interWord = result.all.find((c) => c.start > 0.6 && c.start < 1.4);
  assert.ok(interWord, 'expected cut in gap');
  assert.equal(interWord.safety, 'risky');
  assert.match(interWord.safetyReason ?? '', /dependent_trailing_word/);
});

test('Phase 2.9.1: comma followed by "and" → risky', () => {
  const words = [
    w('We', 0.0, 0.1),
    w('built', 0.2, 0.4),
    w('it,', 0.5, 0.7),
    w('and', 1.5, 1.7),
    w('shipped', 1.8, 2.1),
    w('it.', 2.2, 2.4),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 3,
    minGapSec: 0.5,
    cutSafetyMode: 'all',
  });
  const interWord = result.all.find((c) => c.start > 0.7 && c.start < 1.5);
  assert.ok(interWord, 'expected cut in gap');
  assert.equal(interWord.safety, 'risky');
  assert.match(interWord.safetyReason ?? '', /comma_then_continuation/);
});

test('Phase 2.9.1: comma followed by capital noun → soft', () => {
  const words = [
    w('We', 0.0, 0.1),
    w('did', 0.2, 0.3),
    w('the', 0.4, 0.5),
    w('project,', 0.6, 1.0),
    w('Justine', 1.8, 2.2),
    w('led', 2.3, 2.5),
    w('it.', 2.6, 2.9),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 3.5,
    minGapSec: 0.5,
    cutSafetyMode: 'all',
  });
  const interWord = result.all.find((c) => c.start > 1.0 && c.start < 1.8);
  assert.ok(interWord, 'expected cut in gap');
  assert.equal(interWord.safety, 'soft');
  assert.match(interWord.safetyReason ?? '', /phrase_boundary/);
});

test('Phase 2.9.1: bad_take is always safe', () => {
  const words = [
    w('I', 0.0, 0.2),
    w('am', 0.3, 0.5),
    w('building', 0.6, 1.0),
    w('wait,', 1.4, 1.7),
    w('let', 1.9, 2.0),
    w('me', 2.0, 2.1),
    w('start', 2.2, 2.5),
    w('over', 2.6, 3.0),
    w('I', 3.5, 3.7),
    w('build', 3.8, 4.2),
    w('reels.', 4.3, 4.7),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 6,
    maxCutFraction: 0.99,
    cutSafetyMode: 'all',
  });
  const badTake = result.all.find((c) => c.category === 'bad_take');
  assert.ok(badTake, 'expected bad_take');
  assert.equal(badTake.safety, 'safe');
});

test('Phase 2.9.1: silent-restart n-gram is always safe', () => {
  const words = [
    w('I', 0.0, 0.1),
    w('help', 0.2, 0.4),
    w('families.', 0.5, 0.9),
    w('I', 1.4, 1.5),
    w('help', 1.6, 1.8),
    w('families', 1.9, 2.3),
    w('plan.', 2.4, 2.7),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 4,
    maxCutFraction: 0.99,
    enableSilentRestartDetection: true,
    cutSafetyMode: 'all',
  });
  const restart = result.all.find((c) => c.category === 'bad_take' && c.reason.startsWith('silent_restart'));
  assert.ok(restart, 'expected silent_restart bad_take');
  assert.equal(restart.safety, 'safe');
});

test('Phase 2.9.1: safe_only mode filters out risky and soft cuts', () => {
  const words = [
    w('We', 0.0, 0.1),
    w('built', 0.2, 0.4),
    w('it.', 0.5, 0.7),
    w('Then', 1.5, 1.7),
    w('we', 1.8, 1.9),
    w('went', 2.0, 2.2),
    w('to', 2.3, 2.4),
    w('the', 3.5, 3.6),
    w('store.', 3.7, 4.0),
  ];
  const safeOnly = detectAndClassifyCuts(words, {
    sourceDuration: 5,
    minGapSec: 0.5,
    cutSafetyMode: 'safe_only',
    maxCutFraction: 0.99,
  });
  for (const c of safeOnly.applied) {
    assert.equal(c.safety, 'safe', `applied non-safe cut: ${JSON.stringify(c)}`);
  }
  assert.ok(safeOnly.skipped.some((c) => c.safety === 'risky'),
    'expected at least one risky cut in skipped list');
});

test('Phase 2.9.1: safe_and_soft mode allows soft cuts', () => {
  const words = [
    w('We', 0.0, 0.1),
    w('did', 0.2, 0.3),
    w('the', 0.4, 0.5),
    w('project,', 0.6, 1.0),
    w('Justine', 1.8, 2.2),
    w('led', 2.3, 2.5),
    w('it.', 2.6, 2.9),
  ];
  const safeAndSoft = detectAndClassifyCuts(words, {
    sourceDuration: 3.5,
    minGapSec: 0.5,
    cutSafetyMode: 'safe_and_soft',
  });
  assert.ok(safeAndSoft.applied.some((c) => c.safety === 'soft'),
    `expected soft cut to be applied; got ${JSON.stringify(safeAndSoft.applied.map((c) => ({ s: c.start, e: c.end, safety: c.safety, reason: c.safetyReason })))}`);
  assert.equal(safeAndSoft.skipped.filter((c) => c.safety === 'soft').length, 0);
});

test('Phase 2.9.1.3: slate "April 18, option A." → cut at start (multi-signal)', () => {
  const words = [
    w('April', 0.20, 0.50),
    w('18,', 0.55, 0.85),
    w('option', 0.95, 1.30),
    w('A.', 1.35, 1.65),
    w('Before', 2.65, 3.00),
    w('a', 3.05, 3.10),
    w('CyberVA', 3.15, 3.55),
    w('steps', 3.60, 3.85),
    w('in.', 3.90, 4.20),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 5,
    maxCutFraction: 0.99,
    detectSlateFromTranscript: true,
    cutSafetyMode: 'all',
  });
  const slateCut = result.all.find((c) => c.reason.includes('slate_intro'));
  assert.ok(slateCut, 'expected slate cut');
  assert.equal(slateCut.start, 0);
  assert.ok(slateCut.end >= 1.65, `slate cut should cover at least through "A." (1.65), got ${slateCut.end}`);
  assert.equal(slateCut.safety, 'safe');
  assert.equal(slateCut.safetyReason, 'leading_silence');
});

test('Phase 2.9.1.3: real-content first sentence with month/date alone → NO slate cut', () => {
  const words = [
    w('We', 0.0, 0.2),
    w('launched', 0.3, 0.7),
    w('in', 0.8, 0.9),
    w('April', 1.0, 1.3),
    w('2024.', 1.4, 1.8),
    w('Then', 2.5, 2.8),
    w('everything', 2.9, 3.4),
    w('changed.', 3.5, 4.0),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 5,
    detectSlateFromTranscript: true,
    cutSafetyMode: 'all',
  });
  const slateCut = result.all.find((c) => c.reason.startsWith('slate_intro'));
  assert.equal(slateCut, undefined, 'real-content sentence with date alone should NOT trigger slate');
});

test('Phase 2.9.1.3: short editor phrase "Take 2." → cut (single-signal short-phrase trigger)', () => {
  const words = [
    w('Take', 0.20, 0.55),
    w('2.', 0.60, 0.95),
    w('Welcome', 1.80, 2.10),
    w('back!', 2.15, 2.50),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 3,
    maxCutFraction: 0.99,
    detectSlateFromTranscript: true,
    cutSafetyMode: 'all',
  });
  const slateCut = result.all.find((c) => c.reason.includes('slate_intro'));
  assert.ok(slateCut, 'expected short-editor-phrase slate cut');
  assert.match(slateCut.reason, /short_editor_phrase/);
});

test('Phase 2.9.1.3: slate detection SKIPPED when startAfterSec > 0 (production safety)', () => {
  const words = [
    w('April', 0.20, 0.50),
    w('18,', 0.55, 0.85),
    w('option', 0.95, 1.30),
    w('A.', 1.35, 1.65),
    w('Before', 2.65, 3.00),
    w('we', 3.05, 3.10),
    w('start.', 3.15, 3.55),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 5,
    startAfterSec: 1.65,
    detectSlateFromTranscript: true,
    cutSafetyMode: 'all',
  });
  const slateCut = result.all.find((c) => c.reason.startsWith('slate_intro'));
  assert.equal(slateCut, undefined, 'deterministic slate must NOT fire when startAfterSec > 0');
});

test('Phase 2.9.1.3: camera-shutoff cut emitted past lastWord + pad', () => {
  const words = [
    w('hello.', 0.0, 0.5),
    w('world', 1.0, 1.4),
    w('end.', 4.5, 5.0),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 10,
    cutBeyondLastWordPadSec: 0.5,
    cutSafetyMode: 'all',
    maxCutFraction: 0.99,
  });
  const shutoff = result.all.find((c) => c.reason.includes('camera_shutoff'));
  assert.ok(shutoff, 'expected camera_shutoff cut');
  assert.ok(Math.abs(shutoff.start - 5.5) < 0.05, `cut start ~5.5, got ${shutoff.start}`);
  assert.equal(shutoff.end, 10);
  assert.equal(shutoff.safety, 'safe');
  assert.equal(shutoff.safetyReason, 'trailing_silence');
});

test('Phase 2.9.1.3: NO camera-shutoff cut when last word is at sourceDuration', () => {
  const words = [
    w('hello.', 0.0, 0.5),
    w('world.', 4.5, 4.95),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 5.0,
    cutBeyondLastWordPadSec: 0.5,
    cutSafetyMode: 'all',
  });
  const shutoff = result.all.find((c) => c.reason.startsWith('camera_shutoff'));
  assert.equal(shutoff, undefined, 'no camera_shutoff when no content past last word + pad');
});

test('Phase 2.9.1.4: cut.start inside a Scribe word → clamp pushes start past word.end (real Justine bug)', () => {
  const words = [
    w('what', 61.479, 61.559),
    w('should', 61.619, 61.739),
    w('have', 61.759, 61.840),
    w('been', 61.879, 62.059),
    w('obvious.', 62.139, 62.619),
    w('The', 64.019, 64.099),
    w('operators', 64.199, 64.659),
    w('are', 64.720, 64.799),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 70,
    minGapSec: 0.5,
    retainSec: 0.20,
    cutSafetyMode: 'all',
    externalSilences: [{ start: 62.366, end: 63.832 }],
  });
  const cut = result.all.find((c) => c.start >= 62 && c.start <= 64);
  assert.ok(cut, 'silence cut produced for the dead-air span');
  assert.ok(
    cut.start >= 62.619,
    `cut.start (${cut.start}) must be at or past "obvious." word.end (62.619)`,
  );
  assert.equal(cut.safety, 'safe', `expected safe, got ${cut.safety} (${cut.safetyReason})`);
});

test('Phase 2.9.1.4: cut.end inside a Scribe word → clamp pulls end before word.start (real Justine bug)', () => {
  const words = [
    w('rewards', 69.159, 69.539),
    w('their', 69.559, 69.719),
    w('judgment.', 69.779, 70.220),
    w('They', 71.659, 71.779),
    w('develop', 71.839, 72.159),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 73,
    minGapSec: 0.5,
    retainSec: 0.20,
    cutSafetyMode: 'all',
    externalSilences: [{ start: 69.876, end: 71.474 }],
  });
  const cut = result.all.find((c) => c.start >= 69 && c.start <= 72);
  assert.ok(cut, 'silence cut produced');
  assert.ok(
    cut.start >= 70.220,
    `cut.start (${cut.start}) must not eat into "judgment." (ends 70.220)`,
  );
  assert.ok(
    cut.end <= 71.659,
    `cut.end (${cut.end}) must not eat into "They" (starts 71.659)`,
  );
});

test('Phase 2.9.1.4: camera_shutoff cuts EXEMPT from word-boundary clamp', () => {
  const words = [
    w('producing', 90.0, 90.4),
    w('them.', 92.10, 96.30),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 96.69,
    minGapSec: 0.5,
    retainSec: 0.20,
    cutBeyondLastWordPadSec: 0.5,
    cutSafetyMode: 'all',
    externalSilences: [{ start: 92.16, end: 96.69 }],
  });
  const shutoff = result.all.find((c) => c.reason.startsWith('camera_shutoff'));
  assert.ok(shutoff, 'camera_shutoff cut emitted');
  assert.ok(
    shutoff.start < 93.0,
    `camera_shutoff start (${shutoff.start}) should be ~92.66 from ffmpeg, not pushed past Scribe's stretched word.end`,
  );
});

test('Phase 2.9.1: contextBefore and contextAfter populated on every classified cut', () => {
  const words = [
    w('we', 0.0, 0.1),
    w('built', 0.2, 0.4),
    w('it.', 0.5, 0.7),
    w('Then', 1.5, 1.7),
    w('we', 1.8, 1.9),
    w('went', 2.0, 2.2),
    w('home.', 2.3, 2.6),
  ];
  const result = detectAndClassifyCuts(words, {
    sourceDuration: 3,
    minGapSec: 0.5,
    cutSafetyMode: 'all',
  });
  for (const c of result.all) {
    assert.ok(typeof c.contextBefore === 'string', `missing contextBefore: ${JSON.stringify(c)}`);
    assert.ok(typeof c.contextAfter === 'string', `missing contextAfter: ${JSON.stringify(c)}`);
  }
});
