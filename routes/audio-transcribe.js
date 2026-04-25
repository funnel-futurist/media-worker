/**
 * routes/audio-transcribe.js
 *
 * Word-level Whisper transcription endpoint. Used by creative-engine's
 * compose_pending cron to lazy-fill gemini_markup.word_timestamps when
 * classify_pending didn't produce them.
 *
 * Implementation: shells out to `npx hyperframes transcribe <file> --json`
 * (which wraps whisper.cpp internally — already installed on Railway per
 * Phoenix's PR #78). Output is `transcript.json` in CWD; we read and return
 * its contents as the response body.
 *
 * Returns the same shape Gemini's classify pipeline produces, so callers
 * can drop it directly into ad_ingestion.gemini_markup:
 *   { transcript: string, word_timestamps: Array<{word, start_ms, end_ms}> }
 *
 * Drive sources use the caller-supplied bearer token (same pattern as
 * routes/audio-loudnorm-trim.js + classify.js — Railway never holds OAuth).
 */

import { Router } from 'express';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';

const execAsync = promisify(exec);

export const audioTranscribeRouter = Router();

/**
 * POST /audio-transcribe
 *
 * Body: {
 *   sourceUrl: string,                    // for sourceType='public_url'
 *   sourceType: 'drive' | 'public_url',
 *   driveFileId?: string,                 // required when sourceType='drive'
 *   driveToken?: string,                  // required when sourceType='drive'
 *   model?: string,                       // whisper model (default 'small.en')
 *   adIngestionId?: string,               // for log correlation
 *   clientId?: string,                    // for log correlation
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
      model = 'small.en',
      adIngestionId,
      clientId,
    } = req.body || {};

    if (sourceType === 'drive' && (!driveFileId || !driveToken)) {
      return res.status(400).json({ error: 'driveFileId and driveToken are required when sourceType=drive' });
    }
    if (sourceType !== 'drive' && !sourceUrl) {
      return res.status(400).json({ error: 'sourceUrl is required when sourceType=public_url' });
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

    // ── 2. Run hyperframes transcribe (wraps whisper.cpp) ──────────
    // The CLI writes transcript.json to CWD. We run with cwd=tmpDir so the
    // JSON lands in our scratch folder and gets cleaned up automatically.
    console.log(`[audio-transcribe] hyperframes transcribe (model=${model})`);
    await execAsync(
      `npx hyperframes transcribe "${inputPath}" --model ${model} --json`,
      { cwd: tmpDir, timeout: 300_000, maxBuffer: 50 * 1024 * 1024 }
    );

    const transcriptPath = join(tmpDir, 'transcript.json');
    if (!existsSync(transcriptPath)) {
      throw new Error('hyperframes transcribe produced no transcript.json');
    }

    const raw = JSON.parse(readFileSync(transcriptPath, 'utf-8'));

    // ── 3. Normalize Hyperframes' transcript shape into our gemini_markup shape
    // Hyperframes transcribe output format (per align_captions.js):
    //   { segments: [{ words: [{ word, start, end }, ...], ... }] }
    // We need: { transcript: string, word_timestamps: [{ word, start_ms, end_ms }] }
    const word_timestamps = [];
    let transcriptParts = [];
    const segments = raw.segments ?? raw.transcription ?? [];
    for (const seg of segments) {
      const words = seg.words ?? [];
      for (const w of words) {
        const text = (w.word ?? w.text ?? '').trim();
        if (!text) continue;
        const startSec = typeof w.start === 'number' ? w.start : Number(w.start) || 0;
        const endSec = typeof w.end === 'number' ? w.end : Number(w.end) || startSec;
        word_timestamps.push({
          word: text,
          start_ms: Math.round(startSec * 1000),
          end_ms: Math.round(endSec * 1000),
        });
      }
      if (seg.text) transcriptParts.push(String(seg.text).trim());
    }
    const transcript = transcriptParts.length
      ? transcriptParts.join(' ').replace(/\s+/g, ' ').trim()
      : word_timestamps.map((w) => w.word).join(' ');

    const durationSeconds = word_timestamps.length
      ? word_timestamps[word_timestamps.length - 1].end_ms / 1000
      : 0;

    console.log(
      `[audio-transcribe] done: ${word_timestamps.length} words, ` +
        `transcript ${transcript.length} chars, dur ~${durationSeconds.toFixed(1)}s`
    );

    res.json({
      transcript,
      word_timestamps,
      model,
      durationSeconds,
      adIngestionId: adIngestionId ?? null,
      clientId: clientId ?? null,
    });
  } catch (err) {
    console.error('[audio-transcribe] error:', err?.message ?? err);
    next(err);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
