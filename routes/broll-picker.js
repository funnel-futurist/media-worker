/**
 * routes/broll-picker.js
 *
 * Milestone 1 of the clean-mode pipeline migration: a pure JSON-in/JSON-out
 * Gemini call hosted on Railway. No Supabase, no ffmpeg, no file I/O. Single
 * purpose: prove that Railway's GEMINI_API_KEY can call the production-target
 * model (gemini-3.1-pro-preview) without the FreeTier 429 we hit with the
 * local key. If this returns 200 with valid insertions, the broader
 * clean-mode migration architecture is viable.
 *
 * Auth: bearer WORKER_SECRET (handled by global middleware in server.js).
 *
 * Input/output match scripts/add_brolls.ts:callGeminiForInsertions on the
 * creative-engine side, so the existing local CLI logic ports cleanly when
 * we move to M2 (full pipeline).
 */

import { Router } from 'express';
import axios from 'axios';

export const brollPickerRouter = Router();

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.1-pro-preview';
const RATE_LIMIT_BACKOFFS_MS = [3000, 10000];
const SERVER_ERROR_BACKOFFS_MS = [2000, 5000];

// Cache the available Gemini models list. Populated lazily on first request
// (one extra HTTP call per worker boot — negligible). Reject any request
// whose `model` isn't in this list with a clear 404 + the available list.
let availableModelsCache = null;
let modelsCacheError = null;

