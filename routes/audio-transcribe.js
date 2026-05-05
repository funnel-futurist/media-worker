/**
 * routes/audio-transcribe.js
 *
 * Word-level transcription endpoint. Used by creative-engine's compose_pending
 * cron to produce word_timestamps that drive captions, slate detection, and
 * deterministic editorial cuts.
 *
 * Implementation: POSTs the source bytes to ElevenLabs Scribe
 * (https://api.elevenlabs.io/v1/speech-to-text) with model_id=scribe_v1 and
 * language_code=eng. Response is mapped to the existing
 *   { transcript, word_timestamps: [{word, start_ms, end_ms}], model, durationSeconds }
 * shape so the wire contract to Vercel is unchanged.
 *
 * Why Scribe and not whisper.cpp small.en (the previous implementation):
 * Phase 2c proved Whisper's transcription errors ("Slack→slab", "automation→inone")
 * were the upstream cause of bad editorial decisions. Higher-fidelity input was
 * the cheapest improvement on the whole pipeline.
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
import {
  detectAudioSilences,
  callScribeWithRetry,
  mapScribeResponse,
} from '../lib/scribe_transcribe.js';

export const audioTranscribeRouter = Router();

const SCRIBE_MAX_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB — Scribe's documented limit is 3 GB but we cap conservatively

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

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error('ELEVENLABS_API_KEY not set on Railway — required for Scribe transcription');
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
    if (fileSize > SCRIBE_MAX_BYTES) {
      throw new Error(
        `source is ${(fileSize / 1024 / 1024).toFixed(1)} MB — exceeds Scribe upload cap of 1 GB`,
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

    // ── 2. Call ElevenLabs Scribe ──────────────────────────────────
    // multipart upload via form-data + axios. language_code=eng to match the
    // small.en model behavior we replaced (no auto-detect drift on long
    // monologues with rare loanwords).
    console.log(`[audio-transcribe] scribe POST (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
    const scribeResponse = await callScribeWithRetry(apiKey, inputPath);

    // ── 3. Map response → wire contract ────────────────────────────
    const { transcript, word_timestamps, _debug: mappedDebug } = mapScribeResponse(scribeResponse);

    // Use ffprobe-measured duration over Scribe's audio_duration_secs to keep
    // consistent with how audio-loudnorm-trim measures duration on the same file.
    let durationSeconds = 0;
    try {
      durationSeconds = await getDuration(inputPath);
    } catch (err) {
      console.warn(`[audio-transcribe] ffprobe failed, falling back to Scribe duration: ${err.message}`);
      durationSeconds = typeof scribeResponse.audio_duration_secs === 'number'
        ? scribeResponse.audio_duration_secs
        : (word_timestamps.length ? word_timestamps[word_timestamps.length - 1].end_ms / 1000 : 0);
    }

    // Diagnostic if we somehow got zero words — log raw shape for debugging
    // without an extra round trip. mapScribeResponse populated _debug already.
    if (mappedDebug) {
      console.warn(`[audio-transcribe] PARSED ZERO WORDS. Raw sample: ${mappedDebug.rawSample}`);
    }

    console.log(
      `[audio-transcribe] done: ${word_timestamps.length} words, ` +
        `transcript ${transcript.length} chars, dur ${durationSeconds.toFixed(2)}s ` +
        `(model=elevenlabs_scribe_v1, lang=${scribeResponse.language_code ?? '?'})`,
    );

    res.json({
      transcript,
      word_timestamps,
      silence_map: silenceMap,
      model: 'elevenlabs_scribe_v1',
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
