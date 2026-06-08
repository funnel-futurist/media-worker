/**
 * test/raw_video_cleanup.test.js
 *
 * Unit tests for the transcript-only raw-video cleanup (Phase 1A). Same
 * mocked-fetcher pattern as test/bad_take_detect.test.js so the suite stays
 * fast + offline.
 *
 * Covers the behavior that's NEW vs bad_take_detect:
 *   - removeCuts schema (+ {cuts} fallback)
 *   - startAfterSec CLAMP (not drop) into the allowed region
 *   - combined budget: maxCleanupFraction ceiling AND minRemainingSec floor,
 *     accounting for existingCuts already applied
 *   - segmentHint clamp: a cut never spans a detected segment boundary
 *   - conservative defaults, non-fatal degradation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runRawVideoCleanup } from '../lib/raw_video_cleanup.js';

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

function geminiResponseFor(out) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] };
}

function mockFetcher(out, { ok = true, status = 200 } = {}) {
  return async () => fakeResponse({ ok, status, body: geminiResponseFor(out) });
}

const SAMPLE_WORDS = [w('hello', 0, 0.5), w('world', 1, 1.5), w('again', 2, 2.5)];

// ── happy path ─────────────────────────────────────────────────────────

test('runRawVideoCleanup: empty when Gemini returns no cuts', async () => {
  const r = await runRawVideoCleanup(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: mockFetcher({ removeCuts: [] }) },
  );
  assert.equal(r.mode, 'transcript_only');
  assert.deepEqual(r.removeCuts, []);
  assert.equal(r.totalRemovedSec, 0);
});

test('runRawVideoCleanup: returns valid removeCuts + totalRemovedSec', async () => {
  const r = await runRawVideoCleanup(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        removeCuts: [
          { start: 5.0, end: 6.5, reason: 'setup chatter' },
          { start: 12.0, end: 14.0, reason: 'aborted take' },
        ],
      }),
    },
  );
  assert.equal(r.removeCuts.length, 2);
  assert.deepEqual(r.removeCuts[0], { start: 5.0, end: 6.5, reason: 'setup chatter' });
  assert.equal(r.totalRemovedSec, 3.5);
});

test('runRawVideoCleanup: accepts {cuts} fallback schema', async () => {
  const r = await runRawVideoCleanup(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: mockFetcher({ cuts: [{ start: 5, end: 6, reason: 'x' }] }) },
  );
  assert.equal(r.removeCuts.length, 1);
});

// ── input filtering ────────────────────────────────────────────────────

test('runRawVideoCleanup: drops cuts below min duration and end<=start', async () => {
  const r = await runRawVideoCleanup(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        removeCuts: [
          { start: 5.0, end: 5.1, reason: 'too short' },   // dropped (<0.4)
          { start: 7.0, end: 6.0, reason: 'inverted' },    // dropped
          { start: 10.0, end: 11.0, reason: 'good' },      // kept
        ],
      }),
    },
  );
  assert.equal(r.removeCuts.length, 1);
  assert.equal(r.removeCuts[0].reason, 'good');
});

test('runRawVideoCleanup: CLAMPS start into the allowed region (startAfterSec)', async () => {
  const r = await runRawVideoCleanup(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100, startAfterSec: 5.0 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        removeCuts: [
          { start: 2.0, end: 3.0, reason: 'fully before' },   // dropped (after clamp end<=start)
          { start: 4.5, end: 6.0, reason: 'straddles slate' }, // clamped to {5.0, 6.0}
        ],
      }),
    },
  );
  assert.equal(r.removeCuts.length, 1);
  assert.equal(r.removeCuts[0].start, 5.0);
  assert.equal(r.removeCuts[0].end, 6.0);
});

test('runRawVideoCleanup: drops cuts overlapping existingCuts', async () => {
  const r = await runRawVideoCleanup(
    {
      wordTimestamps: SAMPLE_WORDS,
      sourceDuration: 100,
      existingCuts: [{ start: 10, end: 12 }],
    },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        removeCuts: [
          { start: 10.5, end: 11.5, reason: 'inside existing' }, // dropped
          { start: 30.0, end: 31.0, reason: 'clear' },           // kept
        ],
      }),
    },
  );
  assert.equal(r.removeCuts.length, 1);
  assert.equal(r.removeCuts[0].reason, 'clear');
});

// ── normalization ──────────────────────────────────────────────────────

test('runRawVideoCleanup: sorts + merges overlapping cuts', async () => {
  const r = await runRawVideoCleanup(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        removeCuts: [
          { start: 30.0, end: 31.0, reason: 'late' },
          { start: 5.0, end: 6.5, reason: 'a' },
          { start: 6.0, end: 7.0, reason: 'b' },  // overlaps a → merge
        ],
      }),
    },
  );
  assert.equal(r.removeCuts.length, 2);
  assert.equal(r.removeCuts[0].start, 5.0);
  assert.equal(r.removeCuts[0].end, 7.0);
  assert.match(r.removeCuts[0].reason, /a\+b/);
});

// ── budget: ceiling + floor + existing ──────────────────────────────────

test('runRawVideoCleanup: minRemainingSec floor binds (keeps >= floor)', async () => {
  // ceiling=100 (frac 1.0), floor leaves 30 → maxTotalRemoved=70; budget=70
  const r = await runRawVideoCleanup(
    {
      wordTimestamps: SAMPLE_WORDS,
      sourceDuration: 100,
      maxCleanupFraction: 1.0,
      minRemainingSec: 30,
    },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        removeCuts: [
          { start: 0, end: 40, reason: 'big1' },   // 40s, fits
          { start: 45, end: 85, reason: 'big2' },  // 40s → 80 total > 70 → dropped
        ],
      }),
    },
  );
  assert.deepEqual(r.removeCuts.map((c) => c.reason), ['big1']);
});

test('runRawVideoCleanup: maxCleanupFraction ceiling binds', async () => {
  // frac 0.5 → ceiling 50; floor leaves 92 → maxTotalRemoved=min(50,92)=50
  const r = await runRawVideoCleanup(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100, maxCleanupFraction: 0.5 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        removeCuts: [
          { start: 0, end: 30, reason: 'big1' },   // 30s
          { start: 35, end: 65, reason: 'big2' },  // +30 = 60 > 50 → dropped
        ],
      }),
    },
  );
  assert.deepEqual(r.removeCuts.map((c) => c.reason), ['big1']);
});

test('runRawVideoCleanup: existingCuts consume the budget', async () => {
  // frac 0.85 → ceiling 85; existing removed 80 → budget 5
  const r = await runRawVideoCleanup(
    {
      wordTimestamps: SAMPLE_WORDS,
      sourceDuration: 100,
      existingCuts: [{ start: 0, end: 80 }],
    },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({ removeCuts: [{ start: 85, end: 95, reason: '10s' }] }),
    },
  );
  assert.deepEqual(r.removeCuts, []); // 10s > 5s budget
});

// ── segmentHint clamp (Phase 1B forward-compat) ─────────────────────────

test('runRawVideoCleanup: clamps a cut to the segment containing its start', async () => {
  const r = await runRawVideoCleanup(
    {
      wordTimestamps: SAMPLE_WORDS,
      sourceDuration: 100,
      segmentHint: { clips: [{ start: 0, end: 50 }, { start: 52, end: 100 }] },
    },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        removeCuts: [
          { start: 45, end: 60, reason: 'spans boundary' }, // clamp → {45, 50}
          { start: 60, end: 70, reason: 'inside seg2' },     // kept as-is
        ],
      }),
    },
  );
  assert.equal(r.removeCuts.length, 2);
  assert.deepEqual(r.removeCuts[0], { start: 45, end: 50, reason: 'spans boundary' });
  assert.deepEqual(r.removeCuts[1], { start: 60, end: 70, reason: 'inside seg2' });
});

test('runRawVideoCleanup: drops a cut starting in a boundary gap', async () => {
  const r = await runRawVideoCleanup(
    {
      wordTimestamps: SAMPLE_WORDS,
      sourceDuration: 100,
      segmentHint: { clips: [{ start: 0, end: 50 }, { start: 52, end: 100 }] },
    },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({ removeCuts: [{ start: 50.5, end: 55, reason: 'in gap' }] }),
    },
  );
  assert.deepEqual(r.removeCuts, []);
});

test('runRawVideoCleanup: no segmentHint (1A) → no boundary clamping', async () => {
  const r = await runRawVideoCleanup(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: mockFetcher({ removeCuts: [{ start: 45, end: 60, reason: 'spans' }] }) },
  );
  assert.equal(r.removeCuts.length, 1);
  assert.deepEqual(r.removeCuts[0], { start: 45, end: 60, reason: 'spans' });
});

// ── reason handling ──────────────────────────────────────────────────────

test('runRawVideoCleanup: truncates reason at 80 chars and defaults when missing', async () => {
  const r = await runRawVideoCleanup(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        removeCuts: [
          { start: 5, end: 6, reason: 'a'.repeat(200) },
          { start: 10, end: 11 },
        ],
      }),
    },
  );
  assert.equal(r.removeCuts[0].reason.length, 80);
  assert.equal(r.removeCuts[1].reason, 'raw_cleanup');
});

// ── edge cases ───────────────────────────────────────────────────────────

test('runRawVideoCleanup: empty wordTimestamps → empty, no Gemini call', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return fakeResponse({ body: geminiResponseFor({ removeCuts: [] }) }); };
  const r = await runRawVideoCleanup(
    { wordTimestamps: [], sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: fetcher },
  );
  assert.deepEqual(r.removeCuts, []);
  assert.equal(calls, 0);
});

test('runRawVideoCleanup: malformed JSON degrades to empty (non-fatal)', async () => {
  const fetcher = async () => fakeResponse({ body: { candidates: [{ content: { parts: [{ text: 'nope {' }] } }] } });
  const r = await runRawVideoCleanup(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: fetcher },
  );
  assert.deepEqual(r.removeCuts, []);
});

test('runRawVideoCleanup: non-200 throws (caller catches and keeps existing cuts)', async () => {
  const fetcher = async () => fakeResponse({ ok: false, status: 503, body: 'unavailable' });
  await assert.rejects(
    () => runRawVideoCleanup(
      { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
      { apiKey: 'test', fetchImpl: fetcher },
    ),
    /raw_video_cleanup: Gemini API error 503/,
  );
});

test('runRawVideoCleanup: throws when GEMINI_API_KEY unset', async () => {
  const original = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(
      () => runRawVideoCleanup({ wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 }),
      /GEMINI_API_KEY is not set/,
    );
  } finally {
    if (original !== undefined) process.env.GEMINI_API_KEY = original;
  }
});

// ── prompt construction ──────────────────────────────────────────────────

test('runRawVideoCleanup: prompt has [start_s] transcript, silence windows, temp 0.1', async () => {
  let capturedBody;
  const fetcher = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return fakeResponse({ body: geminiResponseFor({ removeCuts: [] }) });
  };
  await runRawVideoCleanup(
    {
      wordTimestamps: [w('first', 0.1, 0.4), w('second', 0.5, 0.9)],
      sourceDuration: 100,
      silenceMap: [{ start: 3.2, end: 5.0 }],
    },
    { apiKey: 'test', fetchImpl: fetcher },
  );
  const prompt = capturedBody.contents[0].parts[0].text;
  assert.match(prompt, /\[0\.10s\] first/);
  assert.match(prompt, /\[3\.20-5\.00\]/);
  assert.equal(capturedBody.generationConfig.temperature, 0.1);
});

test('runRawVideoCleanup: prompt shows "(none detected)" when no silences', async () => {
  let capturedBody;
  const fetcher = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return fakeResponse({ body: geminiResponseFor({ removeCuts: [] }) });
  };
  await runRawVideoCleanup(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: fetcher },
  );
  assert.match(capturedBody.contents[0].parts[0].text, /\(none detected\)/);
});
