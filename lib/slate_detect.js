/**
 * lib/slate_detect.js
 *
 * Detects "slate" / meta-talk at the start of a video — the announcer-style
 * intro where the speaker says things like:
 *   "Hi, this is Justine, video 3, March 14, special needs trust funnel."
 *   "Title: Why Next Month Becomes Next Year. Selected option A."
 *
 * Returns a SlateMetadata { start: 0, end, transcribedText, identifier } when a
 * slate is detected. Returns null when the speaker dives straight into content.
 *
 * AI does the semantic judgment ("is this slate or content?"). The result is a
 * deterministic contract field the orchestrator trims by.
 *
 * Ported from creative-engine/lib/hyperframes/slate_detect.ts (PR #112) so the
 * M2 clean-mode pipeline gains the same LLM-based slate detection that the
 * production motion-graphics path uses. Replaces the prior pattern-matching
 * detector in lib/cut_detection.js (`findSlateIntro`) which missed phrases
 * like Phil's "Selected Option A" because option_take needed to appear in the
 * first sentence-bounded window — the LLM has no such limitation.
 */

import { fetchGeminiWithRetry } from './gemini_helpers.js';

// Bumped from gemini-2.0-flash → gemini-2.5-flash. Same price, but 2.0 Flash
// is being deprioritized by Google and our project key is currently rate-
// limited on it (returns 429 RESOURCE_EXHAUSTED). 2.5 Flash is healthy on the
// same key per a direct quota probe.
const GEMINI_TEXT_MODEL = 'gemini-2.5-flash';
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent`;

const PROMPT = `You analyze the first ~30 seconds of a video's word-level transcript and decide if the speaker is doing a SLATE / META-INTRO before delivering content.

A SLATE is when the speaker is announcing identifying information — NOT delivering content. Examples:
  • "Hi this is Justine, video 3, March 14"
  • "Okay, recording for the special-needs-trust funnel, take 2"
  • "This is reel number 7 for Joburn Jewelry"
  • A short date/option marker like "April 18 option A.", "May 3 take 2", "April 13–19 Saturday talking head".
    These are studio-style takes labels — the speaker is naming the file/take, not opening the video.
  • A short title-only marker like "Tech stack basics — option B."

NOT slates (these are content):
  • A direct hook like "The truth about your family's care plan is..."
  • A question to the audience
  • A statement about the topic
  • The speaker explicitly addressing the audience ("Hey founders," "Let me tell you...")

Return strict JSON:
{
  "isSlate": boolean,
  "slateEndSeconds": number | null,        // when content actually starts (0 if no slate)
  "transcribedText": string,                // verbatim slate text, or "" if no slate
  "identifier": string | null               // editor-facing label like "Justine - video 3 - March 14 - special needs trust", or null
}

If isSlate is false, slateEndSeconds must be 0, transcribedText "", identifier null.
Slates are typically 1–10 seconds — date/option markers are often only 2–3 seconds. Never exceed 20 seconds. Cut at the natural sentence/breath boundary right before content begins (usually the period after the marker).

Transcript (first 30s):
{{TRANSCRIPT}}`;

const TRANSCRIPT_CUTOFF_MS = 30_000;

function buildTranscriptText(words, cutoffMs) {
  return words
    .filter((w) => w.start_ms < cutoffMs)
    .map((w) => `[${(w.start_ms / 1000).toFixed(2)}s] ${w.word}`)
    .join(' ');
}

/**
 * Run Gemini-based slate detection on the first ~30s of a transcript.
 *
 * @param {Object} input
 * @param {Array<{word: string, start_ms: number, end_ms: number}>} input.wordTimestamps
 * @param {number} input.sourceDuration  source-time seconds (used to clamp the slate window)
 * @param {Object} [opts]
 * @param {string} [opts.apiKey]                 defaults to process.env.GEMINI_API_KEY
 * @param {typeof fetchGeminiWithRetry} [opts.fetchImpl]  inject for tests
 * @returns {Promise<{start: number, end: number, transcribed_text: string, identifier: string|null}|null>}
 */
export async function detectSlate(input, opts = {}) {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  if (!input?.wordTimestamps || input.wordTimestamps.length === 0) {
    return null;
  }

  const transcript = buildTranscriptText(input.wordTimestamps, TRANSCRIPT_CUTOFF_MS);
  if (!transcript.trim()) return null;

  const prompt = PROMPT.replace('{{TRANSCRIPT}}', transcript);

  const fetcher = opts.fetchImpl ?? fetchGeminiWithRetry;
  const res = await fetcher(`${GEMINI_API}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    }),
  }, 'slate_detect');

  if (!res.ok) {
    throw new Error(`slate_detect: Gemini API error ${res.status} — ${await res.text()}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('slate_detect: empty Gemini response');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`slate_detect: invalid JSON response — ${err.message}\n${text}`);
  }

  if (!parsed.isSlate || parsed.slateEndSeconds == null || parsed.slateEndSeconds <= 0) {
    return null;
  }

  // Hard cap at 20s + within source duration
  const end = Math.min(
    parsed.slateEndSeconds,
    20,
    Math.max(0, (input.sourceDuration ?? Infinity) - 1),
  );
  if (end <= 0) return null;

  return {
    start: 0,
    end,
    transcribed_text: parsed.transcribedText ?? '',
    identifier: parsed.identifier ?? null,
  };
}
