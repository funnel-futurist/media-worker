import { Router } from 'express';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, readFileSync, unlinkSync, existsSync, createWriteStream, statSync } from 'fs';
import { pipeline } from 'stream/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);

export const classifyRouter = Router();

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_UPLOAD_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const MODEL = 'gemini-2.0-flash';

/**
 * Stream-download a URL straight to disk via axios stream + Node pipeline.
 *
 * Exists because the previous `axios.get(url, { responseType: 'arraybuffer' })`
 * path in this file OOM-d the Railway worker (or surfaced as the generic
 * undici "fetch failed" with no actionable `cause`) on 500MB+ long-form
 * sources. Streaming caps RSS at the pipe's internal high-water-mark
 * (default 16 KB) regardless of source size.
 *
 * On error: cleans up any partial bytes already written so retries don't
 * accumulate orphan files, and promotes any hidden `err.cause` chain
 * (axios / undici hide ECONNRESET, UND_ERR_HEADERS_TIMEOUT, etc. behind a
 * generic top-level message) into the thrown Error's message so the
 * downstream `last_error` row column is actionable.
 *
 * Exported for the test in test/classify_stream_download.test.js.
 *
 * @param {string} url            HTTP(S) URL to download
 * @param {string} destPath       Absolute path to write the response body to
 * @param {object} [opts]
 * @param {number} [opts.timeout] axios per-request timeout (ms). 0 = no timeout
 *                                — appropriate for large bodies on slow links.
 * @returns {Promise<{ bytes: number }>}
 */
export async function streamDownloadToTempFile(url, destPath, opts = {}) {
  try {
    const dl = await axios.get(url, {
      responseType: 'stream',
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: opts.timeout ?? 0,
    });
    await pipeline(dl.data, createWriteStream(destPath));
    const bytes = statSync(destPath).size;
    return { bytes };
  } catch (err) {
    // Clean up the partial download — Railway's /tmp is ephemeral but tests
    // run on dev machines where the leak would persist.
    if (existsSync(destPath)) {
      try { unlinkSync(destPath); } catch { /* best-effort */ }
    }

    // Unwrap as much of the underlying transport error as the runtime gave us
    // so the thrown message isn't the opaque "fetch failed" placeholder.
    const parts = [];
    if (err.name && err.name !== 'Error') parts.push(`name=${err.name}`);
    if (err.code) parts.push(`code=${err.code}`);
    if (err.cause) {
      const c = err.cause;
      const causeBits = [
        c.name && c.name !== 'Error' ? `name=${c.name}` : null,
        c.code ? `code=${c.code}` : null,
        c.message ? `msg=${c.message}` : null,
      ].filter(Boolean).join(' ');
      if (causeBits) parts.push(`cause(${causeBits})`);
    }
    const detail = parts.length > 0 ? ` [${parts.join(' ')}]` : '';

    const wrapped = new Error(`Stream-download failed: ${err.message}${detail}`);
    // Preserve the original stack so Railway logs still show where it
    // originated rather than only this re-throw site.
    if (err.stack) wrapped.stack = `${wrapped.message}\nCaused by: ${err.stack}`;
    if (err.cause) wrapped.cause = err.cause;
    throw wrapped;
  }
}

function getGeminiKey() {
  const key = process.env.GEMINI_API_KEY?.replace(/\\n/g, '').trim();
  if (!key) throw new Error('GEMINI_API_KEY is not set in Railway env vars');
  return key;
}

function getSupabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_KEY is not set in Railway env vars');
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'marketing',
    'Content-Profile': 'marketing',
  };
}

function getSupabaseUrl() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL is not set in Railway env vars');
  return url;
}

