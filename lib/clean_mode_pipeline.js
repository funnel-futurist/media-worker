/**
 * lib/clean_mode_pipeline.js
 *
 * M2 orchestrator for the full clean-mode reel pipeline. Source MP4 in,
 * final captioned-and-brolled MP4 out — runs entirely on Railway with no
 * portal touchpoints (M3 will add the portal-side cron + status writes).
 *
 * Pipeline steps (timings recorded for the response):
 *   1. download    — service-role REST GET of source.mp4 → /tmp/<jobId>/
 *   2. silenceDetect — ffmpeg silencedetect → silence_map
 *   3. transcribe  — Deepgram Nova-3 on source.mp4 → word_timestamps
 *                    (ElevenLabs Scribe was the prior backend; swapped to
 *                    Deepgram for billing isolation + 35% lower per-hour
 *                    cost — see lib/deepgram_transcribe.js header for the
 *                    full rationale)
 *   4. cutClassify — deterministic_cuts safety classifier → applied + skipped
 *   5. cutApply    — ffmpeg trim+concat → cut.mp4
 *   6. libraryLookup — marketing.broll_library REST query
 *   7. brollPick   — Gemini insertion plan (lib/broll_picker)
 *   8. brollDownload — per-asset HTTPS GET to /tmp/<jobId>/brolls/
 *   9. compose     — ffmpeg face+broll filter_complex → brolled.mp4
 *   10. subtitleGen — math-remap + groupIntoLines + .ass file
 *   11. subtitleBurn — ffmpeg burn .ass into brolled.mp4 → final.mp4
 *   12. upload     — service-role REST POST → Supabase Storage
 *
 * Skip flags (testing-only):
 *   options.skipBroll      — skip steps 6-9; cut.mp4 advances to subtitle step
 *   options.skipSubtitles  — skip steps 10-11; brolled.mp4 (or cut.mp4) is final
 */

import { mkdirSync, rmSync, statSync, writeFileSync, createWriteStream } from 'fs';
import { join, extname } from 'path';
import { pipeline } from 'stream/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';

import { getDuration, probeStreams } from './media.js';
import { detectAudioSilences } from './scribe_transcribe.js';
import { callDeepgramWithRetry, mapDeepgramResponse } from './deepgram_transcribe.js';
import { filterUnsupportedBrollAssets } from './broll_filter.js';
import { detectSlate, snapSlateEndToNextWord } from './slate_detect.js';
import { detectBadTakes } from './bad_take_detect.js';
import { detectFaceOffsetX, buildCropXExpression } from './face_detect.js';
import { searchPixabayVideos, downloadPixabayVideo } from './pixabay_video.js';
import { generateStockKeywords } from './stock_keyword_gen.js';
import { shouldFetchStock, mergeStockIntoLibrary, rebalanceClientFirst } from './stock_library_merge.js';
import { getStockCacheDir } from './stock_cache.js';
// PR-B: BGM (background music) — Pixabay-Music search + adaptive LUFS mix.
import { searchJamendoMusic, downloadJamendoTrack } from './jamendo_music.js';
import { selectBgm } from './bgm_select.js';
import { getLUFS, computeBgmReductionDb, mixBgmIntoVideo } from './bgm_mix.js';
import { runBgmAudioQc } from './audio_qc.js';
import { copyFileSync } from 'fs';
import { detectAndClassifyCuts } from './cut_detection.js';
import { buildKeepSegments, runTrimConcat } from './ffmpeg_trim_concat.js';
import { pickBrollInsertions, getAvailableModels, DEFAULT_MODEL } from './broll_picker.js';
import { downloadFromStorage, uploadToStorage, signStorageUrl } from './storage_helpers.js';
import {
  remapWordsThroughCuts,
  groupIntoLines,
  writeAssAndBurn,
  extractSubtitleWarnings,
} from './subtitle_burn.js';

const execAsync = promisify(exec);

/**
 * @typedef {Object} CleanModeRequest
 * @property {string} jobId
 * @property {{ bucket: string, path: string }} sourceMP4
 * @property {string} clientId
 * @property {{ bucket: string, pathPrefix: string }} output
 * @property {Object} [options]
 * @property {string} [options.model='gemini-3.1-pro-preview']
 * @property {number} [options.brollDensity=0.35]
 * @property {string} [options.cutProfile='talking_head_reel']  // currently informational
 * @property {boolean} [options.skipBroll=false]
 * @property {boolean} [options.skipSubtitles=false]
 */

/**
 * Run the full clean-mode pipeline. Returns the M2 response shape (see
 * routes/clean-mode-compose.js for the documented schema).
 *
 * @param {CleanModeRequest} req
 * @returns {Promise<object>}  M2 success-response shape
 */
