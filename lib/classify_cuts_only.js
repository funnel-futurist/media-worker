/**
 * lib/classify_cuts_only.js
 *
 * Dry-run cut-classifier pipeline. Runs the cheap upstream stages
 *   download → silence detect → Deepgram → slate detect → cut classify
 * and STOPS before bad-take/raw-cleanup/best-take/compose/upload.
 *
 * Built so tuning options like `cutSafetyMode` / `retainSec` can be
 * A/B-tested in ~15-30s per fire instead of ~60-100s for the full
 * /clean-mode-compose pipeline. Backed by /clean-mode-classify (see
 * routes/clean-mode-classify.js).
 *
 * Calls the SAME lower-level helpers as the production pipeline
 * (downloadFromStorage, detectAudioSilences, callDeepgramWithRetry,
 * mapDeepgramResponse, detectSlate, snapSlateEndToNextWord,
 * detectAndClassifyCuts) so the cut-classifier output is byte-identical
 * for the same input. Orchestration is the only thing duplicated;
 * a parity test guards against drift (test/classify_cuts_parity.test.js).
 *
 * Intentionally NOT wired into runCleanModePipeline this PR — that
 * refactor would touch the production hot path and isn't required for
 * the iteration-speed goal. Possible follow-up.
 *
 * Mirrors the cut-classifier option surface of buildPipelineOpts:
 *   - cutSafetyMode    'safe_only' | 'safe_and_soft' | 'all' (default 'safe_only')
 *   - retainSec        number in (0, 1] (default applied downstream)
 *   - silenceNoiseDb   number (default -30)
 *   - silenceMinDur    number (default 0.4)
 *   - slateHint        string ≤ 200 chars
 *   - skipSlate        boolean (skips slate detection entirely)
 *   - deepgramKeywords string[] (Deepgram keyword boosts)
 *
 * All other options (b-roll, banner, hook, BGM, compose, etc) are
 * IGNORED — they don't affect cut classification.
 */

import { mkdirSync } from 'fs';
import { join } from 'path';

import { downloadFromStorage } from './storage_helpers.js';
import { getDuration } from './media.js';
import { detectAudioSilences } from './scribe_transcribe.js';
import { mergeAdjacentSilences } from './clean_mode_pipeline.js';
import { callDeepgramWithRetry, mapDeepgramResponse } from './deepgram_transcribe.js';
import { detectSlate, snapSlateEndToNextWord } from './slate_detect.js';
import { detectAndClassifyCuts } from './cut_detection.js';

/**
 * @param {object} req
 * @param {string} req.jobId
 * @param {{bucket: string, path: string}} req.sourceMP4
 * @param {string} req.clientId
 * @param {object} [req.options]
 * @returns {Promise<{
 *   jobId: string,
 *   processingMs: number,
 *   sourceDurationSec: number,
 *   silence: { spans: number, mergedSpans: number, mergesApplied: number },
 *   transcript: { text: string, words: number },
 *   slate: { detected: boolean, via: 'llm'|'fallback'|'no-slate'|'skipped', endSec: number|null, identifier: string|null, error: string|null, snappedEndSec: number|null },
 *   cuts: {
 *     applied: number, skipped: number, secondsRemoved: number,
 *     byCategory: { applied: object, skipped: object },
 *     appliedDetail: Array<object>, skippedDetail: Array<object>,
 *   },
 *   steps: object,
 * }>}
 */
