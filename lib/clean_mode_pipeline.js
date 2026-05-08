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
  };

  const tmpDir = join('/tmp', jobId);
  const sourcePath = join(tmpDir, 'source.mp4');
  const cutPath = join(tmpDir, 'cut.mp4');
  const brollDir = join(tmpDir, 'brolls');
  const brolledPath = join(tmpDir, 'brolled.mp4');
  const assPath = join(tmpDir, 'captions.ass');
  const finalPath = join(tmpDir, 'final.mp4');

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

    // ── 4. Cut detection + safety classification ─────────────────────
    stepT = stepStart('cutClassify');
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
      // M2 has no separate Gemini slate-detection step (production cron does;
      // M2 doesn't). The deterministic transcript-based detector is the right
      // path for the standalone clean-mode pipeline — same flag the local CLI
      // (transcribe_and_cut.ts) uses. Multi-signal date+option/take or a short
      // editor phrase ≤8 words with no real-speech markers triggers; the
      // safety pass classifies the resulting cut as `leading_silence` (safe).
      detectSlateFromTranscript: true,
    });
    const appliedCuts = cutResult.applied.map((c) => ({ start: c.start, end: c.end }));
    totalSecondsRemoved = appliedCuts.reduce((s, c) => s + (c.end - c.start), 0);
    steps.cutClassify = {
      ms: Date.now() - stepT,
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
            stepT = stepStart('compose');
            composedSegmentMeta = await composeFaceAndBrolls({
              facePath: cutPath,
              brolledPath,
              insertions: normalizedInsertions,
              totalDuration: cutDuration,
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
        outputPath: finalPath,
      });
      steps.subtitleBurn = { ms: Date.now() - stepT };
      const fontWarnings = extractSubtitleWarnings(burnResult.stderr);
      warnings.push(...fontWarnings);
      finalVideoPath = finalPath;

      // PR #95: A/V sync gate on the final captioned MP4.
      streamSync.final = await verifyMP4StreamSync(finalPath);
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
      };
    });

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
        detail: insertionsDetail,
        warnings: insertionWarnings,
      },
      subtitles: {
        lines: lineCount,
      },
      audio: {                                             // PR #100
        loudnorm: audioLoudnormConfig,
      },
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
          };
        }),
        warnings: insertionWarnings,
      },
      subtitles: { lines: lineCount },
      audio: { loudnorm: audioLoudnormConfig },
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

  // Map db `id` → asset_id for broll_picker compatibility
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
  }));

  return { rows: mapped, warnings: filtered.warnings };
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
async function downloadBrollAssets(insertions, library, brollDir) {
  const libById = new Map(library.map((r) => [r.asset_id, r]));
  const out = [];
  for (const ins of insertions) {
    const row = libById.get(ins.asset_id);
    if (!row) {
      throw new Error(`Insertion references unknown asset_id=${ins.asset_id} (not in library)`);
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
 * @returns {Promise<Array<{ asset_id, requestedDurSec, sourceDurSec, actualSegmentDurSec, paddingApplied }>>}
 */
async function composeFaceAndBrolls({ facePath, brolledPath, insertions, totalDuration }) {
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
      parts.push(
        `[0:v]trim=${seg.startSec.toFixed(3)}:${seg.endSec.toFixed(3)},` +
        `setpts=PTS-STARTPTS,` +
        `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,` +
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
        `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,` +
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