export async function runCleanModePipeline(req) {
  const startedAt = Date.now();
  const warnings = [];
  const steps = {};

  const { jobId } = req;
  if (!jobId) throw new Error('jobId is required');
  if (!req.sourceMP4?.bucket || !req.sourceMP4?.path) {
    throw new Error('sourceMP4 must be { bucket, path }');
  }
  if (!req.clientId) throw new Error('clientId is required');
  if (!req.output?.bucket || typeof req.output?.pathPrefix !== 'string') {
    throw new Error('output must be { bucket, pathPrefix }');
  }

  const opts = {
    model: req.options?.model ?? DEFAULT_MODEL,
    brollDensity: typeof req.options?.brollDensity === 'number' ? req.options.brollDensity : 0.35,
    skipBroll: req.options?.skipBroll === true,
    skipSubtitles: req.options?.skipSubtitles === true,
    // PR-A: Pixabay stock b-roll fallback. Default OFF — opt-in per job.
    // skipPixabay overrides pixabayEnabled (mirrors skipBroll/skipSubtitles).
    pixabayEnabled: req.options?.pixabayEnabled === true,
    skipPixabay: req.options?.skipPixabay === true,
    pixabayMaxClips: typeof req.options?.pixabayMaxClips === 'number'
      ? req.options.pixabayMaxClips
      : Number(process.env.PIXABAY_VIDEO_MAX_CLIPS ?? 8),
    // PR-B: Background music. Default OFF — opt-in per job.
    // skipBgm overrides bgmEnabled (same pattern as skipBroll/skipPixabay).
    // bgmVolumeDb stacks on top of the computed adaptive reduction
    // (negative number → extra cut). bgmQcEnabled adds an OPTIONAL
    // post-mix Gemini Pro perceptual check (~5-15s extra latency).
    bgmEnabled: req.options?.bgmEnabled === true,
    skipBgm: req.options?.skipBgm === true,
    bgmQcEnabled: req.options?.bgmQcEnabled === true,
    bgmVolumeDb: typeof req.options?.bgmVolumeDb === 'number' ? req.options.bgmVolumeDb : 0,
  };

  const tmpDir = join('/tmp', jobId);
  const sourcePath = join(tmpDir, 'source.mp4');
  const cutPath = join(tmpDir, 'cut.mp4');
  const brollDir = join(tmpDir, 'brolls');
  const brolledPath = join(tmpDir, 'brolled.mp4');
  const assPath = join(tmpDir, 'captions.ass');
  const finalPath = join(tmpDir, 'final.mp4');
  // PR-B: when bgmEnabled, subtitle burn writes to finalNoBgmPath; the
  // bgmMix step reads that and writes the real final.mp4. When bgmEnabled
  // is false, subtitle burn writes directly to finalPath (no path split).
  const finalNoBgmPath = join(tmpDir, 'finalNoBgm.mp4');

  // PR #103: partial-state holders hoisted to outer scope so the catch
  // block below can return whatever data has already been collected.
  // Without this, a throw mid-pipeline (e.g. the post-cutApply A/V sync
  // gate) would discard silenceMap, cuts, normalizedInsertions, etc —
  // exactly the data the operator needs to debug the failure.
  let inputValidation = null;
  let silenceMap = [];
  let mergedSilenceMap = [];
  let cutResult = null;
  let totalSecondsRemoved = 0;
  let audioLoudnormConfig = null;
  let library = [];
  let clientLibraryCount = 0;          // PR-A: tracked for response.insertions (= usable count after HEIC/URL filter)
  let clientLibraryRawCount = 0;       // PR-D: raw row count BEFORE any filter — diagnostics
  let clientLibrarySkippedHeic = 0;    // PR-D: HEIC/HEIF rows dropped (PR #110)
  let clientLibrarySkippedNoUrl = 0;   // PR-D: rows missing both file_url and storage_url
  let sourceBalanceConfig = null;      // PR-D: response.insertions.sourceBalance block
  let stockHits = [];                  // PR-A: pixabay hits after download+probe
  let stockKeywordsList = [];          // PR-A: keywords used (audit trail)
  // PR-B: BGM state hoisted so the catch (PR #103 partial-data envelope) can
  // surface what was attempted on a failed run.
  let bgmConfig = null;                // selection + mix metadata for response.audio.bgm
  let bgmTrackMeta = null;             // jamendo track + download metadata
  let bgmApplied = false;              // true after mixBgmIntoVideo succeeds
  let bgmSkipReason = null;            // 'opted_out' | 'bgm_select_*' | 'bgm_no_results' | 'bgm_fetch_*' | 'bgm_mix_*'
  let bgmQcResult = null;              // optional Pass 2 perceptual check
  // PR-B2: hoisted so the catch path (PR #103 partial-data envelope) can also
  // surface attribution that was attempted on a failed run.
  let attributionConfig = { required: false, entries: [] };
  let insertions = [];
  let normalizedInsertions = [];
  let composedSegmentMeta = [];
  let pickedModel = opts.model;
  let lineCount = 0;
  let contactSheetUrl = null;
  let finalDurationSec = null;
  let finalUrl = null;
  let finalStorage = null;
  const insertionWarnings = [];
  const streamSync = {};

  try {
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(brollDir, { recursive: true });

    const stepStart = (name) => {
      steps[name] = { ms: 0 };
      return Date.now();
    };

    // ── 0. PR #97: source/clientId slug-match validation ─────────────
    // Catches the wrong-source-with-wrong-clientId hand-off bug from the
    // m2-e2e-002→004 series (Phil's footage was tested with Justine's
    // clientId — the pipeline ran but the broll picker was operating on
    // the wrong client's library). Warning-only in M2 test mode; M3 will
    // resolve clientId from a portal contentItemId to prevent this.
    inputValidation = await validateSourcePairing({
      sourceMP4: req.sourceMP4,
      clientId: req.clientId,
    });
    if (inputValidation.match === 'mismatch') {
      warnings.push(
        `inputValidation: sourceMP4 path slug '${inputValidation.pathSlug}' does NOT match clientId ` +
        `resolved name '${inputValidation.clientName}' (expected slug '${inputValidation.expectedSlug}'). ` +
        `M2 test mode allows this but it's almost always a bug — M3 will resolve clientId from ` +
        `contentItemId to prevent it.`,
      );
    } else if (inputValidation.match === 'unverifiable') {
      warnings.push(
        `inputValidation: sourceMP4 path uses generic prefix '${inputValidation.pathSlug}' — ` +
        `client validation skipped.`,
      );
    } else if (inputValidation.match === 'unknown') {
      warnings.push(
        `inputValidation: ${inputValidation.reason ?? 'cannot validate source/client pairing'}.`,
      );
    }

    // ── 1. Download source ────────────────────────────────────────────
    let stepT = stepStart('download');
    const dl = await downloadFromStorage({
      bucket: req.sourceMP4.bucket,
      path: req.sourceMP4.path,
      outputPath: sourcePath,
    });
    steps.download = { ms: Date.now() - stepT, bytes: dl.bytes };
    console.log(`[clean_mode_pipeline:${jobId}] downloaded source ${dl.bytes}B in ${steps.download.ms}ms`);

    // ── Source duration (used by silence/cut/compose math) ──────────
    const sourceDuration = await getDuration(sourcePath);

    // ── 2. Silence detection ─────────────────────────────────────────
    stepT = stepStart('silenceDetect');
    silenceMap = await detectAudioSilences(sourcePath, { noiseDb: -35, minDur: 0.6 });
    // PR #102: merge silence spans separated by tiny (≤ 0.4s) gaps. Catches
    // "trailing-off → tiny speech blip → resume → stops again" stumbles
    // (B3's 1:11-1:13 issue: spans [84.62-87.25] + [87.31-89.75] separated
    // by 0.06s — effectively one 5.13s low-energy region but the cut
    // detector only saw two separate spans and only cut the first).
    // Conservative tolerance (0.4s); does NOT change silencedetect threshold
    // or any cut-detector tuning.
    mergedSilenceMap = mergeAdjacentSilences(silenceMap, 0.4);
    steps.silenceDetect = {
      ms: Date.now() - stepT,
      spans: silenceMap.length,
      mergedSpans: mergedSilenceMap.length,
      mergesApplied: silenceMap.length - mergedSilenceMap.length,
    };

    // ── 3. Deepgram transcribe ───────────────────────────────────────
    stepT = stepStart('transcribe');
    const dgKey = process.env.DEEPGRAM_API_KEY?.trim();
    if (!dgKey) throw new Error('DEEPGRAM_API_KEY not set on Railway');
    const dgRaw = await callDeepgramWithRetry(dgKey, sourcePath);
    const { transcript, word_timestamps, _debug: dgDebug } = mapDeepgramResponse(dgRaw);
    if (word_timestamps.length === 0) {
      const sample = dgDebug?.rawSample ?? '(no sample)';
      throw new Error(`Deepgram returned 0 words — cannot proceed. Sample: ${sample.slice(0, 200)}`);
    }
    steps.transcribe = { ms: Date.now() - stepT, words: word_timestamps.length };

    // ── 3b. LLM slate detection (PR #112) ──────────────────────────────
    // Gemini Flash judges semantically whether the first ~30s is a
    // slate/meta-intro. Replaces the prior pattern-matching detector that
    // missed phrases like Phil's "Selected Option A" because the regex
    // chain needed multi-signal hits inside the first sentence-bounded
    // window.
    //
    // Failure semantics: if Gemini errors (5xx after retries, malformed
    // response), we fall back to the pattern-matching detector so the
    // pipeline still tries to cut SOMETHING from the intro. If the LLM
    // succeeds with `null`, we trust it (no slate present) and skip the
    // pattern matcher entirely — the pattern matcher's false-positive rate
    // is real (e.g., "March is a great month" → matches `march \d+`).
    stepT = stepStart('slateDetect');
    let slateMetadata = null;
    let slateError = null;
    try {
      slateMetadata = await detectSlate({
        wordTimestamps: word_timestamps,
        sourceDuration,
      });
    } catch (err) {
      slateError = err.message;
      console.warn(
        `[clean_mode_pipeline:${jobId}] slate_detect failed (${err.message}) — ` +
        `falling back to pattern matcher`,
      );
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
    if (slateMetadata) {
      console.log(
        `[clean_mode_pipeline:${jobId}] slate (llm): end=${slateMetadata.end.toFixed(2)}s ` +
        `text="${(slateMetadata.transcribed_text || '').slice(0, 60)}"`,
      );
    }

    // ── 4. Cut detection + safety classification ─────────────────────
    // Capture stepT to a dedicated var so the `badTakeDetect` step below
    // can overwrite stepT without losing this measurement (steps.cutClassify
    // is reported AFTER badTakeDetect runs because we need the bad-take
    // cuts merged into applied[] before we record the final count).
    const cutClassifyStepT = stepStart('cutClassify');
    cutResult = detectAndClassifyCuts(word_timestamps, {
      sourceDuration,
      externalSilences: mergedSilenceMap,            // PR #102: merged-adjacent
      cutSafetyMode: 'safe_only',                    // talking_head_reel default
      preserveEmphasisPauses: true,
      cutMidSentenceLongerThan: 1.0,
      cutBeyondLastWordPadSec: 0.5,
      // PR #105: clean-mode opts in to skipping ASR "silence ghost" words
      // during the word-boundary clamp. Justine's 1:11–1:13 fixture had
      // the ASR (Scribe at the time; Deepgram now) report "The" as a single
      // 2.71s word [87.24, 89.95] that mostly overlapped silencedetect
      // [87.31, 89.75] — the clamp would pull cut.end back to 87.19 and
      // undo the merged silence span PR #102 had just collected. Setting
      // this true with externalSilences supplied lets the clamp ignore that
      // word so the merge survives. Default off in cut_detection.js to
      // preserve the broader test parity suite. The same heuristic applies
      // identically to any ASR backend that returns word-level timestamps.
      relaxClampForGhostWords: true,
      // PR #112: pattern-matching slate detector runs ONLY if the LLM slate
      // detection above failed (slateError non-null). When LLM succeeds —
      // either with a slate or with `null` — we trust it exclusively.
      detectSlateFromTranscript: slateError !== null,
    });

    // Inject the LLM-detected slate cut at the front of applied[]. We
    // synthesize a cut record with the same shape detectAndClassifyCuts
    // emits so renderCut + bucketCut see it as a normal slate cut. Reason
    // string is prefixed `slate_intro` so bucketCut routes it to the
    // 'slate' bucket; ` (llm)` suffix lets the operator tell at a glance
    // which detector fired.
    if (slateMetadata) {
      // PR #114: snap LLM end to the next clean word boundary. On B10 the
      // LLM said 9.04s but Phil's "A" from "Option A" extended past 9.04s,
      // so the cut [0, 9.04] left the "A" sound at the start of the final
      // video. Snap finds the first word that starts strictly after
      // 9.04+0.05s (safety pad) and uses that word's start as the cut end.
      // Result: no partial slate words leak in, AND the final video starts
      // exactly at the next real word (clean intro).
      const snappedEnd = snapSlateEndToNextWord(slateMetadata.end, word_timestamps);
      const snapped = snappedEnd > slateMetadata.end + 0.001;
      cutResult.applied.unshift({
        start: 0,
        end: snappedEnd,
        category: 'silence',
        reason:
          `slate_intro (llm): ${(slateMetadata.transcribed_text || '').slice(0, 60)}`.trim() +
          (snapped ? ` [snap +${(snappedEnd - slateMetadata.end).toFixed(2)}s]` : ''),
        safety: 'safe',
        safetyReason: 'leading_silence',
        contextBefore: '',
        contextAfter: '',
      });
      cutResult.applied.sort((a, b) => a.start - b.start);
      // Surface the snap in the response step metadata so the operator can
      // tell whether the LLM end was used as-is or extended to a word boundary.
      steps.slateDetect.snappedEndSec = Number(snappedEnd.toFixed(3));
      steps.slateDetect.snappedDeltaSec = Number((snappedEnd - slateMetadata.end).toFixed(3));
    }

    // ── 4b. LLM bad-take detection (PR #112) ───────────────────────────
    // M2 had ZERO bad-take detection until this PR (Phil B8's
    // cuts.byCategory.applied.badTake = 0 was the canonical evidence).
    // Gemini Flash identifies stumbles, restarts, false starts that
    // silence/dead-air detection can't see (because they're not silent).
    //
    // Failure semantics: bad-take detection failure is non-fatal. If
    // Gemini errors, we log + continue with no bad-take cuts. The
    // silence/dead-air/slate cuts already applied stay. False negatives
    // here just mean stumbles pass through unchanged — that's safer than
    // a false positive cutting real content.
    stepT = stepStart('badTakeDetect');
    let badTakeCuts = [];
    let badTakeError = null;
    try {
      const slateEnd = slateMetadata?.end ?? 0;
      const existingCuts = cutResult.applied.map((c) => ({ start: c.start, end: c.end }));
      badTakeCuts = await detectBadTakes({
        wordTimestamps: word_timestamps,
        sourceDuration,
        startAfterSec: slateEnd,
        excludeOverlapWith: existingCuts,
      });
    } catch (err) {
      badTakeError = err.message;
      console.warn(
        `[clean_mode_pipeline:${jobId}] bad_take_detect failed (${err.message}) — ` +
        `continuing without bad-take cuts`,
      );
    }
    steps.badTakeDetect = {
      ms: Date.now() - stepT,
      detected: badTakeCuts.length,
      ...(badTakeError ? { error: badTakeError } : {}),
    };

    // Append bad-take cuts to applied[]. category='bad_take' routes them
    // to the 'badTake' bucket via bucketCut (line ~740).
    for (const bt of badTakeCuts) {
      cutResult.applied.push({
        start: bt.start,
        end: bt.end,
        category: 'bad_take',
        reason: `bad_take (llm): ${bt.reason}`.slice(0, 80),
        safety: 'safe',
        safetyReason: 'llm_detected',
        contextBefore: '',
        contextAfter: '',
      });
    }
    if (badTakeCuts.length > 0) {
      cutResult.applied.sort((a, b) => a.start - b.start);
      console.log(
        `[clean_mode_pipeline:${jobId}] bad_takes (llm): added ${badTakeCuts.length} cut(s)`,
      );
    }

    // Recompute applied-cut metadata after slate + bad-take injections.
    const appliedCuts = cutResult.applied.map((c) => ({ start: c.start, end: c.end }));
    totalSecondsRemoved = appliedCuts.reduce((s, c) => s + (c.end - c.start), 0);
    steps.cutClassify = {
      ms: Date.now() - cutClassifyStepT,
      applied: cutResult.applied.length,
      skipped: cutResult.skipped.length,
    };
    console.log(
      `[clean_mode_pipeline:${jobId}] cuts: applied=${cutResult.applied.length} ` +
      `skipped=${cutResult.skipped.length} secondsRemoved=${totalSecondsRemoved.toFixed(2)}`,
    );

    // ── 5. Apply cuts via ffmpeg trim+concat ────────────────────────
    // PR #100: enable EBU R128 loudness normalization on the clean-mode path.
    // The runTrimConcat helper applies loudnorm AFTER concat, so the
    // normalization is based on the kept content (not on cut-out dead air).
    // I=-16 LUFS / TP=-1.5 dBTP / LRA=11 LU is the social-video target —
    // matches production hyperframes in routes/audio-loudnorm-trim.js.
    // Real client raw recordings (Justine especially) record too quietly
    // for direct social upload; loudnorm fixes that without manual leveling.
    audioLoudnormConfig = {
      applied: true,
      integratedLoudnessTargetLufs: -16,
      truePeakDbtp: -1.5,
      lraTargetLu: 11,
      appliedAtStep: 'cutApply',
    };
    stepT = stepStart('cutApply');
    const keepSegments = buildKeepSegments(appliedCuts, sourceDuration);
    await runTrimConcat(sourcePath, cutPath, {
      keepSegments,
      applyLoudnorm: true,                           // PR #100 (was false; see audioLoudnormConfig above)
      encoderArgs: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '192k'],
    });
    const cutDuration = await getDuration(cutPath);
    steps.cutApply = { ms: Date.now() - stepT };

    // PR #95: per-stream A/V sync gate after cut. Catches a corrupted source
    // or a runTrimConcat regression before the broll/subtitle steps amplify it.
    const streamSync = {};
    streamSync.cut = await verifyMP4StreamSync(cutPath);

    // ── 5b. Face detection on cut.mp4 (PR #114) ────────────────────────
    // OpenCV Haar cascade samples 8 frames of cut.mp4 and returns the median
    // face-center X as a fraction of source width. composeFaceAndBrolls uses
    // this to compute the horizontal crop offset so the speaker stays
    // centered in the 9:16 output instead of being pushed to one edge by
    // the naive center crop. Always resolves — face_detect.js falls back
    // to 0.5 (center) on any failure, so a broken detector never prevents
    // the pipeline from producing a video.
    stepT = stepStart('faceDetect');
    const faceDetectResult = await detectFaceOffsetX(cutPath);
    steps.faceDetect = {
      ms: Date.now() - stepT,
      offsetX: Number(faceDetectResult.offsetX.toFixed(4)),
      source: faceDetectResult.source,
      detail: faceDetectResult.detail,
    };
    console.log(
      `[clean_mode_pipeline:${jobId}] face_detect: offsetX=${faceDetectResult.offsetX.toFixed(4)} ` +
      `(${faceDetectResult.source}; ${faceDetectResult.detail})`,
    );

    // ── Default: cut.mp4 is the input to the next step. Skip flags
    //     reroute below. ─────────────────────────────────────────────
    // Note: `library`, `insertions`, `normalizedInsertions`, `composedSegmentMeta`,
    // and `pickedModel` are hoisted at function scope (PR #103) so the
    // outer catch can return what we have on partial-failure.
    let videoForSubtitles = cutPath;
    let videoForSubtitlesDuration = cutDuration;
    let brollAssetsDownloaded = 0;
    let brollBytesTotal = 0;
    const insertionWarnings = [];         // clamp/dedupe events for response.insertions.warnings

    if (!opts.skipBroll) {
      // ── 6. Library lookup ──────────────────────────────────────────
      stepT = stepStart('libraryLookup');
      // PR #110: fetchBrollLibrary returns {rows, warnings}; the warnings
      // capture URL-class drops (HEIC/HEIF today; future libheif PR removes
      // this) so they reach the response without a separate plumbing step.
      const libraryResult = await fetchBrollLibrary(req.clientId);
      library = libraryResult.rows;
      if (libraryResult.warnings.length > 0) {
        warnings.push(...libraryResult.warnings);
      }
      steps.libraryLookup = { ms: Date.now() - stepT, brollsAvailable: library.length };
      clientLibraryCount = library.length;     // PR-A: snapshot before stock merge (= usable client count)
      // PR-D: capture raw + skipped counts so response.insertions can show
      // the operator why stock dominated (e.g., Phil's 8 raw / 0 usable / 8 HEIC).
      clientLibraryRawCount = libraryResult.rawCount ?? library.length;
      clientLibrarySkippedHeic = libraryResult.droppedHeicCount ?? 0;
      clientLibrarySkippedNoUrl = libraryResult.droppedNoUrlCount ?? 0;

      // ── 6b/6c/6d. PR-A: Pixabay stock b-roll fallback ─────────────────
      // Trigger only when (a) the operator opted in via pixabayEnabled AND
      // (b) the client library is below the coverage threshold (per
      // shouldFetchStock — currently `clientLibrarySize < ceil(durationSec/8)`).
      // Fail-soft: any error along the way (Gemini down, Pixabay 5xx, no
      // results, download fail) → skip Pixabay, warn, continue with the
      // client-only library. The pipeline never fails because of stock issues.
      if (opts.pixabayEnabled && !opts.skipPixabay) {
        const coverage = shouldFetchStock({
          clientLibrarySize: clientLibraryCount,
          durationSec: cutDuration,
        });
        if (!coverage.trigger) {
          steps.stockEval = {
            ms: 0,
            triggered: false,
            reason: coverage.reason,
            target: coverage.target,
            clientLibrarySize: clientLibraryCount,
          };
        } else {
          // 6b. stockKeywordGen (Gemini Pro)
          stepT = stepStart('stockKeywordGen');
          let keywordsResult;
          try {
            // Build a sentence-level transcript for the prompt — same shape
            // the picker receives. Use the post-cut remapped words.
            const remappedWordsForKwGen = remapWordsThroughCuts(word_timestamps, appliedCuts);
            const sentencesForKwGen = wordsToSentences(remappedWordsForKwGen);
            keywordsResult = await generateStockKeywords({
              transcript: sentencesForKwGen,
              clientLibrarySize: clientLibraryCount,
              coverageGap: coverage.gap,
              durationSec: cutDuration,
            }, { model: opts.model });
          } catch (err) {
            keywordsResult = { ok: false, kind: 'upstream', body: err.message };
          }
          steps.stockKeywordGen = {
            ms: Date.now() - stepT,
            ok: keywordsResult.ok,
            kind: keywordsResult.ok ? null : keywordsResult.kind,
            keywords: keywordsResult.ok ? keywordsResult.keywords : [],
          };
          if (!keywordsResult.ok) {
            warnings.push(
              `Pixabay stock fallback skipped: stockKeywordGen ${keywordsResult.kind ?? 'failed'}` +
              (keywordsResult.body ? ` — ${String(keywordsResult.body).slice(0, 120)}` : ''),
            );
          } else {
            stockKeywordsList = keywordsResult.keywords;

            // 6c. stockSearch — fetch Pixabay candidates for each keyword,
            //     download + probe in series until we hit pixabayMaxClips.
            stepT = stepStart('stockSearch');
            const pixabayKey = process.env.PIXABAY_API_KEY?.trim();
            if (!pixabayKey) {
              warnings.push(
                'Pixabay stock fallback skipped: PIXABAY_API_KEY is not set on Railway. ' +
                'Set it to enable Pixabay stock b-roll, or set pixabayEnabled=false to silence this warning.',
              );
              steps.stockSearch = { ms: Date.now() - stepT, reason: 'missing_api_key', hits: 0 };
            } else {
              const stockOutDir = getStockCacheDir(jobId, tmpDir);
              // PR-D: cap stock candidates at the COVERAGE GAP, not the
              // operator-set absolute max. Phil-type cases (8 client, 8 HEIC,
              // 0 usable) still get full pixabayMaxClips fetch because gap
              // equals target. Justine-type cases (full client lib) get gap=0
              // and skip the search entirely (handled by shouldFetchStock).
              // The middle case — 5 usable client + 3 gap — fetches at most 3
              // stock so the picker's library is naturally client-heavy.
              const cap = Math.min(opts.pixabayMaxClips, Math.max(1, coverage.gap));
              const collected = [];
              for (const kw of stockKeywordsList) {
                if (collected.length >= cap) break;
                const remaining = cap - collected.length;
                let searchResult;
                try {
                  searchResult = await searchPixabayVideos({
                    query: kw,
                    perPage: Math.min(5, Math.max(3, remaining)),
                    minDur: 3,
                    maxDur: 60,
                    apiKey: pixabayKey,
                  });
                } catch (err) {
                  searchResult = { ok: false, kind: 'upstream', body: err.message };
                }
                if (!searchResult.ok) {
                  warnings.push(
                    `Pixabay search '${kw}' ${searchResult.kind}` +
                    (searchResult.status ? ` (${searchResult.status})` : ''),
                  );
                  continue;
                }
                for (const hit of searchResult.hits) {
                  if (collected.length >= cap) break;
                  try {
                    const dl = await downloadPixabayVideo({ hit, outDir: stockOutDir });
                    let probe;
                    try {
                      probe = await probeStreams(dl.localPath);
                    } catch (probeErr) {
                      warnings.push(
                        `Pixabay px-video-${hit.id} ffprobe failed: ${probeErr.message ?? probeErr}`,
                      );
                      continue;
                    }
                    collected.push({
                      ...hit,
                      ...dl,
                      searchKeyword: kw,
                      sourceDurSec: probe.container?.duration ?? 0,
                      hasVideo: !!probe.video,
                      hasAudio: !!probe.audio,
                      width: probe.video?.width ?? hit.width,
                      height: probe.video?.height ?? hit.height,
                    });
                  } catch (err) {
                    warnings.push(
                      `Pixabay px-video-${hit.id} download failed: ${err.message ?? err}`,
                    );
                  }
                }
              }
              stockHits = collected;
              steps.stockSearch = {
                ms: Date.now() - stepT,
                hits: stockHits.length,
                cap,
                keywordsUsed: stockKeywordsList.length,
              };

              // 6d. mergeLibrary — concat client + stock so the picker sees both.
              if (stockHits.length > 0) {
                library = mergeStockIntoLibrary(library, stockHits);
                console.log(
                  `[clean_mode_pipeline:${jobId}] stock fallback: ${clientLibraryCount} client + ` +
                  `${stockHits.length} pixabay = ${library.length} merged`,
                );
              }
            }
          }
        }
      }

      if (library.length === 0) {
        warnings.push(`broll_library has 0 rows for client_id=${req.clientId} — skipping broll insertion`);
      }

      if (library.length > 0) {
        // ── 7. Broll picker (Gemini) ─────────────────────────────────
        stepT = stepStart('brollPick');
        const geminiKey = process.env.GEMINI_API_KEY?.trim();
        if (!geminiKey) throw new Error('GEMINI_API_KEY not set on Railway');

        // Validate model is available before burning a generateContent call.
        const availableModels = await getAvailableModels(geminiKey);
        if (!availableModels.includes(opts.model)) {
          throw new Error(`Model '${opts.model}' not available on this Gemini API key`);
        }

        // Build sentence-level transcript for Gemini's prompt — use the
        // REMAPPED words (post-cut timeline) so insertions land at the right
        // moments in cut.mp4 / brolled.mp4.
        const remappedWords = remapWordsThroughCuts(word_timestamps, appliedCuts);
        const sentences = wordsToSentences(remappedWords);

        const pickResult = await pickBrollInsertions({
          transcript: sentences,
          library,
          totalDuration: cutDuration,
          brollDensity: opts.brollDensity,
          model: opts.model,
          apiKey: geminiKey,
        });
        if (!pickResult.ok) {
          throw new Error(`broll picker failed: kind=${pickResult.kind} ${pickResult.body ?? pickResult.message ?? pickResult.error ?? ''}`);
        }
        insertions = pickResult.insertions;
        pickedModel = pickResult.model;
        steps.brollPick = { ms: Date.now() - stepT, insertions: insertions.length, model: pickedModel };

        // ── PR-D: client-first source-balance enforcement ─────────────
        // Tag picker output with provenance from the merged library, then
        // run rebalanceClientFirst to trim excess Pixabay picks if the ratio
        // exceeds BROLL_MAX_STOCK_RATIO (default 0.4). Pre-pick library
        // shaping (cap = coverage.gap above) does most of the work — this
        // is the safety net for the rare case where Gemini still over-picks
        // stock despite the prompt + cap.
        const provenanceByAssetId = new Map(library.map((row) => [row.asset_id, row.provenance ?? 'client']));
        for (const ins of insertions) {
          ins.provenance = provenanceByAssetId.get(ins.asset_id) ?? 'client';
        }
        const maxStockRatio = Number(process.env.BROLL_MAX_STOCK_RATIO ?? 0.4);
        const minClientRatio = Number(process.env.BROLL_MIN_CLIENT_RATIO ?? 0.6);
        const rebalanced = rebalanceClientFirst({
          insertions,
          usableClientCount: clientLibraryCount,
          maxStockRatio,
        });
        if (rebalanced.droppedStockCount > 0) {
          insertionWarnings.push(
            `source-balance: dropped ${rebalanced.droppedStockCount} pixabay pick(s) ` +
            `to enforce client-first ratio (max stock ${maxStockRatio}, ${clientLibraryCount} usable client asset(s)).`,
          );
        }
        insertions = rebalanced.insertions;
        sourceBalanceConfig = {
          mode: 'client_first',
          minClientRatio,
          maxStockRatio,
          enforced: rebalanced.droppedStockCount > 0,
          action: rebalanced.action,
          droppedStockCount: rebalanced.droppedStockCount,
          // Phil-style explanation: when usableClient=0 because of HEIC drops,
          // surface that link explicitly so the operator doesn't have to
          // cross-reference warnings[].
          ...(clientLibraryCount === 0 && clientLibrarySkippedHeic > 0 ? {
            note: `usable client asset count is 0 because ${clientLibrarySkippedHeic} HEIC/HEIF asset(s) were skipped — Pixabay was free to dominate. HEIC→JPG conversion is a tracked follow-up; once it lands, those rows become usable and the client-first rule will engage.`,
          } : {}),
        };

        if (insertions.length > 0) {
          // ── 8. Broll asset downloads (also probes each asset) ─────
          stepT = stepStart('brollDownload');
          const downloads = await downloadBrollAssets(insertions, library, brollDir);
          brollAssetsDownloaded = downloads.length;
          brollBytesTotal = downloads.reduce((s, d) => s + d.bytes, 0);
          steps.brollDownload = {
            ms: Date.now() - stepT,
            brollsFetched: brollAssetsDownloaded,
            totalBytes: brollBytesTotal,
          };

          // ── 8b. PR #95: normalize before compose ──────────────────
          // Sort, clamp to cutDuration, drop overlaps. Defensive against
          // picker drift; warnings get surfaced as insertions.warnings.
          normalizedInsertions = normalizeInsertions(downloads, cutDuration, insertionWarnings);
          if (normalizedInsertions.length === 0 && downloads.length > 0) {
            warnings.push(
              `All ${downloads.length} insertion(s) dropped by normalize step — skipping compose. ` +
              `See insertions.warnings for the cause.`,
            );
          }

          if (normalizedInsertions.length > 0) {
            // ── 9. ffmpeg compose face + brolls ─────────────────────
            // PR #114: pass faceCropOffsetX from the face_detect step so the
            // 1080×1920 fill-crop centers on the speaker's face rather than
            // the geometric center of the source frame.
            stepT = stepStart('compose');
            composedSegmentMeta = await composeFaceAndBrolls({
              facePath: cutPath,
              brolledPath,
              insertions: normalizedInsertions,
              totalDuration: cutDuration,
              faceCropOffsetX: faceDetectResult.offsetX,
            });
            steps.compose = { ms: Date.now() - stepT };

            // PR #95: A/V sync gate on the composed output. THIS is the
            // check that would have caught m2-e2e-004's bug (video stream
            // shorter than audio because broll trims silently shrank).
            streamSync.brolled = await verifyMP4StreamSync(brolledPath);

            videoForSubtitles = brolledPath;
            videoForSubtitlesDuration = await getDuration(brolledPath);
          }
        } else {
          warnings.push('broll picker returned 0 insertions — skipping compose');
        }
      }
    }

    let finalVideoPath = videoForSubtitles;
    // lineCount hoisted at function scope (PR #103)

    // PR-B: when BGM is enabled, subtitle burn writes to finalNoBgm.mp4 and
    // the bgmMix step downstream produces the real final.mp4. When BGM is
    // disabled (default), subtitle burn writes directly to finalPath.
    const bgmActive = opts.bgmEnabled && !opts.skipBgm;
    const subtitleOutputPath = bgmActive ? finalNoBgmPath : finalPath;

    if (!opts.skipSubtitles) {
      // ── 10. Subtitle generation (math-remap + grouping) ─────────────
      stepT = stepStart('subtitleGen');
      const remappedWords = remapWordsThroughCuts(word_timestamps, appliedCuts);
      // Use lib defaults (4 words / 1.8s) — talking-head reel style.
      const lines = groupIntoLines(remappedWords);
      lineCount = lines.length;
      steps.subtitleGen = { ms: Date.now() - stepT };

      // ── 11. ffmpeg burn ─────────────────────────────────────────────
      stepT = stepStart('subtitleBurn');
      const burnResult = await writeAssAndBurn({
        lines,
        assPath,
        inputPath: videoForSubtitles,
        outputPath: subtitleOutputPath,
      });
      steps.subtitleBurn = { ms: Date.now() - stepT };
      const fontWarnings = extractSubtitleWarnings(burnResult.stderr);
      warnings.push(...fontWarnings);
      finalVideoPath = subtitleOutputPath;
    }

    // ── 11b/c/d/e. PR-B: Background music ────────────────────────────
    // Insert music UNDER the speaker's voice with adaptive volume targeting
    // a 14 dB speech-music gap (port from creative-engine PR #106's
    // audio_qc.js). All four steps fail-soft: any error skips BGM,
    // promotes finalNoBgm.mp4 to final.mp4, and continues. Pipeline never
    // fails because of BGM issues.
    if (bgmActive) {
      // ── 11b. bgmSelect (Gemini Pro mood/genre/tempo) ──────────────────
      stepT = stepStart('bgmSelect');
      // Use the same remapped + sentence-grouped transcript shape that
      // broll_picker / stock_keyword_gen consume — keeps prompt input
      // consistent across LLM calls.
      const remappedForBgm = remapWordsThroughCuts(word_timestamps, appliedCuts);
      const sentencesForBgm = wordsToSentences(remappedForBgm);
      const subtitleVideoDur = await getDuration(subtitleOutputPath);
      let selectResult;
      try {
        selectResult = await selectBgm(
          { transcript: sentencesForBgm, durationSec: subtitleVideoDur },
          { model: opts.model },
        );
      } catch (err) {
        selectResult = { ok: false, kind: 'upstream', body: err.message };
      }
      steps.bgmSelect = {
        ms: Date.now() - stepT,
        ok: selectResult.ok,
        ...(selectResult.ok ? {
          mood: selectResult.mood,
          genre: selectResult.genre,
          tempo: selectResult.tempo,
          searchQuery: selectResult.searchQuery,
        } : { kind: selectResult.kind }),
      };

      let bgmLocalPath = null;

      if (!selectResult.ok) {
        bgmSkipReason = `bgm_select_${selectResult.kind}`;
        warnings.push(
          `BGM skipped: bgm_select ${selectResult.kind}` +
          (selectResult.body ? ` — ${String(selectResult.body).slice(0, 120)}` : ''),
        );
      } else {
        // ── 11c. bgmFetch (Jamendo search + download) ─────────────────
        // PR-B2: Pixabay's music API is dead (2026-05-08). Jamendo replaces
        // it as the automated CC-BY BGM source. Filters baked into the helper:
        // vocalinstrumental=instrumental, ccnc=0 (commercial-safe),
        // ccnd=0 (remix-safe — we ARE creating a derivative by mixing).
        // Attribution is required for every CC-BY track and surfaces in
        // response.audio.bgm.track.attributionText.
        stepT = stepStart('bgmFetch');
        const jamendoClientId = process.env.JAMENDO_CLIENT_ID?.trim();
        if (!jamendoClientId) {
          bgmSkipReason = 'bgm_fetch_missing_api_key';
          warnings.push(
            'BGM skipped: JAMENDO_CLIENT_ID is not set on Railway. Jamendo is ' +
            'the BGM source for M2 (PR-B2); set the key or set bgmEnabled=false.',
          );
          steps.bgmFetch = { ms: Date.now() - stepT, ok: false, reason: 'missing_api_key' };
        } else {
          // durationMin = ceil(finalDur * 0.5) — accept tracks at least half
          // the video length; the loop fills the remainder.
          const minDur = Math.ceil(subtitleVideoDur * 0.5);
          let searchResult;
          try {
            searchResult = await searchJamendoMusic({
              query: selectResult.searchQuery,
              limit: 10,
              durationMin: minDur,
              clientId: jamendoClientId,
            });
          } catch (err) {
            searchResult = { ok: false, kind: 'upstream', body: err.message };
          }
          if (!searchResult.ok) {
            bgmSkipReason = `bgm_fetch_${searchResult.kind}`;
            warnings.push(`BGM skipped: jamendo ${searchResult.kind}`);
            steps.bgmFetch = { ms: Date.now() - stepT, ok: false, kind: searchResult.kind };
          } else {
            // Pick the first track (Jamendo orders by popularity_total).
            const pick = searchResult.tracks[0];
            try {
              const dl = await downloadJamendoTrack({ track: pick, outDir: tmpDir });
              bgmLocalPath = dl.localPath;
              bgmTrackMeta = { ...pick, ...dl };
              steps.bgmFetch = { ms: Date.now() - stepT, ok: true, tracks: searchResult.tracks.length, pickedId: pick.id };
            } catch (err) {
              bgmSkipReason = `bgm_fetch_download:${err.message}`;
              warnings.push(`BGM skipped: jamendo download failed — ${err.message}`);
              steps.bgmFetch = { ms: Date.now() - stepT, ok: false, kind: 'download', body: err.message };
            }
          }
        }
      }

      // ── 11d. bgmMix (LUFS measure + adaptive mix) ─────────────────
      let bgmMixMeta = null;
      if (bgmLocalPath) {
        stepT = stepStart('bgmMix');
        try {
          // Measure speech + music LUFS in parallel (PR #106 pattern).
          const [speechLufs, musicLufsRaw] = await Promise.all([
            getLUFS(subtitleOutputPath),
            getLUFS(bgmLocalPath),
          ]);
          if (speechLufs == null || musicLufsRaw == null) {
            throw new Error(
              `LUFS measurement failed: speech=${speechLufs}, music=${musicLufsRaw}`,
            );
          }
          const targetGapDb = Number(process.env.BGM_TARGET_GAP_DB ?? 14);
          const reduction = computeBgmReductionDb({
            speechLufs,
            musicLufsRaw,
            targetGapDb,
            extraReductionDb: opts.bgmVolumeDb,
            volumeFloor: Number(process.env.BGM_VOLUME_FLOOR ?? 0.02),
            volumeCeiling: Number(process.env.BGM_VOLUME_CEILING ?? 1.0),
          });
          const fadeSec = Number(process.env.BGM_FADE_SEC ?? 1.5);
          const mixOut = await mixBgmIntoVideo({
            videoPath: subtitleOutputPath,
            bgmPath: bgmLocalPath,
            outputPath: finalPath,
            videoDurationSec: subtitleVideoDur,
            bgmSourceDurSec: bgmTrackMeta.durationSec ?? subtitleVideoDur,
            volume: reduction.volumeLinear,
            fadeSec,
          });
          bgmApplied = true;
          finalVideoPath = finalPath;
          bgmMixMeta = {
            speechLufs,
            musicLufsRaw,
            musicLufsTarget: reduction.musicLufsTarget,
            targetGapDb,
            appliedVolumeLinear: Number(reduction.volumeLinear.toFixed(4)),
            appliedReductionDb: Number(reduction.appliedReductionDb.toFixed(2)),
            clamped: reduction.clamped,
            loopsApplied: mixOut.loopsApplied,
            fadeSec,
          };
          steps.bgmMix = { ms: Date.now() - stepT, applied: true, ...bgmMixMeta };
        } catch (err) {
          bgmSkipReason = `bgm_mix_threw:${err.message.slice(0, 100)}`;
          warnings.push(`BGM mix failed — falling back to no-music final: ${err.message}`);
          steps.bgmMix = { ms: Date.now() - stepT, applied: false, error: err.message };
          // FALLBACK: copy finalNoBgm → final without mixing.
          try {
            copyFileSync(subtitleOutputPath, finalPath);
            finalVideoPath = finalPath;
          } catch (copyErr) {
            // If even the copy fails, fall through to the streamSync gate
            // which will surface the real problem.
            warnings.push(`Could not copy finalNoBgm to final: ${copyErr.message}`);
          }
        }
      } else if (bgmSkipReason) {
        // BGM was attempted (bgmActive=true) but failed before mix. Promote
        // finalNoBgm.mp4 to final.mp4 so the upload step has the right file.
        try {
          copyFileSync(subtitleOutputPath, finalPath);
          finalVideoPath = finalPath;
        } catch (copyErr) {
          warnings.push(`Could not copy finalNoBgm to final: ${copyErr.message}`);
        }
      }

      // ── 11e. bgmQc (OPTIONAL Pass 2 perceptual QC) ────────────────
      // Only runs if bgmQcEnabled=true AND we successfully mixed. Adds
      // ~5-15s. Failures are non-fatal — pipeline keeps going.
      if (bgmApplied && opts.bgmQcEnabled) {
        stepT = stepStart('bgmQc');
        try {
          const qc = await runBgmAudioQc({ finalPath }, { model: opts.model });
          if (qc.ok) {
            bgmQcResult = {
              model: qc.model,
              speechScore: qc.speechScore,
              verdict: qc.verdict,
              suggestedDbReduction: qc.suggestedDbReduction,
              notes: qc.notes,
            };
            if (qc.verdict !== 'good') {
              warnings.push(
                `BGM perceptual QC verdict=${qc.verdict} (speechScore=${qc.speechScore}, ` +
                `suggested ${qc.suggestedDbReduction} dB extra reduction). Re-run with ` +
                `bgmVolumeDb=${qc.suggestedDbReduction} to apply.`,
              );
            }
          } else {
            warnings.push(`BGM perceptual QC failed: ${qc.kind}`);
          }
          steps.bgmQc = { ms: Date.now() - stepT, ok: qc.ok, ...(qc.ok ? { verdict: qc.verdict, speechScore: qc.speechScore } : { kind: qc.kind }) };
        } catch (err) {
          warnings.push(`BGM perceptual QC threw: ${err.message}`);
          steps.bgmQc = { ms: Date.now() - stepT, ok: false, error: err.message };
        }
      }

      // Build the response.audio.bgm config object (success or skip).
      // PR-B2: track shape reflects the Jamendo source + CC-BY attribution.
      // Operators must surface `attributionText` in the YouTube/Instagram
      // description per CC-BY's "best practices for attribution" guidance.
      bgmConfig = {
        applied: bgmApplied,
        skipped: !bgmApplied,
        skipReason: bgmSkipReason,
        track: bgmTrackMeta ? {
          source: 'jamendo',
          jamendoId: bgmTrackMeta.id,
          name: bgmTrackMeta.name ?? null,
          artistName: bgmTrackMeta.artistName ?? null,
          albumName: bgmTrackMeta.albumName ?? null,
          sourceDurSec: bgmTrackMeta.durationSec ?? null,
          licenseCcUrl: bgmTrackMeta.licenseCcUrl ?? null,
          shareUrl: bgmTrackMeta.shareUrl ?? null,
          audioUrl: bgmTrackMeta.audioUrl ?? null,
          audioDownloadUrl: bgmTrackMeta.audioDownloadUrl ?? null,
          localPath: bgmTrackMeta.localPath ?? null,
          tags: Array.isArray(bgmTrackMeta.tags) ? bgmTrackMeta.tags : [],
          attributionRequired: true,
          attributionText: bgmTrackMeta.attributionText ?? null,
          loopsApplied: bgmMixMeta?.loopsApplied ?? 0,
        } : null,
        mix: bgmMixMeta,
        fadeInSec: bgmMixMeta?.fadeSec ?? null,
        fadeOutSec: bgmMixMeta?.fadeSec ?? null,
        selection: selectResult?.ok ? {
          model: selectResult.model,
          mood: selectResult.mood,
          genre: selectResult.genre,
          instrumentTags: selectResult.instrumentTags,
          tempo: selectResult.tempo,
          searchQuery: selectResult.searchQuery,
        } : null,
        qc: bgmQcResult,
      };
    }

    // ── 11f. PR #95: A/V sync gate on the actual final.mp4 ─────────
    // Runs against finalVideoPath which is either:
    //   - the subtitle-burned video (no BGM path)
    //   - the BGM-mixed video (BGM path; could be the original burned file
    //     if BGM failed and we copied finalNoBgm → final)
    if (!opts.skipSubtitles) {
      streamSync.final = await verifyMP4StreamSync(finalVideoPath);
    }

    // ── 12. Upload final.mp4 ─────────────────────────────────────────
    const outputPath = `${req.output.pathPrefix}${jobId}.mp4`;
    finalStorage = { bucket: req.output.bucket, path: outputPath };
    stepT = stepStart('upload');
    const finalBytes = statSync(finalVideoPath).size;
    await uploadToStorage({
      bucket: req.output.bucket,
      path: outputPath,
      filePath: finalVideoPath,
      contentType: 'video/mp4',
    });
    steps.upload = { ms: Date.now() - stepT, finalBytes };

    // ── 13. Sign URL for response (24h TTL — test convenience only) ──
    finalUrl = await signStorageUrl({
      bucket: req.output.bucket,
      path: outputPath,
      expiresIn: 86_400,
    });

    // ── 14. PR #95: contact sheet for visual b-roll proof ────────────
    // Generate one frame per applied insertion at its midpoint, tile into a
    // single JPG, upload alongside the final MP4. Failure is non-fatal —
    // warnings carry the reason but the job still succeeds.
    // contactSheetUrl hoisted at function scope (PR #103)
    if (composedSegmentMeta.length > 0) {
      stepT = stepStart('contactSheet');
      const csLocal = join(tmpDir, `${jobId}-contact-sheet.jpg`);
      const csResult = await generateContactSheet({
        finalPath: finalVideoPath,
        insertions: normalizedInsertions,
        tmpDir,
        outputPath: csLocal,
      });
      if (csResult.ok) {
        const csStoragePath = `${req.output.pathPrefix}${jobId}-contact-sheet.jpg`;
        try {
          await uploadToStorage({
            bucket: req.output.bucket,
            path: csStoragePath,
            filePath: csLocal,
            contentType: 'image/jpeg',
          });
          contactSheetUrl = await signStorageUrl({
            bucket: req.output.bucket,
            path: csStoragePath,
            expiresIn: 86_400,
          });
          steps.contactSheet = { ms: Date.now() - stepT, frames: csResult.count, bytes: statSync(csLocal).size };
        } catch (err) {
          warnings.push(`contact-sheet upload failed (non-fatal): ${err.message ?? err}`);
          steps.contactSheet = { ms: Date.now() - stepT, error: err.message ?? String(err) };
        }
      } else {
        warnings.push(`contact-sheet generation failed (non-fatal): ${csResult.error}`);
        steps.contactSheet = { ms: Date.now() - stepT, error: csResult.error };
      }
    }

    finalDurationSec = await getDuration(finalVideoPath);

    // PR #95: build insertions.detail by joining the picker's intent (asset
    // metadata + requested window) with composeFaceAndBrolls's segmentMeta
    // (sourceDurSec + actualSegmentDurSec + paddingApplied). Both arrays are
    // keyed by asset_id; the normalized insertions list is the source of truth
    // for which insertions actually made it into the final timeline.
    const segmentMetaById = new Map(composedSegmentMeta.map((m) => [m.asset_id, m]));
    const insertionsDetail = normalizedInsertions.map((ins) => {
      const meta = segmentMetaById.get(ins.asset_id) ?? {};
      return {
        assetId: ins.asset_id,
        assetTitle: ins.assetTitle ?? null,
        assetType: ins.assetType ?? null,
        requestedStartSec: Number(ins.startSec.toFixed(3)),
        requestedEndSec: Number(ins.endSec.toFixed(3)),
        requestedDurSec: Number((ins.endSec - ins.startSec).toFixed(3)),
        sourceDurSec: typeof ins.sourceDurSec === 'number' ? Number(ins.sourceDurSec.toFixed(3)) : null,
        actualSegmentDurSec: meta.actualSegmentDurSec ?? null,
        paddingApplied: meta.paddingApplied ?? null,
        hasVideo: !!ins.hasVideo,
        hasAudio: !!ins.hasAudio,
        width: ins.width ?? 0,
        height: ins.height ?? 0,
        localBytes: ins.bytes ?? 0,
        url: ins.url ?? null,
        // PR-A: client/pixabay provenance + attribution surface.
        source: ins.provenance ?? 'client',
        pixabayPageURL: ins.pixabayPageURL ?? null,
        searchKeyword: ins.searchKeyword ?? null,
      };
    });

    // PR-B2: top-level attribution block aggregates every CC-BY/CC-BY-NC-style
    // credit line the operator must surface in the YouTube/Instagram caption.
    // Currently sourced from the BGM track only; PR-C will fold in stock
    // b-roll attribution as well.
    const attributionEntries = [];
    if (bgmConfig?.applied && bgmConfig.track?.attributionText) {
      attributionEntries.push({
        kind: 'bgm',
        source: bgmConfig.track.source,
        text: bgmConfig.track.attributionText,
        url: bgmConfig.track.shareUrl ?? bgmConfig.track.licenseCcUrl ?? null,
        licenseUrl: bgmConfig.track.licenseCcUrl ?? null,
      });
    }
    attributionConfig = attributionEntries.length > 0
      ? { required: true, entries: attributionEntries }
      : { required: false, entries: [] };

    return {
      jobId,
      finalUrl,
      finalStorage,
      durationSec: Number(finalDurationSec.toFixed(3)),
      inputValidation,                                     // PR #97
      cuts: buildCutsReport(cutResult, totalSecondsRemoved),
      insertions: {
        count: insertionsDetail.length,
        pickedCount: insertions.length,                    // raw picker count (pre-normalize) — drift between this and `count` indicates clamps/overlaps
        model: pickedModel,
        // PR-A: provenance breakdown so the operator can see how the final
        // insertion list split between client library and Pixabay stock.
        clientCount: insertionsDetail.filter((d) => d.source === 'client').length,
        stockCount: insertionsDetail.filter((d) => d.source === 'pixabay').length,
        stockKeywords: stockKeywordsList,
        clientLibrarySize: clientLibraryCount,             // count BEFORE stock merge (= usable client count)
        stockHitsAvailable: stockHits.length,              // # candidates Gemini was offered
        // PR-D: full library accounting so the operator can answer
        // "why did stock dominate?" without cross-referencing warnings[].
        clientLibraryRawCount,                             // BEFORE any filter (e.g., 8 for Phil)
        clientLibraryUsableCount: clientLibraryCount,      // AFTER HEIC + URL filter (e.g., 0 for Phil)
        clientLibrarySkipped: {
          heic: clientLibrarySkippedHeic,                  // HEIC/HEIF dropped by PR #110
          noUrl: clientLibrarySkippedNoUrl,                // missing both file_url + storage_url
        },
        pixabayCandidateCount: stockHits.length,           // alias; matches Shannon's spec wording
        sourceBalance: sourceBalanceConfig,                // null when broll skipped/disabled
        detail: insertionsDetail,
        warnings: insertionWarnings,
      },
      subtitles: {
        lines: lineCount,
      },
      audio: {                                             // PR #100
        loudnorm: audioLoudnormConfig,
        bgm: bgmConfig,                                    // PR-B (null when bgm not enabled)
      },
      attribution: attributionConfig,                      // PR-B2: CC-BY credit surface
      streamSync: {
        cut: streamSync.cut ?? null,
        brolled: streamSync.brolled ?? null,
        final: streamSync.final ?? null,
      },
      contactSheetUrl,
      // PR #101 + #102: read-only diagnostics for cut-tuning investigations.
      //   silenceMap        = raw silencedetect output (every span at
      //                       -35dB / ≥0.6s)
      //   mergedSilenceMap  = silenceMap after PR #102's adjacent-span merge
      //                       (gap ≤ 0.4s collapse). This is what the cut
      //                       detector actually saw as `externalSilences`.
      //   silenceMergeStats = raw-vs-merged counts so an operator can spot
      //                       sources with lots of stumble-pattern merges.
      // Compare against cuts.appliedDetail to see which merged spans became
      // cuts vs which were dropped/skipped.
      diagnostics: {
        silenceMap: silenceMap.map((s) => ({
          startSec: Number(s.start.toFixed(3)),
          endSec: Number(s.end.toFixed(3)),
          durSec: Number((s.end - s.start).toFixed(3)),
        })),
        mergedSilenceMap: mergedSilenceMap.map((s) => ({
          startSec: Number(s.start.toFixed(3)),
          endSec: Number(s.end.toFixed(3)),
          durSec: Number((s.end - s.start).toFixed(3)),
        })),
        silenceMergeStats: {
          rawCount: silenceMap.length,
          mergedCount: mergedSilenceMap.length,
          mergesApplied: silenceMap.length - mergedSilenceMap.length,
          gapTolSec: 0.4,
        },
        silenceDetectSettings: { noiseDb: -35, minDurSec: 0.6 },
      },
      processingMs: Date.now() - startedAt,
      steps,
      warnings,
    };
  } catch (err) {
    // PR #103: partial-data error envelope. The pipeline state mutated
    // up to the throw point is preserved (silenceMap, cuts, insertions,
    // streamSync, etc) and returned alongside the error. The route maps
    // this to an appropriate HTTP status using the `error` field.
    //
    // The response shape mirrors the success shape so a caller can parse
    // it with the same logic (just check for the `error` key).
    const errStep = inferStepFromErrorMessage(err?.message ?? '');
    return {
      jobId,
      error: {
        step: errStep,
        message: err?.message ?? String(err),
      },
      // Partial state — null/empty fields signal "not reached":
      finalUrl: finalUrl ?? null,
      finalStorage,
      durationSec: typeof finalDurationSec === 'number' ? Number(finalDurationSec.toFixed(3)) : null,
      inputValidation,
      cuts: cutResult ? buildCutsReport(cutResult, totalSecondsRemoved) : null,
      insertions: {
        count: composedSegmentMeta.length,
        pickedCount: insertions.length,
        model: pickedModel,
        // PR-A: provenance fields mirror the success path so partial-data
        // responses still tell the operator what was attempted.
        clientLibrarySize: clientLibraryCount,
        stockHitsAvailable: stockHits.length,
        stockKeywords: stockKeywordsList,
        // PR-D: full library accounting + source-balance diagnostics in
        // partial-data path too, so failure responses still explain why
        // stock dominated (e.g., HEIC skips on Phil-style sources).
        clientLibraryRawCount,
        clientLibraryUsableCount: clientLibraryCount,
        clientLibrarySkipped: {
          heic: clientLibrarySkippedHeic,
          noUrl: clientLibrarySkippedNoUrl,
        },
        pixabayCandidateCount: stockHits.length,
        sourceBalance: sourceBalanceConfig,
        detail: normalizedInsertions.map((ins) => {
          const meta = new Map(composedSegmentMeta.map((m) => [m.asset_id, m])).get(ins.asset_id) ?? {};
          return {
            assetId: ins.asset_id,
            assetTitle: ins.assetTitle ?? null,
            assetType: ins.assetType ?? null,
            requestedStartSec: Number(ins.startSec.toFixed(3)),
            requestedEndSec: Number(ins.endSec.toFixed(3)),
            requestedDurSec: Number((ins.endSec - ins.startSec).toFixed(3)),
            sourceDurSec: typeof ins.sourceDurSec === 'number' ? Number(ins.sourceDurSec.toFixed(3)) : null,
            actualSegmentDurSec: meta.actualSegmentDurSec ?? null,
            paddingApplied: meta.paddingApplied ?? null,
            hasVideo: !!ins.hasVideo,
            hasAudio: !!ins.hasAudio,
            width: ins.width ?? 0,
            height: ins.height ?? 0,
            localBytes: ins.bytes ?? 0,
            url: ins.url ?? null,
            source: ins.provenance ?? 'client',
            pixabayPageURL: ins.pixabayPageURL ?? null,
            searchKeyword: ins.searchKeyword ?? null,
          };
        }),
        warnings: insertionWarnings,
      },
      subtitles: { lines: lineCount },
      audio: { loudnorm: audioLoudnormConfig, bgm: bgmConfig },
      attribution: attributionConfig,                      // PR-B2: CC-BY credit surface
      streamSync: {
        cut: streamSync.cut ?? null,
        brolled: streamSync.brolled ?? null,
        final: streamSync.final ?? null,
      },
      contactSheetUrl,
      diagnostics: silenceMap.length === 0 ? null : {
        silenceMap: silenceMap.map((s) => ({
          startSec: Number(s.start.toFixed(3)),
          endSec: Number(s.end.toFixed(3)),
          durSec: Number((s.end - s.start).toFixed(3)),
        })),
        mergedSilenceMap: mergedSilenceMap.map((s) => ({
          startSec: Number(s.start.toFixed(3)),
          endSec: Number(s.end.toFixed(3)),
          durSec: Number((s.end - s.start).toFixed(3)),
        })),
        silenceMergeStats: {
          rawCount: silenceMap.length,
          mergedCount: mergedSilenceMap.length,
          mergesApplied: silenceMap.length - mergedSilenceMap.length,
          gapTolSec: 0.4,
        },
        silenceDetectSettings: { noiseDb: -35, minDurSec: 0.6 },
      },
      processingMs: Date.now() - startedAt,
      steps,
      warnings,
    };
  } finally {
    // Always clean up /tmp/<jobId> regardless of success/failure
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * PR #103: classify a thrown error message into a pipeline step name.
 * Same patterns the route used to use; centralized here so the catch can
 * tag the partial response with `error.step` directly.
 */
function inferStepFromErrorMessage(message) {
  if (/Supabase download/i.test(message)) return 'download';
  if (/silencedetect/i.test(message)) return 'silenceDetect';
  if (/Deepgram/.test(message) || /Scribe/.test(message)) return 'transcribe';
  if (/A\/V sync check failed.*cut\.mp4/i.test(message)) return 'cutApply';
  if (/A\/V sync check failed.*brolled\.mp4/i.test(message)) return 'compose';
  if (/A\/V sync check failed.*final\.mp4/i.test(message)) return 'subtitleBurn';
  if (/cuts cover the entire source/i.test(message)) return 'cutApply';
  if (/broll_library lookup/i.test(message)) return 'libraryLookup';
  if (/broll picker failed/i.test(message)) return 'brollPick';
  if (/Broll download/i.test(message) || /no file_url|neither file_url nor storage_url/i.test(message)) return 'brollDownload';
  if (/composeFaceAndBrolls/i.test(message) || /ffmpeg compose/i.test(message)) return 'compose';
  if (/subtitles burn|libass|ffmpeg .* burn/i.test(message)) return 'subtitleBurn';
  if (/Supabase upload/i.test(message)) return 'upload';
  if (/Supabase sign/i.test(message)) return 'sign';
  return 'pipeline';
}

// ── Helpers (private to this module) ────────────────────────────────────

/**
 * PR #102: collapse adjacent silence spans into single spans when the gap
 * between them is ≤ `gapTolSec` (default 0.4s). The cut detector treats
 * each silence span independently — when a long pause is broken by a tiny
 * speech blip (e.g., a 0.06s utterance like "um", "the", "uh" between two
 * 2s+ silences), the detector ends up classifying each silence as its own
 * potential cut and the safety classifier may drop the second one because
 * the prevWord is now the blip word instead of the actual prior sentence.
 *
 * Pre-merging at the orchestrator level gives the detector cleaner input —
 * one continuous span instead of two — without changing any of the
 * detector's tuning (silencedetect threshold, minGapSec, mid-sentence
 * thresholds all stay the same).
 *
 * Uses 0.4s as the conservative tolerance: long enough to catch stumble
 * patterns ("trailing-off → resume → stops again") but short enough that
 * deliberate beats between sentences don't get merged.
 *
 * Pure function. Exported for testing.
 *
 * @param {Array<{ start: number, end: number }>} spans  in source-time seconds
 * @param {number} [gapTolSec=0.4]
 * @returns {Array<{ start: number, end: number }>}
 */
export function mergeAdjacentSilences(spans, gapTolSec = 0.4) {
  if (!Array.isArray(spans) || spans.length === 0) return [];
  const sorted = [...spans]
    .filter((s) => s && typeof s.start === 'number' && typeof s.end === 'number' && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end <= gapTolSec) {
      last.end = Math.max(last.end, s.end);
    } else {
      merged.push({ start: s.start, end: s.end });
    }
  }
  return merged;
}


/**
 * Bucket a classified cut into a category for the operator-facing report.
 * Buckets are derived from `reason` markers (set by the cut detector) plus
 * the `category` field; precedence matches the order detected cuts are
 * emitted, so a slate cut isn't misfiled as a generic leading silence.
 *
 *   slate           — reason starts with `slate_intro:` (deterministic detector)
 *   cameraShutoff   — reason starts with `camera_shutoff:` (post-content trim)
 *   leadingSilence  — silence cut whose reason includes `(leading)`
 *   trailingSilence — silence cut whose reason includes `(trailing)`
 *   deadAir         — any other silence cut (inter-word gap, mid-sentence pause, audio span)
 *   filler          — category=filler (um/uh/etc)
 *   repeat          — category=repeat_word
 *   badTake         — category=bad_take (verbal restart marker OR silent-restart n-gram)
 *   other           — anything that didn't match the above (shouldn't happen with current detector)
 */
export function bucketCut(c) {
  const reason = c.reason ?? '';
  if (reason.startsWith('slate_intro')) return 'slate';
  if (reason.startsWith('camera_shutoff')) return 'cameraShutoff';
  if (c.category === 'silence' && reason.includes('(leading)')) return 'leadingSilence';
  if (c.category === 'silence' && reason.includes('(trailing)')) return 'trailingSilence';
  if (c.category === 'silence') return 'deadAir';
  if (c.category === 'filler') return 'filler';
  if (c.category === 'repeat_word') return 'repeat';
  if (c.category === 'bad_take') return 'badTake';
  return 'other';
}

/**
 * Render one classified cut for the operator-facing report. Times are
 * rounded to 3dp to keep the JSON readable; safety + reason are passed
 * through so the operator can see exactly why a cut was applied or skipped.
 */
function renderCut(c) {
  return {
    startSec: Number(c.start.toFixed(3)),
    endSec: Number(c.end.toFixed(3)),
    durSec: Number((c.end - c.start).toFixed(3)),
    category: c.category,
    bucket: bucketCut(c),
    reason: c.reason,
    safety: c.safety,
    safetyReason: c.safetyReason,
    contextBefore: c.contextBefore,
    contextAfter: c.contextAfter,
  };
}

/**
 * Build the enriched `cuts` block for the response. Keeps the existing
 * summary fields (applied, skipped, secondsRemoved) for backwards
 * compatibility, and adds:
 *   - byCategory: per-bucket counts across applied AND skipped cuts
 *   - applied: detailed array of applied cuts
 *   - skipped: detailed array of skipped cuts (with safetyReason explaining why)
 *   - slate: { detected, startSec, endSec } if a slate cut was applied
 *   - cameraShutoff: { detected, startSec, endSec } if a camera-shutoff cut was applied
 */
export function buildCutsReport(cutResult, totalSecondsRemoved) {
  const applied = cutResult.applied.map(renderCut);
  const skipped = cutResult.skipped.map(renderCut);

  const byCategory = {
    slate: 0, cameraShutoff: 0,
    leadingSilence: 0, trailingSilence: 0, deadAir: 0,
    filler: 0, repeat: 0, badTake: 0, other: 0,
  };
  for (const c of applied) byCategory[c.bucket] = (byCategory[c.bucket] ?? 0) + 1;
  // skipped per-bucket too — nested so callers can tell applied vs skipped breakdown
  const byCategorySkipped = {
    slate: 0, cameraShutoff: 0,
    leadingSilence: 0, trailingSilence: 0, deadAir: 0,
    filler: 0, repeat: 0, badTake: 0, other: 0,
  };
  for (const c of skipped) byCategorySkipped[c.bucket] = (byCategorySkipped[c.bucket] ?? 0) + 1;

  // Slate / camera-shutoff convenience fields — at most one of each can be applied.
  const slateApplied = applied.find((c) => c.bucket === 'slate');
  const shutoffApplied = applied.find((c) => c.bucket === 'cameraShutoff');

  return {
    // Backwards-compat summary
    applied: cutResult.applied.length,
    skipped: cutResult.skipped.length,
    secondsRemoved: Number(totalSecondsRemoved.toFixed(3)),
    // Enriched detail
    byCategory: { applied: byCategory, skipped: byCategorySkipped },
    appliedDetail: applied,
    skippedDetail: skipped,
    slate: slateApplied
      ? { detected: true, startSec: slateApplied.startSec, endSec: slateApplied.endSec, reason: slateApplied.reason }
      : { detected: false },
    cameraShutoff: shutoffApplied
      ? { detected: true, startSec: shutoffApplied.startSec, endSec: shutoffApplied.endSec, reason: shutoffApplied.reason }
      : { detected: false },
  };
}

/**
 * Group word timestamps into sentence-level entries for Gemini's prompt.
 * Same algorithm as creative-engine/scripts/add_brolls.ts:wordsToSentences,
 * but operates on the canonical { word, start_ms, end_ms } shape.
 */
function wordsToSentences(words) {
  const PUNCT_END = /[.!?]$/;
  const out = [];
  let buf = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    buf.push(w);
    const next = words[i + 1];
    if (!next || PUNCT_END.test(w.word)) {
      out.push({
        startSec: buf[0].start_ms / 1000,
        endSec: buf[buf.length - 1].end_ms / 1000,
        text: buf.map((b) => b.word).join(' '),
      });
      buf = [];
    }
  }
  return out;
}

