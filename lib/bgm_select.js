/**
 * lib/bgm_select.js
 *
 * Gemini Pro picks BGM mood/genre/instruments based on the transcript and
 * the kind of reel being made (educational, emotional, trust-building,
 * etc.). The output drives the Pixabay-Music search keywords used by the
 * orchestrator's bgmFetch step.
 *
 * Same envelope shape as broll_picker / slate_detect / bad_take_detect /
 * stock_keyword_gen — `{ok, ...}` on success, `{ok: false, kind, ...}` on
 * failure. Failures are non-fatal at the orchestrator level: BGM is
 * skipped, the pipeline still ships a video without a music bed, and the
 * skipReason surfaces in the response.
 *
 * Uses gemini-3.1-pro-preview by default per Shannon's
 * "Gemini Pro only on clean-mode AI decisions" directive 2026-05-08.
 * Lock-in: test/clean_mode_models_lock.test.js.
 */

import { fetchGeminiWithRetry } from './gemini_helpers.js';

const DEFAULT_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM_PROMPT = `You pick background music for short-form social-media reels.

A speaker has produced a talking-head reel. You see the transcript and the
total length. Your job: describe the music that should sit underneath the
voice — quiet enough to not compete, but emotionally aligned with the
content's tone, topic, and pacing.

Match these dimensions to the transcript:
  - mood: the emotional register (e.g., "warm, hopeful", "serious,
    contemplative", "uplifting, energetic", "trust-building, calm")
  - genre: the musical category (e.g., "acoustic folk", "ambient pad",
    "minimal piano", "soft electronic", "cinematic strings")
  - instrumentTags: 2-4 instrument keywords for Pixabay-Music search
    (e.g., ["acoustic guitar", "piano", "soft drums"])
  - tempo: "slow" | "moderate" | "upbeat"
  - searchQuery: a 3-6 word search string optimized for Pixabay-Music
    (combine genre + 1-2 instrument tags + mood adjective). Examples:
    "warm acoustic folk guitar", "hopeful piano ambient calm",
    "uplifting cinematic strings"

For talking-head reels with sensitive topics (financial planning, legal
advice, medical content, family emotional content), prefer:
  - acoustic / piano / ambient over electronic
  - moderate or slow tempo
  - warm / hopeful / contemplative moods over high-energy

For energetic / motivational topics, slightly more uplifting tempos and
brighter genres are OK — but the bed must still be quiet enough that the
voice clearly leads.

Return ONLY this JSON (no markdown, no commentary):
{
  "mood": "...",
  "genre": "...",
  "instrumentTags": ["...", "..."],
  "tempo": "slow|moderate|upbeat",
  "searchQuery": "..."
}`;

function buildUserPrompt({ transcript, durationSec }) {
  const transcriptText = Array.isArray(transcript)
    ? transcript.map((s) => s?.text ?? '').join(' ').trim()
    : String(transcript ?? '').trim();
  return [
    `Talking-head reel (${Math.round(durationSec)}s after cleanup).`,
    '',
    'Transcript:',
    transcriptText,
  ].join('\n');
}

/**
 * Pick BGM mood/genre/tempo via Gemini Pro.
 *
 * @param {Object} input
 * @param {Array<{startSec: number, endSec: number, text: string}>|string} input.transcript
 * @param {number} input.durationSec  cleaned video duration (after cuts) in seconds
 * @param {Object} [opts]
 * @param {string} [opts.apiKey]            defaults to process.env.GEMINI_API_KEY
 * @param {string} [opts.model]             defaults to gemini-3.1-pro-preview
 * @param {typeof fetchGeminiWithRetry} [opts.fetchImpl]
 * @returns {Promise<{ok: true, mood: string, genre: string, instrumentTags: string[], tempo: string, searchQuery: string, model: string} | {ok: false, kind: 'upstream'|'empty'|'parse'|'shape', status?: number, body?: string}>}
 */
export async function selectBgm(input, opts = {}) {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('selectBgm: GEMINI_API_KEY is not set');

  const model = opts.model ?? DEFAULT_MODEL;
  const fetcher = opts.fetchImpl ?? fetchGeminiWithRetry;

  const userPrompt = buildUserPrompt(input);
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.4,         // slight creative latitude on mood phrasing
      // PR-B1: bumped 512 → 8192 to match broll_picker. Gemini-3.1-Pro
      // consumes tokens on internal reasoning even with responseMimeType
      // set to JSON, and the combined-test on 2026-05-08 hit truncation
      // ("Unexpected end of JSON input" with body `{ "mood":`). 8192
      // gives Pro plenty of room to think + emit the JSON object.
      maxOutputTokens: 8192,
    },
  });

  let res;
  try {
    res = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 'bgm_select');
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

  const mood = typeof parsed?.mood === 'string' ? parsed.mood.trim() : '';
  const genre = typeof parsed?.genre === 'string' ? parsed.genre.trim() : '';
  const tags = Array.isArray(parsed?.instrumentTags)
    ? parsed.instrumentTags.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean).slice(0, 6)
    : [];
  const tempo = ['slow', 'moderate', 'upbeat'].includes(parsed?.tempo) ? parsed.tempo : 'moderate';
  const searchQuery = typeof parsed?.searchQuery === 'string' ? parsed.searchQuery.trim() : '';

  if (!mood || !genre || !searchQuery) {
    return {
      ok: false,
      kind: 'shape',
      body: `response missing required fields. got: mood="${mood}" genre="${genre}" searchQuery="${searchQuery}"`,
    };
  }

  return { ok: true, mood, genre, instrumentTags: tags, tempo, searchQuery, model };
}
