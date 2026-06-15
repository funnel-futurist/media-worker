/**
 * test/classify_cuts_only.test.js
 *
 * Unit tests for runClassifyCutsOnly with stubbed I/O. We don't hit
 * Supabase, Deepgram, Gemini, or ffmpeg — every external helper is
 * injected via the depsOverride seam so the test runs deterministically
 * in <50ms.
 *
 * The point is to lock in:
 *   1. The dry-run honors cutSafetyMode / retainSec (forwards them
 *      verbatim to detectAndClassifyCuts).
 *   2. The response envelope shape stays stable.
 *   3. Slate inject + snap-to-word happens when slate is detected.
 *   4. opts.skipSlate=true short-circuits slate detection entirely.
 *   5. byCategory bucketing matches the production semantics enough
 *      for the dry-run UI to surface the same numbers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runClassifyCutsOnly } from '../lib/classify_cuts_only.js';

const BASE_REQ = {
  jobId: 'test-classify-001',
  sourceMP4: { bucket: 'client-uploads', path: 'enablesnp/raw/test.mp4' },
  clientId: 'enablesnp',
};

function makeWords(specs) {
  // specs = [[startSec, endSec, word], ...]
  return specs.map(([s, e, w]) => ({ start_ms: s * 1000, end_ms: e * 1000, word: w }));
}

/**
 * Default stubs: simulate a 30s talking-head clip with one silence span,
 * no slate, and a cleanly-classifiable cut at 10-12s.
 */
function makeStubs(overrides = {}) {
  return {
    tmpDir: `/tmp/classify-test-${Math.floor(Math.random() * 1e9)}`,
    downloadFromStorage: async () => ({ bytes: 1_000_000 }),
    getDuration: async () => 30.0,
    detectAudioSilences: async () => [{ start: 10.0, end: 12.0 }],
    mergeAdjacentSilences: (spans) => spans, // pass-through for simplicity
    callDeepgramWithRetry: async () => ({ /* opaque raw */ }),
    mapDeepgramResponse: () => ({
      transcript: 'word one. word two. word three.',
      word_timestamps: makeWords([
        [0.0, 0.5, 'word'],
        [0.5, 1.0, 'one.'],
        [3.0, 3.5, 'word'],
        [3.5, 4.0, 'two.'],
        [12.5, 13.0, 'word'],
        [13.0, 13.5, 'three.'],
      ]),
    }),
    detectSlate: async () => null, // no slate detected by default
    snapSlateEndToNextWord: (end) => end + 0.05,
    detectAndClassifyCuts: () => ({
      applied: [
        { start: 10.0, end: 12.0, category: 'silence', reason: 'post_sentence_dead_air', safety: 'safe', safetyReason: 'post_sentence', contextBefore: 'two.', contextAfter: 'word' },
      ],
      skipped: [],
      all: [],
      capDropped: [],
    }),
    ...overrides,
  };
}

test('runClassifyCutsOnly: requires jobId / sourceMP4 / clientId', async () => {
  await assert.rejects(() => runClassifyCutsOnly({}), /jobId is required/);
  await assert.rejects(() => runClassifyCutsOnly({ jobId: 'j' }), /sourceMP4/);
  await assert.rejects(() => runClassifyCutsOnly({ jobId: 'j', sourceMP4: { bucket: 'b', path: 'p' } }), /clientId/);
});

test('runClassifyCutsOnly: requires DEEPGRAM_API_KEY', async () => {
  const original = process.env.DEEPGRAM_API_KEY;
  delete process.env.DEEPGRAM_API_KEY;
  try {
    await assert.rejects(
      () => runClassifyCutsOnly(BASE_REQ, makeStubs()),
      /DEEPGRAM_API_KEY/,
    );
  } finally {
    if (original) process.env.DEEPGRAM_API_KEY = original;
  }
});

