/**
 * routes/audio-transcribe.js
 *
 * Word-level transcription endpoint. Used by creative-engine's compose_pending
 * cron to produce word_timestamps that drive captions, slate detection, and
 * deterministic editorial cuts.
 *
 * Implementation: POSTs the source bytes to Deepgram Nova-3
 * (https://api.deepgram.com/v1/listen?model=nova-3&...). Response is mapped
 * to the existing
 *   { transcript, word_timestamps: [{word, start_ms, end_ms}], model, durationSeconds }
 *
 * The previous backend was ElevenLabs Scribe (model_id=scribe_v1,
 * language_code=eng). Swapped to Deepgram for billing isolation and 35%
 * lower per-hour cost — see lib/deepgram_transcribe.js header for the full
 * rationale. Wire contract on this route is unchanged.
 * shape so the wire contract to Vercel is unchanged.
 *
 * Why a hosted ASR and not whisper.cpp small.en (the original implementation):
 * Phase 2c proved Whisper's transcription errors ("Slack→slab", "automation→inone")
 * were the upstream cause of bad editorial decisions. Higher-fidelity input was
 * the cheapest improvement on the whole pipeline. Scribe replaced Whisper;
 * Deepgram replaced Scribe — both deliver the same word-level fidelity;
 * Deepgram does it at a lower per-hour rate under a Funnel-Futurists-owned
 * billing account.
 *
 * Drive sources still use the caller-supplied bearer token (Railway never holds
 * OAuth credentials — same pattern as routes/audio-loudnorm-trim.js + classify.js).
 */

