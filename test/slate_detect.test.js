/**
 * test/slate_detect.test.js
 *
 * Unit tests for the Gemini-based slate detector. The actual Gemini call is
 * mocked via the `fetchImpl` opts hook so the suite stays fast + offline.
 *
 * Test strategy:
 *   - Build a fake Response object that returns a canned Gemini JSON shape
 *   - Inject via `fetchImpl` so detectSlate calls our mock instead of fetch
 *   - Assert the shape transformations: prompt construction, response parsing,
 *     hard caps, and edge cases (empty input, malformed JSON, etc.)
 *
 * What we DON'T test here:
 *   - The actual Gemini semantic judgment ("is this slate?") — that's the
 *     model's job. We just verify our wiring is correct.
 *   - Network failures / 429 retries — covered by lib/gemini_helpers.js
 *     (which is bypassed when fetchImpl is injected).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSlate } from '../lib/slate_detect.js';

// ── helpers ────────────────────────────────────────────────────────────

function w(word, startSec, endSec) {
  return { word, start_ms: Math.round(startSec * 1000), end_ms: Math.round(endSec * 1000) };
}

/**
 * Fake Response factory — minimal shape to satisfy detectSlate's reads
 * (.ok, .status, .text(), .json()).
 */
function fakeResponse({ ok = true, status = 200, body }) {
  return {
    ok,
    status,
    async text() { return JSON.stringify(body); },
    async json() { return body; },
    clone() { return fakeResponse({ ok, status, body }); },
  };
}

/**
 * Wrap a Gemini-shaped JSON payload in the response envelope detectSlate
 * expects (candidates[0].content.parts[0].text holds the JSON-encoded
 * inner detector output).
 */
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

// ── happy path ─────────────────────────────────────────────────────────

test('detectSlate: returns null when isSlate=false', async () => {
  const result = await detectSlate(
    { wordTimestamps: [w('hello', 0, 0.5)], sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        isSlate: false,
        slateEndSeconds: 0,
        transcribedText: '',
        identifier: null,
      }),
    },
  );
  assert.equal(result, null);
});

test('detectSlate: returns SlateMetadata when isSlate=true (date+option case)', async () => {
  const result = await detectSlate(
    {
      wordTimestamps: [
        w('April', 0.1, 0.3),
        w('27,', 0.3, 0.6),
        w('option', 0.7, 1.0),
        w('A.', 1.0, 1.3),
        w('Title:', 1.6, 2.0),
      ],
      sourceDuration: 100,
    },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        isSlate: true,
        slateEndSeconds: 1.5,
        transcribedText: 'April 27, option A.',
        identifier: 'April 27 - option A',
      }),
    },
  );
  assert.deepEqual(result, {
    start: 0,
    end: 1.5,
    transcribed_text: 'April 27, option A.',
    identifier: 'April 27 - option A',
  });
});

test('detectSlate: handles Phil-style "Selected Option A" intro (regression for B8)', async () => {
  // The exact scenario PR #112 was opened to fix. Pattern matcher missed
  // option_take here; the LLM should catch it (mocked outcome below).
  const result = await detectSlate(
    {
      wordTimestamps: [
        w('Selected', 0.5, 0.9),
        w('option', 0.9, 1.2),
        w('A.', 1.2, 1.5),
        w('Title:', 1.8, 2.1),
        w('Why', 2.1, 2.3),
      ],
      sourceDuration: 100,
    },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        isSlate: true,
        slateEndSeconds: 1.7,
        transcribedText: 'Selected option A.',
        identifier: 'option A',
      }),
    },
  );
  assert.ok(result, 'expected a slate to be returned');
  assert.equal(result.end, 1.7);
  assert.match(result.transcribed_text, /Selected option A/i);
});

// ── input validation ──────────────────────────────────────────────────

test('detectSlate: returns null when wordTimestamps is empty', async () => {
  // Should NOT call Gemini for empty input — assert the fetcher is never invoked.
  let calls = 0;
  const fetcher = async () => { calls++; return fakeResponse({ body: geminiResponseFor({}) }); };
  const result = await detectSlate(
    { wordTimestamps: [], sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: fetcher },
  );
  assert.equal(result, null);
  assert.equal(calls, 0);
});

test('detectSlate: returns null when wordTimestamps is missing', async () => {
  const result = await detectSlate(
    { wordTimestamps: undefined, sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: mockFetcher({ isSlate: true, slateEndSeconds: 5 }) },
  );
  assert.equal(result, null);
});

test('detectSlate: returns null when all words are past the 30s cutoff (no transcript text)', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return fakeResponse({ body: geminiResponseFor({}) }); };
  const result = await detectSlate(
    {
      wordTimestamps: [w('post-cutoff', 35, 36)],
      sourceDuration: 100,
    },
    { apiKey: 'test', fetchImpl: fetcher },
  );
  assert.equal(result, null);
  assert.equal(calls, 0, 'should not call Gemini when transcript window is empty');
});

