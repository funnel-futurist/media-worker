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
 *   3. transcribe  — ElevenLabs Scribe on source.mp4 → word_timestamps
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

import { getDuration } from './media.js';
import { detectAudioSilences, callScribeWithRetry, mapScribeResponse } from './scribe_transcribe.js';
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

  try {
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(brollDir, { recursive: true });

    const stepStart = (name) => {
      steps[name] = { ms: 0 };
      return Date.now();
    };

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
    const silenceMap = await detectAudioSilences(sourcePath, { noiseDb: -35, minDur: 0.6 });
    steps.silenceDetect = { ms: Date.now() - stepT, spans: silenceMap.length };

    // ── 3. Scribe transcribe ─────────────────────────────────────────
    stepT = stepStart('transcribe');
    const elevenKey = process.env.ELEVENLABS_API_KEY?.trim();
    if (!elevenKey) throw new Error('ELEVENLABS_API_KEY not set on Railway');
    const scribeRaw = await callScribeWithRetry(elevenKey, sourcePath);
    const { transcript, word_timestamps, _debug: scribeDebug } = mapScribeResponse(scribeRaw);
    if (word_timestamps.length === 0) {
      const sample = scribeDebug?.rawSample ?? '(no sample)';
      throw new Error(`Scribe returned 0 words — cannot proceed. Sample: ${sample.slice(0, 200)}`);
    }
    steps.transcribe = { ms: Date.now() - stepT, words: word_timestamps.length };

    // ── 4. Cut detection + safety classification ─────────────────────
    stepT = stepStart('cutClassify');
    const cutResult = detectAndClassifyCuts(word_timestamps, {
      sourceDuration,
      externalSilences: silenceMap,
      cutSafetyMode: 'safe_only',                    // talking_head_reel default
      preserveEmphasisPauses: true,
      cutMidSentenceLongerThan: 1.0,
      cutBeyondLastWordPadSec: 0.5,
      detectSlateFromTranscript: false,              // M2 caller-controlled slate; keep off
    });
    const appliedCuts = cutResult.applied.map((c) => ({ start: c.start, end: c.end }));
    const totalSecondsRemoved = appliedCuts.reduce((s, c) => s + (c.end - c.start), 0);
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
    stepT = stepStart('cutApply');
    const keepSegments = buildKeepSegments(appliedCuts, sourceDuration);
    await runTrimConcat(sourcePath, cutPath, {
      keepSegments,
      applyLoudnorm: false,                          // M2 plan: no loudnorm in clean mode
      encoderArgs: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '192k'],
    });
    const cutDuration = await getDuration(cutPath);
    steps.cutApply = { ms: Date.now() - stepT };

    // ── Default: cut.mp4 is the input to the next step. Skip flags
    //     reroute below. ─────────────────────────────────────────────
    let videoForSubtitles = cutPath;
    let videoForSubtitlesDuration = cutDuration;
    let insertions = [];
    let pickedModel = opts.model;
    let library = [];
    let brollAssetsDownloaded = 0;
    let brollBytesTotal = 0;

    if (!opts.skipBroll) {
      // ── 6. Library lookup ──────────────────────────────────────────
      stepT = stepStart('libraryLookup');
      library = await fetchBrollLibrary(req.clientId);
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
          // ── 8. Broll asset downloads ──────────────────────────────
          stepT = stepStart('brollDownload');
          const downloads = await downloadBrollAssets(insertions, library, brollDir);
          brollAssetsDownloaded = downloads.length;
          brollBytesTotal = downloads.reduce((s, d) => s + d.bytes, 0);
          steps.brollDownload = {
            ms: Date.now() - stepT,
            brollsFetched: brollAssetsDownloaded,
            totalBytes: brollBytesTotal,
          };

          // ── 9. ffmpeg compose face + brolls ──────────────────────
          stepT = stepStart('compose');
          await composeFaceAndBrolls({
            facePath: cutPath,
            brolledPath,
            insertions: downloads,                // each has localPath
            totalDuration: cutDuration,
          });
          steps.compose = { ms: Date.now() - stepT };
          videoForSubtitles = brolledPath;
          videoForSubtitlesDuration = await getDuration(brolledPath);
        } else {
          warnings.push('broll picker returned 0 insertions — skipping compose');
        }
      }
    }

    let finalVideoPath = videoForSubtitles;
    let lineCount = 0;

    if (!opts.skipSubtitles) {
      // ── 10. Subtitle generation (math-remap + grouping) ─────────────
      stepT = stepStart('subtitleGen');
      const remappedWords = remapWordsThroughCuts(word_timestamps, appliedCuts);
      const lines = groupIntoLines(remappedWords, 6, 2.5);
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
    }

    // ── 12. Upload final.mp4 ─────────────────────────────────────────
    const outputPath = `${req.output.pathPrefix}${jobId}.mp4`;
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
    const finalUrl = await signStorageUrl({
      bucket: req.output.bucket,
      path: outputPath,
      expiresIn: 86_400,
    });

    const finalDuration = await getDuration(finalVideoPath);

    return {
      jobId,
      finalUrl,
      finalStorage: { bucket: req.output.bucket, path: outputPath },
      durationSec: Number(finalDuration.toFixed(3)),
      cuts: {
        applied: cutResult.applied.length,
        skipped: cutResult.skipped.length,
        secondsRemoved: Number(totalSecondsRemoved.toFixed(3)),
      },
      insertions: {
        count: insertions.length,
        model: pickedModel,
      },
      subtitles: {
        lines: lineCount,
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

// ── Helpers (private to this module) ────────────────────────────────────

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
 * Query marketing.broll_library for the given client_id via Supabase REST.
 * Uses Accept-Profile: marketing (existing pattern from routes/classify.js).
 *
 * Returns BrollRow[] in the shape lib/broll_picker expects (asset_id +
 * metadata fields). file_url is included for the download step.
 */
async function fetchBrollLibrary(clientId) {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)?.trim();
  if (!url) throw new Error('SUPABASE_URL is not set');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  const select = [
    'id', 'asset_title', 'asset_type', 'content_strategy_type',
    'context', 'emotion', 'insight', 'when_to_use',
    'file_url', 'drive_file_id',
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
  // Map db `id` → asset_id for broll_picker compatibility
  return (res.data ?? []).map((row) => ({
    asset_id: row.id,
    asset_title: row.asset_title,
    asset_type: row.asset_type,
    content_strategy_type: row.content_strategy_type,
    context: row.context,
    emotion: row.emotion,
    insight: row.insight,
    when_to_use: row.when_to_use,
    file_url: row.file_url,
    drive_file_id: row.drive_file_id,
  }));
}

/**
 * Download every broll referenced by the insertions list. Errors out clearly
 * if a row is missing file_url (M2 plan: no Drive OAuth resolution).
 *
 * Returns a list parallel to insertions, each carrying the local broll path
 * for the ffmpeg compose step.
 */
async function downloadBrollAssets(insertions, library, brollDir) {
  const libById = new Map(library.map((r) => [r.asset_id, r]));
  const out = [];
  for (const ins of insertions) {
    const row = libById.get(ins.asset_id);
    if (!row) {
      throw new Error(`Insertion references unknown asset_id=${ins.asset_id} (not in library)`);
    }
    if (!row.file_url) {
      throw new Error(
        `Broll ${ins.asset_id} has no file_url. Run portal_assets_sync first (drive_file_id alone is not supported in M2).`,
      );
    }
    const ext = (extname(new URL(row.file_url).pathname) || '.mp4').toLowerCase();
    const localPath = join(brollDir, `${ins.asset_id}${ext}`);
    const res = await axios.get(row.file_url, {
      responseType: 'stream',
      timeout: 180_000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      // Drain stream into buffer for the error body
      const chunks = [];
      for await (const chunk of res.data) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8').slice(0, 300);
      throw new Error(`Broll download ${res.status} for ${row.file_url}: ${body}`);
    }
    await pipeline(res.data, createWriteStream(localPath));
    const bytes = statSync(localPath).size;
    out.push({ ...ins, localPath, bytes });
  }
  return out;
}

/**
 * ffmpeg compose: full-screen broll replacement during selected windows,
 * face audio passthrough across the entire timeline. Mirrors
 * creative-engine/scripts/add_brolls.ts:buildFilterComplex.
 *
 * @param {Object} args
 * @param {string} args.facePath
 * @param {string} args.brolledPath
 * @param {Array<{ startSec: number, endSec: number, asset_id: string, localPath: string }>} args.insertions
 * @param {number} args.totalDuration
 */
async function composeFaceAndBrolls({ facePath, brolledPath, insertions, totalDuration }) {
  // Sort insertions by start; build alternating face/broll segments
  const sorted = [...insertions].sort((a, b) => a.startSec - b.startSec);
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

  const parts = [];
  const concatLabels = [];
  segments.forEach((seg, i) => {
    const outLabel = `seg${i}v`;
    if (seg.kind === 'face') {
      parts.push(
        `[0:v]trim=${seg.startSec.toFixed(3)}:${seg.endSec.toFixed(3)},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[${outLabel}]`,
      );
    } else {
      const ins = sorted[seg.insertionIndex];
      const dur = ins.endSec - ins.startSec;
      const inputIdx = seg.insertionIndex + 1;
      parts.push(
        `[${inputIdx}:v]trim=0:${dur.toFixed(3)},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[${outLabel}]`,
      );
    }
    concatLabels.push(`[${outLabel}]`);
  });

  parts.push(`${concatLabels.join('')}concat=n=${concatLabels.length}:v=1:a=0[outv]`);
  parts.push(`[0:a]asetpts=PTS-STARTPTS[outa]`);
  const filter = parts.join(';');

  // Build ffmpeg command. Shell-quote each input path; insertions provide
  // localPath in the order they appear in `sorted`.
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
}