async function supabaseUpdate(table, id, data) {
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: getSupabaseHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} failed: ${await res.text()}`);
}

async function supabaseInsert(table, data) {
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/${table}`, {
    method: 'POST',
    headers: getSupabaseHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase POST ${table} failed: ${await res.text()}`);
}

async function uploadToGeminiFiles(buffer, mimeType, displayName) {
  const apiKey = getGeminiKey();

  const initRes = await fetch(`${GEMINI_UPLOAD_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buffer.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });

  const uploadUrl = initRes.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) {
    const body = await initRes.text().catch(() => '(unreadable)');
    throw new Error(`Failed to get Gemini upload URL (HTTP ${initRes.status}): ${body.slice(0, 300)}`);
  }

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'Content-Length': String(buffer.length),
    },
    body: new Uint8Array(buffer),
  });

  if (!uploadRes.ok) throw new Error(`Gemini file upload failed: ${await uploadRes.text()}`);

  const fileData = await uploadRes.json();
  let fileState = fileData.file.state;
  const fileName = fileData.file.name;

  const deadline = Date.now() + 180_000; // 3 min max
  while (fileState === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error('Gemini file processing timed out after 3 minutes');
    await new Promise(r => setTimeout(r, 5000));
    const checkRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`
    );
    const checkData = await checkRes.json();
    fileState = checkData.state;
    if (fileState === 'ACTIVE') return checkData.uri;
    if (fileState === 'FAILED' || fileState === 'ERROR') {
      throw new Error(`Gemini file processing failed: ${fileState}`);
    }
  }

  return fileData.file.uri;
}

async function callGemini(fileUri, mimeType, prompt) {
  const apiKey = getGeminiKey();

  // Append a size constraint — Submagic handles transcription/silence/bad-takes,
  // so we only need classification metadata from Gemini.
  const compactConstraint = `

CRITICAL OUTPUT CONSTRAINT (token limit):
- word_timestamps → EMPTY ARRAY []
- silence_map → EMPTY ARRAY []
- bad_take_flags → EMPTY ARRAY []
- timestamps → EMPTY ARRAY []
- broll_cues → REQUIRED: pick 3-5 natural moments where a cutaway would work. Format EXACTLY: [{"time_seconds": 5, "duration_seconds": 4, "cue": "one-line visual description grounded in what the speaker is saying at this exact moment — used for b-roll library matching, so be specific (e.g. 'team member at computer', 'speaker pointing at whiteboard', 'close-up of product', not generic labels)"}] — integer seconds only
- transcript → ONE sentence only (max 30 words)
- emotion_tags → REQUIRED: 1-2 tags based on delivery tone

Focus all tokens on accurate classification, quality scores, pipeline routing, broll_cues, and emotion_tags.`;

  const res = await fetch(`${GEMINI_API_URL}/${MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { file_data: { mime_type: mimeType, file_uri: fileUri } },
          { text: prompt + compactConstraint },
        ],
      }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 8192 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini API error: ${await res.text()}`);

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');

  return JSON.parse(text);
}

async function runClassification({ ingestionId, storageUrl, mimeType, filename, clientId, prompt, slackChannel, clientName, driveFileId, driveToken }) {
  try {
    console.log(`[classify] starting: ${ingestionId} (${filename})`);

    let buffer;
    // Path to the source video on local disk. Set by both Drive and portal
    // paths below — Drive writes a materialized buffer here for ffmpeg;
    // portal streams directly to this path without ever materializing the
    // full file in memory.
    let sourceFilePath;
    if (driveFileId && driveToken) {
      // Download directly from Google Drive (avoids Vercel serverless memory limits)
      console.log(`[classify] downloading from Drive: ${driveFileId}`);
      const driveRes = await axios.get(
        `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
        { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${driveToken}` } }
      );
      buffer = Buffer.from(driveRes.data);
      console.log(`[classify] Drive download complete: ${Math.round(buffer.length / 1024 / 1024)}MB`);

      // Upload to Supabase Storage so ad_ingestion.file_url becomes a stable URL
      // Use axios (not fetch) — native fetch silently fails for large buffers (100MB+).
      // maxBodyLength/maxContentLength: Infinity required for 100-500MB video files.
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (supabaseUrl && supabaseKey) {
        const datePrefix = new Date().toISOString().split('T')[0];
        // Sanitize filename for Supabase Storage — replace em-dashes, smart quotes,
        // and other non-ASCII characters that cause InvalidKey errors
        const safeFilename = filename
          .replace(/[\u2014\u2013]/g, '-')   // em-dash, en-dash → hyphen
          .replace(/[\u2018\u2019\u201C\u201D]/g, "'")  // smart quotes → straight
          .replace(/[^\x20-\x7E]/g, '_')     // any remaining non-ASCII → underscore
          .replace(/\s+/g, '_');              // spaces → underscores
        const storagePath = `raw-intake/${clientId}/${datePrefix}/${safeFilename}`;
        try {
          await axios.post(
            `${supabaseUrl}/storage/v1/object/video-modules/${storagePath}`,
            buffer,
            {
              headers: { Authorization: `Bearer ${supabaseKey}`, 'Content-Type': mimeType, 'x-upsert': 'true' },
              maxBodyLength: Infinity,
              maxContentLength: Infinity,
            }
          );
          const publicUrl = `${supabaseUrl}/storage/v1/object/public/video-modules/${storagePath}`;
          await supabaseUpdate('ad_ingestion', ingestionId, { file_url: publicUrl });
          console.log(`[classify] uploaded to Supabase Storage: ${storagePath}`);
        } catch (uploadErr) {
          const detail = uploadErr.response?.data ? JSON.stringify(uploadErr.response.data) : uploadErr.message;
          console.error(`[classify] Supabase Storage upload failed: ${detail}`);
          throw new Error(`Supabase Storage upload failed: ${detail}`);
        }
      }
    } else {
      // Portal path: stream the signed URL directly to disk. Previously this
      // buffered the whole response into memory via
      // `axios.get(..., { responseType: 'arraybuffer' })` and then `writeFileSync`-d
      // it back out. For long-form uploads (500MB+, e.g. the 535MB 36-min
      // case that surfaced this bug on 2026-06-06) that path either OOM-d
      // the worker or surfaced as undici "fetch failed" with no `cause` chain,
      // both producing the same useless `last_error: "fetch failed"` row
      // state. Streaming caps memory at the stream's internal buffer
      // (default 16 KB) regardless of file size, and only the ffmpeg-trimmed
      // ~180s slice ever lands in a JS Buffer for the Gemini upload below.
      sourceFilePath = join('/tmp', `${randomUUID()}_classify_dl.mp4`);
      console.log(`[classify] streaming portal source to ${sourceFilePath}`);
      const { bytes } = await streamDownloadToTempFile(storageUrl, sourceFilePath);
      console.log(`[classify] streamed ${Math.round(bytes / 1024 / 1024)}MB to disk (${bytes} bytes)`);
    }

    // Drive path produced `buffer` for the Supabase Storage re-upload step
    // above but still needs an on-disk copy for ffmpeg below. Materialize it.
    if (buffer && !sourceFilePath) {
      sourceFilePath = join('/tmp', `${randomUUID()}_classify_raw.mp4`);
      writeFileSync(sourceFilePath, buffer);
    }

    // 2. Trim to 3 min for Gemini — full 150-200MB videos cause Gemini init failures
    //    (rate limit / payload size). Classification only needs a representative sample.
    //    broll_cues up to 180s are still accurate; hook/emotion/quality unaffected.
    const CLASSIFY_MAX_SECONDS = 180;
    const trimPath = join('/tmp', `${randomUUID()}_classify_trim.mp4`);
    let geminiBuffer;
    try {
      await execAsync(`ffmpeg -i "${sourceFilePath}" -t ${CLASSIFY_MAX_SECONDS} -c copy -y "${trimPath}"`, { timeout: 60000 });
      if (existsSync(trimPath)) {
        geminiBuffer = readFileSync(trimPath);
        console.log(`[classify] trimmed to ${CLASSIFY_MAX_SECONDS}s for Gemini: ${Math.round(geminiBuffer.length / 1024 / 1024)}MB`);
      } else {
        // ffmpeg returned 0 without producing the trim file. Fall back to the
        // source so behaviour matches the pre-stream version on small files.
        geminiBuffer = readFileSync(sourceFilePath);
        console.warn(`[classify] trim produced no output; using full source (${Math.round(geminiBuffer.length / 1024 / 1024)}MB)`);
      }
    } catch (trimErr) {
      console.warn(`[classify] ffmpeg trim failed, using full source: ${trimErr.message}`);
      geminiBuffer = readFileSync(sourceFilePath);
    } finally {
      if (existsSync(sourceFilePath)) unlinkSync(sourceFilePath);
      if (existsSync(trimPath)) unlinkSync(trimPath);
    }

    // 3. Upload to Gemini Files API
    const fileUri = await uploadToGeminiFiles(geminiBuffer, mimeType, filename);
    console.log(`[classify] Gemini file ready: ${fileUri}`);

    // 4. Call Gemini
    const result = await callGemini(fileUri, mimeType, prompt);
    console.log(`[classify] classified: ${result.classification?.asset_type} (${result.classification?.confidence})`);

    // 5. Update ad_ingestion
    await supabaseUpdate('ad_ingestion', ingestionId, {
      asset_type: result.classification.asset_type,
      gemini_classification: { ...result.classification, performance_analysis: result.performance_analysis ?? null },
      gemini_markup: { ...(result.markup ?? {}), emotion_tags: result.emotion_tags ?? [] },
      re_record_flag: result.classification.re_record_flag ?? false,
      re_record_notes: result.classification.re_record_notes ?? null,
      pipeline: result.pipeline_routing?.pipeline ?? null,
      sub_pipeline: result.pipeline_routing?.sub_pipeline ?? null,
      editing_program: result.pipeline_routing?.editing_program ?? null,
      audience_context: result.audience_context ?? {},
      status: 'classified',
      last_error: null,
    });

    // 6. Log classification_complete event
    await supabaseInsert('content_pipeline_events', {
      client_id: clientId,
      event_type: 'classification_complete',
      source_module: 'railway/classify-async',
      metadata: {
        ingestion_id: ingestionId,
        asset_type: result.classification.asset_type,
        confidence: result.classification.confidence,
        quality_score: result.classification.quality_score,
        energy_score: result.classification.energy_score,
        pipeline: result.pipeline_routing?.pipeline ?? null,
        re_record_flag: result.classification.re_record_flag ?? false,
      },
    });

    // 7. Slack notification — classification always goes to internal ops channel only
    const channel = process.env.SLACK_CHANNEL_OPS || slackChannel;
    const slackToken = process.env.SLACK_BOT_TOKEN;
    if (channel && slackToken) {
      const perf = result.performance_analysis;
      const rating = perf?.overall_rating ?? null;
      const verdictEmoji = { green: '🟢', yellow: '🟡', red: '🔴' }[rating] ?? '⚪';
      const verdictLabel = { green: 'Green — good to go', yellow: 'Yellow — usable, not peak', red: 'Red — re-record needed' }[rating] ?? 'No performance rating';

      const lines = [
        `📥 *${clientName || 'Client'}* uploaded a video`,
        `*File:* ${filename}`,
        '',
        `*${verdictEmoji} ${verdictLabel}*`,
        perf?.performance_notes ? `*Why:* ${perf.performance_notes}` : null,
        perf?.recommended_action ? `*Action:* ${perf.recommended_action}` : null,
        '',
        `_Type: \`${result.classification.asset_type}\` · Quality: ${result.classification.quality_score}/100 · Energy: ${result.classification.energy_score}/100_`,
      ].filter(line => line !== null).join('\n');

      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${slackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel, text: lines }),
      }).catch(err => console.error('[classify] Slack notify failed:', err.message));
    }

    console.log(`[classify] done: ${ingestionId}`);
  } catch (err) {
    console.error(`[classify] failed: ${ingestionId}:`, err.message);

    // Revert to pending so staleness recovery or next cron can retry
    try {
      await supabaseUpdate('ad_ingestion', ingestionId, {
        status: 'pending',
        last_error: err.message,
      });
      await supabaseInsert('content_pipeline_events', {
        client_id: clientId,
        event_type: 'error',
        source_module: 'railway/classify-async',
        metadata: { ingestion_id: ingestionId, error: err.message },
      });
    } catch (dbErr) {
      console.error('[classify] DB update on error failed:', dbErr.message);
    }
  }
}

// ── POST /classify-async ───────────────────────────────────────────────────
// Responds immediately with { started: true }.
// Classification runs in the background on Railway (no timeout).
classifyRouter.post('/classify-async', async (req, res, next) => {
  try {
    const { ingestionId, storageUrl, mimeType, filename, clientId, prompt, slackChannel, clientName, driveFileId, driveToken } = req.body;

    if (!ingestionId || !mimeType || !prompt) {
      return res.status(400).json({
        error: 'Missing required fields: ingestionId, mimeType, prompt',
      });
    }

    // ACK immediately — Railway classifies in the background
    res.json({ started: true, ingestionId });

    runClassification({ ingestionId, storageUrl, mimeType, filename, clientId, prompt, slackChannel, clientName, driveFileId, driveToken })
      .catch(err => console.error('[classify-async] unhandled:', err.message));

  } catch (err) {
    next(err);
  }
});
