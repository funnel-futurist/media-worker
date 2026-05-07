/**
 * test/deepgram_transcribe.test.js
 *
 * Pure-function tests for mapDeepgramResponse — the converter from
 * Deepgram's raw response shape to the pipeline's canonical
 *   { transcript, word_timestamps: [{word, start_ms, end_ms}] }.
 *
 * No network: callDeepgramWithRetry's HTTP behavior is exercised by the
 * production pipeline + the local key probe (tmp/deepgram-key-probe.sh),
 * not by this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mapDeepgramResponse } from '../lib/deepgram_transcribe.js';

// Minimal fixture matching Deepgram's prerecorded API response (model=nova-3,
// smart_format=true, punctuate=true). Trimmed to the fields we read.
function makeRawResponse(words, transcript) {
  return {
    results: {
      channels: [
        {
          alternatives: [
            {
              transcript: transcript ?? words.map((w) => w.punctuated_word ?? w.word).join(' '),
              words,
            },
          ],
        },
      ],
    },
  };
}

// ── happy path ─────────────────────────────────────────────────────────

test('map: standard 3-word response → canonical shape', () => {
  const raw = makeRawResponse([
    { word: 'hello', start: 0.16, end: 0.48, confidence: 0.99, punctuated_word: 'Hello' },
    { word: 'there', start: 0.50, end: 0.84, confidence: 0.98, punctuated_word: 'there.' },
    { word: 'friend', start: 1.00, end: 1.40, confidence: 0.97, punctuated_word: 'friend' },
  ]);
  const out = mapDeepgramResponse(raw);
  assert.equal(out.word_timestamps.length, 3);
  assert.deepEqual(out.word_timestamps[0], { word: 'Hello', start_ms: 160, end_ms: 480 });
  assert.deepEqual(out.word_timestamps[1], { word: 'there.', start_ms: 500, end_ms: 840 });
  assert.deepEqual(out.word_timestamps[2], { word: 'friend', start_ms: 1000, end_ms: 1400 });
  // No _debug branch on a happy result.
  assert.equal(out._debug, undefined);
});

test('map: transcript prefers alt.transcript over reconstructed join', () => {
  // Deepgram's alt.transcript is what we trust — it carries the
  // smart-formatted punctuation. The synthetic `makeRawResponse` already
  // sets it, but we'll make the words[] strings deliberately different
  // to confirm we read the top-level field.
  const raw = makeRawResponse(
    [
      { word: 'a', start: 0.0, end: 0.1, punctuated_word: 'A' },
      { word: 'b', start: 0.2, end: 0.3, punctuated_word: 'b' },
    ],
    'A real transcript with punctuation.',
  );
  const out = mapDeepgramResponse(raw);
  assert.equal(out.transcript, 'A real transcript with punctuation.');
});

test('map: punctuated_word carries sentence-end markers (cut detector relies on this)', () => {
  // The line-grouper in subtitle_burn.js breaks on words ending in .!? —
  // we need punctuated_word, not the bare word, so that "there." carries
  // its period.
  const raw = makeRawResponse([
    { word: 'wait',    start: 0.0, end: 0.3, punctuated_word: 'Wait!' },
    { word: 'really',  start: 0.4, end: 0.7, punctuated_word: 'Really?' },
  ]);
  const out = mapDeepgramResponse(raw);
  assert.equal(out.word_timestamps[0].word, 'Wait!');
  assert.equal(out.word_timestamps[1].word, 'Really?');
});

test('map: falls back to bare `word` when punctuated_word is absent', () => {
  // Defensive: if Deepgram ever stops sending punctuated_word (older model /
  // future change), use the bare word so we degrade gracefully.
  const raw = makeRawResponse([
    { word: 'plain', start: 0.0, end: 0.3 }, // no punctuated_word
  ]);
  const out = mapDeepgramResponse(raw);
  assert.equal(out.word_timestamps[0].word, 'plain');
});

// ── filtering ──────────────────────────────────────────────────────────

test('map: drops words with empty/whitespace text', () => {
  const raw = makeRawResponse([
    { word: 'hello', start: 0.0, end: 0.3, punctuated_word: 'Hello' },
    { word: '',      start: 0.4, end: 0.5, punctuated_word: '' },        // dropped
    { word: '   ',   start: 0.6, end: 0.7, punctuated_word: '   ' },     // dropped
    { word: 'world', start: 0.8, end: 1.0, punctuated_word: 'world' },
  ]);
  const out = mapDeepgramResponse(raw);
  assert.equal(out.word_timestamps.length, 2);
  assert.equal(out.word_timestamps[0].word, 'Hello');
  assert.equal(out.word_timestamps[1].word, 'world');
});

test('map: drops words with end <= start (corrupt / zero-duration)', () => {
  const raw = makeRawResponse([
    { word: 'good',  start: 0.0, end: 0.3, punctuated_word: 'good' },
    { word: 'bad',   start: 0.5, end: 0.5, punctuated_word: 'bad' },   // dropped: end == start
    { word: 'worse', start: 1.0, end: 0.8, punctuated_word: 'worse' }, // dropped: end < start
    { word: 'okay',  start: 1.5, end: 1.8, punctuated_word: 'okay' },
  ]);
  const out = mapDeepgramResponse(raw);
  assert.equal(out.word_timestamps.length, 2);
  assert.equal(out.word_timestamps[0].word, 'good');
  assert.equal(out.word_timestamps[1].word, 'okay');
});

// ── timestamp conversion ───────────────────────────────────────────────

test('map: rounds seconds → milliseconds, never produces fractional ms', () => {
  // 0.1234s → 123ms (rounded). 0.1235s → 124ms. Verifies we use Math.round
  // (not Math.floor) so timing stays accurate at sub-frame granularity.
  const raw = makeRawResponse([
    { word: 'a', start: 0.1234, end: 0.5678, punctuated_word: 'a' },
  ]);
  const out = mapDeepgramResponse(raw);
  assert.equal(out.word_timestamps[0].start_ms, 123);
  assert.equal(out.word_timestamps[0].end_ms, 568);
  assert.ok(Number.isInteger(out.word_timestamps[0].start_ms));
  assert.ok(Number.isInteger(out.word_timestamps[0].end_ms));
});

// ── empty / malformed input → _debug branch ────────────────────────────

test('map: empty words array attaches _debug with shape info', () => {
  const raw = makeRawResponse([]);
  const out = mapDeepgramResponse(raw);
  assert.equal(out.word_timestamps.length, 0);
  assert.ok(out._debug, 'expected _debug on empty result');
  assert.equal(out._debug.rawWordsLength, 0);
  assert.deepEqual(out._debug.rawTopLevelKeys, ['results']);
  assert.ok(typeof out._debug.rawSample === 'string');
  assert.ok(out._debug.rawSample.length > 0);
});

test('map: missing results.channels → _debug branch with empty altKeys', () => {
  const raw = { results: {} };
  const out = mapDeepgramResponse(raw);
  assert.equal(out.word_timestamps.length, 0);
  assert.equal(out.transcript, '');
  assert.ok(out._debug);
  assert.deepEqual(out._debug.altKeys, []);
});

test('map: completely empty input → safe degradation (no throw)', () => {
  const out = mapDeepgramResponse(null);
  assert.equal(out.word_timestamps.length, 0);
  assert.equal(out.transcript, '');
  assert.ok(out._debug);
});

test('map: transcript falls back to joined words if alt.transcript missing', () => {
  // Edge case: alt.transcript absent but words[] populated.
  const raw = {
    results: {
      channels: [{
        alternatives: [{
          // no transcript field
          words: [
            { word: 'hello', start: 0.0, end: 0.3, punctuated_word: 'Hello' },
            { word: 'world', start: 0.4, end: 0.7, punctuated_word: 'world' },
          ],
        }],
      }],
    },
  };
  const out = mapDeepgramResponse(raw);
  assert.equal(out.transcript, 'Hello world');
  assert.equal(out.word_timestamps.length, 2);
});

// ── ordering preservation ──────────────────────────────────────────────

test('map: preserves input word order (no internal sorting)', () => {
  // The pipeline downstream assumes word_timestamps are in chronological
  // order. Deepgram already returns them sorted; we must not re-sort or
  // reorder.
  const raw = makeRawResponse([
    { word: 'first',  start: 0.0, end: 0.3, punctuated_word: 'First' },
    { word: 'second', start: 0.4, end: 0.7, punctuated_word: 'second' },
    { word: 'third',  start: 0.8, end: 1.1, punctuated_word: 'third.' },
  ]);
  const out = mapDeepgramResponse(raw);
  assert.equal(out.word_timestamps[0].word, 'First');
  assert.equal(out.word_timestamps[1].word, 'second');
  assert.equal(out.word_timestamps[2].word, 'third.');
});
