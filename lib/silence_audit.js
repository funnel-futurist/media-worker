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
 * Build the audit. Pure function — no I/O, no logging.
 *
 * @param {object} args
 * @param {SilenceSpan[]} args.mergedSilences  output of mergeAdjacentSilences
 * @param {ClassifiedCut[]} args.applied       cutResult.applied
 * @param {ClassifiedCut[]} args.skipped       cutResult.skipped
 * @returns {SilenceAudit}
 */
export function auditSilenceCoverage({ mergedSilences, applied, skipped }) {
  const rows = [];
  let detectedSilenceSec = 0;
  let cutSilenceSec = 0;
  let survivingSilenceSec = 0;

  for (const span of mergedSilences) {
    if (typeof span?.start !== 'number' || typeof span?.end !== 'number') continue;
    if (span.end <= span.start) continue;

    const durSec = span.end - span.start;
    detectedSilenceSec += durSec;

    // First match against applied — the most common case, and we want
    // to report "cut" even if a stricter overlap also exists in skipped.
    const appliedHit = applied.find((c) => overlaps(span.start, span.end, c.start, c.end));
    if (appliedHit) {
      rows.push({
        span: [round3(span.start), round3(span.end)],
        durSec: round3(durSec),
        decision: 'cut',
        reason: appliedHit.safetyReason ?? appliedHit.reason ?? 'unknown',
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
      });
      survivingSilenceSec += durSec;
      continue;
    }

    // Detector found a silence but no cut was generated. This happens
    // when retain + preserve eat the whole span, or the post-trim cut
    // window is < minCutDurationSec.
    rows.push({
      span: [round3(span.start), round3(span.end)],
      durSec: round3(durSec),
      decision: 'dropped',
      reason: 'subthreshold',
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
 *   [silence-audit] [12.340, 13.120] (0.780s) → CUT (post_sentence_dead_air)
 *   [silence-audit] [45.100, 46.200] (1.100s) → PRESERVED (mid_sentence_long_pause_0.88s)
 *   [silence-audit] [78.000, 78.620] (0.620s) → DROPPED (subthreshold)
 */
export function formatSilenceAuditLine(row) {
  const [s, e] = row.span;
  const dur = row.durSec;
  return `[silence-audit] [${s.toFixed(3)}, ${e.toFixed(3)}] (${dur.toFixed(3)}s) → ${row.decision.toUpperCase()} (${row.reason})`;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