/**
 * PR #97: lowercase + alphanumeric-only slug. Pure function, exported for
 * testing.
 *
 *   "Justine"                     → "justine"
 *   "Chelsea & Phil | EnableSNP"  → "chelsea-phil-enablesnp"
 *   "Joe Sebestyen | SupportED Tutoring" → "joe-sebestyen-supported-tutoring"
 *   "  Hello   World!! "          → "hello-world"
 *
 * Mirrors the convention used for storage path slugs (e.g.
 * `client-uploads/justine-cyborg-va/...`) so we can compare apples to apples.
 *
 * @param {string} str
 * @returns {string}
 */
export function slugify(str) {
  return String(str ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * PR #97: leading folder names that say nothing about which client a file
 * belongs to. When the path slug is one of these, we can't validate the
 * pairing — emit `match: 'unverifiable'` and skip the check.
 */
const GENERIC_PATH_PREFIXES = new Set([
  'uploads', 'test', 'tests', 'shared', 'tmp',
  'media-uploads', 'outputs', 'public', 'staging',
]);

/**
 * PR #97: cross-check the sourceMP4 path's leading folder against the
 * client_name resolved from `marketing.client_content_config`. M2 test mode
 * accepts manual `clientId` from the caller, which lets a wrong-client
 * pairing slip through (e.g. m2-e2e-002→004 ran Phil's footage with
 * Justine's clientId — pipeline succeeded but Justine's brolls were applied
 * to Phil's audio).
 *
 * **WARNING-ONLY**: never throws on mismatch. The caller (orchestrator) maps
 * each match outcome to a `warnings.push()` line. Failure to resolve the
 * client_id (DB lookup error, missing row) returns `match: 'unknown'`
 * rather than throwing — we don't want this gate to take down a job over a
 * sanity-check feature.
 *
 * Match levels:
 *   'ok'           — pathSlug exact-equals OR contains OR is contained by expectedSlug
 *   'unverifiable' — pathSlug is a generic prefix (uploads/test/tmp/etc)
 *   'unknown'      — couldn't resolve clientId or extract pathSlug
 *   'mismatch'     — both slugs known and unrelated
 *
 * Returns the full envelope so the orchestrator can surface it under
 * `inputValidation` in the response.
 *
 * @param {Object} args
 * @param {{ bucket: string, path: string }} args.sourceMP4
 * @param {string} args.clientId
 * @returns {Promise<{
 *   sourceMP4: { bucket: string, path: string },
 *   clientId: string,
 *   pathSlug: string | null,
 *   clientName: string | null,
 *   expectedSlug: string | null,
 *   match: 'ok' | 'unverifiable' | 'unknown' | 'mismatch',
 *   reason?: string,
 * }>}
 */
async function validateSourcePairing({ sourceMP4, clientId }) {
  const envelope = {
    sourceMP4: { bucket: sourceMP4.bucket, path: sourceMP4.path },
    clientId,
    pathSlug: null,
    clientName: null,
    expectedSlug: null,
    match: 'unknown',
  };
  const rawPathSlug = sourceMP4?.path?.split('/')?.[0];
  const pathSlug = rawPathSlug ? rawPathSlug.toLowerCase() : null;
  envelope.pathSlug = pathSlug;

  // Resolve client_name from marketing.client_content_config. Use the same
  // service-role REST + Accept-Profile pattern as fetchBrollLibrary so
  // there's only one auth/url contract to maintain.
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)?.trim();
  if (!url) {
    return { ...envelope, match: 'unknown', reason: 'SUPABASE_URL not set on worker' };
  }
  if (!key) {
    return { ...envelope, match: 'unknown', reason: 'SUPABASE_SERVICE_ROLE_KEY not set on worker' };
  }
  let res;
  try {
    res = await axios.get(
      `${url.replace(/\/$/, '')}/rest/v1/client_content_config` +
      `?client_id=eq.${encodeURIComponent(clientId)}&select=client_name`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Accept-Profile': 'marketing',
        },
        timeout: 30_000,
        validateStatus: () => true,
      },
    );
  } catch (err) {
    return { ...envelope, match: 'unknown', reason: `client_content_config lookup error: ${err.message ?? err}` };
  }
  if (res.status < 200 || res.status >= 300) {
    return {
      ...envelope,
      match: 'unknown',
      reason: `client_content_config lookup ${res.status}`,
    };
  }
  if (!Array.isArray(res.data) || res.data.length === 0) {
    return {
      ...envelope,
      match: 'unknown',
      reason: `client_id ${clientId} not found in marketing.client_content_config`,
    };
  }
  const clientName = res.data[0].client_name ?? null;
  const expectedSlug = clientName ? slugify(clientName) : null;
  envelope.clientName = clientName;
  envelope.expectedSlug = expectedSlug;

  if (!pathSlug) {
    return { ...envelope, match: 'unknown', reason: 'sourceMP4.path has no leading segment' };
  }
  if (!expectedSlug) {
    return { ...envelope, match: 'unknown', reason: 'client_content_config row has empty client_name' };
  }
  if (
    pathSlug === expectedSlug ||
    pathSlug.includes(expectedSlug) ||
    expectedSlug.includes(pathSlug)
  ) {
    return { ...envelope, match: 'ok' };
  }
  if (GENERIC_PATH_PREFIXES.has(pathSlug)) {
    return { ...envelope, match: 'unverifiable', reason: `generic path prefix '${pathSlug}'` };
  }
  return { ...envelope, match: 'mismatch' };
}

