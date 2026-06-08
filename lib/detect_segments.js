/**
 * lib/detect_segments.js
 *
 * Phase 1B — multi-part SEGMENT DETECTION (detect + log ONLY; NO split).
 *
 * Some raw uploads are one ~10-min recording containing MULTIPLE separate
 * intended videos (Part 1/Ad 1, Part 2/Ad 2, …). This module runs a Gemini
 * pass over the FULL RAW transcript (BEFORE any cleanup cuts are applied, so
 * boundary phrases like "next one" are still present) and reports the likely
 * clip boundaries.
 *
 * Phase 1B does NOT split the upload into multiple outputs — that's Phase 1C
 * and needs the child-content_items migration. Here we only:
 *   1. detect + log the boundaries (telemetry on how often multi-part happens), and
 *   2. hand the boundaries to raw_video_cleanup as a `segmentHint` so cleanup
 *      stays boundary-aware and never cuts ACROSS a detected reset (never joins
 *      the end of Ad 1 to the middle of Ad 2).
 *
 * INTENTIONALLY conservative: default to ONE clip unless there's a CLEAR reset
 * / new-video start. A false "multiple" only tightens the cleanup's
 * boundary-awareness; a false "single" just behaves like Phase 1A. We'd rather
 * under-segment than wrongly slice a single continuous video.
 *
 * Returns:
 *   { detectedMultipleClips: boolean,
 *     clips: [{ clipIndex, start, end, titleGuess, reason }] }   // source-time seconds
 */

import { fetchGeminiWithRetry } from './gemini_helpers.js';

const GEMINI_TEXT_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent`;

const PROMPT = `You analyze the word-level transcript of a RAW recording and decide whether it contains ONE intended video, or MULTIPLE separate intended videos/ads recorded back-to-back in the same sitting.

Treat it as MULTIPLE only when there is a CLEAR reset / new-video start. Signals:
  • Explicit markers: "next one", "next video", "another one", "let's do the next ad", "okay, next", "second ad", "take two" of a NEW piece (not a re-take of the same line)
  • A long pause FOLLOWED BY a clearly different topic / new hook / new intro
  • The speaker restating a fresh opening ("Hi, I'm…", a new hook) after finishing a prior piece
  • Two clearly different offers/ads/topics spoken back-to-back

Do NOT treat as multiple when:
  • It's the same topic with re-takes/restarts of the SAME lines (that's one clip — cleanup handles the bad takes)
  • Natural pauses, tangents, or examples within one continuous piece
  • You are UNSURE — default to ONE clip

Output STRICT JSON. For ONE video:
{ "detectedMultipleClips": false, "clips": [] }

For MULTIPLE videos, give each intended clip's span in seconds (cover the real content of each; you may leave small gaps where the between-clip reset/chatter sits):
{
  "detectedMultipleClips": true,
  "clips": [
    { "start": <sec>, "end": <sec>, "titleGuess": "<short label>", "reason": "<why this is a separate clip / what marked the boundary>" }
  ]
}

SILENCE WINDOWS (start-end seconds — long pauses are candidate boundaries):
{{SILENCES}}

Word-timestamped transcript (one [start_s] word per token):
{{TRANSCRIPT}}`;

function buildTranscriptText(words) {
  return words
    .map((w) => `[${(w.start_ms / 1000).toFixed(2)}s] ${w.word}`)
    .join(' ');
}

function buildSilencesText(silenceMap) {
  if (!Array.isArray(silenceMap) || silenceMap.length === 0) return '(none detected)';
  return silenceMap
    .map((s) => `[${Number(s.start).toFixed(2)}-${Number(s.end).toFixed(2)}]`)
    .join(' ');
}

/**
 * Detect whether a raw recording contains multiple intended clips.
 *
 * @param {Object} input
 * @param {string} [input.transcript]                                    full transcript (context)
 * @param {Array<{word:string,start_ms:number,end_ms:number}>} input.wordTimestamps
 * @param {number} input.sourceDuration                                  source-time seconds
 * @param {Array<{start:number,end:number}>} [input.silenceMap=[]]       long-pause candidates
 * @param {Object} [opts]
 * @param {string} [opts.apiKey]                                         defaults to process.env.GEMINI_API_KEY
 * @param {typeof fetchGeminiWithRetry} [opts.fetchImpl]                 inject for tests
 * @returns {Promise<{detectedMultipleClips:boolean, clips:Array<{clipIndex:number,start:number,end:number,titleGuess:string,reason:string}>}>}
 */
export async function detectSegments(input, opts = {}) {
  const sourceDuration = input?.sourceDuration ?? 0;

  // Single-clip result: a full-span clip, multi=false (caller treats as "no
  // boundary constraint" — segmentHint stays null).
  const single = () => ({
    detectedMultipleClips: false,
    clips: sourceDuration > 0
      ? [{ clipIndex: 1, start: 0, end: sourceDuration, titleGuess: '', reason: 'single clip' }]
      : [],
  });

  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  if (!input?.wordTimestamps || input.wordTimestamps.length === 0) return single();
  if (sourceDuration <= 0) return single();

  const prompt = PROMPT
    .replace('{{SILENCES}}', buildSilencesText(input.silenceMap))
    .replace('{{TRANSCRIPT}}', buildTranscriptText(input.wordTimestamps));

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
  }, 'detect_segments');

  if (!res.ok) {
    throw new Error(`detect_segments: Gemini API error ${res.status} — ${await res.text()}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return single();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Non-fatal: degrade to single clip (Phase 1A behavior).
    console.warn(`[detect_segments] invalid JSON, treating as single clip: ${err.message}`);
    return single();
  }

  if (parsed?.detectedMultipleClips !== true || !Array.isArray(parsed?.clips)) {
    return single();
  }

  // Validate + normalize: numeric, in-range, end>start, sorted, non-overlapping.
  const valid = [];
  for (const c of parsed.clips) {
    if (typeof c?.start !== 'number' || typeof c?.end !== 'number') continue;
    let start = Math.max(0, c.start);
    const end = Math.min(sourceDuration, c.end);
    if (end <= start) continue;
    valid.push({
      start,
      end,
      titleGuess: typeof c.titleGuess === 'string' ? c.titleGuess.slice(0, 120) : '',
      reason: typeof c.reason === 'string' ? c.reason.slice(0, 160) : '',
    });
  }
  valid.sort((a, b) => a.start - b.start);

  // Enforce non-overlap by clamping each clip's start to the previous clip's
  // end (keeps segments disjoint so the cleanup clamp behaves predictably).
  const disjoint = [];
  let prevEnd = 0;
  for (const c of valid) {
    const start = Math.max(c.start, prevEnd);
    if (c.end - start <= 0) continue; // fully swallowed by previous → drop
    disjoint.push({ start, end: c.end, titleGuess: c.titleGuess, reason: c.reason });
    prevEnd = c.end;
  }

  // Need at least 2 real clips to call it multi-part; otherwise single.
  if (disjoint.length < 2) return single();

  return {
    detectedMultipleClips: true,
    clips: disjoint.map((c, i) => ({ clipIndex: i + 1, ...c })),
  };
}
