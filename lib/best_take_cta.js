/**
 * lib/best_take_cta.js
 *
 * Phase 2 — transcript-only "best take + end-on-CTA".
 *
 * John on the Dr. Joe "ad 1": (a) a retake at ~1:08 survived — the editor
 * should "pick the best take", and (b) the cut "ended on a hook, not a CTA."
 * The shipped raw-video cleanup (1A) is deliberately conservative and does
 * neither. This module adds structure awareness to the worker edit, AFTER 1A:
 *
 *   1. END-ON-CTA (auto, gated): find the final genuine call-to-action and
 *      trim trailing chatter so the video ENDS on the CTA. Emitted as one
 *      `removeCuts` span the pipeline merges into the existing cut set (same
 *      path as cleanup cuts) — the single existing cutApply renders it.
 *   2. BEST-TAKE (LOG ONLY in v1): detect repeated-take groups + a recommended
 *      keep, and return them as a `bestTakeProposal`. NEVER added to removeCuts
 *      in this version — we review the proposals on real footage before we
 *      trust an auto-drop.
 *
 * Why self-detect (not reuse creative-engine #163's ad_structure)? The portal
 * `cs.content_items` row and the #163 `marketing.ad_ingestion.gemini_markup`
 * analysis are separate pipelines with NO join key, and most uploads never
 * create an ad_ingestion row. The worker already has the Deepgram transcript +
 * word_timestamps, so it self-detects (same Gemini approach as #163).
 *
 * Design mirrors lib/raw_video_cleanup.js (same Gemini call + tagged-transcript
 * conventions). Two differences:
 *   1. The end-on-CTA trim is HEAVILY GATED (confidence, position, trailing
 *      length, single-clip, min-remaining) — see computeCtaTrim. When in doubt
 *      it LOGS the CTA but does NOT trim.
 *   2. It is NON-FATAL by RETURN (not throw): on any error it returns the empty
 *      shape with `error` set, so the caller's try/catch is belt-and-braces.
 *
 * Returns source-time SECONDS:
 *   { mode:'transcript_only',
 *     cta: { found, end_time, confidence, excerpt } | null,
 *     removeCuts: [{ start, end, reason }],          // ONLY the end-on-CTA trim
 *     bestTakeProposal: { groups:[...], proposedDrops:[...] },   // LOG ONLY
 *     error? }
 */

import { fetchGeminiWithRetry } from './gemini_helpers.js';

// Pro-only on clean-mode AI decisions (same rule as raw_video_cleanup.js /
// bad_take_detect.js). This stage chooses what to trim from the rendered video.
const GEMINI_TEXT_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent`;

// ── End-on-CTA trim gates (tunable). The trim only fires when ALL hold. ──────
// Weak CTA detection → log only, never trim.
export const CTA_MIN_CONFIDENCE = 0.75;
// The closing CTA must be late in the clip — guards against trimming on an
// early "book a call" buried in the body.
export const CTA_MIN_POSITION_FRAC = 0.55;
// Very short clips legitimately put the CTA early — skip the position check
// below this duration.
export const SHORT_CLIP_SEC = 45;
// Don't bother trimming a sliver of trailing content.
export const MIN_TRAILING_TRIM_SEC = 1.75;
// Keep this much AFTER the spoken CTA so it isn't clipped.
export const CTA_TRAIL_BUFFER_SEC = 0.5;
// Never trim if it would leave less than this much gross kept video.
const DEFAULT_MIN_REMAINING_SEC = 8;
// Cuts shorter than this aren't worth a concat seam (matches cleanup).
const MIN_CUT_SEC = 0.4;

// Proposed-drop confidence by take quality. The best-take proposal is LOG ONLY
// in v1; this numeric is so a future auto-cut can threshold on it without a
// prompt change. Documented mapping, not a model output.
export const QUALITY_CONFIDENCE = {
  aborted: 0.9,
  weak: 0.65,
  good: 0.5,
  best: 0.4,
};
const DEFAULT_DROP_CONFIDENCE = 0.5;

// Reused verbatim from creative-engine #163 ad_structure CTA indicators so the
// worker and the intake analysis agree on what "a CTA" sounds like.
export const CTA_ACTION_LANGUAGE = [
  'fill out the form',
  'book a call',
  'register',
  'go to the next page',
  'apply',
  'get started',
  'schedule',
  'submit your info',
  "we'll walk you through the next steps",
];

const PROMPT = `You are analyzing a RAW talking-head ad recording (a word-level transcript with [start_s] time tags). Do TWO things.