/**
 * Query marketing.broll_library for the given client_id via Supabase REST.
 * Uses Accept-Profile: marketing (existing pattern from routes/classify.js).
 *
 * Returns BrollRow[] in the shape lib/broll_picker expects (asset_id +
 * metadata fields). Both `file_url` and `storage_url` are included for the
 * download step — `file_url` is the legacy/manual upload column, but the
 * standard portal_assets_sync flow populates `storage_url` (a public
 * `video-modules/broll/<client_id>/...` Supabase URL). Most production rows
 * have `storage_url` populated and `file_url` null.
 *
 * **Filter (M2 hardening):** Rows where BOTH `file_url` and `storage_url`
 * are null are dropped before returning — these are typically Drive-only
 * assets that haven't been uploaded to Storage yet. M2 doesn't resolve
 * Drive OAuth, so the worker has no way to download them. Without this
 * filter, Gemini's picker (running at temperature 0.5) randomly selects
 * such rows ~5% of the time per pick, causing ~25% of full-pipeline jobs
 * to fail at brollDownload. Filtering up front gives Gemini only assets
 * the worker can actually fetch.
 *
 * **HEIC/HEIF filter (PR #110):** After the URL-presence filter, rows whose
 * effective URL ends in `.heic` or `.heif` are dropped via
 * `filterUnsupportedBrollAssets` (lib/broll_filter.js). The worker can
 * download HEIC bytes but ffprobe and the static-image broll path don't
 * understand the container, so they crash at the probe step. Phil/Chelsea
 * & Phil's library on 2026-05-08 was a mix of 6 `.mov` videos + 7 `.heic`
 * iPhone photos — without this filter, Gemini picks an HEIC ~50% of the
 * time and B7 dies. Returns `{rows, warnings}` so the orchestrator can
 * surface the dropped-count warning in the response. Follow-up: add
 * libheif/imagemagick + HEIC→JPG conversion at brollDownload to recover
 * the dropped assets.
 *
 * @returns {Promise<{rows: Array<object>, warnings: string[]}>}
 */
