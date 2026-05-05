/**
 * lib/broll_picker.js
 *
 * Gemini-based b-roll insertion planner. Extracted from routes/broll-picker.js
 * (M1 endpoint) so the M2 clean-mode-compose pipeline can call this directly
 * instead of doing an internal HTTP hop.
 *
 * The exported helpers are:
 *   1. getAvailableModels(apiKey) — lazily-cached model list (one extra HTTP
 *      call per worker boot). Used to validate the requested model before
 *      we burn a generateContent call on a 404.
 *   2. pickBrollInsertions({...}) — the full Gemini generateContent call:
 *      builds prompts, calls with retry, parses JSON. Returns either a
 *      success envelope or a typed-error envelope so callers can map to
 *      HTTP status codes (route) or throw (M2 pipeline).
 *
 * Mirrors scripts/add_brolls.ts:callGeminiForInsertions on the creative-engine
 * side so the contract stays identical between the local CLI flow and the
 * Railway endpoint.
 */

import axios from 'axios';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const RATE_LIMIT_BACKOFFS_MS = [3000, 10000];
const SERVER_ERROR_BACKOFFS_MS = [2000, 5000];

export const DEFAULT_MODEL = 'gemini-3.1-pro-preview';

// Module-level cache. Populated lazily on first request.
let availableModelsCache = null;

/**
 * Fetch the list of Gemini models available to the given API key. Cached
 * for the lifetime of the process — model availability changes rarely.
 *
 * @param {string} apiKey
 * @returns {Promise<string[]>}  array of model ids without the `models/` prefix
 */
export async function getAvailableModels(apiKey) {
  if (availableModelsCache) return availableModelsCache;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set on Railway');
  try {
    const res = await axios.get(`${GEMINI_API_BASE}?key=${apiKey}`, { timeout: 15_000 });
    const names = (res.data?.models ?? [])
      .map((m) => (typeof m?.name === 'string' ? m.name.replace(/^models\//, '') : null))
      .filter(Boolean);
    if (names.length === 0) {
      throw new Error('Gemini Models endpoint returned empty list');
    }
    availableModelsCache = names;
    return names;
  } catch (err) {
    const status = err.response?.status ?? 0;
    const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : err.message;
    throw new Error(`Failed to list Gemini models (status=${status}): ${body}`);
  }
}

/**
 * Build the system + user prompts for the b-roll picker. Pure function so
 * tests can lock down prompt wording without making network calls.
 */
function buildPrompts({ transcript, library, totalDuration, brollDensity }) {
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

  return { systemPrompt, userPrompt };
}

/**
 * Call Gemini's generateContent with retry on 429 / 5xx.
 *
 * @returns {Promise<{ ok: true, data: object } | { ok: false, status: number, body: string }>}
 */
async function callGeminiWithRetry(model, apiKey, body) {
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
        validateStatus: () => true,
      });
    } catch (err) {
      lastStatus = 0;
      lastBody = err.message;
      if (attempt === maxAttempts - 1) break;
      const delay = SERVER_ERROR_BACKOFFS_MS[attempt] ?? 5000;
      console.log(`[broll_picker] network error — retrying in ${delay}ms (attempt ${attempt + 2}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (res.status >= 200 && res.status < 300) {
      return { ok: true, data: res.data };
    }

    lastStatus = res.status;
    lastBody = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

    if (res.status !== 429 && res.status < 500) {
      return { ok: false, status: res.status, body: lastBody };
    }

    if (attempt === maxAttempts - 1) break;
    const delays = res.status === 429 ? RATE_LIMIT_BACKOFFS_MS : SERVER_ERROR_BACKOFFS_MS;
    const delay = delays[attempt] ?? delays[delays.length - 1];
    console.log(`[broll_picker] ${res.status} ${res.status === 429 ? 'rate-limited' : 'server-error'} — retrying in ${delay}ms (attempt ${attempt + 2}/${maxAttempts})`);
    await new Promise((r) => setTimeout(r, delay));
  }

  return { ok: false, status: lastStatus, body: lastBody };
}

/**
 * Plan b-roll insertions for a transcript via Gemini.
 *
 * Result envelope (keeps caller in control of HTTP status mapping):
 *   { ok: true, insertions, model }
 *   { ok: false, kind: 'upstream', status, body }       — Gemini 4xx/5xx pass-through
 *   { ok: false, kind: 'empty', rawResponse }           — Gemini returned no text
 *   { ok: false, kind: 'parse', error, rawText }        — text wasn't valid JSON
 *   { ok: false, kind: 'shape', message, rawText }      — JSON missing insertions[]
 *
 * @param {Object} args
 * @param {Array<{ startSec: number, endSec: number, text: string }>} args.transcript
 * @param {Array<object>} args.library  rows from broll_library
 * @param {number} args.totalDuration
 * @param {number} [args.brollDensity=0.35]
 * @param {string} [args.model='gemini-3.1-pro-preview']
 * @param {string} args.apiKey
 */
export async function pickBrollInsertions({
  transcript,
  library,
  totalDuration,
  brollDensity = 0.35,
  model = DEFAULT_MODEL,
  apiKey,
}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY not provided to pickBrollInsertions');

  const { systemPrompt, userPrompt } = buildPrompts({ transcript, library, totalDuration, brollDensity });
  const requestBody = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.5,
      maxOutputTokens: 8192,
    },
  };

  console.log(`[broll_picker] calling Gemini model=${model}, transcript=${transcript.length} sentences, library=${library.length} brolls`);
  const geminiResult = await callGeminiWithRetry(model, apiKey, requestBody);

  if (!geminiResult.ok) {
    return { ok: false, kind: 'upstream', status: geminiResult.status, body: geminiResult.body };
  }

  const text = geminiResult.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    return { ok: false, kind: 'empty', rawResponse: JSON.stringify(geminiResult.data).slice(0, 1000) };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, kind: 'parse', error: err.message, rawText: text.slice(0, 1000) };
  }
  if (!Array.isArray(parsed.insertions)) {
    return { ok: false, kind: 'shape', message: "Gemini response missing 'insertions' array", rawText: text.slice(0, 1000) };
  }

  console.log(`[broll_picker] success: model=${model}, returned ${parsed.insertions.length} insertions`);
  return { ok: true, insertions: parsed.insertions, model };
}
