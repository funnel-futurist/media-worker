/**
 * lib/silence_audit.js
 *
 * PR-AC: turn the silence-cutting pipeline from a black box into a fully
 * inspectable per-span audit so dead-air leaks are diagnosable from logs
 * alone — no more "I saw an awkward pause, can you check the code?".
 *
 * The audit walks every silence span the detector found (after PR #102's
 * adjacent-span merge) and pairs each one with what the classifier
 * decided to do with it:
 *
 *   "cut"        — a span in cutResult.applied[] overlaps this silence.
 *                  The reel will have this dead air removed.
 *
 *   "preserved"  — a span in cutResult.skipped[] overlaps this silence.
 *                  The classifier judged the cut RISKY (e.g., mid-sentence
 *                  pause too short to safely remove) and dropped it from
 *                  the safe-only mode. The reel KEEPS this dead air.
 *
 *   "dropped"    — neither applied nor skipped has an overlapping cut.
 *                  The detector saw the silence but the cut window was
 *                  too small after retain/preserve subtraction. The reel
 *                  KEEPS this dead air.
 *
 * Each row also reports the silence's start/end/dur and (for cut and
 * preserved rows) the safetyReason slug emitted by classifyCutSafety so
 * the operator can tell at a glance WHY the classifier decided what it
 * decided. For dropped rows we mark dropReason='subthreshold' since the
 * detector dropped the span without generating a record we can inspect.
 *
 * The shape is deliberately small and serialisable so it survives the
 * pipeline response envelope and shows up in /api/editor/callback
 * inspection without inflating payload size.
 */

/**
 * @typedef {object} SilenceSpan
 * @property {number} start  seconds
 * @property {number} end    seconds
 */

/**
 * @typedef {object} ClassifiedCut
 * @property {number} start
 * @property {number} end
 * @property {string} [reason]
 * @property {string} [safetyReason]
 * @property {string} [category]
 */

/**
 * @typedef {object} SilenceAuditRow
 * @property {[number, number]} span         [start, end] of the merged silence
 * @property {number} durSec                 end - start
 * @property {'cut' | 'preserved' | 'dropped'} decision
 * @property {string} reason                 free-text (the cut's safetyReason
 *                                           when cut|preserved, 'subthreshold'
 *                                           when dropped)
 */

/**
 * @typedef {object} SilenceAuditSummary
 * @property {number} spansDetected
 * @property {number} spansCut
 * @property {number} spansPreserved
 * @property {number} spansDropped
 * @property {number} detectedSilenceSec     total silence duration found
 * @property {number} cutSilenceSec          duration of silence inside `cut` spans
 * @property {number} survivingSilenceSec    duration of silence inside
 *                                           preserved + dropped spans (= dead
 *                                           air the reel will keep)
 */

/**
 * @typedef {object} SilenceAudit
 * @property {SilenceAuditRow[]} rows
 * @property {SilenceAuditSummary} summary
 */

/**
 * Does two intervals [aS, aE] and [bS, bE] overlap? Open at the endpoints
 * — touching boundaries (aE === bS) do not count, which matches how cuts
 * are emitted (always with a > 0 duration).
 */
function overlaps(aS, aE, bS, bE) {
  return aS < bE && bS < aE;
}

/**
 * PR-AK: compute "prev" / "next" word context for a silence span. Used
 * to enrich each audit row with the actual words around the cut
 * boundary — so an operator reading the log can tell at a glance
 * whether a preserved/dropped span was the right call, without
 * opening the source video.
 *
 * Returns up to 4 words ending at the silence start (prev) and up to
 * 4 words starting at the silence end (next), joined by spaces.
 */
function contextAround(spanStart, spanEnd, words) {
  if (!Array.isArray(words) || words.length === 0) return { prev: '', next: '' };
  const startMs = spanStart * 1000;
  const endMs = spanEnd * 1000;
  const before = [];
  const after = [];
  for (const w of words) {
    if (typeof w?.start_ms !== 'number' || typeof w?.end_ms !== 'number') continue;
    if (w.end_ms <= startMs + 50) {
      before.push(w.word);
    } else if (w.start_ms >= endMs - 50) {
      after.push(w.word);
      if (after.length >= 4) break;
    }
  }
  return {
    prev: before.slice(-4).join(' '),
    next: after.slice(0, 4).join(' '),
  };
}