async function fetchBrollLibrary(clientId) {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)?.trim();
  if (!url) throw new Error('SUPABASE_URL is not set');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  const select = [
    'id', 'asset_title', 'asset_type', 'content_strategy_type',
    'context', 'emotion', 'insight', 'when_to_use',
    'file_url', 'storage_url', 'drive_file_id',
  ].join(',');
  const queryUrl = `${url.replace(/\/$/, '')}/rest/v1/broll_library?client_id=eq.${encodeURIComponent(clientId)}&select=${select}`;
  const res = await axios.get(queryUrl, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Accept-Profile': 'marketing',
    },
    timeout: 30_000,
    validateStatus: () => true,
  });
  if (res.status < 200 || res.status >= 300) {
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data).slice(0, 500);
    throw new Error(`broll_library lookup ${res.status}: ${body}`);
  }
  const rawRows = res.data ?? [];
  // Drop rows the worker can't download (no Drive OAuth in M2).
  const usableRows = rawRows.filter((row) => row.file_url || row.storage_url);
  const droppedNoUrlCount = rawRows.length - usableRows.length;
  if (droppedNoUrlCount > 0) {
    console.log(
      `[clean_mode_pipeline] broll_library: ${rawRows.length} rows for client=${clientId}, ` +
      `${droppedNoUrlCount} dropped (no file_url and no storage_url), ${usableRows.length} usable`,
    );
  }

  // PR #110: drop HEIC/HEIF assets the worker can't process today (ffprobe
  // doesn't understand the container; static-image broll path crashes at
  // probe). Surfaces a warning so the operator can see why the library
  // shrank. Tracked follow-up: libheif/imagemagick + HEIC→JPG conversion
  // at brollDownload to recover these assets.
  const filtered = filterUnsupportedBrollAssets(usableRows);
  if (filtered.droppedHeicCount > 0) {
    console.log(
      `[clean_mode_pipeline] broll_library: dropped ${filtered.droppedHeicCount} HEIC/HEIF row(s) ` +
      `for client=${clientId}, ${filtered.rows.length} remain`,
    );
  }

  // Map db `id` → asset_id for broll_picker compatibility.
  // PR-A: tag rows with provenance='client' so the orchestrator can
  // distinguish them from Pixabay-stock rows after merge.
  const mapped = filtered.rows.map((row) => ({
    asset_id: row.id,
    asset_title: row.asset_title,
    asset_type: row.asset_type,
    content_strategy_type: row.content_strategy_type,
    context: row.context,
    emotion: row.emotion,
    insight: row.insight,
    when_to_use: row.when_to_use,
    file_url: row.file_url,
    storage_url: row.storage_url,
    drive_file_id: row.drive_file_id,
    provenance: 'client',
  }));

  return {
    rows: mapped,
    warnings: filtered.warnings,
    // PR-D: surface raw vs usable vs dropped counts so the orchestrator can
    // populate response.insertions.clientLibrary{Raw,Usable,Skipped} for the
    // operator. Phil's case (8 raw, 8 HEIC dropped, 0 usable) is the canonical
    // example where "stock dominated" needs to be visibly tied to HEIC.
    rawCount: rawRows.length,
    droppedNoUrlCount,
    droppedHeicCount: filtered.droppedHeicCount,
    usableCount: mapped.length,
  };
}

