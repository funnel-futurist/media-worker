/**
 * lib/stock_keyword_gen.js
 *
 * Gemini Pro generates 3-6 search keywords from the transcript when the
 * client b-roll library is short on coverage. The keywords are passed into
 * `searchPixabayVideos` to fetch supplemental stock candidates the broll
 * picker (also Gemini Pro) can choose from alongside client rows.
 *
 * Why a separate Gemini call (instead of folding into broll_picker):
 *   - Keeps the picker prompt unchanged — picker still gets a unified
 *     library array; it doesn't need to know that some rows are stock
 *   - Keeps keyword generation failure independent of picker failure
 *   - Lets us cap the picker prompt size (Pixabay candidates are added
 *     only if keywords succeed; otherwise client-only library is sent)
 *
 * Returns the same envelope shape as broll_picker / slate_detect /
 * bad_take_detect — `{ok, keywords|kind, ...}` — so the orchestrator can
 * handle failure modes consistently.
 *
 * Uses gemini-3.1-pro-preview by default per Shannon's "Gemini Pro only"
 * directive (no Flash anywhere in M2).
 */

import { fetchGeminiWithRetry } from './gemini_helpers.js';

const DEFAULT_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM_PROMPT = `You generate Pixabay video search keywords for short-form social-media reels.

The speaker has produced a talking-head reel. The client's b-roll library
doesn't have enough good matches to support every key beat in the
transcript. Your job: produce 3 to 6 short search keywords that will
return Pixabay stock footage RELEVANT to the message — not random or
overly generic visuals.

GOOD keywords:
  - Concrete subjects/objects/actions tied to the transcript (e.g.,
    "family planning home", "documents desk paperwork", "calendar pages",
    "parents children living room")
  - 2-4 words each, no quotes, no punctuation
  - Visual nouns + adjectives — what the camera should see, not abstractions

AVOID:
  - Generic emotional words alone ("hope", "concern", "trust") — paired
    with a concrete subject is fine
  - Brand names, logos, copyrighted properties
  - Person identifiers (names, jobs, ages) — Pixabay doesn't index people
    well and we want supportive imagery, not portraits
  - Single words — they return too much irrelevant content

Return ONLY this JSON (no markdown, no commentary):
{
  "keywords": ["...", "...", "..."],
  "reasoning": "<one-sentence summary of why these keywords>"
}`;

function buildUserPrompt({ transcript, clientLibrarySize, coverageGap, durationSec }) {
  // Compact transcript representation: just the speaker's text, no timestamps.
  // Keywords come from the message, not the timing.
  const transcriptText = Array.isArray(transcript)
    ? transcript.map((s) => s?.text ?? '').join(' ').trim()
    : String(transcript ?? '').trim();
  return [
    `Talking-head reel (${Math.round(durationSec)}s after cleanup).`,
    `Client b-roll library has ${clientLibrarySize} usable assets — short by ~${coverageGap} clips.`,
    `Generate ${Math.max(3, coverageGap)} to 6 keywords (no fewer than 3).`,
    '',
    `Transcript:`,
    transcriptText,
    '',
    SYSTEM_PROMPT.includes('Return ONLY this JSON') ? '' : 'Return ONLY this JSON: { "keywords": [...], "reasoning": "..." }',
  ].filter(Boolean).join('\n');
}

/**
 * Call Gemini Pro to generate stock-video search keywords.
 *
 * @param {Object} input
 * @param {Array<{startSec: number, endSec: number, text: string}>} input.transcript
 *   sentence-level transcript (same shape broll_picker receives)
 * @param {number} input.clientLibrarySize  # of usable client rows
 * @param {number} input.coverageGap        ceil(dur/8) - clientLibrarySize, ≥1
 * @param {number} input.durationSec        cut.mp4 duration in seconds
 * @param {Object} [opts]
 * @param {string} [opts.apiKey]              defaults to process.env.GEMINI_API_KEY
 * @param {string} [opts.model]               defaults to gemini-3.1-pro-preview
 * @param {typeof fetchGeminiWithRetry} [opts.fetchImpl]  inject for tests
 * @returns {Promise<{ok: true, keywords: string[], reasoning: string, model: string} | {ok: false, kind: 'upstream'|'empty'|'parse'|'shape', status?: number, body?: string}>}
 */
export async function generateStockKeywords(input, opts = {}) {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('generateStockKeywords: GEMINI_API_KEY is not set');

  const model = opts.model ?? DEFAULT_MODEL;
  const fetcher = opts.fetchImpl ?? fetchGeminiWithRetry;

  const userPrompt = buildUserPrompt(input);

  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.3,         // a little creative on keyword phrasing, but stable
      // PR-B1: bumped 512 → 8192 to match broll_picker. Gemini-3.1-Pro
      // consumes tokens on internal reasoning even with responseMimeType
      // set to JSON, and the combined-test on 2026-05-08 hit truncation
      // ("Unexpected end of JSON input" with body `{ "keywords": [`).
      // 8192 gives Pro plenty of room to think + emit the JSON object.
      maxOutputTokens: 8192,
    },
  });

  let res;
  try {
    res = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 'stock_keyword_gen');
  } catch (err) {
    return { ok: false, kind: 'upstream', body: err.message ?? String(err) };
  }

  if (!res.ok) {
    let bodyText = '';
    try { bodyText = await res.text(); } catch (_) { /* noop */ }
    return { ok: false, kind: 'upstream', status: res.status, body: bodyText.slice(0, 500) };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, kind: 'parse', body: `invalid JSON envelope: ${err.message}` };
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return { ok: false, kind: 'empty', body: 'no candidate text in Gemini response' };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, kind: 'parse', body: `invalid inner JSON: ${err.message}\n${text.slice(0, 300)}` };
  }

  if (!Array.isArray(parsed?.keywords)) {
    return { ok: false, kind: 'shape', body: 'response missing keywords[] array' };
  }

  // Defensive cleanup: trim, drop empty, drop excessively long, dedupe (case-insensitive).
  const seen = new Set();
  const cleaned = [];
  for (const kw of parsed.keywords) {
    if (typeof kw !== 'string') continue;
    const t = kw.trim();
    if (t.length === 0 || t.length > 60) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(t);
  }

  if (cleaned.length === 0) {
    return { ok: false, kind: 'shape', body: 'all keywords were empty/duplicate after cleanup' };
  }

  return {
    ok: true,
    keywords: cleaned,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    model,
  };
}