test('runClassifyCutsOnly: happy path returns the expected envelope', async () => {
  process.env.DEEPGRAM_API_KEY = 'dummy';
  const result = await runClassifyCutsOnly(BASE_REQ, makeStubs());

  assert.equal(result.jobId, 'test-classify-001');
  assert.ok(typeof result.processingMs === 'number');
  assert.equal(result.sourceDurationSec, 30.0);

  assert.equal(result.silence.spans, 1);
  assert.equal(result.silence.mergedSpans, 1);
  assert.equal(result.transcript.words, 6);
  assert.ok(typeof result.transcript.text === 'string');

  assert.equal(result.slate.detected, false);
  assert.equal(result.slate.via, 'no-slate');
  assert.equal(result.slate.endSec, null);
  assert.equal(result.slate.snappedEndSec, null);

  assert.equal(result.cuts.applied, 1);
  assert.equal(result.cuts.skipped, 0);
  assert.equal(result.cuts.secondsRemoved, 2.0);
  assert.equal(result.cuts.appliedDetail.length, 1);
  assert.equal(result.cuts.appliedDetail[0].startSec, 10.0);
  assert.equal(result.cuts.appliedDetail[0].endSec, 12.0);
  assert.equal(result.cuts.appliedDetail[0].bucket, 'deadAir');
  assert.equal(result.cuts.appliedDetail[0].safety, 'safe');

  // Steps that ran
  assert.ok(result.steps.download);
  assert.ok(result.steps.silenceDetect);
  assert.ok(result.steps.transcribe);
  assert.ok(result.steps.slateDetect);
  assert.ok(result.steps.cutClassify);
  // Steps the dry-run must NOT run
  assert.equal(result.steps.badTakeDetect, undefined);
  assert.equal(result.steps.compose, undefined);
  assert.equal(result.steps.subtitleBurn, undefined);
  assert.equal(result.steps.upload, undefined);
});

test('runClassifyCutsOnly: forwards cutSafetyMode + retainSec to detectAndClassifyCuts', async () => {
  process.env.DEEPGRAM_API_KEY = 'dummy';
  let captured = null;
  const stubs = makeStubs({
    detectAndClassifyCuts: (_words, opts) => {
      captured = opts;
      return { applied: [], skipped: [], all: [], capDropped: [] };
    },
  });

  await runClassifyCutsOnly({
    ...BASE_REQ,
    options: { cutSafetyMode: 'safe_and_soft', retainSec: 0.25 },
  }, stubs);

  assert.equal(captured.cutSafetyMode, 'safe_and_soft');
  assert.equal(captured.retainSec, 0.25);
});

test('runClassifyCutsOnly: cutSafetyMode default is safe_only', async () => {
  process.env.DEEPGRAM_API_KEY = 'dummy';
  let captured = null;
  const stubs = makeStubs({
    detectAndClassifyCuts: (_words, opts) => {
      captured = opts;
      return { applied: [], skipped: [], all: [], capDropped: [] };
    },
  });
  await runClassifyCutsOnly(BASE_REQ, stubs);
  assert.equal(captured.cutSafetyMode, 'safe_only');
  // retainSec NOT injected when omitted (defaults belong to detectAndClassifyCuts)
  assert.equal(captured.retainSec, undefined);
});

test('runClassifyCutsOnly: slate detection inject + snap-to-word', async () => {
  process.env.DEEPGRAM_API_KEY = 'dummy';
  let snapInput = null;
  const stubs = makeStubs({
    detectSlate: async () => ({
      start: 0,
      end: 4.85,
      transcribed_text: 'June 14 reel — selected option A',
      identifier: 'date_and_title',
    }),
    snapSlateEndToNextWord: (end, _words) => { snapInput = end; return 5.10; },
  });

  const result = await runClassifyCutsOnly(BASE_REQ, stubs);
  assert.equal(result.slate.detected, true);
  assert.equal(result.slate.via, 'llm');
  assert.equal(result.slate.endSec, 4.85);
  assert.equal(result.slate.snappedEndSec, 5.1);
  assert.equal(result.slate.identifier, 'date_and_title');
  assert.equal(snapInput, 4.85);

  // Slate cut injected at the FRONT of applied[], category=silence,
  // reason starts with slate_intro so it buckets to 'slate'.
  assert.equal(result.cuts.applied, 2); // original cut + slate
  assert.equal(result.cuts.appliedDetail[0].startSec, 0);
  assert.equal(result.cuts.appliedDetail[0].endSec, 5.1);
  assert.equal(result.cuts.appliedDetail[0].bucket, 'slate');
  assert.match(result.cuts.appliedDetail[0].reason, /^slate_intro \(llm\)/);
});

