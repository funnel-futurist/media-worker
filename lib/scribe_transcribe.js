/**
 * lib/scribe_transcribe.js
 *
 * Shared helpers for ElevenLabs Scribe transcription + ffmpeg silencedetect.
 * Extracted from routes/audio-transcribe.js so the M2 clean-mode-compose
 * pipeline can reuse the same primitives without duplicating logic.
 *
 * Three exported helpers:
 *   1. detectAudioSilences(inputPath, opts) — ffmpeg silencedetect → spans
 *   2. callScribeWithRetry(apiKey, filePath) — multipart POST + 1 retry
 *   3. mapScribeResponse(raw) — Scribe response → canonical word_timestamps
 *
 * The route in routes/audio-transcribe.js composes these for the existing
 * /audio-transcribe wire contract; the M2 pipeline (lib/clean_mode_pipeline)
 * composes them with the M2-specific paths and timing accounting.
 */

import { createReadStream } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import FormData from 'form-data';

const execAsync = promisify(exec);

const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const SCRIBE_TIMEOUT_MS = 180_000;

/**
 * Run ffmpeg silencedetect on the source mp4 and return silence spans.
 * Returns Array<{start, end}> in source-time seconds. Empty array on
 * ffmpeg failure (silence detection is optional — caller falls back to
 * word-gap heuristic).
 */
export async function detectAudioSilences(inputPath, opts = {}) {
  const noiseDb = typeof opts.noiseDb === 'number' ? opts.noiseDb : -35;
  const minDur = typeof opts.minDur === 'number' ? opts.minDur : 0.6;
  try {
    const { stderr } = await execAsync(
      `ffmpeg -i "${inputPath}" -af "silencedetect=noise=${noiseDb}dB:duration=${minDur}" -f null -`,
      { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 },
    ).catch((err) => {
      const stderrOut = (err && (err.stderr || err.message)) || '';
      return { stderr: stderrOut };
    });

    const startMatches = [...stderr.matchAll(/silence_start: ([\d.]+)/g)];
    const endMatches = [...stderr.matchAll(/silence_end: ([\d.]+)/g)];
    const spans = [];
    for (let i = 0; i < startMatches.length; i++) {
      const start = parseFloat(startMatches[i][1]);
      const end = endMatches[i] ? parseFloat(endMatches[i][1]) : null;
      if (end == null || end <= start) continue;
      if (end - start < minDur) continue;
      spans.push({ start, end });
    }
    return spans;
  } catch (err) {
    console.warn(`[scribe_transcribe] silencedetect failed (non-fatal): ${err.message}`);
    return [];
  }
}

/**
 * Call Scribe with one retry on transient network failures. Does NOT retry
 * on 4xx (caller's fault — bad audio, bad key, oversize). Returns the raw
 * Scribe JSON; map it via mapScribeResponse() to get the canonical shape.
 */
export async function callScribeWithRetry(apiKey, filePath) {
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
      if (status >= 400 && status < 500) {
        const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : err.message;
        throw new Error(`Scribe ${status} — ${body}`);
      }
      if (attempt === 1) {
        console.warn(`[scribe_transcribe] scribe attempt 1 failed (${err.message}), retrying in 2s`);
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }
  throw new Error(`Scribe failed after retry: ${lastErr?.message ?? lastErr}`);
}

/**
 * Map a raw Scribe response to the canonical
 *   { transcript, word_timestamps, _debug? }
 * shape used by the rest of the pipeline.
 *
 * Filters Scribe's words[] to type='word' only — drops 'spacing' (whitespace
 * metadata) and 'audio_event' (non-speech sound annotations).
 *
 * The canonical transcript comes from the top-level `text` field, NOT joined
 * from filtered words — punctuation lives in the spacing entries we just
 * dropped, so joining the words alone would lose punctuation.
 *
 * If zero words parse, attaches a `_debug` field with raw shape info so the
 * caller can log without an extra round trip.
 */
export function mapScribeResponse(raw) {
  const rawWords = Array.isArray(raw?.words) ? raw.words : [];
  const word_timestamps = rawWords
    .filter((w) => w && w.type === 'word' && typeof w.text === 'string' && w.text.trim().length > 0)
    .map((w) => ({
      word: w.text.trim(),
      start_ms: Math.round((typeof w.start === 'number' ? w.start : 0) * 1000),
      end_ms: Math.round((typeof w.end === 'number' ? w.end : 0) * 1000),
    }))
    .filter((w) => w.end_ms > w.start_ms);

  const transcript = typeof raw?.text === 'string'
    ? raw.text.trim()
    : word_timestamps.map((w) => w.word).join(' ');

  let _debug = null;
  if (word_timestamps.length === 0) {
    const sample = JSON.stringify(raw).slice(0, 2000);
    _debug = {
      rawTopLevelKeys: raw && typeof raw === 'object' ? Object.keys(raw) : [],
      rawWordsLength: rawWords.length,
      rawWordTypes: [...new Set(rawWords.map((w) => w?.type))],
      rawSample: sample,
    };
  }

  return _debug
    ? { transcript, word_timestamps, _debug }
    : { transcript, word_timestamps };
}