/**
 * Build the audit. Pure function — no I/O, no logging.
 *
 * @param {object} args
 * @param {SilenceSpan[]} args.mergedSilences  output of mergeAdjacentSilences
 * @param {ClassifiedCut[]} args.applied       cutResult.applied
 * @param {ClassifiedCut[]} args.skipped       cutResult.skipped
 * @param {ClassifiedCut[]} [args.capDropped]  PR-AD: cuts the maxCutFraction
 *                                             cap silently evicted
 * @param {Array} [args.words]                 PR-AK: word_timestamps so we
 *                                             can enrich each row with the
 *                                             transcript context (prev/next
 *                                             words) around the silence span.
 * @returns {SilenceAudit}
 */
export function auditSilenceCoverage({ mergedSilences, applied, skipped, capDropped = [], words = [] }) {
  const rows = [];
  let detectedSilenceSec = 0;
  let cutSilenceSec = 0;
  let survivingSilenceSec = 0;

  for (const span of mergedSilences) {
    if (typeof span?.start !== 'number' || typeof span?.end !== 'number') continue;
    if (span.end <= span.start) continue;

    const durSec = span.end - span.start;
    detectedSilenceSec += durSec;
    const ctx = contextAround(span.start, span.end, words);

    // First match against applied — the most common case, and we want
    // to report "cut" even if a stricter overlap also exists in skipped.
    const appliedHit = applied.find((c) => overlaps(span.start, span.end, c.start, c.end));
    if (appliedHit) {
      rows.push({
        span: [round3(span.start), round3(span.end)],
        durSec: round3(durSec),
        decision: 'cut',
        reason: appliedHit.safetyReason ?? appliedHit.reason ?? 'unknown',
        prev: ctx.prev,
        next: ctx.next,
      });
      cutSilenceSec += durSec;
      continue;
    }

    const skippedHit = skipped.find((c) => overlaps(span.start, span.end, c.start, c.end));
    if (skippedHit) {
      rows.push({
        span: [round3(span.start), round3(span.end)],
        durSec: round3(durSec),
        decision: 'preserved',
        reason: skippedHit.safetyReason ?? skippedHit.reason ?? 'unknown',
        prev: ctx.prev,
        next: ctx.next,
      });
      survivingSilenceSec += durSec;
      continue;
    }

    // PR-AD: distinguish "cap dropped it" from "no cut was ever generated".
    const cappedHit = capDropped.find((c) => overlaps(span.start, span.end, c.start, c.end));
    const dropReason = cappedHit ? 'max_cut_fraction_cap' : 'subthreshold';

    rows.push({
      span: [round3(span.start), round3(span.end)],
      durSec: round3(durSec),
      decision: 'dropped',
      reason: dropReason,
      prev: ctx.prev,
      next: ctx.next,
    });
    survivingSilenceSec += durSec;
  }

  const spansCut = rows.filter((r) => r.decision === 'cut').length;
  const spansPreserved = rows.filter((r) => r.decision === 'preserved').length;
  const spansDropped = rows.filter((r) => r.decision === 'dropped').length;

  return {
    rows,
    summary: {
      spansDetected: rows.length,
      spansCut,
      spansPreserved,
      spansDropped,
      detectedSilenceSec: round3(detectedSilenceSec),
      cutSilenceSec: round3(cutSilenceSec),
      survivingSilenceSec: round3(survivingSilenceSec),
    },
  };
}

/**
 * Format one audit row as a single log line. Stable, grep-friendly format
 * so future shell pipelines / dashboards can parse it.
 *
 *   [silence-audit] [12.340, 13.120] (0.780s) → CUT (post_sentence_dead_air) | "the right plan." → "And so..."
 *   [silence-audit] [45.100, 46.200] (1.100s) → PRESERVED (mid_sentence_long_pause_0.88s) | "we offer" → "the best"
 *   [silence-audit] [78.000, 78.620] (0.620s) → DROPPED (subthreshold) | "and" → "we"
 *
 * PR-AK: the trailing `| "<prev>" → "<next>"` section shows the actual
 * words ending before the silence and starting after it. Operators can
 * scan the log and immediately tell whether a preserved/dropped span
 * was the right call without opening the source video.
 *
 * Older rows without prev/next still format cleanly (no context segment).
 */
export function formatSilenceAuditLine(row) {
  const [s, e] = row.span;
  const dur = row.durSec;
  const base = `[silence-audit] [${s.toFixed(3)}, ${e.toFixed(3)}] (${dur.toFixed(3)}s) → ${row.decision.toUpperCase()} (${row.reason})`;
  if (row.prev || row.next) {
    return base + ` | "${row.prev || ''}" → "${row.next || ''}"`;
  }
  return base;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
