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
    // Use the locally-installed hyperframes binary (pinned in package.json
    // as ^0.4.20). Calling `npx hyperframes` was downloading 0.4.30 fresh
    // each call AND failing — possibly version-incompatible with whisper-cli
    // setup on Railway. Direct local-bin call avoids both issues.
    const localBin = join(process.cwd(), 'node_modules', '.bin', 'hyperframes');
    let runStdout = '';
    let runStderr = '';
    try {
      const result = await execAsync(
        `"${localBin}" transcribe "${inputPath}" --model ${model} --json`,
        { cwd: tmpDir, timeout: 300_000, maxBuffer: 50 * 1024 * 1024 }
      );
      runStdout = result.stdout ?? '';
      runStderr = result.stderr ?? '';
    } catch (execErr) {
      // execAsync swallows stderr by default — we need it to know why
      // whisper-cli failed (model missing, ffmpeg path issue, etc).
      const stdout = (execErr.stdout || '').toString();
      const stderr = (execErr.stderr || '').toString();
      const msg = execErr.message || String(execErr);
      throw new Error(
        `hyperframes transcribe exec failed:\n` +
          `  stderr: ${stderr.slice(-1500)}\n` +
          `  stdout: ${stdout.slice(-500)}\n` +
          `  msg: ${msg.slice(0, 200)}`
      );
    }

    const transcriptPath = join(tmpDir, 'transcript.json');
    if (!existsSync(transcriptPath)) {
      throw new Error(
        `hyperframes transcribe produced no transcript.json. ` +
          `stderr tail: ${runStderr.slice(-1500)}\n` +
          `stdout tail: ${runStdout.slice(-500)}`
      );
    }

    const raw = JSON.parse(readFileSync(transcriptPath, 'utf-8'));

    // ── 3. Normalize Whisper output to gemini_markup shape ─────────
    // Hyperframes wraps Whisper but the underlying binary's output format
    // varies between platforms:
    //   - OpenAI whisper.exe (Windows / miniconda):
    //       { segments: [{ words: [{ word, start, end (seconds) }] }] }
    //   - whisper.cpp on Linux/Railway (--output-json-full):
    //       { transcription: [{ tokens: [{ text, offsets:{from,to} (ms), ... }],
    //                            text: "...", offsets: {from, to} }] }
    // We must handle BOTH. Normalize to:
    //   { transcript: string, word_timestamps: [{word, start_ms, end_ms}] }
    const word_timestamps = [];
    const transcriptParts = [];

    const segments = raw.segments ?? raw.transcription ?? [];
    console.log(
      `[audio-transcribe] parsed ${segments.length} segments; ` +
        `top-level keys: [${Object.keys(raw).join(', ')}]`
    );

    for (const seg of segments) {
      // Use 'words' (OpenAI) if present, else fall back to 'tokens' (whisper.cpp).
      const items = seg.words ?? seg.tokens ?? [];
      for (const item of items) {
        const rawText = item.word ?? item.text ?? '';
        const text = String(rawText).trim();
        if (!text) continue;
        // whisper.cpp special tokens to skip:
        //   "[BLANK_AUDIO]", "[_BEG_]", "<|0.00|>", "<|en|>", etc.
        if (/^[\[<]/.test(text) || /^\[_/.test(text)) continue;

        // Time extraction:
        //   whisper.cpp: item.offsets = {from, to} in MILLISECONDS (ints)
        //   OpenAI:      item.start / item.end in SECONDS (floats)
        let start_ms, end_ms;
        if (item.offsets && typeof item.offsets.from === 'number') {
          start_ms = item.offsets.from;
          end_ms = item.offsets.to;
        } else {
          const startSec =
            typeof item.start === 'number' ? item.start : Number(item.start) || 0;
          const endSec =
            typeof item.end === 'number' ? item.end : Number(item.end) || startSec;
          start_ms = Math.round(startSec * 1000);
          end_ms = Math.round(endSec * 1000);
        }
        word_timestamps.push({ word: text, start_ms, end_ms });
      }
      if (seg.text) transcriptParts.push(String(seg.text).trim());
    }

    const transcript = transcriptParts.length
      ? transcriptParts.join(' ').replace(/\s+/g, ' ').trim()
      : word_timestamps.map((w) => w.word).join(' ');

    // When word_timestamps is empty, expose diagnostic info in the response
    // so the Vercel-side caller can save it for inspection. Without this we
    // have no visibility into Whisper's actual output shape from outside the
    // Railway box.
    let _debug = null;
    if (word_timestamps.length === 0) {
      const sample = JSON.stringify(raw).slice(0, 2000);
      console.warn(`[audio-transcribe] PARSED ZERO WORDS. Raw sample: ${sample}`);
      _debug = {
        rawTopLevelKeys: Object.keys(raw),
        rawIsArray: Array.isArray(raw),
        rawSample: sample,
        segmentsCount: segments.length,
        firstSegmentKeys: segments[0] ? Object.keys(segments[0]) : null,
        firstSegmentSample: segments[0] ? JSON.stringify(segments[0]).slice(0, 1000) : null,
      };
    }

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
      ..._debug ? { _debug } : {},
    });
  } catch (err) {
    console.error('[audio-transcribe] error:', err?.message ?? err);
    next(err);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
