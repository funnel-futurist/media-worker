/**
 * lib/bad_take_detect.js
 *
 * Gemini-driven detection of BAD TAKES — moments the speaker stumbles,
 * restarts, or trails off mid-sentence. These are content moments that
 * should be cut from the rendered short, but are not pure silence (so the
 * silence detector misses them).
 *
 * Returns cut windows in source-time SECONDS. Caller merges these with the
 * silence cuts before passing the unified list to runTrimConcat.
 *
 * Hard caps:
 *   • total cut duration ≤ maxCutFraction × sourceDuration (default 25%)
 *     so Gemini can't decimate a video full of dramatic pauses
 *   • each cut ≥ 0.3s (anything shorter isn't worth the concat seam)
 *
 * The detector is INTENTIONALLY conservative: false positives mean the speaker
 * gets cut mid-thought; false negatives just mean the existing silence/dead-air
 * cuts pass them through unchanged. We'd rather miss a stumble than cut a
 * real sentence.
 *
 * Ported from creative-engine/lib/hyperframes/bad_take_detect.ts (PR #112)
 * — addresses M2's pre-existing 0% bad-take coverage. Phil B8's
 * `cuts.byCategory.applied.badTake = 0` confirmed the gap.
 */

import { fetchGeminiWithRetry } from './gemini_helpers.js';

// gemini-2.5-flash same as slate_detect — quota-healthy on our project key.
const GEMINI_TEXT_MODEL = 'gemini-2.5-flash';
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent`;

const PROMPT = `You analyze a video's word-level transcript and identify BAD TAKES — moments the speaker stumbles, restarts, or trails off. Only those moments should be CUT from the rendered video. Healthy content stays.

CUT examples:
  • "wait, let me start over" — the restart phrase itself
  • "uh, um, you know" filler that's clearly a stumble (NOT natural conversational filler)
  • Repeated phrases that are obvious false starts: "the the", "I — I want", "we — we — we"
  • Trailing off mid-sentence then re-stating the same idea differently — cut the trailed-off attempt
  • Coughs, throat-clears, audible mistakes the speaker corrects

DO NOT CUT:
  • Natural speech rhythm with brief hesitations (≤ 0.5s)
  • Thoughtful pauses that emphasize a point
  • Slow delivery on important words
  • Filler words that fit the speaker's natural conversational style and don't disrupt meaning
  • Any single word — cuts must wrap a stumble window, not a single mid-sentence word

Cut windows MUST be:
  • Tight — only the bad section, not the surrounding good content
  • At least 0.3 seconds long
  • Start at or after the timestamp of the first bad word; end at or before the next clean word

Return strict JSON. If nothing to cut, return an empty cuts array:
{
  "cuts": [
    { "start": <seconds>, "end": <seconds>, "reason": "<≤6-word label>" }
  ]
}

Word-timestamped transcript (one [start_s] word per token):
{{TRANSCRIPT}}`;

function buildTranscriptText(words) {
  return words
    .map((w) => `[${(w.start_ms / 1000).toFixed(2)}s] ${w.word}`)
    .join(' ');
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * Detect bad-take cuts via Gemini Flash.
 *
 * @param {Object} input
 * @param {Array<{word: string, start_ms: number, end_ms: number}>} input.wordTimestamps
 * @param {number} input.sourceDuration                       source-time seconds
 * @param {number} [input.startAfterSec=0]                    don't emit cuts within this leading window (e.g. set to slate end)
 * @param {Array<{start: number, end: number}>} [input.excludeOverlapWith=[]] existing silence cuts — bad-take cuts that overlap will be dropped
 * @param {number} [input.maxCutFraction=0.25]                max fraction of source duration that can be cut
 * @param {Object} [opts]
 * @param {string} [opts.apiKey]                              defaults to process.env.GEMINI_API_KEY
 * @param {typeof fetchGeminiWithRetry} [opts.fetchImpl]      inject for tests
 * @returns {Promise<Array<{start: number, end: number, reason: string}>>}
 */
export async function detectBadTakes(input, opts = {}) {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  if (!input?.wordTimestamps || input.wordTimestamps.length === 0) {
    return [];
  }

  const startAfter = input.startAfterSec ?? 0;
  const maxCutFraction = input.maxCutFraction ?? 0.25;
  const excludeOverlap = input.excludeOverlapWith ?? [];
  const sourceDuration = input.sourceDuration ?? 0;
  const maxTotalCutSec = sourceDuration * maxCutFraction;

  const transcript = buildTranscriptText(input.wordTimestamps);
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
  }, 'bad_take_detect');

  if (!res.ok) {
    throw new Error(`bad_take_detect: Gemini API error ${res.status} — ${await res.text()}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Bad-take detection failure is non-fatal — log and degrade to "no cuts".
    // The pipeline keeps shipping; we just lose this run's bad-take signal.
    console.warn(`[bad_take_detect] invalid JSON, returning empty: ${err.message}`);
    return [];
  }

  const rawCuts = Array.isArray(parsed?.cuts) ? parsed.cuts : [];
  const cleaned = [];

  for (const c of rawCuts) {
    if (typeof c?.start !== 'number' || typeof c?.end !== 'number') continue;
    const start = c.start;
    const end = c.end;
    if (end <= start) continue;
    if (end - start < 0.3) continue;
    if (start < startAfter) continue;
    // Drop cuts that overlap with already-detected silence windows — the
    // silence cut already handles that span.
    if (excludeOverlap.some((s) => overlaps({ start, end }, s))) continue;
    cleaned.push({
      start,
      end,
      reason: typeof c.reason === 'string' ? c.reason.slice(0, 80) : 'bad_take',
    });
  }

  // Sort + merge any overlapping bad-take cuts (e.g. Gemini returned two
  // overlapping windows for the same stumble).
  cleaned.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const c of cleaned) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end);
      last.reason = `${last.reason}+${c.reason}`.slice(0, 80);
    } else {
      merged.push({ ...c });
    }
  }

  // Safety cap — if Gemini wants to cut more than maxCutFraction of the source,
  // keep cuts in returned order and stop adding once we've reached the cap.
  const capped = [];
  let totalCut = 0;
  for (const c of merged) {
    const dur = c.end - c.start;
    if (totalCut + dur > maxTotalCutSec) {
      console.warn(
        `[bad_take_detect] cut cap reached (${maxTotalCutSec.toFixed(2)}s) — ` +
        `dropped ${merged.length - capped.length} bad-take cuts`,
      );
      break;
    }
    capped.push(c);
    totalCut += dur;
  }
  return capped;
}