export async function runClassifyCutsOnly(req, depsOverride = {}) {
  const startedAt = Date.now();

  if (!req?.jobId) throw new Error('jobId is required');
  if (!req.sourceMP4?.bucket || !req.sourceMP4?.path) {
    throw new Error('sourceMP4 must be { bucket, path }');
  }
  if (!req.clientId) throw new Error('clientId is required');

  // Dependency overrides are test seams. Production passes none and gets
  // the imported helpers above; tests stub the network-heavy ones (Deepgram,
  // slate detect, download) with fixtures.
  const deps = {
    downloadFromStorage: depsOverride.downloadFromStorage ?? downloadFromStorage,
    getDuration: depsOverride.getDuration ?? getDuration,
    detectAudioSilences: depsOverride.detectAudioSilences ?? detectAudioSilences,
    mergeAdjacentSilences: depsOverride.mergeAdjacentSilences ?? mergeAdjacentSilences,
    callDeepgramWithRetry: depsOverride.callDeepgramWithRetry ?? callDeepgramWithRetry,
    mapDeepgramResponse: depsOverride.mapDeepgramResponse ?? mapDeepgramResponse,
    detectSlate: depsOverride.detectSlate ?? detectSlate,
    snapSlateEndToNextWord: depsOverride.snapSlateEndToNextWord ?? snapSlateEndToNextWord,
    detectAndClassifyCuts: depsOverride.detectAndClassifyCuts ?? detectAndClassifyCuts,
  };

  const { jobId } = req;
  const opts = req.options ?? {};
  const tmpDir = depsOverride.tmpDir ?? join('/tmp', `classify-${jobId}`);
  const sourcePath = join(tmpDir, 'source.mp4');
  mkdirSync(tmpDir, { recursive: true });

  const steps = {};
  const stepStart = (name) => {
    steps[name] = { ms: 0 };
    return Date.now();
  };

  // ── 1. Download source ────────────────────────────────────────────────
  let stepT = stepStart('download');
  const dl = await deps.downloadFromStorage({
    bucket: req.sourceMP4.bucket,
    path: req.sourceMP4.path,
    outputPath: sourcePath,
  });
  steps.download = { ms: Date.now() - stepT, bytes: dl.bytes };

  const sourceDuration = await deps.getDuration(sourcePath);

  // ── 2. Silence detection ──────────────────────────────────────────────
  // Matches clean_mode_pipeline.js step 2 (lines 470-486). Same defaults
  // (-30 dB / 0.4s) so the silence spans the cut classifier sees are
  // identical.
  stepT = stepStart('silenceDetect');
  const silenceNoiseDb = typeof opts.silenceNoiseDb === 'number' ? opts.silenceNoiseDb : -30;
  const silenceMinDur = typeof opts.silenceMinDur === 'number' ? opts.silenceMinDur : 0.4;
  const silenceMap = await deps.detectAudioSilences(sourcePath, { noiseDb: silenceNoiseDb, minDur: silenceMinDur });
  const mergedSilenceMap = deps.mergeAdjacentSilences(silenceMap, 0.4);
  steps.silenceDetect = {
    ms: Date.now() - stepT,
    spans: silenceMap.length,
    mergedSpans: mergedSilenceMap.length,
    mergesApplied: silenceMap.length - mergedSilenceMap.length,
  };

  // ── 3. Deepgram transcribe ────────────────────────────────────────────
  stepT = stepStart('transcribe');
  const dgKey = process.env.DEEPGRAM_API_KEY?.trim();
  if (!dgKey) throw new Error('DEEPGRAM_API_KEY not set on Railway');
  const deepgramKeywords = Array.isArray(opts.deepgramKeywords)
    ? opts.deepgramKeywords.filter((k) => typeof k === 'string' && k.trim().length > 0)
    : undefined;
  const dgRaw = await deps.callDeepgramWithRetry(dgKey, sourcePath, { keywords: deepgramKeywords });
  const { transcript, word_timestamps, _debug: dgDebug } = deps.mapDeepgramResponse(dgRaw);
  if (word_timestamps.length === 0) {
    const sample = dgDebug?.rawSample ?? '(no sample)';
    // Same human-readable message as the full pipeline. Keeps the
    // "Deepgram returned 0 words" phrase so existing tests + error-step
    // classification still match. (Dry-run returns sync, so there's no
    // portal callback / terminal flag to forward here.)
    throw new Error(
      `No speech detected in source audio — verify the uploaded file. ` +
      `(Deepgram returned 0 words; the source has an audio track but no ` +
      `recognizable speech.) Sample: ${sample.slice(0, 200)}`,
    );
  }
  steps.transcribe = { ms: Date.now() - stepT, words: word_timestamps.length };

  // ── 3b. Slate detection ───────────────────────────────────────────────
  // Mirrors clean_mode_pipeline.js step 3b (lines 519-569). When the LLM
  // returns a slate window we synthesize the leading-silence cut and snap
  // its end to the next word boundary — same as production.
  stepT = stepStart('slateDetect');
  let slateMetadata = null;
  let slateError = null;
  let slateSkipReason = null;
  if (opts.skipSlate === true) {
    slateSkipReason = 'opts.skipSlate=true';
    steps.slateDetect = { ms: Date.now() - stepT, detected: false, via: 'skipped', skipReason: slateSkipReason };
  } else {
    try {
      slateMetadata = await deps.detectSlate(
        { wordTimestamps: word_timestamps, sourceDuration },
        { slateHint: opts.slateHint },
      );
    } catch (err) {
      slateError = err.message;
    }
    steps.slateDetect = {
      ms: Date.now() - stepT,
      detected: slateMetadata !== null,
      via: slateMetadata ? 'llm' : (slateError ? 'fallback' : 'no-slate'),
      ...(slateError ? { error: slateError } : {}),
      ...(slateMetadata ? {
        endSec: Number(slateMetadata.end.toFixed(3)),
        identifier: slateMetadata.identifier,
      } : {}),
    };
  }

  // ── 4. Cut detection + safety classification ──────────────────────────
  // Same option set as clean_mode_pipeline.js lines 576-644. Anything we
  // pass here that's hardcoded there (preservePostSentenceSec, etc) MUST
  // stay in sync — the parity test catches drift.
  const cutClassifyStepT = Date.now();
  const cutResult = deps.detectAndClassifyCuts(word_timestamps, {
    sourceDuration,
    externalSilences: mergedSilenceMap,
    cutSafetyMode: opts.cutSafetyMode ?? 'safe_only',
    preserveEmphasisPauses: true,
    ...(typeof opts.retainSec === 'number' ? { retainSec: opts.retainSec } : {}),
    preservePostSentenceSec: 0.3,
    minCutDurationSec: 0.12,
    cutMidSentenceLongerThan: 1.0,
    cutBeyondLastWordPadSec: 0.5,
    protectSafeCutsFromCap: true,
    longCommaPauseAsSafeThreshSec: 1.5,
    returnCapDropped: true,
    relaxClampForGhostWords: true,
    detectSlateFromTranscript: slateError !== null,
  });

  // Inject the LLM-detected slate cut at the front of applied[], snapping
  // the end to the next word boundary — same as clean_mode_pipeline.js
  // lines 652-692. Skips when slate detection was skipped or returned null.
  let snappedSlateEndSec = null;
  if (slateMetadata) {
    snappedSlateEndSec = deps.snapSlateEndToNextWord(slateMetadata.end, word_timestamps);
    cutResult.applied.unshift({
      start: 0,
      end: snappedSlateEndSec,
      category: 'silence',
      reason: `slate_intro (llm): ${(slateMetadata.transcribed_text || '').slice(0, 60)}`.trim(),
      safety: 'safe',
      safetyReason: 'leading_silence',
      contextBefore: '',
      contextAfter: '',
    });
    cutResult.applied.sort((a, b) => a.start - b.start);
  }

  const totalSecondsRemoved = cutResult.applied.reduce((s, c) => s + (c.end - c.start), 0);
  steps.cutClassify = {
    ms: Date.now() - cutClassifyStepT,
    applied: cutResult.applied.length,
    skipped: cutResult.skipped.length,
  };

  // Build byCategory summaries the experiment scripts already know how to
  // read (same shape as the full pipeline's response).
  const bucketCategories = ['slate', 'cameraShutoff', 'leadingSilence', 'trailingSilence', 'deadAir', 'filler', 'repeat', 'badTake', 'other'];
  const byCategory = {
    applied: Object.fromEntries(bucketCategories.map((k) => [k, 0])),
    skipped: Object.fromEntries(bucketCategories.map((k) => [k, 0])),
  };
  for (const c of cutResult.applied) byCategory.applied[bucketCutCategory(c)] += 1;
  for (const c of cutResult.skipped) byCategory.skipped[bucketCutCategory(c)] += 1;

  return {
    jobId,
    processingMs: Date.now() - startedAt,
    sourceDurationSec: Number(sourceDuration.toFixed(3)),
    silence: {
      spans: silenceMap.length,
      mergedSpans: mergedSilenceMap.length,
      mergesApplied: silenceMap.length - mergedSilenceMap.length,
    },
    transcript: { text: transcript, words: word_timestamps.length },
    slate: {
      detected: slateMetadata !== null,
      via: slateSkipReason ? 'skipped' : (slateMetadata ? 'llm' : (slateError ? 'fallback' : 'no-slate')),
      endSec: slateMetadata ? Number(slateMetadata.end.toFixed(3)) : null,
      snappedEndSec: snappedSlateEndSec != null ? Number(snappedSlateEndSec.toFixed(3)) : null,
      identifier: slateMetadata?.identifier ?? null,
      error: slateError,
    },
    cuts: {
      applied: cutResult.applied.length,
      skipped: cutResult.skipped.length,
      secondsRemoved: Number(totalSecondsRemoved.toFixed(3)),
      byCategory,
      appliedDetail: cutResult.applied.map(formatCutForResponse),
      skippedDetail: cutResult.skipped.map(formatCutForResponse),
    },
    steps,
  };
}