test('detectSlate: throws when GEMINI_API_KEY is unset (no opts.apiKey, no env)', async () => {
  const original = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(
      () => detectSlate({ wordTimestamps: [w('hi', 0, 0.5)], sourceDuration: 100 }),
      /GEMINI_API_KEY is not set/,
    );
  } finally {
    if (original !== undefined) process.env.GEMINI_API_KEY = original;
  }
});

// ── output normalization / hard caps ──────────────────────────────────

test('detectSlate: clamps slate end at 20s hard cap', async () => {
  const result = await detectSlate(
    { wordTimestamps: [w('long', 0, 0.5)], sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        isSlate: true,
        slateEndSeconds: 30,  // claims 30s slate — should clamp to 20
        transcribedText: 'long slate',
        identifier: null,
      }),
    },
  );
  assert.equal(result.end, 20);
});

test('detectSlate: clamps slate end at sourceDuration - 1 (no slate longer than the video)', async () => {
  const result = await detectSlate(
    { wordTimestamps: [w('hi', 0, 0.5)], sourceDuration: 5 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        isSlate: true,
        slateEndSeconds: 10,  // claims 10s slate on a 5s source
        transcribedText: 'too long',
        identifier: null,
      }),
    },
  );
  assert.equal(result.end, 4);  // 5 - 1
});

test('detectSlate: returns null when slateEndSeconds is null or 0', async () => {
  for (const slateEndSeconds of [null, 0, -1]) {
    const result = await detectSlate(
      { wordTimestamps: [w('hi', 0, 0.5)], sourceDuration: 100 },
      {
        apiKey: 'test',
        fetchImpl: mockFetcher({
          isSlate: true,
          slateEndSeconds,
          transcribedText: '',
          identifier: null,
        }),
      },
    );
    assert.equal(result, null, `expected null for slateEndSeconds=${slateEndSeconds}`);
  }
});

test('detectSlate: identifier defaults to null when missing', async () => {
  const result = await detectSlate(
    { wordTimestamps: [w('hi', 0, 0.5)], sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        isSlate: true,
        slateEndSeconds: 1.5,
        transcribedText: 'slate',
        // identifier intentionally omitted
      }),
    },
  );
  assert.equal(result.identifier, null);
});

// ── error handling ───────────────────────────────────────────────────

test('detectSlate: throws on Gemini API non-200', async () => {
  const fetcher = async () => fakeResponse({ ok: false, status: 500, body: 'internal error' });
  await assert.rejects(
    () => detectSlate(
      { wordTimestamps: [w('hi', 0, 0.5)], sourceDuration: 100 },
      { apiKey: 'test', fetchImpl: fetcher },
    ),
    /slate_detect: Gemini API error 500/,
  );
});

test('detectSlate: throws on empty Gemini response (no candidates[0].content.parts)', async () => {
  const fetcher = async () => fakeResponse({ body: { candidates: [] } });
  await assert.rejects(
    () => detectSlate(
      { wordTimestamps: [w('hi', 0, 0.5)], sourceDuration: 100 },
      { apiKey: 'test', fetchImpl: fetcher },
    ),
    /slate_detect: empty Gemini response/,
  );
});

test('detectSlate: throws on malformed JSON in Gemini response', async () => {
  const fetcher = async () => fakeResponse({
    body: {
      candidates: [{ content: { parts: [{ text: 'this is not json {' }] } }],
    },
  });
  await assert.rejects(
    () => detectSlate(
      { wordTimestamps: [w('hi', 0, 0.5)], sourceDuration: 100 },
      { apiKey: 'test', fetchImpl: fetcher },
    ),
    /slate_detect: invalid JSON response/,
  );
});

// ── prompt construction ──────────────────────────────────────────────

test('detectSlate: builds transcript with [start_s] markers and word body', async () => {
  // Inspect the request body to confirm prompt construction matches the
  // upstream creative-engine format. This locks the [Xs] timestamp marker
  // pattern that the LLM was prompt-tuned against.
  let capturedBody;
  const fetcher = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return fakeResponse({ body: geminiResponseFor({ isSlate: false, slateEndSeconds: 0 }) });
  };
  await detectSlate(
    { wordTimestamps: [w('hello', 1.234, 1.567), w('world.', 1.7, 2.0)], sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: fetcher },
  );
  const promptText = capturedBody.contents[0].parts[0].text;
  assert.match(promptText, /\[1\.23s\] hello/);
  assert.match(promptText, /\[1\.70s\] world\./);
  // Generation config is set for stable detection
  assert.equal(capturedBody.generationConfig.temperature, 0.1);
  assert.equal(capturedBody.generationConfig.responseMimeType, 'application/json');
});