1) FINAL CTA — Find the LAST genuine call-to-action that CLOSES the ad: the line that tells the viewer the next step using action language such as:
{{CTA_LANGUAGE}}
  • "end_time" = the timestamp (seconds) where the spoken CTA FINISHES (i.e. where the real content ends). Anything after it is trailing chatter.
  • Only set "found": true when there is a CLEAR closing CTA. An early "book a call" buried in the middle of the body is NOT the closing CTA.
  • "confidence" 0..1 — how sure you are this is the genuine closing CTA.

2) REPEATED TAKES — Find groups where the speaker delivered the SAME content more than once (retakes / restarts / "let me try that again" / a flubbed line re-done). For each group:
  • list the takes in TIME order, each with a "quality" of "best" | "good" | "weak" | "aborted" and a short reason
  • pick the ONE to keep via "recommended_keep_index" (0-based) — usually the LAST clean, complete take
  Do NOT include content that was only said once. Do NOT group two DIFFERENT topics/ads together — those are separate content, not retakes.

Be CONSERVATIVE — when unsure, leave it out. Keep-if-unsure.

Return STRICT JSON:
{
  "cta": { "found": <bool>, "end_time": <seconds>, "confidence": <0..1>, "excerpt": "<short quote of the CTA>" },
  "take_groups": [
    {
      "content_summary": "<=8-word label of the repeated line",
      "takes": [ { "start": <seconds>, "end": <seconds>, "quality": "best|good|weak|aborted", "reason": "<=8-word note" } ],
      "recommended_keep_index": <0-based index into takes>
    }
  ]
}
If there is no clear closing CTA, set "cta.found": false. If nothing is repeated, return "take_groups": [].

SILENCE WINDOWS (start-end seconds):
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
 * Build the Gemini prompt. Exported for tests (assert tagged transcript + the
 * CTA action-language list are present).
 */
export function buildBestTakeCtaPrompt(transcriptText, silencesText) {
  return PROMPT
    .replace('{{CTA_LANGUAGE}}', CTA_ACTION_LANGUAGE.map((p) => `  • "${p}"`).join('\n'))
    .replace('{{SILENCES}}', silencesText)
    .replace('{{TRANSCRIPT}}', transcriptText);
}

function clampTime(t, sourceDuration) {
  if (typeof t !== 'number' || Number.isNaN(t)) return null;
  if (t < 0) return 0;
  if (t > sourceDuration) return sourceDuration;
  return t;
}

/**
 * Normalize the model's raw JSON into { cta, bestTakeProposal }. Pure — no I/O.
 * Clamps times to [0, sourceDuration], drops invalid spans, derives
 * proposedDrops as every take that is NOT the recommended keep.
 *
 * @param {any} parsed                model JSON
 * @param {number} sourceDuration     source-time seconds
 */
