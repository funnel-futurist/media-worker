/**
 * lib/options_validation.js
 *
 * 2026-06-15: shared validators for the body.options fields that affect
 * the cut-classifier output (silence detect → Deepgram → slate detect →
 * cut classify). Extracted from routes/clean-mode-compose.js so the new
 * dry-run route (/clean-mode-classify) can validate the same option
 * surface without duplicating the inline checks.
 *
 * NOT a full extraction of every clean-mode-compose validator — only the
 * subset whose value changes the cut-classifier result. B-roll, banner,
 * intro hook, BGM, output size, raw cleanup, best-take, and aiEditMode
 * validators stay inline in clean-mode-compose.js (they don't affect
 * cuts and the dry-run rejects them implicitly by ignoring them).
 *
 * Pattern: each validator returns `null` on pass or an error string on
 * fail. The caller maps `string` → `400 { jobId, step: 'validate', error }`.
 * Pure functions — no I/O, easy to unit test.
 */

/**
 * Returns null if cutSafetyMode is omitted or one of the allowed enums.
 * Returns an error string otherwise.
 */
export function validateCutSafetyMode(v) {
  if (v == null) return null;
  if (v !== 'safe_only' && v !== 'safe_and_soft' && v !== 'all') {
    return "options.cutSafetyMode must be 'safe_only', 'safe_and_soft', or 'all'";
  }
  return null;
}

/**
 * Returns null if retainSec is omitted or a finite number in (0, 1].
 * Returns an error string otherwise.
 */
export function validateRetainSec(v) {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1) {
    return 'options.retainSec must be a number in (0, 1]';
  }
  return null;
}

/**
 * Returns null if silenceNoiseDb is omitted or a finite number in [-60, -10].
 */
export function validateSilenceNoiseDb(v) {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < -60 || v > -10) {
    return 'options.silenceNoiseDb must be a number in [-60, -10]';
  }
  return null;
}

/**
 * Returns null if silenceMinDur is omitted or a finite number in (0, 5].
 */
export function validateSilenceMinDur(v) {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 5) {
    return 'options.silenceMinDur must be a number in (0, 5]';
  }
  return null;
}

/**
 * Returns null if slateHint is omitted or a string ≤ 200 chars.
 */
export function validateSlateHint(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return 'options.slateHint must be a string';
  if (v.length > 200) return 'options.slateHint must be ≤ 200 characters';
  return null;
}

/**
 * Returns null if skipSlate is omitted or a boolean.
 */
export function validateSkipSlate(v) {
  if (v == null) return null;
  if (typeof v !== 'boolean') return 'options.skipSlate must be a boolean';
  return null;
}

/**
 * Returns null if deepgramKeywords is omitted or an array of ≤ 20
 * non-empty strings, each ≤ 200 chars.
 */
export function validateDeepgramKeywords(v) {
  if (v == null) return null;
  if (!Array.isArray(v)) return 'options.deepgramKeywords must be an array of strings';
  if (v.length > 20) return 'options.deepgramKeywords may not exceed 20 entries';
  for (let i = 0; i < v.length; i++) {
    const term = v[i];
    if (typeof term !== 'string' || term.trim().length === 0) {
      return `options.deepgramKeywords[${i}] must be a non-empty string`;
    }
    if (term.length > 200) {
      return `options.deepgramKeywords[${i}] is too long (max 200 chars)`;
    }
  }
  return null;
}

/**
 * Runs ALL cut-affecting validators against `options`. Returns the first
 * error string, or null if every field passes. Used by /clean-mode-classify
 * to gate the dry-run pipeline.
 */
export function validateClassifyOptions(options) {
  if (options == null) return null;
  if (typeof options !== 'object') return 'options must be an object';
  const checks = [
    validateCutSafetyMode(options.cutSafetyMode),
    validateRetainSec(options.retainSec),
    validateSilenceNoiseDb(options.silenceNoiseDb),
    validateSilenceMinDur(options.silenceMinDur),
    validateSlateHint(options.slateHint),
    validateSkipSlate(options.skipSlate),
    validateDeepgramKeywords(options.deepgramKeywords),
  ];
  for (const err of checks) {
    if (err !== null) return err;
  }
  return null;
}
