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
import { detectSlate, validateSlatePreservesHooks } from '../lib/slate_detect.js';

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

// ── PR-AH: post-hoc hook validator (validateSlatePreservesHooks) ─────

test('validator: preserves rhetorical question hook between meta markers (Sat 23 regression)', () => {
  // Exact Sat 23 pattern: "Saturday, May 23. If not now, when? Selected option. Finding…"
  // Gemini bundled everything into the slate at 12.16s. The validator must
  // shorten to the start of "If not now, when?" and preserve the hook.
  const words = [
    w('Saturday,', 0.20, 0.60),
    w('May', 0.65, 0.85),
    w('23.', 0.90, 1.20),
    w('If', 2.00, 2.15),
    w('not', 2.20, 2.40),
    w('now,', 2.45, 2.70),
    w('when?', 2.75, 3.10),
    w('Selected', 3.80, 4.20),
    w('option.', 4.25, 4.60),
    w('Finding', 5.00, 5.30),
    w('the', 5.35, 5.45),
    w('right', 5.50, 5.80),
  ];
  const parsed = {
    isSlate: true,
    slateEndSeconds: 12.16,
    transcribedText: 'Saturday, May 23. If not now, when? Selected option. Finding',
    identifier: 'Phil - May 23',
  };
  const result = validateSlatePreservesHooks(parsed, words);
  // Slate should end at start of "If" (2.00s), not 12.16s
  assert.equal(result.slateEndSeconds, 2.00);
  assert.match(result.transcribedText, /Saturday,/);
  assert.match(result.transcribedText, /23\./);
  assert.ok(!result.transcribedText.includes('If'), 'hook text must not be in slate transcribedText');
});

test('validator: preserves topic opener between meta markers (Mon 18 regression)', () => {
  // Mon 18 pattern: "Monday, May 18. Thinking about planning versus deciding to plan."
  // Gemini bundled everything into the slate at 14.13s.
  const words = [
    w('Monday,', 0.30, 0.70),
    w('May', 0.75, 0.95),
    w('18.', 1.00, 1.30),
    w('Thinking', 2.50, 2.90),
    w('about', 2.95, 3.15),
    w('planning', 3.20, 3.60),
    w('versus', 3.65, 3.95),
    w('deciding', 4.00, 4.40),
    w('to', 4.45, 4.55),
    w('plan.', 4.60, 4.90),
  ];
  const parsed = {
    isSlate: true,
    slateEndSeconds: 14.13,
    transcribedText: 'Monday, May 18. Thinking about planning versus deciding to plan.',
    identifier: 'Phil - May 18',
  };
  const result = validateSlatePreservesHooks(parsed, words);
  // Slate should end at start of "Thinking" (2.50s)
  assert.equal(result.slateEndSeconds, 2.50);
  assert.match(result.transcribedText, /Monday,/);
  assert.match(result.transcribedText, /18\./);
  assert.ok(!result.transcribedText.includes('Thinking'), 'content must not be in slate transcribedText');
});

test('validator: does NOT shorten genuine multi-part slate (no regression on PR #114)', () => {
  // "Monday April 27. Title: Why Next Month Becomes Next Year. Selected Option A."
  // All three sentences are meta — validator must leave slate unchanged.
  const words = [
    w('Monday', 0.10, 0.40),
    w('April', 0.45, 0.70),
    w('27.', 0.75, 1.00),
    w('Title:', 1.30, 1.60),
    w('Why', 1.65, 1.80),
    w('Next', 1.85, 2.00),
    w('Month', 2.05, 2.30),
    w('Becomes', 2.35, 2.60),
    w('Next', 2.65, 2.80),
    w('Year.', 2.85, 3.10),
    w('Selected', 3.40, 3.70),
    w('Option', 3.75, 4.00),
    w('A.', 4.05, 4.20),
    w('The', 5.00, 5.10),
    w('reason', 5.15, 5.40),
  ];
  const parsed = {
    isSlate: true,
    slateEndSeconds: 4.50,
    transcribedText: 'Monday April 27. Title: Why Next Month Becomes Next Year. Selected Option A.',
    identifier: 'April 27 - option A',
  };
  const result = validateSlatePreservesHooks(parsed, words);
  // Should NOT shorten — "Title:" prefix makes sentence 2 a meta marker,
  // "Selected Option A." matches the option pattern.
  assert.equal(result.slateEndSeconds, 4.50, 'multi-part slate must not be shortened');
});

test('validator: passes through when no slate detected', () => {
  const result = validateSlatePreservesHooks(
    { isSlate: false, slateEndSeconds: 0, transcribedText: '', identifier: null },
    [w('hello', 0, 0.5)],
  );
  assert.equal(result.isSlate, false);
  assert.equal(result.slateEndSeconds, 0);
});

test('validator: passes through when words array is empty', () => {
  const parsed = { isSlate: true, slateEndSeconds: 5, transcribedText: 'test', identifier: null };
  const result = validateSlatePreservesHooks(parsed, []);
  assert.equal(result.slateEndSeconds, 5);
});

// ── PR-AH: end-to-end detectSlate with hook preservation ──────────────

test('detectSlate: Sat 23 hook preserved when Gemini over-classifies (e2e)', async () => {
  // Simulate Gemini returning slateEndSeconds: 12.16 (bundles the hook).
  // The post-hoc validator should shorten it before the final return.
  const words = [
    w('Saturday,', 0.20, 0.60),
    w('May', 0.65, 0.85),
    w('23.', 0.90, 1.20),
    w('If', 2.00, 2.15),
    w('not', 2.20, 2.40),
    w('now,', 2.45, 2.70),
    w('when?', 2.75, 3.10),
    w('Selected', 3.80, 4.20),
    w('option.', 4.25, 4.60),
    w('Finding', 5.00, 5.30),
    w('the', 5.35, 5.45),
    w('right', 5.50, 5.80),
    w('plan.', 5.85, 6.10),
  ];
  const result = await detectSlate(
    { wordTimestamps: words, sourceDuration: 120 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        isSlate: true,
        slateEndSeconds: 12.16,
        transcribedText: 'Saturday, May 23. If not now, when? Selected option. Finding',
        identifier: 'Phil - May 23',
      }),
    },
  );
  assert.ok(result, 'should still detect a slate');
  assert.equal(result.end, 2.00, 'slate end should be at start of "If" (hook preserved)');
  assert.ok(!result.transcribed_text.includes('If'), 'hook must not appear in transcribed text');
});

test('detectSlate: Mon 18 topic opener preserved when Gemini over-classifies (e2e)', async () => {
  const words = [
    w('Monday,', 0.30, 0.70),
    w('May', 0.75, 0.95),
    w('18.', 1.00, 1.30),
    w('Thinking', 2.50, 2.90),
    w('about', 2.95, 3.15),
    w('planning', 3.20, 3.60),
    w('versus', 3.65, 3.95),
    w('deciding', 4.00, 4.40),
    w('to', 4.45, 4.55),
    w('plan.', 4.60, 4.90),
    w('And', 5.50, 5.60),
    w('so', 5.65, 5.80),
  ];
  const result = await detectSlate(
    { wordTimestamps: words, sourceDuration: 120 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        isSlate: true,
        slateEndSeconds: 14.13,
        transcribedText: 'Monday, May 18. Thinking about planning versus deciding to plan.',
        identifier: 'Phil - May 18',
      }),
    },
  );
  assert.ok(result, 'should still detect a slate');
  assert.equal(result.end, 2.50, 'slate end should be at start of "Thinking" (content preserved)');
});
