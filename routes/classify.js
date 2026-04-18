import { Router } from 'express';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);

export const classifyRouter = Router();

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_UPLOAD_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const MODEL = 'gemini-2.0-flash';

function getGeminiKey() {
  const key = process.env.GEMINI_API_KEY?.trim();
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
- broll_cues → REQUIRED: pick 3-5 natural moments where a cutaway would work. Format EXACTLY: [{"time_seconds": 5, "duration_seconds": 4}] — integer seconds only, no other fields
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
      // Download from Supabase Storage (legacy path)
      const { data: fileData } = await axios.get(storageUrl, { responseType: 'arraybuffer' });
      buffer = Buffer.from(fileData);
      console.log(`[classify] downloaded ${Math.round(buffer.length / 1024 / 1024)}MB`);
    }

    // 2. Trim to 3 min for Gemini — full 150-200MB videos cause Gemini init failures
    //    (rate limit / payload size). Classification only needs a representative sample.
    //    broll_cues up to 180s are still accurate; hook/emotion/quality unaffected.
    const CLASSIFY_MAX_SECONDS = 180;
    const rawPath = join('/tmp', `${randomUUID()}_classify_raw.mp4`);
    const trimPath = join('/tmp', `${randomUUID()}_classify_trim.mp4`);
    let geminiBuffer = buffer;
    try {
      writeFileSync(rawPath, buffer);
      await execAsync(`ffmpeg -i "${rawPath}" -t ${CLASSIFY_MAX_SECONDS} -c copy -y "${trimPath}"`, { timeout: 60000 });
      if (existsSync(trimPath)) {
        geminiBuffer = readFileSync(trimPath);
        console.log(`[classify] trimmed to ${CLASSIFY_MAX_SECONDS}s for Gemini: ${Math.round(geminiBuffer.length / 1024 / 1024)}MB`);
      }
    } catch (trimErr) {
      console.warn(`[classify] ffmpeg trim failed, using full buffer: ${trimErr.message}`);
    } finally {
      if (existsSync(rawPath)) unlinkSync(rawPath);
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
