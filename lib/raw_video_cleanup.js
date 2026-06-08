/**
 * lib/raw_video_cleanup.js
 *
 * Phase 1A — transcript-only "raw video cleanup".
 *
 * Shannon uploads RAW talking-head footage: bad takes, restarts, "let me try
 * that again", pre-roll setup chatter, long dead air, failed attempts. The
 * existing silence + bad-take detectors catch silence and short stumbles, but
 * not whole repeated takes / aborted attempts / setup chatter. This module
 * adds a Gemini pass over the word-level transcript that returns those spans
 * as `removeCuts`. The clean_mode_pipeline merges them into the existing cut
 * set so the single existing `cutApply` renders the cleaned base (`cut.mp4`).
 *
 * Design mirrors lib/bad_take_detect.js (same Gemini call + cap pattern), with
 * three differences:
 *   1. Broader detection target (repeated takes / setup chatter / failed
 *      attempts), not just mid-sentence stumbles.
 *   2. Higher cut budget than bad-take's 25% — raw multi-take footage
 *      legitimately needs to drop more — BUT bounded by BOTH a
 *      `maxCleanupFraction` ceiling AND a `minRemainingSec` floor so it can
 *      never nuke the whole clip.
 *   3. Optional `segmentHint` (Phase 1B). When present, every removeCut is
 *      clamped to within a single detected segment so a cut can NEVER span a
 *      boundary (it must never join the end of Ad 1 to the middle of Ad 2).
 *
 * INTENTIONALLY conservative — keep-if-unsure. False positives cut real
 * content; false negatives just leave a take the operator can trim later.
 * The job NEVER fails because of this stage: on any error the caller keeps the
 * existing cuts and ships.
 *
 * Returns cut windows in source-time SECONDS:
 *   { mode: 'transcript_only', removeCuts: [{ start, end, reason }], totalRemovedSec }
 */

import { fetchGeminiWithRetry } from './gemini_helpers.js';
import { mergeCutSpans, totalRemovedSec } from './cut_spans.js';

// Pro-only on clean-mode AI decisions (same rule as bad_take_detect.js /
// slate_detect.js). Cleanup chooses what to cut from the rendered video.
const GEMINI_TEXT_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent`;

// Higher ceiling than bad-take (0.25) — raw multi-take footage legitimately
// removes more. Still a SAFETY ceiling, not a target; the prompt stays
// conservative. Combined with minRemainingSec floor below.
const DEFAULT_MAX_CLEANUP_FRACTION = 0.85;
// Never let cleanup leave less than this much video. Hard floor against a
// runaway plan that would empty the clip.
const DEFAULT_MIN_REMAINING_SEC = 8;
// Cuts shorter than this aren't worth a concat seam (matches bad-take).
const MIN_CUT_SEC = 0.4;

const PROMPT = `You are cleaning a RAW talking-head recording before it is edited. The speaker recorded it in one sitting and it may contain throwaway material. Identify ONLY the spans that should be CUT so the cleanest version of the real content remains.

CUT these (when CLEAR):
  • Pre-roll setup chatter before the real content starts — "okay", "am I recording?", "let me get set up", "ready?", throat-clears, talking to someone off-camera
  • Failed/aborted takes that the speaker then re-does — keep the LAST clean, complete take of a line and cut the earlier broken attempts
  • Explicit restart markers and the broken attempt before them — "let me try that again", "wait, start over", "scratch that", "one more time"
  • Long dead air / silence between attempts (the SILENCE WINDOWS below mark candidates)
  • Tail-end chatter after the content clearly ends — "okay that's it", "did you get that?"

DO NOT CUT:
  • Real content, even if delivery is slightly imperfect
  • Natural pauses, emphasis, or slow delivery
  • Anything you are UNSURE about — when in doubt, KEEP it
  • A span that bridges two clearly DIFFERENT topics/ads — those are separate content (a different stage handles splitting), NOT a bad take. Never merge across a topic change.

Rules for every cut window:
  • Tight — only the throwaway span, not surrounding good content
  • At least ${MIN_CUT_SEC} seconds long
  • Start at/after the first bad word; end at/before the next clean word
  • Prefer KEEPING the final complete take of any repeated line

Return STRICT JSON. If nothing is clearly removable, return an empty array:
{
  "removeCuts": [
    { "start": <seconds>, "end": <seconds>, "reason": "<=8-word label, e.g. 'setup chatter' | 'aborted take' | 'restart' | 'dead air'" }
  ]
}

SILENCE WINDOWS (start-end seconds, candidates for dead-air between takes):
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

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * Clamp a removeCut so it never spans a detected segment boundary.
 * Returns the portion of the cut that lies inside the segment containing its
 * START, or null if the cut starts outside every segment (gap between clips).
 *
 * @param {{start:number,end:number,reason:string}} cut
 * @param {Array<{start:number,end:number}>} segments  sorted, non-overlapping
 */
function clampToSegment(cut, segments) {
  for (const seg of segments) {
    if (cut.start >= seg.start && cut.start < seg.end) {
      const end = Math.min(cut.end, seg.end);
      if (end - cut.start < MIN_CUT_SEC) return null;
      return { start: cut.start, end, reason: cut.reason };
    }
  }
  return null; // starts in a boundary gap → drop (conservative)
}