async function getAvailableModels() {
  if (availableModelsCache) return availableModelsCache;
  if (modelsCacheError) throw modelsCacheError;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set on Railway');
  try {
    const res = await axios.get(`${GEMINI_API_BASE}?key=${apiKey}`, {
      timeout: 15_000,
    });
    const names = (res.data?.models ?? [])
      .map((m) => (typeof m?.name === 'string' ? m.name.replace(/^models\//, '') : null))
      .filter(Boolean);
    if (names.length === 0) {
      throw new Error('Gemini Models endpoint returned empty list');
    }
    availableModelsCache = names;
    return names;
  } catch (err) {
    // Don't permanently cache errors — the next request gets a fresh attempt.
    const status = err.response?.status ?? 0;
    const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : err.message;
    throw new Error(`Failed to list Gemini models (status=${status}): ${body}`);
  }
}

/**
 * POST /broll-picker
 *
 * Body:
 *   {
 *     transcript: Array<{ startSec: number, endSec: number, text: string }>,
 *     library: Array<{
 *       asset_id: string, asset_title: string, asset_type?: string,
 *       content_strategy_type?: string, context?: string, insight?: string,
 *       emotion?: string, when_to_use?: string,
 *     }>,
 *     totalDuration: number,
 *     brollDensity?: number,           // default 0.35
 *     model?: string,                  // default 'gemini-3.1-pro-preview'
 *   }
 *
 * Response (200):
 *   {
 *     insertions: Array<{
 *       startSec: number, endSec: number, asset_id: string,
 *       reason: string, matchedPhrase: string,
 *     }>,
 *     model: string,
 *   }
 */
brollPickerRouter.post('/broll-picker', async (req, res, next) => {
  try {
    const {
      transcript,
      library,
      totalDuration,
      brollDensity = 0.35,
      model: requestedModel,
    } = req.body || {};

    // ── Validate body shape ─────────────────────────────────────────
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return res.status(400).json({ error: 'transcript must be a non-empty array of { startSec, endSec, text }' });
    }
    if (!Array.isArray(library) || library.length === 0) {
      return res.status(400).json({ error: 'library must be a non-empty array of broll metadata objects' });
    }
    if (typeof totalDuration !== 'number' || totalDuration <= 0) {
      return res.status(400).json({ error: 'totalDuration must be a positive number (seconds)' });
    }
    if (typeof brollDensity !== 'number' || brollDensity <= 0 || brollDensity > 1) {
      return res.status(400).json({ error: 'brollDensity must be a number in (0, 1]' });
    }

    const model = typeof requestedModel === 'string' && requestedModel.length > 0
      ? requestedModel
      : DEFAULT_MODEL;

    // ── Validate model is in Gemini's available list ────────────────
    let availableModels;
    try {
      availableModels = await getAvailableModels();
    } catch (err) {
      console.error('[broll-picker] could not fetch available models:', err.message);
      return res.status(502).json({ error: `Could not validate model: ${err.message}` });
    }
    if (!availableModels.includes(model)) {
      return res.status(404).json({
        error: `Model '${model}' not available on this Gemini API key`,
        availableModels,
      });
    }

    // ── Build prompts (mirrors scripts/add_brolls.ts) ───────────────
    const systemPrompt = `You are an expert short-form video editor selecting b-roll insertions for a 9:16 talking-head reel. You receive a transcript with sentence-level timestamps and a library of available b-roll assets with metadata. You return a JSON insertion plan: which seconds of the video should cut to which b-roll asset, and why.

Return ONLY valid JSON of shape:
{
  "insertions": [
    { "startSec": number, "endSec": number, "asset_id": string, "reason": string, "matchedPhrase": string }
  ]
}

No prose, no markdown fences, no commentary outside the JSON.`;

    const targetBrollSec = totalDuration * brollDensity;

    const userPrompt = `Transcript with sentence-level timestamps:
${JSON.stringify(transcript, null, 2)}

Total video duration: ${totalDuration.toFixed(2)}s
Target b-roll runtime: ~${targetBrollSec.toFixed(2)}s (${(brollDensity * 100).toFixed(0)}% of total)

Available b-roll library:
${JSON.stringify(library, null, 2)}

Constraints:
- Pick brolls only at moments where the visual genuinely explains, illustrates, or reinforces what the speaker is saying.
- Do NOT insert during transitions, abstract claims, or pure talky moments.
- Density target: ~${(brollDensity * 100).toFixed(0)}% of total runtime.
- Variety: never reuse the same asset_id twice in this video.
- Insertion duration: match the spoken phrase the broll is paired with, bounded [2.5s, 5.0s].
- Min 4s spacing between consecutive brolls.
- The matchedPhrase should be the exact text of the sentence (or a substring) that justifies the broll.
- The reason should be a short sentence explaining why this specific broll fits this specific moment.

Return ONLY the JSON object described in the system prompt.`;

    const requestBody = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.5,
        maxOutputTokens: 8192,
      },
    };

    // ── Call Gemini with retry on 429/5xx ───────────────────────────
    console.log(`[broll-picker] calling Gemini model=${model}, transcript=${transcript.length} sentences, library=${library.length} brolls`);
    const geminiResult = await callGeminiWithRetry(model, requestBody);

    if (!geminiResult.ok) {
      // Pass through Gemini's error verbatim — caller (and we) need to see
      // 429 / FreeTier vs 404 model not found vs 5xx upstream.
      return res.status(geminiResult.status || 502).json({
        error: 'Gemini upstream error',
        upstreamStatus: geminiResult.status,
        upstreamBody: geminiResult.body,
      });
    }

    // ── Parse Gemini response ───────────────────────────────────────
    const text = geminiResult.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return res.status(502).json({
        error: 'Gemini returned empty response',
        rawResponse: JSON.stringify(geminiResult.data).slice(0, 1000),
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return res.status(502).json({
        error: `Gemini returned invalid JSON: ${err.message}`,
        rawText: text.slice(0, 1000),
      });
    }

    if (!Array.isArray(parsed.insertions)) {
      return res.status(502).json({
        error: "Gemini response missing 'insertions' array",
        rawText: text.slice(0, 1000),
      });
    }

    console.log(`[broll-picker] success: model=${model}, returned ${parsed.insertions.length} insertions`);

    res.json({
      insertions: parsed.insertions,
      model,
    });
  } catch (err) {
    console.error('[broll-picker] error:', err?.message ?? err);
    next(err);
  }
});

/**
 * Call Gemini's generateContent with retry on 429 / 5xx. Pass-through on
 * 4xx (caller bug) and on success.
 *
 * Returns:
 *   { ok: true, data }                 — successful 200
 *   { ok: false, status, body }        — non-retryable error or retries exhausted
 */
async function callGeminiWithRetry(model, body) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
  const maxAttempts = 2;

  let lastStatus = 0;
  let lastBody = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res;
    try {
      res = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60_000,
        validateStatus: () => true, // capture all statuses; we decide
      });
    } catch (err) {
      // Pure network error
      lastStatus = 0;
      lastBody = err.message;
      if (attempt === maxAttempts - 1) break;
      const delay = SERVER_ERROR_BACKOFFS_MS[attempt] ?? 5000;
      console.log(`[broll-picker] network error — retrying in ${delay}ms (attempt ${attempt + 2}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    // Success
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, data: res.data };
    }

    lastStatus = res.status;
    lastBody = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

    // Non-retryable client error
    if (res.status !== 429 && res.status < 500) {
      return { ok: false, status: res.status, body: lastBody };
    }

    // Out of retries
    if (attempt === maxAttempts - 1) break;

    const delays = res.status === 429 ? RATE_LIMIT_BACKOFFS_MS : SERVER_ERROR_BACKOFFS_MS;
    const delay = delays[attempt] ?? delays[delays.length - 1];
    console.log(`[broll-picker] ${res.status} ${res.status === 429 ? 'rate-limited' : 'server-error'} — retrying in ${delay}ms (attempt ${attempt + 2}/${maxAttempts})`);
    await new Promise((r) => setTimeout(r, delay));
  }

  return { ok: false, status: lastStatus, body: lastBody };
}
