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

CRITICAL — multi-part slates (PR #114): Many speakers do a multi-part slate readout in a single intro, e.g. "Monday April 27. Title: Why Next Month Becomes Next Year. Selected Option A." That is ONE slate spanning multiple sentences, not three sentences with content in between. slateEndSeconds MUST be the moment the speaker stops doing slate-style metadata and starts the actual content of the video — even if that means cutting after several sentences of slate. Do NOT stop at the first marker (e.g., the date) and leave subsequent slate content (title/option/take) un-cut.

Slates are typically 1–15 seconds; multi-part slates can run up to ~18 seconds. Never exceed 20 seconds. Cut at the natural sentence/breath boundary RIGHT BEFORE content actually begins (usually the period after the LAST slate marker, then any small breath pause).

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
 * Snap an LLM-emitted slate end timestamp to the next clean word boundary.
 *
 * The LLM returns a fractional second like 9.04s based on its read of the
 * transcript, but Deepgram's word boundaries don't always align with that
 * estimate. On B10 (m2-e2e-018-enablesnp, 2026-05-08) Phil's slate ended
 * at 9.04s per the LLM, but the actual word "A" from "Option A" extended
 * past 9.04s — so the cut [0, 9.04] left the "A" sound at the start of
 * the final video.
 *
 * Fix (PR #114): take the LLM end and find the FIRST word in the transcript
 * that starts STRICTLY AFTER `llmEndSec + safetyPadSec`. Use that word's
 * start as the actual cut end. This guarantees:
 *   1. No partial word from the slate leaks into the final output, AND
 *   2. The cut starts the final video right at the next real word
 *      (any silence between the slate end and the next word is also
 *      removed — desirable for a clean intro).
 *
 * If no word starts after the LLM end (LLM end is past all words), return
 * the LLM end unchanged — there's nothing to snap to.
 *
 * @param {number} llmEndSec       slate end in source-time seconds (LLM output)
 * @param {Array<{start_ms: number}>} words  full Deepgram word_timestamps
 * @param {number} [safetyPadSec=0.05]  small grace period so a word whose
 *   start is essentially at the LLM end (e.g., LLM said 9.04, word starts at
 *   9.05) still gets caught and the cut extends past it
 * @returns {number}  the snapped cut end (source-time seconds)
 */
export function snapSlateEndToNextWord(llmEndSec, words, safetyPadSec = 0.05) {
  if (!Array.isArray(words) || words.length === 0) return llmEndSec;
  if (typeof llmEndSec !== 'number' || !Number.isFinite(llmEndSec)) return llmEndSec;
  const threshold = llmEndSec + safetyPadSec;
  // Words are chronological so a linear scan stops at the first hit; no need
  // to sort. Use start_ms (Deepgram's authoritative timing) and convert to s.
  for (const w of words) {
    if (typeof w?.start_ms !== 'number') continue;
    const startSec = w.start_ms / 1000;
    if (startSec > threshold) {
      return startSec;
    }
  }
  return llmEndSec;
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
