/**
 * test/slate_snap.test.js
 *
 * Unit tests for snapSlateEndToNextWord — the post-processing helper that
 * extends an LLM-emitted slate end timestamp to the next clean word
 * boundary. Solves the B10 regression where the LLM said slate ends at
 * 9.04s but Phil's "A" from "Option A" extended past 9.04s, leaving the
 * sound at the start of the final video.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { snapSlateEndToNextWord } from '../lib/slate_detect.js';

function w(word, startSec, endSec) {
  return { word, start_ms: Math.round(startSec * 1000), end_ms: Math.round(endSec * 1000) };
}

// ── happy path ────────────────────────────────────────────────────────

test('snap: LLM end falls in the middle of a gap → snap to next word start', () => {
  const words = [
    w('Selected', 7.5, 7.9),
    w('option', 8.0, 8.4),
    w('A.', 8.5, 9.0),
    w('Why', 10.5, 10.7),       // next real content
    w('next', 10.8, 11.0),
  ];
  // LLM said 9.5s (in the gap between "A." and "Why")
  const out = snapSlateEndToNextWord(9.5, words);
  assert.equal(out, 10.5, 'should snap to start of "Why"');
});

test('snap: LLM end equal to a word end → snap to NEXT word, not the same one', () => {
  // The B10 regression case: LLM rounds slate end to "A." word end at 9.04.
  // Without the safety pad, the snap would find "A." itself (start_ms < 9.04
  // but end_ms == 9.04). The safety pad pushes the search past it.
  const words = [
    w('option', 8.5, 8.9),
    w('A.', 8.95, 9.04),         // ends right at LLM's reported slate end
    w('Why', 10.5, 10.7),
  ];
  const out = snapSlateEndToNextWord(9.04, words);
  assert.equal(out, 10.5, 'should NOT snap back to "A."; should advance to "Why"');
});

test('snap: LLM end falls inside a word → snap past the containing word', () => {
  const words = [
    w('option', 8.0, 8.4),
    w('A,Title:', 8.5, 9.5),     // long combined word straddles 9.04
    w('Why', 10.5, 10.7),
  ];
  const out = snapSlateEndToNextWord(9.04, words);
  // The containing word starts BEFORE 9.04+0.05, so it doesn't match the
  // "strictly after" filter. The next word after it ("Why") wins.
  assert.equal(out, 10.5);
});

test('snap: LLM end is past all words → return LLM end unchanged', () => {
  const words = [
    w('hello', 0, 0.5),
    w('world', 1, 1.5),
  ];
  const out = snapSlateEndToNextWord(60.0, words);
  assert.equal(out, 60.0);
});

// ── safety pad behavior ───────────────────────────────────────────────

test('snap: word starting just BEFORE LLM end + pad does not get picked', () => {
  // LLM end 9.0s; safety pad 0.05; threshold = 9.05.
  // Word at 9.0-9.04 ends RIGHT at LLM end. Next word starts at 9.06 (just
  // above threshold). Should pick the word at 9.06 — not skip ahead further.
  const words = [
    w('A.', 9.0, 9.04),
    w('Title:', 9.06, 9.40),
  ];
  const out = snapSlateEndToNextWord(9.0, words);
  assert.equal(out, 9.06);
});

test('snap: custom safety pad shifts the threshold accordingly', () => {
  const words = [
    w('A.', 9.0, 9.04),
    w('Title:', 9.06, 9.40),
    w('Why', 9.50, 9.70),
  ];
  // With a 0.10s pad, threshold = 9.10. "Title:" starts at 9.06 (below),
  // "Why" starts at 9.50 (above) → picks Why.
  const out = snapSlateEndToNextWord(9.0, words, 0.10);
  assert.equal(out, 9.50);
});

// ── edge cases ────────────────────────────────────────────────────────

test('snap: empty words array → return LLM end unchanged', () => {
  const out = snapSlateEndToNextWord(9.04, []);
  assert.equal(out, 9.04);
});

test('snap: null/undefined words array → return LLM end unchanged', () => {
  assert.equal(snapSlateEndToNextWord(9.04, null), 9.04);
  assert.equal(snapSlateEndToNextWord(9.04, undefined), 9.04);
});

test('snap: non-finite LLM end → return LLM end unchanged (defensive)', () => {
  assert.ok(Number.isNaN(snapSlateEndToNextWord(NaN, [w('a', 0, 1)])));
  assert.equal(snapSlateEndToNextWord(Infinity, [w('a', 0, 1)]), Infinity);
});

test('snap: words with missing start_ms are skipped, not crash', () => {
  const words = [
    { word: 'broken' },                       // no start_ms
    w('valid', 10.0, 10.5),
  ];
  const out = snapSlateEndToNextWord(5.0, words);
  assert.equal(out, 10.0);
});

test('snap: returns the FIRST matching word, not the latest', () => {
  // Linear scan; should stop at the first hit.
  const words = [
    w('a', 5.0, 5.5),
    w('b', 6.0, 6.5),
    w('c', 7.0, 7.5),
    w('d', 8.0, 8.5),
  ];
  const out = snapSlateEndToNextWord(5.7, words);  // threshold = 5.75
  assert.equal(out, 6.0, 'should pick "b" not "c" or "d"');
});

// ── regression lock-in: B10 Phil case ─────────────────────────────────

test('snap: B10 Phil case — LLM 9.04s + Deepgram word boundaries → cuts past Option A', () => {
  // Approximated from the actual B10 transcript shape: LLM emitted 9.04 as
  // the slate end. The "A" from Option A had its end_ms rounded down to
  // ~9050 by Deepgram. Without the snap, the cut [0, 9.04] left the audio
  // tail of "A" at the very start of the final video. With the snap, we
  // advance to the next real word which starts post-slate.
  const phil_b10_like_words = [
    w('Monday,', 0.10, 0.40),
    w('April', 0.50, 0.80),
    w('27.', 0.85, 1.20),
    w('Title:', 1.50, 1.85),
    w('Why', 1.90, 2.10),
    w('next', 2.15, 2.40),
    w('month', 2.45, 2.75),
    w('becomes', 2.80, 3.20),
    w('next', 3.25, 3.50),
    w('year', 3.55, 3.90),
    w('for', 3.95, 4.10),
    w('families', 4.15, 4.65),
    w('like', 4.70, 4.90),
    w('yours.', 4.95, 5.40),
    w('Selected', 7.50, 7.90),
    w('option', 7.95, 8.30),
    w('A.', 8.40, 9.05),         // ends at 9.05 — just past LLM's 9.04
    w('Before', 10.30, 10.60),    // first real content word
    w('a', 10.65, 10.75),
    w('CyberGrade', 10.80, 11.40),
  ];
  const out = snapSlateEndToNextWord(9.04, phil_b10_like_words);
  assert.equal(out, 10.30, 'should snap to "Before" — fully past Option A');
});
