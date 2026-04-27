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
import { writeFileSync, mkdirSync, rmSync, existsSync, statSync, createReadStream } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import axios from 'axios';
import FormData from 'form-data';
import { getDuration } from '../lib/media.js';

export const audioTranscribeRouter = Router();

const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const SCRIBE_MAX_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB — Scribe's documented limit is 3 GB but we cap conservatively
const SCRIBE_TIMEOUT_MS = 180_000;

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

    // ── 2. Call ElevenLabs Scribe ──────────────────────────────────
    // multipart upload via form-data + axios. language_code=eng to match the
    // small.en model behavior we replaced (no auto-detect drift on long
    // monologues with rare loanwords).
    console.log(`[audio-transcribe] scribe POST (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
    const scribeResponse = await callScribeWithRetry(apiKey, inputPath);

    // ── 3. Map response → wire contract ────────────────────────────
    // Scribe returns words[] with type='word' | 'spacing' | 'audio_event'.
    // Filter to type='word' only — spacing is whitespace metadata, audio_event
    // is non-speech sound annotations that aren't part of the speaker's words.
    const rawWords = Array.isArray(scribeResponse.words) ? scribeResponse.words : [];
    const word_timestamps = rawWords
      .filter((w) => w && w.type === 'word' && typeof w.text === 'string' && w.text.trim().length > 0)
      .map((w) => ({
        word: w.text.trim(),
        start_ms: Math.round((typeof w.start === 'number' ? w.start : 0) * 1000),
        end_ms: Math.round((typeof w.end === 'number' ? w.end : 0) * 1000),
      }))
      .filter((w) => w.end_ms > w.start_ms);

    // Canonical transcript = top-level `text` (not joined from filtered words —
    // word/spacing punctuation lives in the spacing entries we just dropped).
    const transcript = typeof scribeResponse.text === 'string'
      ? scribeResponse.text.trim()
      : word_timestamps.map((w) => w.word).join(' ');

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

    // Diagnostic if we somehow got zero words — lets the caller log raw shape
    // for debugging without an extra round trip.
    let _debug = null;
    if (word_timestamps.length === 0) {
      const sample = JSON.stringify(scribeResponse).slice(0, 2000);
      console.warn(`[audio-transcribe] PARSED ZERO WORDS. Raw sample: ${sample}`);
      _debug = {
        rawTopLevelKeys: Object.keys(scribeResponse),
        rawWordsLength: rawWords.length,
        rawWordTypes: [...new Set(rawWords.map((w) => w.type))],
        rawSample: sample,
      };
    }

    console.log(
      `[audio-transcribe] done: ${word_timestamps.length} words, ` +
        `transcript ${transcript.length} chars, dur ${durationSeconds.toFixed(2)}s ` +
        `(model=elevenlabs_scribe_v1, lang=${scribeResponse.language_code ?? '?'})`,
    );

    res.json({
      transcript,
      word_timestamps,
      model: 'elevenlabs_scribe_v1',
      durationSeconds,
      adIngestionId: adIngestionId ?? null,
      clientId: clientId ?? null,
      ..._debug ? { _debug } : {},
    });
  } catch (err) {
    console.error('[audio-transcribe] error:', err?.message ?? err);
    next(err);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

/**
 * Call Scribe with one retry on transient network failures. We do NOT retry on
 * 4xx (caller's fault — bad audio, bad key, oversize) — those will fail the
 * same way again.
 */
async function callScribeWithRetry(apiKey, filePath) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const form = new FormData();
      form.append('file', createReadStream(filePath), { filename: 'source.mp4', contentType: 'video/mp4' });
      form.append('model_id', 'scribe_v1');
      form.append('language_code', 'eng');

      const res = await axios.post(SCRIBE_URL, form, {
        headers: {
          ...form.getHeaders(),
          'xi-api-key': apiKey,
        },
        timeout: SCRIBE_TIMEOUT_MS,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      return res.data;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status ?? 0;
      // 4xx: don't retry
      if (status >= 400 && status < 500) {
        const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : err.message;
        throw new Error(`Scribe ${status} — ${body}`);
      }
      // 5xx or network: retry once after 2s
      if (attempt === 1) {
        console.warn(`[audio-transcribe] scribe attempt 1 failed (${err.message}), retrying in 2s`);
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }
  throw new Error(`Scribe failed after retry: ${lastErr?.message ?? lastErr}`);
}