/**
 * Download every broll referenced by the insertions list AND probe each one
 * with ffprobe so the compose step knows the asset's source duration up-front
 * (PR #95: that's what enables the loop-vs-trim dispatch — see
 * composeFaceAndBrolls). Resolves the download URL with
 * `file_url ?? storage_url` — `file_url` (legacy/manual upload column) is
 * preferred when present, but the synced-asset flow populates `storage_url`
 * instead. Errors out clearly if a row has neither (drive_file_id-only —
 * M2 doesn't resolve Drive OAuth).
 *
 * Returns a list parallel to insertions, each carrying:
 *   { ...originalInsertion, localPath, bytes, url,
 *     assetTitle, assetType,
 *     sourceDurSec, hasVideo, hasAudio, width, height }
 */
// Exported for unit tests (PR-A) — see test/download_broll_assets.test.js.
// Production callers reach it via runCleanModePipeline only.
export async function downloadBrollAssets(insertions, library, brollDir) {
  const libById = new Map(library.map((r) => [r.asset_id, r]));
  const out = [];
  for (const ins of insertions) {
    const row = libById.get(ins.asset_id);
    if (!row) {
      throw new Error(`Insertion references unknown asset_id=${ins.asset_id} (not in library)`);
    }

    // PR-A short-circuit: stock rows from Pixabay are pre-downloaded + pre-probed
    // by the orchestrator's stockSearch step (lib/pixabay_video.js +
    // probeStreams). When `row.localPath` is present, skip the axios fetch and
    // reuse the cached probe data — no second download, no second probe.
    if (row.localPath) {
      out.push({
        ...ins,
        localPath: row.localPath,
        bytes: 0,                          // not tracked for stock; cosmetic field
        url: row.file_url ?? null,
        assetTitle: row.asset_title ?? null,
        assetType: row.asset_type ?? null,
        sourceDurSec: typeof row.sourceDurSec === 'number' ? row.sourceDurSec : 0,
        hasVideo: row.hasVideo === true,
        hasAudio: row.hasAudio === true,
        width: typeof row.width === 'number' ? row.width : 0,
        height: typeof row.height === 'number' ? row.height : 0,
        // Surface provenance so the response can label client vs pixabay.
        provenance: row.provenance ?? 'client',
        pixabayPageURL: row.pixabayPageURL ?? null,
        searchKeyword: row.searchKeyword ?? null,
      });
      continue;
    }

    const downloadUrl = row.file_url ?? row.storage_url;
    if (!downloadUrl) {
      throw new Error(
        `Broll ${ins.asset_id} has neither file_url nor storage_url. Run portal_assets_sync first (drive_file_id alone is not supported in M2).`,
      );
    }
    const ext = (extname(new URL(downloadUrl).pathname) || '.mp4').toLowerCase();
    const localPath = join(brollDir, `${ins.asset_id}${ext}`);
    const res = await axios.get(downloadUrl, {
      responseType: 'stream',
      timeout: 180_000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      const chunks = [];
      for await (const chunk of res.data) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8').slice(0, 300);
      throw new Error(`Broll download ${res.status} for ${downloadUrl}: ${body}`);
    }
    await pipeline(res.data, createWriteStream(localPath));
    const bytes = statSync(localPath).size;
    // Probe the asset so compose can dispatch trim-vs-loop based on real
    // duration. probeStreams handles missing/unparseable streams gracefully.
    let probe;
    try {
      probe = await probeStreams(localPath);
    } catch (err) {
      throw new Error(`ffprobe failed on broll ${ins.asset_id} (${localPath}): ${err.message ?? err}`);
    }
    out.push({
      ...ins,
      localPath,
      bytes,
      url: downloadUrl,
      assetTitle: row.asset_title ?? null,
      assetType: row.asset_type ?? null,
      sourceDurSec: probe.container.duration,
      hasVideo: !!probe.video,
      hasAudio: !!probe.audio,
      width: probe.video?.width ?? 0,
      height: probe.video?.height ?? 0,
      // PR-A: provenance defaults to 'client' for rows without an explicit
      // tag (legacy/library) and to whatever fetchBrollLibrary set for new rows.
      provenance: row.provenance ?? 'client',
      pixabayPageURL: row.pixabayPageURL ?? null,
      searchKeyword: row.searchKeyword ?? null,
    });
  }
  return out;
}

/**
 * Sort, clamp, and dedupe broll insertions before they reach the compose step.
 * Defensive — Gemini's picker is asked not to overlap, but the response shape
 * doesn't enforce it and we'd rather drop overlaps cleanly than let them
 * desync the timeline.
 *
 * Steps:
 *   1. Drop rows whose clamped window is empty (start ≥ end after clamping
 *      to [0, cutDuration]).
 *   2. Push a warning when an endSec is clamped down (means the picker chose
 *      a window past the end of the cut video).
 *   3. Sort by startSec.
 *   4. For overlapping pairs, keep the earlier insertion and drop the later
 *      one (warn). Earlier-wins because it usually has tighter prosody to
 *      the moment Gemini chose it for.
 *
 * Returns the cleaned list. Warnings are pushed into the caller-provided
 * `warnings` array (mutated).
 *
 * @param {Array<{ startSec, endSec, asset_id, ... }>} rawInsertions
 * @param {number} cutDuration  the source-of-truth video timeline length
 * @param {string[]} warnings   mutated: clamp/dedupe events appended here
 * @returns {Array}  same shape, sorted + clamped + non-overlapping
 */
export function normalizeInsertions(rawInsertions, cutDuration, warnings) {
  if (!Array.isArray(rawInsertions)) return [];
  const clamped = [];
  for (const ins of rawInsertions) {
    const rawStart = typeof ins?.startSec === 'number' ? ins.startSec : NaN;
    const rawEnd = typeof ins?.endSec === 'number' ? ins.endSec : NaN;
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      warnings.push(`Insertion ${ins?.asset_id ?? '(no id)'}: non-numeric start/end — dropped`);
      continue;
    }
    const start = Math.max(0, rawStart);
    const end = Math.min(cutDuration, rawEnd);
    if (end <= start) {
      warnings.push(
        `Insertion ${ins.asset_id}: window [${rawStart.toFixed(3)}, ${rawEnd.toFixed(3)}] empty after clamp — dropped`,
      );
      continue;
    }
    if (rawEnd > cutDuration + 0.001) {
      warnings.push(
        `Insertion ${ins.asset_id}: clamped endSec ${rawEnd.toFixed(3)}s → ${cutDuration.toFixed(3)}s ` +
        `(picker chose a window past the cut-video end)`,
      );
    }
    clamped.push({ ...ins, startSec: start, endSec: end });
  }
  clamped.sort((a, b) => a.startSec - b.startSec);
  // Dedupe overlaps — keep first, drop later.
  const out = [];
  for (const ins of clamped) {
    const prev = out[out.length - 1];
    if (prev && ins.startSec < prev.endSec - 0.001) {
      warnings.push(
        `Insertion ${ins.asset_id} (${ins.startSec.toFixed(3)}-${ins.endSec.toFixed(3)}) overlaps with ` +
        `${prev.asset_id} (${prev.startSec.toFixed(3)}-${prev.endSec.toFixed(3)}) — dropped`,
      );
      continue;
    }
    out.push(ins);
  }
  return out;
}

