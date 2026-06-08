/**
 * test/best_take_cta.test.js
 *
 * Unit tests for Phase 2 best-take + end-on-CTA (transcript-only). Same
 * mocked-fetcher pattern as test/raw_video_cleanup.test.js so the suite stays
 * fast + offline.
 *
 * Three layers:
 *   - computeCtaTrim (pure)   — the GATES: confidence, position, trailing,
 *                               multi-part, min-remaining, short-clip skip.
 *   - normalizeResult (pure)  — CTA clamp/found, take_groups → proposedDrops,
 *                               keep-index defaulting, <2-take groups dropped.
 *   - analyzeBestTakeAndCta   — full path with an injected fetch: trim applied,
 *                               proposal NEVER in removeCuts, non-fatal errors,
 *                               prompt assertions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeBestTakeAndCta,
  computeCtaTrim,
  normalizeResult,
  buildBestTakeCtaPrompt,
  CTA_ACTION_LANGUAGE,
  CTA_MIN_CONFIDENCE,
  QUALITY_CONFIDENCE,
} from '../lib/best_take_cta.js';

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

const SAMPLE_WORDS = [w('fill', 60, 60.3), w('out', 60.3, 60.6), w('the', 60.6, 60.8), w('form', 60.8, 61.2)];
const goodCta = { found: true, end_time: 70, confidence: 0.85, excerpt: 'fill out the form' };

// ── computeCtaTrim (pure GATES) ──────────────────────────────────────────

test('computeCtaTrim: high-conf late single-clip CTA with trailing → trims [ctaEnd+buffer, dur]', () => {
  const r = computeCtaTrim({ cta: goodCta, sourceDuration: 80, endOnCta: true, isMultiPart: false });
  assert.equal(r.applied, true);
  assert.equal(r.removeCuts.length, 1);
  assert.deepEqual(r.removeCuts[0], { start: 70.5, end: 80, reason: 'post-CTA trailing' });
});

test('computeCtaTrim: endOnCta off → no trim even with a perfect CTA', () => {
  const r = computeCtaTrim({ cta: goodCta, sourceDuration: 80, endOnCta: false, isMultiPart: false });
  assert.equal(r.applied, false);
  assert.equal(r.skipReason, 'endOnCta_off');
  assert.deepEqual(r.removeCuts, []);
});

test('computeCtaTrim: cta not found → no trim', () => {
  const r = computeCtaTrim({ cta: { found: false, end_time: 0, confidence: 0 }, sourceDuration: 80, endOnCta: true, isMultiPart: false });
  assert.equal(r.skipReason, 'no_cta');
});

test('computeCtaTrim: low confidence (<0.75) → no trim (logged)', () => {
  const r = computeCtaTrim({ cta: { ...goodCta, confidence: 0.6 }, sourceDuration: 80, endOnCta: true, isMultiPart: false });
  assert.equal(r.applied, false);
  assert.equal(r.skipReason, 'low_confidence');
});

test('computeCtaTrim: multi-part → no trim (deferred to 1C)', () => {
  const r = computeCtaTrim({ cta: goodCta, sourceDuration: 80, endOnCta: true, isMultiPart: true });
  assert.equal(r.skipReason, 'multi_part');
});

test('computeCtaTrim: early CTA on a normal-length clip → no trim', () => {
  // end_time 20 < 0.55*80=44 → cta_too_early
  const r = computeCtaTrim({ cta: { ...goodCta, end_time: 20 }, sourceDuration: 80, endOnCta: true, isMultiPart: false });
  assert.equal(r.skipReason, 'cta_too_early');
});

test('computeCtaTrim: very-short clip (<45s) SKIPS the position check', () => {
  // dur 30 < SHORT_CLIP_SEC → position gate skipped; CTA at 12 still trims the tail
  const r = computeCtaTrim({ cta: { ...goodCta, end_time: 12 }, sourceDuration: 30, endOnCta: true, isMultiPart: false });
  assert.equal(r.applied, true);
  assert.deepEqual(r.removeCuts[0], { start: 12.5, end: 30, reason: 'post-CTA trailing' });
});

test('computeCtaTrim: tiny trailing (<1.75s) → no trim', () => {
  // end_time 68, buffer 0.5 → trimStart 68.5, trailing 1.5 < 1.75
  const r = computeCtaTrim({ cta: { ...goodCta, end_time: 68 }, sourceDuration: 70, endOnCta: true, isMultiPart: false });
  assert.equal(r.skipReason, 'trailing_too_short');
});

test('computeCtaTrim: respects minRemainingSec floor (never trims into the body)', () => {
  // dur 40 (<45 → position skipped), CTA at 6 → trimStart 6.5 < floor 10
  const r = computeCtaTrim({ cta: { ...goodCta, end_time: 6 }, sourceDuration: 40, endOnCta: true, isMultiPart: false, minRemainingSec: 10 });
  assert.equal(r.skipReason, 'below_min_remaining');
});

test('computeCtaTrim: custom buffer widens the kept tail', () => {
  const r = computeCtaTrim({ cta: goodCta, sourceDuration: 80, endOnCta: true, isMultiPart: false, buffer: 1.0 });
  assert.deepEqual(r.removeCuts[0], { start: 71, end: 80, reason: 'post-CTA trailing' });
});

// ── normalizeResult (pure) ───────────────────────────────────────────────

test('normalizeResult: found CTA is clamped to [0, dur] and confidence to [0,1]', () => {
  const { cta } = normalizeResult({ cta: { found: true, end_time: 200, confidence: 1.5, excerpt: 'x' } }, 80);
  assert.equal(cta.found, true);
  assert.equal(cta.end_time, 80); // 200 → clamped
  assert.equal(cta.confidence, 1); // 1.5 → clamped
});

test('normalizeResult: found:false stays not-found', () => {
  const { cta } = normalizeResult({ cta: { found: false } }, 80);
  assert.equal(cta.found, false);
});

test('normalizeResult: take_groups → groups + proposedDrops (keep excluded)', () => {
  const { bestTakeProposal } = normalizeResult({
    take_groups: [{
      content_summary: 'intro line',
      takes: [
        { start: 5, end: 9, quality: 'aborted', reason: 'flubbed' },
        { start: 12, end: 16, quality: 'weak', reason: 'low energy' },
        { start: 20, end: 24, quality: 'best', reason: 'clean' },
      ],
      recommended_keep_index: 2,
    }],
  }, 100);
  assert.equal(bestTakeProposal.groups.length, 1);
  assert.equal(bestTakeProposal.groups[0].recommendedKeepIndex, 2);
  // drops are takes 0 + 1 (NOT the keep), sorted by start
  assert.deepEqual(bestTakeProposal.proposedDrops.map((d) => d.start), [5, 12]);
  assert.equal(bestTakeProposal.proposedDrops[0].confidence, QUALITY_CONFIDENCE.aborted);
  assert.equal(bestTakeProposal.proposedDrops[1].confidence, QUALITY_CONFIDENCE.weak);
});

test('normalizeResult: a group with <2 valid takes is dropped', () => {
  const { bestTakeProposal } = normalizeResult({
    take_groups: [{ takes: [{ start: 5, end: 9, quality: 'good' }] }],
  }, 100);
  assert.equal(bestTakeProposal.groups.length, 0);
  assert.equal(bestTakeProposal.proposedDrops.length, 0);
});

test('normalizeResult: invalid recommended_keep_index defaults to the LAST take', () => {
  const { bestTakeProposal } = normalizeResult({
    take_groups: [{
      takes: [{ start: 5, end: 9, quality: 'good' }, { start: 12, end: 16, quality: 'best' }],
      recommended_keep_index: 9, // out of range
    }],
  }, 100);
  assert.equal(bestTakeProposal.groups[0].recommendedKeepIndex, 1);
  assert.deepEqual(bestTakeProposal.proposedDrops.map((d) => d.start), [5]); // keep last → drop first
});

test('normalizeResult: takes with end<=start or sub-min duration are dropped', () => {
  const { bestTakeProposal } = normalizeResult({
    take_groups: [{
      takes: [
        { start: 9, end: 5, quality: 'good' },   // inverted → dropped
        { start: 5, end: 5.2, quality: 'good' }, // <0.4 → dropped
        { start: 12, end: 16, quality: 'good' },
        { start: 20, end: 24, quality: 'best' },
      ],
    }],
  }, 100);
  // only 2 valid takes survive → still a group
  assert.equal(bestTakeProposal.groups[0].takes.length, 2);
});

// ── analyzeBestTakeAndCta (injected fetch) ───────────────────────────────

test('analyze: endOnCta path trims the tail AND returns the proposal (proposal NOT in removeCuts)', async () => {
  const r = await analyzeBestTakeAndCta(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 80, endOnCta: true },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        cta: goodCta,
        take_groups: [{
          takes: [
            { start: 5, end: 9, quality: 'aborted', reason: 'flub' },
            { start: 12, end: 16, quality: 'best', reason: 'clean' },
          ],
          recommended_keep_index: 1,
        }],
      }),
    },
  );
  assert.equal(r.mode, 'transcript_only');
  // CTA trim applied
  assert.deepEqual(r.removeCuts, [{ start: 70.5, end: 80, reason: 'post-CTA trailing' }]);
  // proposal present...
  assert.equal(r.bestTakeProposal.proposedDrops.length, 1);
  assert.equal(r.bestTakeProposal.proposedDrops[0].start, 5);
  // ...but the proposed drop is NEVER in removeCuts (log-only in v1)
  assert.ok(!r.removeCuts.some((c) => c.start === 5));
});

test('analyze: bestTakeDetect-only (endOnCta false) → proposal but NO trim', async () => {
  const r = await analyzeBestTakeAndCta(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 80, endOnCta: false },
    {
      apiKey: 'test',
      fetchImpl: mockFetcher({
        cta: goodCta,
        take_groups: [{ takes: [{ start: 5, end: 9, quality: 'weak' }, { start: 12, end: 16, quality: 'best' }], recommended_keep_index: 1 }],
      }),
    },
  );
  assert.deepEqual(r.removeCuts, []); // no trim
  assert.equal(r.cta.found, true);     // CTA still detected + returned
  assert.equal(r.bestTakeProposal.proposedDrops.length, 1);
});

test('analyze: multi-part segmentHint → CTA detected but NO auto-trim', async () => {
  const r = await analyzeBestTakeAndCta(
    {
      wordTimestamps: SAMPLE_WORDS,
      sourceDuration: 80,
      endOnCta: true,
      segmentHint: { clips: [{ start: 0, end: 40 }, { start: 42, end: 80 }] },
    },
    { apiKey: 'test', fetchImpl: mockFetcher({ cta: goodCta, take_groups: [] }) },
  );
  assert.deepEqual(r.removeCuts, []);
  assert.equal(r.cta.found, true);
});

test('analyze: malformed JSON → non-fatal empty with error', async () => {
  const fetcher = async () => fakeResponse({ body: { candidates: [{ content: { parts: [{ text: 'nope {' }] } }] } });
  const r = await analyzeBestTakeAndCta(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 80, endOnCta: true },
    { apiKey: 'test', fetchImpl: fetcher },
  );
  assert.deepEqual(r.removeCuts, []);
  assert.equal(r.cta, null);
  assert.deepEqual(r.bestTakeProposal, { groups: [], proposedDrops: [] });
  assert.match(r.error ?? '', /invalid JSON/);
});

test('analyze: non-200 → non-fatal empty with error (does NOT throw)', async () => {
  const r = await analyzeBestTakeAndCta(
    { wordTimestamps: SAMPLE_WORDS, sourceDuration: 80, endOnCta: true },
    { apiKey: 'test', fetchImpl: mockFetcher({}, { ok: false, status: 503 }) },
  );
  assert.deepEqual(r.removeCuts, []);
  assert.match(r.error ?? '', /Gemini 503/);
});

test('analyze: missing apiKey and empty timestamps → error, no fetch', async () => {
  let calls = 0;
  const counting = async () => { calls++; return fakeResponse({ body: geminiResponseFor({}) }); };
  const noKey = await analyzeBestTakeAndCta({ wordTimestamps: SAMPLE_WORDS, sourceDuration: 80 }, { apiKey: '', fetchImpl: counting });
  assert.match(noKey.error ?? '', /GEMINI_API_KEY/);
  const noWords = await analyzeBestTakeAndCta({ wordTimestamps: [], sourceDuration: 80 }, { apiKey: 'test', fetchImpl: counting });
  assert.match(noWords.error ?? '', /no word timestamps/);
  assert.equal(calls, 0); // neither path hit the network
});

test('analyze: request body uses temperature 0.1 + JSON mode + tagged transcript + CTA language', async () => {
  let capturedBody;
  const fetcher = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return fakeResponse({ body: geminiResponseFor({ cta: { found: false }, take_groups: [] }) });
  };
  await analyzeBestTakeAndCta(
    { wordTimestamps: [w('fill', 60.0, 60.3)], sourceDuration: 80, endOnCta: true },
    { apiKey: 'test', fetchImpl: fetcher },
  );
  assert.equal(capturedBody.generationConfig.temperature, 0.1);
  assert.equal(capturedBody.generationConfig.responseMimeType, 'application/json');
  const prompt = capturedBody.contents[0].parts[0].text;
  assert.match(prompt, /\[60\.00s\] fill/);
  for (const phrase of CTA_ACTION_LANGUAGE) assert.ok(prompt.includes(phrase), `prompt missing CTA phrase: ${phrase}`);
});

// ── prompt builder ───────────────────────────────────────────────────────

test('buildBestTakeCtaPrompt: includes CTA action-language list + transcript + silences', () => {
  const p = buildBestTakeCtaPrompt('[60.00s] fill [60.30s] out', '[3.20-5.00]');
  assert.match(p, /\[60\.00s\] fill/);
  assert.match(p, /\[3\.20-5\.00\]/);
  for (const phrase of CTA_ACTION_LANGUAGE) assert.ok(p.includes(phrase));
});

test('CTA_MIN_CONFIDENCE is the documented 0.75 gate', () => {
  assert.equal(CTA_MIN_CONFIDENCE, 0.75);
});