export function normalizeResult(parsed, sourceDuration) {
  // ── CTA ──
  let cta = null;
  const rawCta = parsed?.cta;
  if (rawCta && typeof rawCta === 'object') {
    const end = clampTime(rawCta.end_time, sourceDuration);
    const found = rawCta.found === true && end != null;
    cta = {
      found,
      end_time: end ?? 0,
      confidence: typeof rawCta.confidence === 'number'
        ? Math.max(0, Math.min(1, rawCta.confidence))
        : 0,
      excerpt: typeof rawCta.excerpt === 'string' ? rawCta.excerpt.slice(0, 200) : '',
    };
  }

  // ── Best-take groups (LOG ONLY) ──
  const groups = [];
  const proposedDrops = [];
  const rawGroups = Array.isArray(parsed?.take_groups) ? parsed.take_groups : [];
  for (const g of rawGroups) {
    const rawTakes = Array.isArray(g?.takes) ? g.takes : [];
    const takes = [];
    for (const t of rawTakes) {
      const start = clampTime(t?.start, sourceDuration);
      const end = clampTime(t?.end, sourceDuration);
      if (start == null || end == null || end - start < MIN_CUT_SEC) continue;
      const quality = ['best', 'good', 'weak', 'aborted'].includes(t?.quality) ? t.quality : 'good';
      takes.push({
        start,
        end,
        quality,
        reason: typeof t?.reason === 'string' ? t.reason.slice(0, 80) : '',
      });
    }
    if (takes.length < 2) continue; // not a repeated-take group
    takes.sort((a, b) => a.start - b.start);

    // Keep index: model's choice if valid, else the LAST take (conservative
    // "keep the last clean complete take").
    let keepIndex = Number.isInteger(g?.recommended_keep_index) ? g.recommended_keep_index : takes.length - 1;
    if (keepIndex < 0 || keepIndex >= takes.length) keepIndex = takes.length - 1;

    groups.push({
      contentSummary: typeof g?.content_summary === 'string' ? g.content_summary.slice(0, 80) : '',
      takes,
      recommendedKeepIndex: keepIndex,
    });

    takes.forEach((t, i) => {
      if (i === keepIndex) return;
      proposedDrops.push({
        start: t.start,
        end: t.end,
        reason: `best_take drop (${t.quality}): ${t.reason}`.slice(0, 80),
        confidence: QUALITY_CONFIDENCE[t.quality] ?? DEFAULT_DROP_CONFIDENCE,
      });
    });
  }
  proposedDrops.sort((a, b) => a.start - b.start);

  return { cta, bestTakeProposal: { groups, proposedDrops } };
}

/**
 * Decide whether to emit the end-on-CTA trim. Pure — all gates live here so the
 * unit tests can exercise them without a Gemini call.
 *
 * @returns {{ removeCuts: Array<{start,end,reason}>, applied: boolean, skipReason: string|null }}
 */
export function computeCtaTrim({
  cta,
  sourceDuration,
  endOnCta,
  isMultiPart,
  buffer = CTA_TRAIL_BUFFER_SEC,
  minRemainingSec = DEFAULT_MIN_REMAINING_SEC,
}) {
  const none = (skipReason) => ({ removeCuts: [], applied: false, skipReason });

  if (endOnCta !== true) return none('endOnCta_off');
  if (!cta || cta.found !== true) return none('no_cta');
  if (cta.confidence < CTA_MIN_CONFIDENCE) return none('low_confidence');
  if (isMultiPart) return none('multi_part'); // per-creative trim deferred to 1C
  if (!(sourceDuration > 0)) return none('no_duration');

  // Position gate — skip only for very short clips, where an early CTA is normal.
  if (sourceDuration >= SHORT_CLIP_SEC && cta.end_time < CTA_MIN_POSITION_FRAC * sourceDuration) {
    return none('cta_too_early');
  }

  const trimStart = cta.end_time + buffer;
  const trimEnd = sourceDuration;
  if (trimEnd - trimStart < MIN_TRAILING_TRIM_SEC) return none('trailing_too_short');
  if (trimEnd - trimStart < MIN_CUT_SEC) return none('trailing_too_short');
  // Gross kept region (before existing cuts) must clear the floor — never trim
  // into the body.
  if (trimStart < minRemainingSec) return none('below_min_remaining');

  return {
    removeCuts: [{ start: trimStart, end: trimEnd, reason: 'post-CTA trailing' }],
    applied: true,
    skipReason: null,
  };
}