/**
 * Verify per-stream durations of an MP4 are within tolerance. Catches the
 * exact failure mode that broke `m2-e2e-004`: ffmpeg's compose silently
 * producing a video stream shorter than the audio because broll inputs were
 * shorter than the requested insertion duration.
 *
 * On mismatch, throws with all three durations in the message so the route's
 * error envelope surfaces them. On success, returns the durations so the
 * orchestrator can attach them to `streamSync.<step>` in the response.
 *
 * **Tolerance: 200ms (PR #104).** Originally 100ms (PR #95) but real-world
 * ffmpeg trim+concat on a ~100s talking-head with 12+ cuts plus loudnorm
 * (PR #100) plus HEVC decode produces ~100-150ms of accumulated frame-
 * boundary drift that's imperceptible to viewers (~3 frames at 25fps,
 * well under the human ~250ms perception threshold for talking-head
 * dialogue). 200ms preserves the original protection — m2-e2e-004's bug
 * was 1+ seconds of drift, still caught loudly — while not false-positiving
 * on healthy ffmpeg output. PR #104 confirmed via PR #103 partial-data
 * envelope showing 133ms drift on cut.mp4 with no actual quality issue.
 *
 * @param {string} filePath
 * @param {Object} [opts]
 * @param {number} [opts.toleranceSec=0.2]
 * @returns {Promise<{ videoSec: number, audioSec: number, containerSec: number, withinTolerance: true }>}
 */