import { Router } from 'express';
import { writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import axios from 'axios';

import { getDuration } from '../lib/media.js';
import { detectAudioSilences } from '../lib/scribe_transcribe.js';
import { callDeepgramWithRetry, mapDeepgramResponse } from '../lib/deepgram_transcribe.js';

export const audioTranscribeRouter = Router();

// 1 GB cap — Deepgram's documented limit is 2 GB but we cap conservatively
// (also matches the prior Scribe-era cap so callers see no behavior change).
const TRANSCRIBE_MAX_BYTES = 1 * 1024 * 1024 * 1024;

/**
 * POST /audio-transcribe
 *
 * Body: {
 *   sourceUrl: string,                    // for sourceType='public_url'
 *   sourceType: 'drive' | 'public_url',
 *   driveFileId?: string,                 // required when sourceType='drive'
 *   driveToken?: string,                  // required when sourceType='drive'
 *   model?: string,                       // ignored — kept for back-compat with old callers
 *   adIngestionId?: string,
 *   clientId?: string,
 * }
 *
 * Response: {
 *   transcript: string,
 *   word_timestamps: Array<{ word: string, start_ms: number, end_ms: number }>,
 *   model: string,
 *   durationSeconds: number,
 * }
 */
audioTranscribeRouter.post('/audio-transcribe', async (req, res, next) => {
  const tmpDir = join('/tmp', `transcribe-${randomUUID()}`);
  try {
    const {
      sourceUrl,
      sourceType,
      driveFileId,
      driveToken,
      adIngestionId,
      clientId,
      // Phase 2.9: per-row silencedetect tuning. Defaults preserve Phase 2.7
      // behaviour (-35dB / 0.6s) when absent. Caller (creative-engine
      // compose_pending) computes these from the resolved cut_profile.
      silenceDb,
      silenceMinDur,
    } = req.body || {};

    if (sourceType === 'drive' && (!driveFileId || !driveToken)) {
      return res.status(400).json({ error: 'driveFileId and driveToken are required when sourceType=drive' });
    }
    if (sourceType !== 'drive' && !sourceUrl) {
      return res.status(400).json({ error: 'sourceUrl is required when sourceType=public_url' });
    }

    const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('DEEPGRAM_API_KEY not set on Railway — required for transcription');
    }

    mkdirSync(tmpDir, { recursive: true });
    const inputPath = join(tmpDir, 'source.mp4');

    // ── 1. Download source ─────────────────────────────────────────
    console.log(`[audio-transcribe] downloading ${sourceType} for ${adIngestionId ?? '(no id)'}`);
    const downloadUrl = sourceType === 'drive'
      ? `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media&supportsAllDrives=true`
      : sourceUrl;
    const downloadHeaders = sourceType === 'drive'
      ? { Authorization: `Bearer ${driveToken}` }
      : {};
    const { data } = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 180_000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      headers: downloadHeaders,
    });
    writeFileSync(inputPath, Buffer.from(data));

    if (!existsSync(inputPath)) {
      throw new Error('source download produced no file on disk');
    }

    const fileSize = statSync(inputPath).size;
    if (fileSize > TRANSCRIBE_MAX_BYTES) {
      throw new Error(
        `source is ${(fileSize / 1024 / 1024).toFixed(1)} MB — exceeds transcribe upload cap of 1 GB`,
      );
    }

    // ── 1b. Audio-waveform silence detection (Phoenix's approach from PR #106) ──
    // Run ffmpeg silencedetect on the source audio to find REAL silences —
    // not just gaps between Whisper words. Returns spans where audio energy
    // drops below -35 dBFS for ≥ 0.6s. More accurate than word-gap heuristics
    // because it catches mid-sentence breath pauses, gaps inside slurred
    // speech, and is sample-accurate (vs Whisper word boundary drift).
    //
    // Uses defaults from ff-pilot/scripts/silence_cut.js. compose_pending
    // can override via deterministic_cuts options if a client speaker has
    // unusual mic levels.
    const noiseDb = typeof silenceDb === 'number' ? silenceDb : -35;
    const minDur = typeof silenceMinDur === 'number' ? silenceMinDur : 0.6;
    console.log(`[audio-transcribe] running ffmpeg silencedetect (${noiseDb}dB, ${minDur}s)`);
    const silenceMap = await detectAudioSilences(inputPath, { noiseDb, minDur });
    console.log(`[audio-transcribe] silencedetect found ${silenceMap.length} silence span(s)`);

    // ── 2. Call Deepgram Nova-3 ────────────────────────────────────
    // Raw-bytes POST (no multipart wrapping needed — Deepgram extracts audio
    // server-side from the mp4 container). language=en, smart_format=true,
    // punctuate=true — see lib/deepgram_transcribe.js for the full query
    // string and rationale for each parameter.
    console.log(`[audio-transcribe] deepgram POST (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
    const dgResponse = await callDeepgramWithRetry(apiKey, inputPath);

    // ── 3. Map response → wire contract ────────────────────────────
    const { transcript, word_timestamps, _debug: mappedDebug } = mapDeepgramResponse(dgResponse);

    // Always trust ffprobe over the ASR's own duration field — keeps duration
    // consistent with how audio-loudnorm-trim measures duration on the same
    // file. Deepgram returns duration via results.duration; we only fall
    // back to it (or to the last-word end_ms) if ffprobe fails.
    let durationSeconds = 0;
    try {
      durationSeconds = await getDuration(inputPath);
    } catch (err) {
      console.warn(`[audio-transcribe] ffprobe failed, falling back to Deepgram duration: ${err.message}`);
      durationSeconds = typeof dgResponse?.metadata?.duration === 'number'
        ? dgResponse.metadata.duration
        : (word_timestamps.length ? word_timestamps[word_timestamps.length - 1].end_ms / 1000 : 0);
    }

    // Diagnostic if we somehow got zero words — log raw shape for debugging
    // without an extra round trip. mapDeepgramResponse populated _debug already.
    if (mappedDebug) {
      console.warn(`[audio-transcribe] PARSED ZERO WORDS. Raw sample: ${mappedDebug.rawSample}`);
    }

    const dgModel = dgResponse?.metadata?.model_info
      ? Object.values(dgResponse.metadata.model_info)[0]?.name ?? 'nova-3'
      : 'nova-3';
    console.log(
      `[audio-transcribe] done: ${word_timestamps.length} words, ` +
        `transcript ${transcript.length} chars, dur ${durationSeconds.toFixed(2)}s ` +
        `(model=deepgram_${dgModel})`,
    );

    res.json({
      transcript,
      word_timestamps,
      silence_map: silenceMap,
      // The wire contract historically reported `model: 'elevenlabs_scribe_v1'`.
      // Now that we've switched backends, callers (creative-engine
      // compose_pending) should be able to introspect which ASR ran. Use a
      // namespaced string the same shape.
      model: `deepgram_${dgModel}`,
      durationSeconds,
      adIngestionId: adIngestionId ?? null,
      clientId: clientId ?? null,
      ...(mappedDebug ? { _debug: mappedDebug } : {}),
    });
  } catch (err) {
    console.error('[audio-transcribe] error:', err?.message ?? err);
    next(err);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