/**
 * Transcript-only best-take + end-on-CTA analysis.
 *
 * @param {Object} input
 * @param {string} [input.transcript]                                   full transcript (context only)
 * @param {Array<{word:string,start_ms:number,end_ms:number}>} input.wordTimestamps
 * @param {number} input.sourceDuration                                 source-time seconds
 * @param {Array<{start:number,end:number}>} [input.silenceMap=[]]      merged silence spans (signal)
 * @param {{clips:Array<{start:number,end:number}>}|null} [input.segmentHint=null]  multi-part boundaries; >1 clip ⇒ no auto-trim
 * @param {boolean} [input.endOnCta=false]                              gate: enable the end-on-CTA trim
 * @param {number} [input.ctaTrailBufferSec=0.5]                        seconds kept after the CTA
 * @param {number} [input.minRemainingSec=8]                            floor on gross kept duration
 * @param {Object} [opts]
 * @param {string} [opts.apiKey]                                        defaults to process.env.GEMINI_API_KEY
 * @param {typeof fetchGeminiWithRetry} [opts.fetchImpl]                inject for tests
 * @returns {Promise<{mode:'transcript_only', cta:Object|null, removeCuts:Array, bestTakeProposal:Object, error?:string}>}
 */
export async function analyzeBestTakeAndCta(input, opts = {}) {
  const empty = {
    mode: 'transcript_only',
    cta: null,
    removeCuts: [],
    bestTakeProposal: { groups: [], proposedDrops: [] },
  };

  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) return { ...empty, error: 'GEMINI_API_KEY is not set' };

  if (!input?.wordTimestamps || input.wordTimestamps.length === 0) {
    return { ...empty, error: 'no word timestamps' };
  }

  const sourceDuration = input.sourceDuration ?? 0;
  if (sourceDuration <= 0) return { ...empty, error: 'invalid sourceDuration' };

  const silenceMap = Array.isArray(input.silenceMap) ? input.silenceMap : [];
  const segments = input.segmentHint?.clips && Array.isArray(input.segmentHint.clips)
    ? input.segmentHint.clips
    : null;
  const isMultiPart = !!(segments && segments.length > 1);
  const buffer = typeof input.ctaTrailBufferSec === 'number' && input.ctaTrailBufferSec >= 0
    ? input.ctaTrailBufferSec
    : CTA_TRAIL_BUFFER_SEC;
  const minRemainingSec = typeof input.minRemainingSec === 'number'
    ? input.minRemainingSec
    : DEFAULT_MIN_REMAINING_SEC;

  const prompt = buildBestTakeCtaPrompt(
    buildTranscriptText(input.wordTimestamps),
    buildSilencesText(silenceMap),
  );

  const fetcher = opts.fetchImpl ?? fetchGeminiWithRetry;
  let res;
  try {
    res = await fetcher(`${GEMINI_API}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      }),
    }, 'best_take_cta');
  } catch (err) {
    return { ...empty, error: `best_take_cta: fetch failed — ${err.message}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ...empty, error: `best_take_cta: Gemini ${res.status} — ${body}`.slice(0, 300) };
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return { ...empty, error: 'best_take_cta: empty model response' };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ...empty, error: `best_take_cta: invalid JSON — ${err.message}` };
  }

  const { cta, bestTakeProposal } = normalizeResult(parsed, sourceDuration);

  const trim = computeCtaTrim({
    cta,
    sourceDuration,
    endOnCta: input.endOnCta === true,
    isMultiPart,
    buffer,
    minRemainingSec,
  });

  if (cta?.found && !trim.applied) {
    console.log(
      `[best_take_cta] CTA found @${cta.end_time.toFixed(2)}s (conf ${cta.confidence.toFixed(2)}) ` +
      `but trim skipped: ${trim.skipReason}`,
    );
  }

  return {
    mode: 'transcript_only',
    cta,
    removeCuts: trim.removeCuts,
    bestTakeProposal,
  };
}