async function verifyMP4StreamSync(filePath, opts = {}) {
  const toleranceSec = typeof opts.toleranceSec === 'number' ? opts.toleranceSec : 0.2;
  const probe = await probeStreams(filePath);
  const v = probe.video?.duration;
  const a = probe.audio?.duration;
  const c = probe.container.duration;
  if (v == null) {
    throw new Error(`verifyMP4StreamSync: ${filePath} has no video stream`);
  }
  if (a == null) {
    throw new Error(`verifyMP4StreamSync: ${filePath} has no audio stream`);
  }
  const va = Math.abs(v - a);
  const vc = Math.abs(v - c);
  const ac = Math.abs(a - c);
  if (va > toleranceSec || vc > toleranceSec || ac > toleranceSec) {
    throw new Error(
      `A/V sync check failed on ${filePath}: ` +
      `video=${v.toFixed(3)}s audio=${a.toFixed(3)}s container=${c.toFixed(3)}s ` +
      `(|video-audio|=${va.toFixed(3)}s, |video-container|=${vc.toFixed(3)}s, ` +
      `|audio-container|=${ac.toFixed(3)}s, tolerance=${toleranceSec}s)`,
    );
  }
  return {
    videoSec: Number(v.toFixed(3)),
    audioSec: Number(a.toFixed(3)),
    containerSec: Number(c.toFixed(3)),
    withinTolerance: true,
  };
}

/**
 * Build a contact-sheet JPG showing one frame per applied b-roll insertion
 * at its midpoint. Used as **independent visual proof** that broll segments
 * actually appear in the final MP4 — the response's `insertions.count` is
 * not enough on its own (m2-e2e-004 reported 5 insertions but most were
 * 0.1s flashes invisible on playback).
 *
 * Strategy: extract one JPG per midpoint (fast — single-frame -ss seek),
 * then tile with ffmpeg's `tile` filter into a single image.
 *
 * Failure mode: if extraction or tiling fails, return null. The caller should
 * push a warning but NOT fail the job — this is a debug artifact, not a
 * primary output.
 *
 * @param {Object} args
 * @param {string} args.finalPath        the captioned final MP4 on disk
 * @param {Array<{ startSec, endSec, asset_id }>} args.insertions  applied insertions in final-timeline coordinates
 * @param {string} args.tmpDir           per-job tmp dir for intermediate frames
 * @param {string} args.outputPath       where to write the contact-sheet JPG
 * @returns {Promise<{ ok: true, path: string, count: number } | { ok: false, error: string }>}
 */
async function generateContactSheet({ finalPath, insertions, tmpDir, outputPath }) {
  if (!Array.isArray(insertions) || insertions.length === 0) {
    return { ok: false, error: 'no insertions to contact-sheet' };
  }
  try {
    const framePaths = [];
    for (let i = 0; i < insertions.length; i++) {
      const ins = insertions[i];
      const mid = (ins.startSec + ins.endSec) / 2;
      const framePath = join(tmpDir, `cs-frame-${String(i).padStart(3, '0')}.jpg`);
      // -ss before -i = fast seek to nearest keyframe; close enough for a
      // contact-sheet thumbnail. -frames:v 1 grabs one frame and stops.
      // -q:v 3 = decent JPG quality (2 = best, 31 = worst).
      await execAsync(
        `ffmpeg -y -ss ${mid.toFixed(3)} -i "${finalPath}" -frames:v 1 -q:v 3 ` +
        `-vf "scale=270:480:force_original_aspect_ratio=decrease,pad=270:480:(ow-iw)/2:(oh-ih)/2" ` +
        `"${framePath}"`,
        { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
      );
      if (!statSync(framePath).size) {
        throw new Error(`frame extraction at t=${mid.toFixed(3)}s produced empty file`);
      }
      framePaths.push(framePath);
    }
    // Tile horizontally — N frames in a single row keeps it simple and the
    // JPG tall+narrow-friendly even for long videos with many insertions.
    const inputs = framePaths.map((p) => `-i "${p}"`).join(' ');
    const tileFilter = `tile=${framePaths.length}x1`;
    await execAsync(
      `ffmpeg -y ${inputs} -filter_complex "${tileFilter}" -frames:v 1 -q:v 3 "${outputPath}"`,
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
    );
    if (!statSync(outputPath).size) {
      throw new Error('tile output empty');
    }
    return { ok: true, path: outputPath, count: framePaths.length };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * ffmpeg compose: full-screen broll replacement during selected windows,
 * face audio passthrough across the entire timeline.
 *
 * **PR #95 — duration enforcement:** every broll segment is guaranteed to
 * equal its requested duration regardless of source asset length. The fix
 * dispatches per-segment based on probed `sourceDurSec`:
 *   - asset_dur >= dur  → trim only (`paddingApplied: 'trim'`)
 *   - asset_dur < dur   → loop=loop=-1 then trim (`paddingApplied: 'loop'`)
 *
 * **PR #111 — fill-crop reframing:** both face and broll segments are scaled
 * with `force_original_aspect_ratio=increase` then center-cropped to exactly
 * 1080×1920. This fills the entire 9:16 vertical canvas with picture content
 * — no letterbox bars, no empty background — even when the source is
 * landscape (1920×1080). Replaces the prior `decrease,pad=...` approach that
 * left ~656px of black at top and bottom for landscape talking-head sources
 * (Phil B7 frame at 5s on 2026-05-08 confirmed the letterbox).
 *
 * Trade-off: center-crop assumes the speaker is roughly centered horizontally
 * in their landscape recording. Off-center speakers would get partially
 * cropped. Phil + Justine both shoot centered, so the simple center-crop is
 * safe today. Tracked follow-up: face-detect-aware crop offset using OpenCV
 * (already in the Dockerfile) for future clients with off-center framing.
 *
 * The contact-sheet thumbnail filter at `buildContactSheet` deliberately
 * keeps the original `decrease,pad=...` pattern — it's an internal QA index
 * (270×480 thumbs), not production output, where letterboxing is acceptable.
 *
 * The `loop` filter holds a single-frame photo "video" frozen for the full
 * duration AND replays a too-short clip — both behaviors acceptable. Output
 * frame budget for `loop` is capped at 25 fps × insertion duration so we
 * never request more frames than the segment will actually hold.
 *
 * Caller MUST pass insertions that have already been sorted/clamped/dedup'd
 * by `normalizeInsertions` and probed by `downloadBrollAssets`. Each entry
 * needs `localPath`, `sourceDurSec`, `startSec`, `endSec`.
 *
 * Returns an array of per-insertion segment metadata (for response detail):
 *   [{ asset_id, requestedDurSec, sourceDurSec, actualSegmentDurSec, paddingApplied }]
 *
 * Throws if any segment can't be built (missing localPath, etc).
 *
 * @param {Object} args
 * @param {string} args.facePath
 * @param {string} args.brolledPath
 * @param {Array<{ startSec, endSec, asset_id, localPath, sourceDurSec }>} args.insertions  pre-normalized + pre-probed
 * @param {number} args.totalDuration  cut.mp4 duration — the timeline length to fill
 * @param {number} [args.faceCropOffsetX=0.5]  fraction in [0,1] — horizontal
 *   crop center for face video segments. 0.5 = naive center crop (pre-PR-#114
 *   default; safe but pushes off-center subjects to the edge); other values
 *   come from face detection on cut.mp4. Brolls always center-crop because
 *   they're iPhone portrait content (1080×1920 effective) where the crop is
 *   a no-op.
 * @returns {Promise<Array<{ asset_id, requestedDurSec, sourceDurSec, actualSegmentDurSec, paddingApplied }>>}
 */
async function composeFaceAndBrolls({ facePath, brolledPath, insertions, totalDuration, faceCropOffsetX = 0.5 }) {
  const sorted = [...insertions].sort((a, b) => a.startSec - b.startSec);

  // Build alternating face/broll segment list. Caller already deduped overlaps
  // via normalizeInsertions, so cursor advances strictly.
  const segments = [];
  let cursor = 0;
  sorted.forEach((ins, idx) => {
    if (ins.startSec > cursor + 0.001) {
      segments.push({ kind: 'face', startSec: cursor, endSec: ins.startSec });
    }
    segments.push({ kind: 'broll', insertionIndex: idx });
    cursor = ins.endSec;
  });
  if (cursor < totalDuration - 0.001) {
    segments.push({ kind: 'face', startSec: cursor, endSec: totalDuration });
  }
  if (segments.length === 0) {
    throw new Error('composeFaceAndBrolls: no segments produced — check insertion timestamps');
  }

  // Per-insertion metadata accumulates here for the response.
  const segmentMeta = [];

  const parts = [];
  const concatLabels = [];
  segments.forEach((seg, i) => {
    const outLabel = `seg${i}v`;
    if (seg.kind === 'face') {
      // PR #111: fill-crop instead of letterbox-pad.
      // PR #114: face-aware horizontal offset. faceCropOffsetX defaults to 0.5
      // (center crop = pre-PR-#114 behavior) so callers that don't run face
      // detection still work. When face detection succeeds, offsetX is the
      // median fraction of source-width where the speaker's face lives, and
      // buildCropXExpression produces an ffmpeg `crop=` x-expression that
      // keeps the face horizontally centered in the 1080×1920 output.
      const cropXExpr = buildCropXExpression(faceCropOffsetX);
      parts.push(
        `[0:v]trim=${seg.startSec.toFixed(3)}:${seg.endSec.toFixed(3)},` +
        `setpts=PTS-STARTPTS,` +
        `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:${cropXExpr}:0,` +
        `setsar=1,format=yuv420p[${outLabel}]`,
      );
    } else {
      const ins = sorted[seg.insertionIndex];
      const dur = ins.endSec - ins.startSec;
      // PR #98: only fail on NaN/Infinity (real probe failure that the caller
      // can't fix). 0 / missing duration is the static-image case — the loop
      // path was designed exactly for this (single-frame MP4 wrappers from
      // PNG/JPG assets where ffprobe reports no format.duration).
      if (typeof ins.sourceDurSec !== 'number' || !Number.isFinite(ins.sourceDurSec)) {
        throw new Error(
          `composeFaceAndBrolls: insertion ${ins.asset_id} missing/invalid sourceDurSec — ` +
          `caller must run downloadBrollAssets first`,
        );
      }
      const inputIdx = seg.insertionIndex + 1;
      // Dispatch:
      //   sourceDurSec <= 0     → static image / probe-zero → must loop to fill `dur`
      //   sourceDurSec >= dur   → trim-only (asset is at least as long as the segment)
      //   else (in between)     → loop+trim (real video shorter than the segment)
      // The 0.05s tolerance avoids a redundant loop pass when asset_dur is
      // within ~50ms of dur.
      const needsLoop = ins.sourceDurSec <= 0 || ins.sourceDurSec + 0.05 < dur;
      const paddingApplied = needsLoop ? 'loop' : 'trim';
      // Compose the per-segment filter chain. When looping, prepend
      // `loop=loop=-1:size=...:start=0` BEFORE trim so the trim sees an
      // arbitrarily-long virtual input. `size` is the loop's per-iteration
      // frame budget — we standardize on 25 fps via the scale chain so
      // dur × 25 frames is always sufficient regardless of source fps.
      // Min 1 frame so 0-frame edge cases don't break the filter.
      const loopFrames = Math.max(1, Math.ceil(dur * 25));
      const inputChain = needsLoop
        ? `[${inputIdx}:v]loop=loop=-1:size=${loopFrames}:start=0,trim=0:${dur.toFixed(3)}`
        : `[${inputIdx}:v]trim=0:${dur.toFixed(3)}`;
      parts.push(
        `${inputChain},setpts=PTS-STARTPTS,` +
        // PR #111: fill-crop instead of letterbox-pad — same change as the
        // face segment above. iPhone portrait brolls (rotate=90) are
        // already 1080×1920 effective so this is a no-op for them; landscape
        // brolls now fill-crop the same as the face video.
        `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
        `setsar=1,format=yuv420p[${outLabel}]`,
      );
      segmentMeta.push({
        asset_id: ins.asset_id,
        requestedDurSec: Number(dur.toFixed(3)),
        sourceDurSec: Number(ins.sourceDurSec.toFixed(3)),
        actualSegmentDurSec: Number(dur.toFixed(3)),  // by construction post-fix
        paddingApplied,
      });
    }
    concatLabels.push(`[${outLabel}]`);
  });

  parts.push(`${concatLabels.join('')}concat=n=${concatLabels.length}:v=1:a=0[outv]`);
  parts.push(`[0:a]asetpts=PTS-STARTPTS[outa]`);
  const filter = parts.join(';');

  const inputs = [`-i "${facePath}"`];
  for (const ins of sorted) inputs.push(`-i "${ins.localPath}"`);

  const cmd =
    `ffmpeg -y ${inputs.join(' ')} ` +
    `-filter_complex "${filter}" ` +
    `-map "[outv]" -map "[outa]" ` +
    `-c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k ` +
    `"${brolledPath}"`;

  await execAsync(cmd, { timeout: 600_000, maxBuffer: 50 * 1024 * 1024 });

  if (!statSync(brolledPath).size) {
    throw new Error('ffmpeg compose produced empty output');
  }
  return segmentMeta;
}
