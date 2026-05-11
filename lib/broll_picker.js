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
 * tests can lock down prompt wording without making network calls. Exported
 * so the prefer-client constraint (PR-D) can be snapshot-locked without
 * spawning a Gemini call.
 */
/**
 * Build the SOURCE MIX rule for the picker prompt. Internal helper for
 * `buildPrompts`. Two variants today; future modes (e.g. 'client_first'
 * for the opposite extreme) can be added without changing buildPrompts.
 *
 * Returned string is a single Constraints-bullet line ready to drop into
 * the prompt.
 */
function buildSourceMixClause(clientPreference) {
  if (clientPreference === 'minimal') {
    // Phil-style libraries: mostly static photos / repetitive imagery that
    // doesn't carry the edit well at high density. Push Gemini hard
    // toward stock; allow 1-2 client picks for brand identity only.
    return `- SOURCE MIX (MINIMAL-CLIENT MODE) — This client's b-roll library is mostly static photos or repetitive imagery that does not translate well to motion at high density. STRONGLY PREFER Pixabay stock (provenance="pixabay") for every spoken moment. Use client assets (provenance="client") ONLY when (1) the client asset is clearly and obviously the best fit for a specific moment that no stock equivalent explains as well, OR (2) to anchor 1-2 moments with authentic brand/client footage for visual identity. Default to STOCK for all other moments. Do NOT over-pick client b-roll just because it exists in the library. Aim for at most 1-2 client picks per video; the rest should be stock.`;
  }
  // Default 'balanced' — the AI-blend "USE BOTH" rule from PR-F.
  return `- SOURCE MIX — When the library contains BOTH client-provided assets (provenance="client") AND Pixabay stock assets (provenance="pixabay"), USE BOTH. The audience benefits from a healthy mix of authentic client footage and supporting stock visuals. For each spoken moment, pick the asset that best fits the line — prefer client only when relevance is genuinely similar; pick stock when it explains the moment more directly or fills a beat the client library doesn't cover well. Don't force one source; don't force the other. Aim for a healthy mix when both are available; pick exclusively from one source only when the other genuinely doesn't fit any moment.`;
}

/**
 * Build picker prompts. PR #130 (2026-05-12) adds `clientPreference`:
 *
 *   'balanced'  (default) — AI-blend "USE BOTH" rule from PR-F. Picker
 *                           treats client + stock equally per-moment.
 *                           Used by every client with a video-heavy or
 *                           good-quality client b-roll library.
 *   'minimal'             — Strong stock bias. Client b-roll is allowed
 *                           only when CLEARLY the best fit, capped at
 *                           ~1-2 picks per video for brand identity.
 *                           Used for clients whose library is mostly
 *                           static photos / repetitive images that don't
 *                           translate well to motion (Phil's library).
 *
 * The bias lives in the prompt — Gemini decides per-moment whether to
 * honor it. Post-pick enforcement (PR-F `rebalanceClientFirst`) still
 * applies, with `brollMaxStockRatio` clamping the ceiling regardless.
 */
/**
 * Compute a short aspect descriptor for the system prompt (e.g. '9:16 talking-head reel',
 * '4:5 talking-head ad', '1:1 square video'). Selection is content-flavored: 4:5 is the
 * standard ad-creative aspect, 9:16 is the standard reel/short, 1:1 is legacy square.
 * Falls back to "{W}×{H} talking-head video" for unknown aspects.
 */
function describeAspect(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '9:16 talking-head reel';
  }
  // Reduce to integer ratio for comparison.
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(width, height);
  const rw = width / g;
  const rh = height / g;
  if (rw === 9 && rh === 16) return '9:16 talking-head reel';
  if (rw === 4 && rh === 5) return '4:5 talking-head ad';
  if (rw === 1 && rh === 1) return '1:1 square talking-head video';
  if (rw === 16 && rh === 9) return '16:9 landscape talking-head video';
  return `${width}×${height} talking-head video`;
}

export function buildPrompts({
  transcript,
  library,
  totalDuration,
  brollDensity,
  clientPreference = 'balanced',
  outputWidth = 1080,
  outputHeight = 1920,
}) {
  const aspectDescriptor = describeAspect(outputWidth, outputHeight);
  const systemPrompt = `You are an expert short-form video editor selecting b-roll insertions for a ${aspectDescriptor}. You receive a transcript with sentence-level timestamps and a library of available b-roll assets with metadata. You return a JSON insertion plan: which seconds of the video should cut to which b-roll asset, and why.

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
- ASSET ID FIDELITY — Copy the full asset_id EXACTLY VERBATIM from the library candidate list. Do NOT truncate, shorten, or abbreviate UUIDs (e.g., never emit "1c2817be" when the library row is "1c2817be-8326-4f4c-a666-56d422f44612" — emit the full string with all dashes). Do NOT invent or fabricate IDs. Return only IDs that appear in the library JSON above. The downstream pipeline matches insertion.asset_id against the library by exact-string equality first.
${buildSourceMixClause(clientPreference)}

Return ONLY the JSON object described in the system prompt.`;

  return { systemPrompt, userPrompt };
}

/**
 * Call Gemini's generateContent with retry on 429 / 5xx.
 *
 * Per-attempt timeout: 120s (PR #113 — bumped from 60s after B9 attempts on
 * 2026-05-08 hit two consecutive 60s timeouts on `gemini-3.1-pro-preview` for
 * Phil's source. Pro model latency varies day-to-day; B7 ran broll_pick in
 * 21-115s on prior days but elevated to >60s on 2026-05-08. The wider budget
 * absorbs Pro's tail latency without downgrading to Flash. With maxAttempts=2,
 * worst-case wall time is ~240s before failing — acceptable for the quality
 * Pro provides on broll selection. Do NOT switch to Flash here without
 * Shannon's explicit approval.).
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
        timeout: 120_000,
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
  clientPreference = 'balanced',
  outputWidth = 1080,
  outputHeight = 1920,
}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY not provided to pickBrollInsertions');

  const { systemPrompt, userPrompt } = buildPrompts({
    transcript, library, totalDuration, brollDensity, clientPreference,
    outputWidth, outputHeight,
  });
  const requestBody = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.5,
      // Bumped 8192 → 16384 on 2026-05-11 after a real production run
      // (jobId=62c08f03-458e-4d35-a57b-b5550200a434, content_item
      // 5d69189c-be10-43d0-b4ff-0277cb2052e3) failed at brollPick with
      // "Unexpected end of JSON input" — Gemini 3.1 Pro consumes a
      // variable number of tokens on internal reasoning, then emits the
      // structured JSON. Output scales with library×insertions×field
      // length (one record per pick with reason + matchedPhrase strings),
      // so 8192 ran dry mid-emit on this clip even though an earlier
      // sync-verify run on the SAME source got lucky. 16384 is well
      // within Gemini Pro's 65536 cap, and you only pay for tokens
      // actually emitted (not the cap), so the bump costs nothing
      // except removing a class of intermittent failure.
      maxOutputTokens: 16384,
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
