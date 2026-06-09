/**
 * test/slate_hint_end_precision.test.js
 *
 * 2026-06-09: regression guard for the EnableSNP Saturday Jun 13 over-cut.
 *
 * Before the fix, when slateHint matched a sentence, the deterministic floor
 * cut at the sentence's `endMs` — which over-cut whenever Deepgram fused the
 * spoken slate AND the opening hook into one giant sentence (no period
 * between "june 30" and "a quiet reminder"). The fix: when the hint match is
 * the winning boundary, find the precise end_ms of the LAST hint token
 * within the sentence and cut THERE.
 *
 * Covers:
 *  - findHintEndMsInSentence pure helper (the new exported logic).
 *  - detectDeterministicSlateFloor end-to-end with the exact Saturday
 *    transcript shape (hint matches a fused sentence; the hook follows).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { findHintEndMsInSentence, detectDeterministicSlateFloor } from '../lib/slate_detect.js';

// Helper: build a Deepgram-style word given a 1-based positional index, the
// raw word text, and ms-aligned start/end times.
function w(word, startMs, endMs) {
  return { word, start_ms: startMs, end_ms: endMs };
}

// ─────────────────────────── findHintEndMsInSentence ───────────────────────

test('findHintEndMsInSentence: returns end_ms of the LAST hint token inside the sentence', () => {
  // Sentence: "saturday june 13th the calm reminder about june 30 a quiet reminder"
  const sentenceWords = [
    w('saturday', 0, 500),
    w('june', 500, 800),
    w('13th', 800, 1200),
    w('the', 1200, 1300),
    w('calm', 1300, 1700),
    w('reminder', 1700, 2300),
    w('about', 2300, 2600),
    w('june', 2600, 2900),
    w('30', 2900, 3400),    // ← end of the hint
    w('a', 3500, 3600),     // ← hook begins
    w('quiet', 3600, 4000),
    w('reminder', 4000, 4600),
  ];
  const hint = 'saturday june 13th the calm reminder about june 30';
  assert.equal(findHintEndMsInSentence(sentenceWords, hint), 3400);
});

test('findHintEndMsInSentence: ignores hint-tokens repeated later in the sentence (only counts the first in-order match)', () => {
  // The word "reminder" appears twice — once inside the hint, once in the
  // hook ("a quiet reminder"). The alignment walks LEFT-TO-RIGHT once, so it
  // stops advancing the hint pointer after the hint's full token sequence
  // has been consumed → the second "reminder" can't pull the cut forward.
  const sentenceWords = [
    w('the', 0, 100),
    w('calm', 100, 400),
    w('reminder', 400, 800),  // hint "reminder"
    w('about', 800, 1000),
    w('june', 1000, 1200),
    w('30', 1200, 1500),      // ← end of hint
    w('a', 1600, 1700),
    w('quiet', 1700, 2000),
    w('reminder', 2000, 2400), // ← later "reminder" should NOT be the end
  ];
  const hint = 'the calm reminder about june 30';
  assert.equal(findHintEndMsInSentence(sentenceWords, hint), 1500);
});

test('findHintEndMsInSentence: empty / missing inputs return null (no surprise crashes)', () => {
  assert.equal(findHintEndMsInSentence([], 'whatever'), null);
  assert.equal(findHintEndMsInSentence(null, 'whatever'), null);
  assert.equal(findHintEndMsInSentence([w('hello', 0, 100)], ''), null);
});

test('findHintEndMsInSentence: returns null when fewer than 0.6 of hint tokens match', () => {
  // Hint has 5 content tokens; sentence only contains 1 of them.
  const sentenceWords = [
    w('completely', 0, 500),
    w('unrelated', 500, 1000),
    w('content', 1000, 1500),
  ];
  const hint = 'imagine june without this lingering';
  assert.equal(findHintEndMsInSentence(sentenceWords, hint), null);
});

test('findHintEndMsInSentence: tolerates stopwords inside the sentence (only content tokens align)', () => {
  // Hint stopword-strips to [imagine, june, without, this, lingering].
  // Sentence has them all in order, plus extra stopwords scattered.
  const sentenceWords = [
    w('imagine', 0, 400),
    w('june', 400, 700),
    w('without', 700, 1100),
    w('this', 1100, 1300),
    w('lingering', 1300, 1900),     // ← end of hint
    w('feeling', 2000, 2400),       // hook word
  ];
  const hint = 'Imagine June Without This Lingering';
  assert.equal(findHintEndMsInSentence(sentenceWords, hint), 1900);
});

// ─────────────────────────── detectDeterministicSlateFloor end-to-end ──────

test('floor: hint match in a FUSED slate+hook sentence cuts at the hint end (Saturday Jun 13 case)', () => {
  // The Deepgram transcript Deepgram returned for Saturday: one big sentence
  // (no period between "june 30" and "a quiet reminder").
  const words = [
    w('saturday', 0, 500),
    w('june', 500, 800),
    w('13th', 800, 1200),
    w('the', 1200, 1300),
    w('calm', 1300, 1700),
    w('reminder', 1700, 2300),
    w('about', 2300, 2600),
    w('june', 2600, 2900),
    w('30', 2900, 3400),
    w('a', 3500, 3600),
    w('quiet', 3600, 4000),
    w('reminder', 4000, 4600),
    w('for', 4600, 4800),
    w('any', 4800, 5000),
    w('family.', 5000, 5400),       // first period — Deepgram closes the sentence here
  ];
  const out = detectDeterministicSlateFloor(words, {
    slateHint: 'saturday june 13th the calm reminder about june 30',
  });
  assert.ok(out, 'expected a floor match');
  // Cut at "30"'s end_ms (3.4s), NOT the fused sentence's end (5.4s).
  assert.equal(out.endSec, 3.4);
});

test('floor: when there is no hint match, falls back to the old sentence-end behavior (meta-marker path unchanged)', () => {
  // Phil's old date+option pattern (no hint provided here).
  const words = [
    w('Selected', 0, 400),
    w('option', 400, 800),
    w('A.', 800, 1200),             // period closes the sentence
    w('What', 1300, 1600),          // hook follows
    w('your', 1600, 1800),
    w('future.', 1800, 2200),
  ];
  const out = detectDeterministicSlateFloor(words, { slateHint: '' });
  assert.ok(out, 'expected a meta-marker floor match');
  assert.equal(out.endSec, 1.2, 'should cut at the meta marker sentence end');
});

test('floor: hint match in a CLEAN sentence (slate followed by a period) is unchanged by the fix', () => {
  // When Deepgram does put a period between slate and hook, the precise
  // hint-end and the sentence-end coincide. Regression guard: the fix must
  // not change behavior here.
  const words = [
    w('A', 0, 100),
    w('Quiet', 100, 500),
    w('Reminder.', 500, 1000),       // ← sentence ends with the title period
    w('Our', 1100, 1300),
    w('foundational', 1300, 2000),
  ];
  const out = detectDeterministicSlateFloor(words, { slateHint: 'A Quiet Reminder' });
  assert.ok(out, 'expected a floor match');
  assert.equal(out.endSec, 1.0);
});
