/**
 * test/bad_take_detect.test.js
 *
 * Unit tests for the Gemini-based bad-take detector. Same mocked-fetcher
 * pattern as test/slate_detect.test.js so the suite stays fast + offline.
 *
 * What we test:
 *   - Output filtering: min duration, startAfter, overlap exclusion
 *   - Output normalization: sort + merge of overlapping cuts
 *   - Safety cap: maxCutFraction × sourceDuration enforcement
 *   - Reason text handling (truncation, defaults)
 *   - Edge cases: empty input, malformed JSON, error degradation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBadTakes } from '../lib/bad_take_detect.js';

function w(word, startSec, endSec) {
  return { word, start_ms: Math.round(startSec * 1000), end_ms: Math.round(endSec * 1000) };
}

function fakeResponse({ ok = true, status = 200, body }) {
  return {
    ok,
    status,
    async text() { return JSON.stringify(body); },
    async json() { return body; },
    clone() { return fakeResponse({ ok, status, body }); },
  };
}

function geminiResponseFor(detectorOutput) {
  return {
    candidates: [
      { content: { parts: [{ text: JSON.stringify(detectorOutput) }] } },
    ],
  };
}

function mockFetcher(detectorOutput, { ok = true, status = 200 } = {}) {
  return async () => fakeResponse({ ok, status, body: geminiResponseFor(detectorOutput) });
}

const SAMPLE_WORDS = [w('hello', 0, 0.5), w('world', 1, 1.5), w('again', 2, 2.5)];

// ── happy path ─────────────────────────────────────────────────────────

test('detectBadTakes: returns empty array when Gemini returns no cuts', async () => {
  const result = await detectBadTakes(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: mockFetcher({ cuts: [] }) },
  );
  assert.deepEqual(result, []);
});

test('detectBadTakes: returns valid cuts unchanged', async () => {
  const result = await detectBadTakes(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        cuts: [
          { start: 5.0, end: 6.5, reason: 'restart phrase' },
          { start: 12.0, end: 13.0, reason: 'stumble' },
        ],
      }),
    },
  );
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { start: 5.0, end: 6.5, reason: 'restart phrase' });
  assert.deepEqual(result[1], { start: 12.0, end: 13.0, reason: 'stumble' });
});

// ── input filtering ────────────────────────────────────────────────────

test('detectBadTakes: drops cuts below 0.3s minimum duration', async () => {
  const result = await detectBadTakes(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        cuts: [
          { start: 5.0, end: 5.1, reason: 'too short' },          // dropped (0.1s)
          { start: 5.0, end: 5.29, reason: 'just below' },        // dropped (0.29s)
          // Use 0.31s to avoid float-precision edge (6.3-6.0 = 0.2999... in JS).
          // The filter is `<0.3`, so 0.31 is comfortably above the threshold.
          { start: 6.0, end: 6.31, reason: 'just above min' },    // kept
          { start: 7.0, end: 7.5, reason: 'comfortable' },        // kept
        ],
      }),
    },
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].reason, 'just above min');
  assert.equal(result[1].reason, 'comfortable');
});

test('detectBadTakes: drops cuts where end <= start', async () => {
  const result = await detectBadTakes(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        cuts: [
          { start: 5.0, end: 5.0, reason: 'zero-duration' },      // dropped
          { start: 7.0, end: 6.0, reason: 'inverted' },           // dropped
          { start: 10.0, end: 11.0, reason: 'good' },             // kept
        ],
      }),
    },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, 'good');
});

test('detectBadTakes: drops cuts that start before startAfterSec (slate window)', async () => {
  const result = await detectBadTakes(
    {
      wordTimestamps: SAMPLE_WORDS,
      sourceDuration: 100,
      startAfterSec: 5.0,  // pretend slate ends at 5s
    },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        cuts: [
          { start: 2.0, end: 3.0, reason: 'inside slate window' },  // dropped
          { start: 4.5, end: 5.5, reason: 'starts before' },         // dropped
          { start: 6.0, end: 7.0, reason: 'after slate' },           // kept
        ],
      }),
    },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, 'after slate');
});

test('detectBadTakes: drops cuts that overlap excludeOverlapWith (silence cuts)', async () => {
  const result = await detectBadTakes(
    {
      wordTimestamps: SAMPLE_WORDS,
      sourceDuration: 100,
      excludeOverlapWith: [
        { start: 10.0, end: 12.0 },  // existing silence cut
        { start: 20.0, end: 22.0 },
      ],
    },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        cuts: [
          { start: 10.5, end: 11.5, reason: 'overlap1' },     // dropped (inside silence)
          { start: 11.5, end: 13.0, reason: 'overlap2' },     // dropped (straddles silence end)
          { start: 21.5, end: 22.5, reason: 'overlap3' },     // dropped (straddles silence start)
          { start: 15.0, end: 16.0, reason: 'no overlap' },   // kept
          { start: 30.0, end: 31.0, reason: 'far away' },     // kept
        ],
      }),
    },
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].reason, 'no overlap');
  assert.equal(result[1].reason, 'far away');
});

// ── normalization ──────────────────────────────────────────────────────

test('detectBadTakes: sorts unsorted cuts chronologically', async () => {
  const result = await detectBadTakes(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        cuts: [
          { start: 30.0, end: 31.0, reason: 'third' },
          { start: 5.0, end: 6.0, reason: 'first' },
          { start: 15.0, end: 16.0, reason: 'second' },
        ],
      }),
    },
  );
  assert.deepEqual(result.map((c) => c.reason), ['first', 'second', 'third']);
});

test('detectBadTakes: merges overlapping cuts (Gemini sometimes returns dupes)', async () => {
  const result = await detectBadTakes(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        cuts: [
          { start: 5.0, end: 6.5, reason: 'restart' },
          { start: 6.0, end: 7.0, reason: 'continued' },  // overlaps; should merge
          { start: 10.0, end: 11.0, reason: 'separate' }, // stays separate
        ],
      }),
    },
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].start, 5.0);
  assert.equal(result[0].end, 7.0);  // extended
  assert.match(result[0].reason, /restart\+continued/);
  assert.equal(result[1].start, 10.0);
  assert.equal(result[1].end, 11.0);
});

// ── safety cap ─────────────────────────────────────────────────────────

test('detectBadTakes: enforces maxCutFraction × sourceDuration', async () => {
  // sourceDuration=100, default maxCutFraction=0.25 → cap at 25s total cut
  const result = await detectBadTakes(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        cuts: [
          { start: 0, end: 10, reason: 'big1' },     // 10s
          { start: 20, end: 30, reason: 'big2' },    // 10s; cumulative 20s
          { start: 40, end: 50, reason: 'big3' },    // 10s; cumulative 30s — exceeds 25s
          { start: 60, end: 65, reason: 'big4' },    // dropped (cap reached)
        ],
      }),
    },
  );
  // Should keep the first two (cumulative 20s), then drop big3 because
  // adding it would exceed the 25s cap. (Greedy stop, not selective skip.)
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((c) => c.reason), ['big1', 'big2']);
});

test('detectBadTakes: respects custom maxCutFraction', async () => {
  const result = await detectBadTakes(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100, maxCutFraction: 0.5 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        cuts: [
          { start: 0, end: 20, reason: 'big1' },     // 20s; under 50s cap
          { start: 25, end: 45, reason: 'big2' },    // 20s; cumulative 40s — under cap
          { start: 50, end: 70, reason: 'big3' },    // 20s; cumulative 60s — exceeds 50s cap
        ],
      }),
    },
  );
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((c) => c.reason), ['big1', 'big2']);
});

// ── reason text handling ───────────────────────────────────────────────

test('detectBadTakes: truncates reason at 80 chars', async () => {
  const veryLongReason = 'a'.repeat(200);
  const result = await detectBadTakes(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        cuts: [{ start: 5, end: 6, reason: veryLongReason }],
      }),
    },
  );
  assert.equal(result[0].reason.length, 80);
});

test('detectBadTakes: defaults reason to "bad_take" when missing', async () => {
  const result = await detectBadTakes(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        cuts: [{ start: 5, end: 6 }],  // no reason field
      }),
    },
  );
  assert.equal(result[0].reason, 'bad_take');
});

// ── edge cases ─────────────────────────────────────────────────────────

test('detectBadTakes: returns [] when wordTimestamps is empty', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return fakeResponse({ body: geminiResponseFor({ cuts: [] }) }); };
  const result = await detectBadTakes(
    { wordTimestamps: [], sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: fetcher },
  );
  assert.deepEqual(result, []);
  assert.equal(calls, 0);
});

test('detectBadTakes: returns [] gracefully when Gemini response JSON is malformed', async () => {
  // Bad-take detection failure is non-fatal — pipeline keeps shipping with
  // no bad-take cuts (silence/dead-air still apply).
  const fetcher = async () => fakeResponse({
    body: {
      candidates: [{ content: { parts: [{ text: 'not json {' }] } }],
    },
  });
  const result = await detectBadTakes(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: fetcher },
  );
  assert.deepEqual(result, []);
});

test('detectBadTakes: throws on Gemini API non-200 (these ARE fatal)', async () => {
  // Distinct from the malformed-JSON case: API errors propagate so the
  // orchestrator can flag them as a partial-data step failure.
  const fetcher = async () => fakeResponse({ ok: false, status: 503, body: 'unavailable' });
  await assert.rejects(
    () => detectBadTakes(
      { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
      { apiKey: 'test', fetchImpl: fetcher },
    ),
    /bad_take_detect: Gemini API error 503/,
  );
});

test('detectBadTakes: drops malformed cut entries (non-numeric start/end)', async () => {
  const result = await detectBadTakes(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        cuts: [
          { start: 'five', end: 6, reason: 'string start' },       // dropped
          { start: 5, end: null, reason: 'null end' },              // dropped
          { start: 10, end: 11, reason: 'good' },                   // kept
        ],
      }),
    },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, 'good');
});

test('detectBadTakes: throws when GEMINI_API_KEY is unset', async () => {
  const original = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(
      () => detectBadTakes({ wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 }),
      /GEMINI_API_KEY is not set/,
    );
  } finally {
    if (original !== undefined) process.env.GEMINI_API_KEY = original;
  }
});

// ── prompt construction ──────────────────────────────────────────────

test('detectBadTakes: builds transcript with [start_s] markers across full word list', async () => {
  let capturedBody;
  const fetcher = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return fakeResponse({ body: geminiResponseFor({ cuts: [] }) });
  };
  await detectBadTakes(
    { wordTimestamps: [w('first', 0.1, 0.4), w('second', 0.5, 0.9)], sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: fetcher },
  );
  const promptText = capturedBody.contents[0].parts[0].text;
  assert.match(promptText, /\[0\.10s\] first/);
  assert.match(promptText, /\[0\.50s\] second/);
  assert.equal(capturedBody.generationConfig.temperature, 0.1);
});