/**
 * Transcript-only raw-video cleanup.
 *
 * @param {Object} input
 * @param {string} [input.transcript]                                   full transcript (context only)
 * @param {Array<{word:string,start_ms:number,end_ms:number}>} input.wordTimestamps
 * @param {number} input.sourceDuration                                 source-time seconds
 * @param {Array<{start:number,end:number}>} [input.silenceMap=[]]      merged silence spans (dead-air signal)
 * @param {Array<{start:number,end:number}>} [input.existingCuts=[]]    cuts already applied (silence/slate/bad-take) — for the budget + overlap drop
 * @param {{clips:Array<{start:number,end:number}>}|null} [input.segmentHint=null]  Phase 1B boundaries; clamps cuts within a single segment
 * @param {number} [input.startAfterSec=0]                              don't emit cuts before this (e.g. slate end)
 * @param {number} [input.maxCleanupFraction=0.85]                      ceiling on total removed fraction (existing + new)
 * @param {number} [input.minRemainingSec=8]                            floor on remaining video duration
 * @param {Object} [opts]
 * @param {string} [opts.apiKey]                                        defaults to process.env.GEMINI_API_KEY
 * @param {typeof fetchGeminiWithRetry} [opts.fetchImpl]                inject for tests
 * @returns {Promise<{mode:'transcript_only', removeCuts:Array<{start:number,end:number,reason:string}>, totalRemovedSec:number}>}
 */
export async function runRawVideoCleanup(input, opts = {}) {
  const empty = { mode: 'transcript_only', removeCuts: [], totalRemovedSec: 0 };

  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  if (!input?.wordTimestamps || input.wordTimestamps.length === 0) {
    return empty;
  }

  const sourceDuration = input.sourceDuration ?? 0;
  if (sourceDuration <= 0) return empty;

  const startAfter = input.startAfterSec ?? 0;
  const existingCuts = Array.isArray(input.existingCuts) ? input.existingCuts : [];
  const silenceMap = Array.isArray(input.silenceMap) ? input.silenceMap : [];
  const segments = input.segmentHint?.clips && Array.isArray(input.segmentHint.clips)
    ? input.segmentHint.clips
    : null;
  const maxCleanupFraction = typeof input.maxCleanupFraction === 'number'
    ? input.maxCleanupFraction
    : DEFAULT_MAX_CLEANUP_FRACTION;
  const minRemainingSec = typeof input.minRemainingSec === 'number'
    ? input.minRemainingSec
    : DEFAULT_MIN_REMAINING_SEC;

  const prompt = PROMPT
    .replace('{{SILENCES}}', buildSilencesText(silenceMap))
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
  }, 'raw_video_cleanup');

  if (!res.ok) {
    // Non-fatal upstream: caller catches and keeps existing cuts.
    throw new Error(`raw_video_cleanup: Gemini API error ${res.status} — ${await res.text()}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return empty;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.warn(`[raw_video_cleanup] invalid JSON, returning empty: ${err.message}`);
    return empty;
  }

  // Accept either { removeCuts } (our schema) or { cuts } (defensive).
  const raw = Array.isArray(parsed?.removeCuts)
    ? parsed.removeCuts
    : Array.isArray(parsed?.cuts)
      ? parsed.cuts
      : [];

  let cleaned = [];
  for (const c of raw) {
    if (typeof c?.start !== 'number' || typeof c?.end !== 'number') continue;
    let { start, end } = c;
    if (end <= start) continue;
    if (start < startAfter) start = startAfter;          // clamp into allowed region
    if (end - start < MIN_CUT_SEC) continue;
    // Drop cuts that overlap an already-applied cut — that span is handled.
    if (existingCuts.some((s) => overlaps({ start, end }, s))) continue;
    cleaned.push({
      start,
      end,
      reason: typeof c.reason === 'string' ? c.reason.slice(0, 80) : 'raw_cleanup',
    });
  }

  // Phase 1B: clamp every RAW cut to within a single detected segment FIRST —
  // BEFORE the merge — so a cut can never span a boundary and two cuts in
  // different segments don't merge across the gap between them. No-op in 1A
  // (segments === null).
  if (segments && segments.length > 0) {
    const clampedList = [];
    for (const c of cleaned) {
      const clamped = clampToSegment(c, segments);
      if (clamped) clampedList.push(clamped);
      else console.log(`[raw_video_cleanup] dropped cross-boundary cut [${c.start.toFixed(2)}, ${c.end.toFixed(2)}]`);
    }
    cleaned = clampedList;
  }

  // Sort + merge overlapping windows the model may have double-reported
  // (within a segment, post-clamp).
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

  // Budget: combined (existing + new) removal must stay under the fraction
  // ceiling AND leave >= minRemainingSec. Whichever is tighter wins.
  const existingRemoved = totalRemovedSec(existingCuts);
  const maxTotalRemoved = Math.min(
    sourceDuration * maxCleanupFraction,
    Math.max(0, sourceDuration - minRemainingSec),
  );
  let budget = Math.max(0, maxTotalRemoved - existingRemoved);

  const capped = [];
  for (const c of merged) {
    const dur = c.end - c.start;
    if (dur > budget) {
      console.warn(
        `[raw_video_cleanup] budget reached (maxTotalRemoved=${maxTotalRemoved.toFixed(2)}s, ` +
        `existing=${existingRemoved.toFixed(2)}s) — dropped ${merged.length - capped.length} cleanup cut(s)`,
      );
      break;
    }
    capped.push(c);
    budget -= dur;
  }

  return {
    mode: 'transcript_only',
    removeCuts: capped,
    totalRemovedSec: capped.reduce((s, c) => s + (c.end - c.start), 0),
  };
}