/**
 * Categorize a cut for the byCategory summary. Mirrors the bucketing
 * the full pipeline produces in its response.cuts.byCategory.
 */
function bucketCutCategory(cut) {
  const reason = (cut.reason ?? '').toLowerCase();
  if (cut.category === 'bad_take') return 'badTake';
  if (cut.category === 'raw_cleanup') return 'other';
  if (cut.category === 'cta_trim') return 'other';
  if (reason.startsWith('slate_intro')) return 'slate';
  if (reason.includes('camera_off') || reason.includes('cameraoff')) return 'cameraShutoff';
  if (reason.includes('leading_silence')) return 'leadingSilence';
  if (reason.includes('trailing_silence')) return 'trailingSilence';
  if (cut.category === 'silence') return 'deadAir';
  if (reason.includes('filler')) return 'filler';
  if (reason.includes('repeat')) return 'repeat';
  return 'other';
}

function formatCutForResponse(cut) {
  return {
    startSec: Number(cut.start.toFixed(3)),
    endSec: Number(cut.end.toFixed(3)),
    bucket: bucketCutCategory(cut),
    safety: cut.safety ?? null,
    safetyReason: cut.safetyReason ?? null,
    reason: cut.reason ?? '',
    contextBefore: cut.contextBefore ?? '',
    contextAfter: cut.contextAfter ?? '',
  };
}
