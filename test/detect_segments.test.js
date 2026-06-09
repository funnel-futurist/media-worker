/**
 * test/detect_segments.test.js
 *
 * Unit tests for Phase 1B multi-part segment detection. Same mocked-fetcher
 * pattern as test/raw_video_cleanup.test.js (offline, fast).
 *
 * Covers: single-clip defaults, multi-clip normalization (sort / clamp /
 * disjoint / reindex), the <2-clips → single fallback, conservative
 * degradation (malformed JSON, errors), and prompt construction.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectSegments } from '../lib/detect_segments.js';

const PIPELINE_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'clean_mode_pipeline.js'),
  'utf8',
);

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

// ── pipeline gating: detection is OPT-IN, not auto-run with cleanup ────────
// 2026-06-09: decoupled from rawVideoCleanup so it stops firing a wasted Gemini
// pass on every cleanup job (operators pre-segment + upload single clips, so it
// always returned "single clip"). Must run ONLY when opts.segmentDetect is set.

test('pipeline: segment detection gates on opts.segmentDetect ONLY (decoupled from rawVideoCleanup)', () => {
  assert.match(
    PIPELINE_SRC,
    /if \(opts\.segmentDetect\) \{[\s\S]*?stepStart\('segmentDetect'\)/,
    'segment detection must run only when opts.segmentDetect is set',
  );
  assert.doesNotMatch(
    PIPELINE_SRC,
    /if \(opts\.rawVideoCleanup \|\| opts\.segmentDetect\)/,
    'segment detection must NOT auto-run with rawVideoCleanup (decoupled 2026-06-09)',
  );
});

// ── single clip ──────────────────────────────────────────────────────────

test('detectSegments: detectedMultipleClips:false → single full-span clip', async () => {
  const r = await detectSegments(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: mockFetcher({ detectedMultipleClips: false, clips: [] }) },
  );
  assert.equal(r.detectedMultipleClips, false);
  assert.equal(r.clips.length, 1);
  assert.deepEqual(
    { start: r.clips[0].start, end: r.clips[0].end },
    { start: 0, end: 100 },
  );
});

test('detectSegments: fewer than 2 valid clips → single', async () => {
  const r = await detectSegments(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: mockFetcher({ detectedMultipleClips: true, clips: [{ start: 10, end: 40 }] }) },
  );
  assert.equal(r.detectedMultipleClips, false);
});

// ── multiple clips ─────────────────────────────────────────────────────────

test('detectSegments: two valid clips → multi, reindexed clipIndex', async () => {
  const r = await detectSegments(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 200 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        detectedMultipleClips: true,
        clips: [
          { start: 12.4, end: 104.2, titleGuess: 'Ad 1', reason: 'first take' },
          { start: 132.6, end: 198.0, titleGuess: 'Ad 2', reason: 'new intro after reset' },
        ],
      }),
    },
  );
  assert.equal(r.detectedMultipleClips, true);
  assert.equal(r.clips.length, 2);
  assert.deepEqual(r.clips.map((c) => c.clipIndex), [1, 2]);
  assert.equal(r.clips[0].titleGuess, 'Ad 1');
  assert.equal(r.clips[1].reason, 'new intro after reset');
});

test('detectSegments: sorts clips and clamps to [0, sourceDuration]', async () => {
  const r = await detectSegments(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        detectedMultipleClips: true,
        clips: [
          { start: 60, end: 200, reason: 'second, end past duration' }, // end clamped → 100
          { start: -5, end: 40, reason: 'first, start before 0' },       // start clamped → 0
        ],
      }),
    },
  );
  assert.equal(r.clips.length, 2);
  assert.deepEqual(r.clips[0], { clipIndex: 1, start: 0, end: 40, titleGuess: '', reason: 'first, start before 0' });
  assert.deepEqual(r.clips[1], { clipIndex: 2, start: 60, end: 100, titleGuess: '', reason: 'second, end past duration' });
});

test('detectSegments: overlapping clips are made disjoint (start clamped to prev end)', async () => {
  const r = await detectSegments(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        detectedMultipleClips: true,
        clips: [
          { start: 0, end: 40, reason: 'a' },
          { start: 30, end: 80, reason: 'b overlaps a' }, // start clamped → 40
        ],
      }),
    },
  );
  assert.equal(r.clips.length, 2);
  assert.equal(r.clips[0].end, 40);
  assert.equal(r.clips[1].start, 40);
  assert.equal(r.clips[1].end, 80);
});

test('detectSegments: a clip fully swallowed by the previous is dropped → single', async () => {
  const r = await detectSegments(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        detectedMultipleClips: true,
        clips: [
          { start: 0, end: 50, reason: 'a' },
          { start: 10, end: 30, reason: 'inside a' }, // swallowed → dropped → only 1 left
        ],
      }),
    },
  );
  assert.equal(r.detectedMultipleClips, false);
});

test('detectSegments: drops non-numeric / inverted clips before the count check', async () => {
  const r = await detectSegments(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        detectedMultipleClips: true,
        clips: [
          { start: 'x', end: 40, reason: 'bad start' },  // dropped
          { start: 70, end: 60, reason: 'inverted' },      // dropped
          { start: 0, end: 40, reason: 'good1' },          // kept
          { start: 50, end: 90, reason: 'good2' },         // kept
        ],
      }),
    },
  );
  assert.equal(r.clips.length, 2);
  assert.deepEqual(r.clips.map((c) => c.reason), ['good1', 'good2']);
});

// ── edge cases ───────────────────────────────────────────────────────────

test('detectSegments: empty wordTimestamps → single, no Gemini call', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return fakeResponse({ body: geminiResponseFor({ detectedMultipleClips: false }) }); };
  const r = await detectSegments(
    { wordTimestamps: [], sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: fetcher },
  );
  assert.equal(r.detectedMultipleClips, false);
  assert.equal(calls, 0);
});

test('detectSegments: malformed JSON degrades to single (non-fatal)', async () => {
  const fetcher = async () => fakeResponse({ body: { candidates: [{ content: { parts: [{ text: 'nope {' }] } }] } });
  const r = await detectSegments(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 },
    { apiKey: 'test', fetchImpl: fetcher },
  );
  assert.equal(r.detectedMultipleClips, false);
});

test('detectSegments: non-200 throws (caller treats as single clip)', async () => {
  const fetcher = async () => fakeResponse({ ok: false, status: 503, body: 'unavailable' });
  await assert.rejects(
    () => detectSegments({ wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 }, { apiKey: 'test', fetchImpl: fetcher }),
    /detect_segments: Gemini API error 503/,
  );
});

test('detectSegments: throws when GEMINI_API_KEY unset', async () => {
  const original = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(
      () => detectSegments({ wordTimestamps: SAMPLE_WORDS, sourceDuration: 100 }),
      /GEMINI_API_KEY is not set/,
    );
  } finally {
    if (original !== undefined) process.env.GEMINI_API_KEY = original;
  }
});

// ── prompt construction ──────────────────────────────────────────────────

test('detectSegments: prompt has [start_s] transcript, silence windows, temp 0.1', async () => {
  let capturedBody;
  const fetcher = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return fakeResponse({ body: geminiResponseFor({ detectedMultipleClips: false }) });
  };
  await detectSegments(
    {
      wordTimestamps: [w('first', 0.1, 0.4), w('second', 0.5, 0.9)],
      sourceDuration: 100,
      silenceMap: [{ start: 40.0, end: 43.5 }],
    },
    { apiKey: 'test', fetchImpl: fetcher },
  );
  const prompt = capturedBody.contents[0].parts[0].text;
  assert.match(prompt, /\[0\.10s\] first/);
  assert.match(prompt, /\[40\.00-43\.50\]/);
  assert.equal(capturedBody.generationConfig.temperature, 0.1);
});
