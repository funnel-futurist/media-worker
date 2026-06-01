/**
 * lib/ai_edit_mode.js
 *
 * Pure resolver for the `aiEditMode` preset (2026-06-01).
 *
 * Two modes the client picks between, for both reels and ads:
 *   - 'subtitles_hook_only' — captions + AI hook title + cleanup; NO b-roll.
 *   - 'hook_subtitles_broll' — captions + AI hook title + cleanup + b-roll
 *                              (the current default behavior).
 *
 * The preset is a DEFAULT-SETTER. If the caller already sends explicit
 * `skipBroll` or `introHookEnabled` in the request body, those win — this
 * preserves backward compatibility for every existing caller that addresses
 * the granular flags directly.
 *
 * Why both reels and ads default to 'hook_subtitles_broll' when the field
 * is omitted: that's the current production behavior. We don't want adding
 * this preset to silently flip any in-flight ad workflow that today expects
 * b-roll. The portal will pre-pick 'subtitles_hook_only' for ads in its UI
 * and send it explicitly when that's what the client chose.
 *
 * Underlying machinery the preset selects between (none of it new — all
 * already validated + consumed by clean_mode_pipeline.js):
 *   - skipBroll          → gates the brollLibrary / picker / download / compose
 *   - introHookEnabled   → gates the post-compose hook-title drawtext overlay
 *
 * Does NOT touch:
 *   - bannerEnabled / bannerConfig (ads' alternative hook surface — orthogonal)
 *   - captionStyle / skipSubtitles (caption styling + on/off stay independent)
 *   - any cleanup flags (dead-air, bad-take, slate removal all run in both modes)
 */

export const AI_EDIT_MODES = Object.freeze([
  'subtitles_hook_only',
  'hook_subtitles_broll',
]);

// Default when the caller omits aiEditMode. Same for reels and ads to keep
// current production behavior unchanged.
export const DEFAULT_AI_EDIT_MODE = 'hook_subtitles_broll';

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isValidAiEditMode(value) {
  return AI_EDIT_MODES.includes(value);
}

/**
 * Resolve the aiEditMode preset into the two pipeline flags it gates.
 *
 * Precedence: explicit caller-supplied `skipBroll` / `introHookEnabled`
 * win over the preset's defaults (backward-compat). The `source` field
 * surfaces which path produced each value so the operator can see it in
 * the [ai-edit-mode] log.
 *
 * @param {Object} args
 * @param {string|undefined} [args.aiEditMode]   opts.aiEditMode (route-validated upstream)
 * @param {Object} [args.explicit]               the raw opts. Honored fields:
 *                                                 - skipBroll        (boolean)
 *                                                 - introHookEnabled (boolean)
 * @returns {{
 *   aiEditMode: 'subtitles_hook_only'|'hook_subtitles_broll',
 *   skipBroll: boolean,
 *   introHookEnabled: boolean,
 *   source: 'preset' | 'explicit' | 'mixed'
 * }}
 */
export function resolveAiEditMode({ aiEditMode, explicit } = {}) {
  const mode = isValidAiEditMode(aiEditMode) ? aiEditMode : DEFAULT_AI_EDIT_MODE;
  const ex = explicit ?? {};

  // Preset values.
  const presetSkipBroll = mode === 'subtitles_hook_only';
  const presetIntroHookEnabled = true; // both modes enable the hook title per spec.

  // Explicit caller flags (only `boolean` counts — null/undefined defers).
  const hasExplicitSkipBroll = typeof ex.skipBroll === 'boolean';
  const hasExplicitIntroHook = typeof ex.introHookEnabled === 'boolean';

  const skipBroll = hasExplicitSkipBroll ? ex.skipBroll : presetSkipBroll;
  const introHookEnabled = hasExplicitIntroHook ? ex.introHookEnabled : presetIntroHookEnabled;

  let source;
  if (hasExplicitSkipBroll && hasExplicitIntroHook) source = 'explicit';
  else if (!hasExplicitSkipBroll && !hasExplicitIntroHook) source = 'preset';
  else source = 'mixed';

  return { aiEditMode: mode, skipBroll, introHookEnabled, source };
}