test('runClassifyCutsOnly: opts.skipSlate=true short-circuits slate detection', async () => {
  process.env.DEEPGRAM_API_KEY = 'dummy';
  let slateCalled = false;
  const stubs = makeStubs({
    detectSlate: async () => { slateCalled = true; return null; },
  });

  const result = await runClassifyCutsOnly({
    ...BASE_REQ,
    options: { skipSlate: true },
  }, stubs);

  assert.equal(slateCalled, false, 'detectSlate must NOT be called when skipSlate=true');
  assert.equal(result.slate.detected, false);
  assert.equal(result.slate.via, 'skipped');
});

test('runClassifyCutsOnly: slate detection error → fallback path + detectSlateFromTranscript=true', async () => {
  process.env.DEEPGRAM_API_KEY = 'dummy';
  let cutClassifyOpts = null;
  const stubs = makeStubs({
    detectSlate: async () => { throw new Error('Gemini 500 retry exhausted'); },
    detectAndClassifyCuts: (_words, opts) => {
      cutClassifyOpts = opts;
      return { applied: [], skipped: [], all: [], capDropped: [] };
    },
  });

  const result = await runClassifyCutsOnly(BASE_REQ, stubs);
  assert.equal(result.slate.detected, false);
  assert.equal(result.slate.via, 'fallback');
  assert.match(result.slate.error ?? '', /Gemini 500/);
  // When LLM slate fails we tell the deterministic cut detector to try
  // its own pattern-based slate scan as a backstop.
  assert.equal(cutClassifyOpts.detectSlateFromTranscript, true);
});

test('runClassifyCutsOnly: Deepgram zero-words throws cleanly', async () => {
  process.env.DEEPGRAM_API_KEY = 'dummy';
  const stubs = makeStubs({
    mapDeepgramResponse: () => ({ transcript: '', word_timestamps: [], _debug: { rawSample: 'silence' } }),
  });
  await assert.rejects(
    () => runClassifyCutsOnly(BASE_REQ, stubs),
    /Deepgram returned 0 words/,
  );
});

test('runClassifyCutsOnly: forwards deepgramKeywords + silence tuning to the right deps', async () => {
  process.env.DEEPGRAM_API_KEY = 'dummy';
  let dgKeywords = null;
  let silenceArgs = null;
  const stubs = makeStubs({
    callDeepgramWithRetry: async (_key, _path, opts) => { dgKeywords = opts.keywords; return {}; },
    detectAudioSilences: async (_path, opts) => { silenceArgs = opts; return []; },
  });
  await runClassifyCutsOnly({
    ...BASE_REQ,
    options: {
      deepgramKeywords: ['special needs', '  ', 'wondered'],
      silenceNoiseDb: -25,
      silenceMinDur: 0.5,
    },
  }, stubs);
  assert.deepEqual(dgKeywords, ['special needs', 'wondered']); // whitespace stripped
  assert.equal(silenceArgs.noiseDb, -25);
  assert.equal(silenceArgs.minDur, 0.5);
});

test('runClassifyCutsOnly: appliedDetail uses bucket strings the experiment scripts already read', async () => {
  process.env.DEEPGRAM_API_KEY = 'dummy';
  const stubs = makeStubs({
    detectAndClassifyCuts: () => ({
      applied: [
        { start: 0.1, end: 0.3, category: 'silence', reason: 'leading_silence', safety: 'safe' },
        { start: 5.0, end: 6.0, category: 'silence', reason: 'phrase_boundary_comma', safety: 'soft' },
        { start: 10.0, end: 11.0, category: 'bad_take', reason: 'bad_take (llm): restart', safety: 'safe' },
      ],
      skipped: [
        { start: 20.0, end: 20.4, category: 'silence', reason: 'mid_sentence_no_boundary', safety: 'risky' },
      ],
      all: [], capDropped: [],
    }),
  });

  const result = await runClassifyCutsOnly(BASE_REQ, stubs);
  assert.equal(result.cuts.byCategory.applied.leadingSilence, 1);
  assert.equal(result.cuts.byCategory.applied.deadAir, 1);
  assert.equal(result.cuts.byCategory.applied.badTake, 1);
  assert.equal(result.cuts.byCategory.skipped.deadAir, 1);
});
