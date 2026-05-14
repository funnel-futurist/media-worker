/**
 * lib/intro_card_render.js
 *
 * ffmpeg drawtext OVERLAY renderer for the intro hook title text.
 *
 * **PR-Y (2026-05-14) — architecture pivot.** The original PR-L design
 * rendered a standalone 5-second dark-slate card and concat-demuxed it
 * onto the front of cut.mp4. That worked technically but had three
 * issues Shannon flagged on first visual review:
 *   1. Solid background hid the actual video
 *   2. Text could overflow the 1080×1920 frame at long-hook font sizes
 *   3. Subtitles competed with the title during the intro window
 *
 * PR-Y replaces the prepend-and-shift model with a TIME-BOUNDED OVERLAY:
 *   - The original video remains the background — speaker (or b-roll) is
 *     visible behind the title during the intro window
 *   - drawtext uses `enable='between(t,0,N)'` so the text only renders
 *     during the first N seconds, then disappears cleanly
 *   - No concat, no +5s timeline shift, no offset machinery anywhere
 *   - Reel duration is unchanged from the cut video
 *   - Subtitles are filtered out in [0, introDurationSec] by the
 *     orchestrator (separate concern) so they don't overlap the title
 *
 * Visual styling preserved from PR-L (white text, 8px black stroke,
 * 6px shadow, fade in/out, centered) so the card still looks like the
 * polished hook Phoenix asked for.
 *
 * Dynamic font shrinking: if the schedule-picked size produces lines
 * that overflow the safe area, the helper shrinks the font in 8pt
 * steps down to a 48pt floor until everything fits. This addresses
 * jobId db3e829f's `eds Household Runs On C...` clipping at both
 * edges (7 words at 80pt × 0.58 = 2134px overflowed the 1080 frame).
 *
 * drawtext escape rules preserved:
 *   '  → escape as \'
 *   :  → escape as \:
 *   \  → escape as \\
 *   %  → escape as \%
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

const DEFAULT_WIDTH = 1080;
const DEFAULT_HEIGHT = 1920;
const DEFAULT_DURATION_SEC = 5.0;

// Font-size schedule. First-pass sizes by word count. If a chosen size
// produces lines that don't fit, the dynamic shrink loop below drops in
// 8pt steps until the longest line fits or the floor is hit.
const FONT_SIZE_SCHEDULE = [
  { maxWords: 4,  px: 120 },
  { maxWords: 6,  px: 96 },
  { maxWords: Number.MAX_SAFE_INTEGER, px: 80 },
];
const FONT_SIZE_FLOOR_PX = 48;
const FONT_SHRINK_STEP_PX = 8;

const SAFE_HORIZONTAL_MARGIN_PX = 120;
// Pixel-per-glyph estimate for Montserrat Black at the given font sizes.
// Uppercased Title-Case English averages ~0.58× font size per character
// (including spaces).
const AVG_GLYPH_WIDTH_FACTOR = 0.58;
const LINE_SPACING_FACTOR = 1.15;

const FADE_DURATION_SEC = 0.4;

// ── PR-X: Montserrat Black path resolution (unchanged) ──────────────

let _cachedFontPath;
let _cachedFontPathLookupAttempted = false;

const KNOWN_FONT_PATH_CANDIDATES = [
  '/usr/share/fonts/truetype/montserrat/Montserrat-Black.ttf',
  '/usr/share/fonts/opentype/montserrat/Montserrat-Black.otf',
  '/usr/share/fonts/truetype/montserrat/Montserrat-Bold.ttf',
];

/**
 * Resolve Montserrat Black to an absolute font file path. Caches the
 * result after first lookup. Never throws — returns null if nothing
 * resolves, in which case the caller falls back to drawtext's `font=`
 * fontconfig syntax (which may itself fail on degraded containers).
 *
 * @returns {Promise<string | null>}
 */
export async function resolveMontserratBlackPath() {
  if (_cachedFontPathLookupAttempted) return _cachedFontPath ?? null;
  _cachedFontPathLookupAttempted = true;

  const queries = [
    'Montserrat:weight=900',
    'Montserrat:style=Black',
    'Montserrat-Black',
  ];
  for (const query of queries) {
    try {
      const { stdout } = await execAsync(`fc-match -f "%{file}" "${query}"`, { timeout: 5000 });
      const path = String(stdout).trim();
      if (path && existsSync(path) && /montserrat/i.test(path)) {
        _cachedFontPath = path;
        return path;
      }
    } catch {
      // try next
    }
  }

  for (const candidate of KNOWN_FONT_PATH_CANDIDATES) {
    if (existsSync(candidate)) {
      _cachedFontPath = candidate;
      return candidate;
    }
  }

  _cachedFontPath = null;
  return null;
}

/** Reset the cached font path. ONLY for tests. @internal */
export function _resetFontPathCacheForTests() {
  _cachedFontPath = undefined;
  _cachedFontPathLookupAttempted = false;
}

// ── Pure helpers for font sizing + line wrapping ────────────────────

/**
 * Pick the first-pass font size in pixels for the given word count.
 * The dynamic-shrink loop in fitTextToFrame may reduce this further if
 * lines don't fit.
 *
 * @param {number} wordCount
 * @returns {number}
 */
export function fontSizeForWordCount(wordCount) {
  for (const tier of FONT_SIZE_SCHEDULE) {
    if (wordCount <= tier.maxWords) return tier.px;
  }
  return FONT_SIZE_SCHEDULE[FONT_SIZE_SCHEDULE.length - 1].px;
}

/** Estimated rendered width in pixels for a line at the given font size. */
function estimateLineWidthPx(line, fontSizePx) {
  return line.length * fontSizePx * AVG_GLYPH_WIDTH_FACTOR;
}

const MAX_LINES = 3;

/**
 * Try to fit `hookText` at `fontSizePx` using exactly `lineCount` lines.
 * Returns the lines if they all fit within the safe area, or null.
 *
 * Splits are picked greedily for balance: scores by the widest resulting
 * line, lowest-max-width split wins. For 1 line the result is trivially
 * the hook itself; for 2 or 3 lines we enumerate every word-boundary
 * split combination and pick the most balanced fit.
 *
 * @param {string} hookText
 * @param {number} fontSizePx
 * @param {number} containerWidth
 * @param {number} lineCount  1, 2, or 3
 * @returns {string[] | null}
 */
function tryFit(hookText, fontSizePx, containerWidth, lineCount) {
  const safeWidth = containerWidth - 2 * SAFE_HORIZONTAL_MARGIN_PX;

  if (lineCount === 1) {
    return estimateLineWidthPx(hookText, fontSizePx) <= safeWidth ? [hookText] : null;
  }

  const words = hookText.split(/\s+/).filter(Boolean);
  if (words.length < lineCount) return null;

  if (lineCount === 2) {
    let best = null;
    let bestScore = Infinity;
    for (let i = 1; i < words.length; i++) {
      const l1 = words.slice(0, i).join(' ');
      const l2 = words.slice(i).join(' ');
      const w1 = estimateLineWidthPx(l1, fontSizePx);
      const w2 = estimateLineWidthPx(l2, fontSizePx);
      if (w1 <= safeWidth && w2 <= safeWidth) {
        const score = Math.max(w1, w2);
        if (score < bestScore) {
          bestScore = score;
          best = [l1, l2];
        }
      }
    }
    return best;
  }

  // lineCount === 3: enumerate (i, j) split pairs where 0 < i < j < N.
  let best = null;
  let bestScore = Infinity;
  for (let i = 1; i < words.length - 1; i++) {
    for (let j = i + 1; j < words.length; j++) {
      const l1 = words.slice(0, i).join(' ');
      const l2 = words.slice(i, j).join(' ');
      const l3 = words.slice(j).join(' ');
      const w1 = estimateLineWidthPx(l1, fontSizePx);
      const w2 = estimateLineWidthPx(l2, fontSizePx);
      const w3 = estimateLineWidthPx(l3, fontSizePx);
      if (w1 <= safeWidth && w2 <= safeWidth && w3 <= safeWidth) {
        const score = Math.max(w1, w2, w3);
        if (score < bestScore) {
          bestScore = score;
          best = [l1, l2, l3];
        }
      }
    }
  }
  return best;
}

/**
 * Fit the hook text into the frame. Priority order per Shannon's PR-Y
 * spec:
 *
 *   1. Try 1 line at the schedule font size
 *   2. Try 2 lines at the schedule font size
 *   3. Try 3 lines at the schedule font size
 *   4. Only after exhausting all wrap counts → shrink font 8pt and retry
 *      (1 → 2 → 3 lines again at the smaller font)
 *   5. Continue down to FONT_SIZE_FLOOR_PX (48pt) — readability floor
 *
 * Wrap-before-shrink means we prefer 3 lines at 80pt over 1-2 lines at
 * 56pt — keeps the text bigger and more readable. Only when even 3
 * lines won't fit do we drop the font size.
 *
 * Returns the final lines + the chosen font size. If even 48pt × 3
 * lines doesn't fit, returns a 3-line approximate split (may overflow
 * visually); operator review surfaces those edge cases.
 *
 * @param {string} hookText
 * @param {number} [containerWidth=1080]
 * @returns {{ fontSizePx: number, lines: string[] }}
 */
export function fitTextToFrame(hookText, containerWidth = DEFAULT_WIDTH) {
  const words = hookText.split(/\s+/).filter(Boolean);
  let fontSizePx = fontSizeForWordCount(words.length);

  while (fontSizePx >= FONT_SIZE_FLOOR_PX) {
    // Wrap-before-shrink: exhaust 1 → 2 → 3 line attempts at the current
    // font BEFORE dropping the size.
    for (let lineCount = 1; lineCount <= MAX_LINES; lineCount++) {
      const lines = tryFit(hookText, fontSizePx, containerWidth, lineCount);
      if (lines) return { fontSizePx, lines };
    }
    fontSizePx -= FONT_SHRINK_STEP_PX;
  }

  // Floor hit — even 48pt × 3 lines can't fit (e.g., extremely long
  // single words). Best-effort 3-line approximate split. Operator
  // visual review catches these edge cases.
  if (words.length >= MAX_LINES) {
    const thirdSize = Math.ceil(words.length / 3);
    return {
      fontSizePx: FONT_SIZE_FLOOR_PX,
      lines: [
        words.slice(0, thirdSize).join(' '),
        words.slice(thirdSize, thirdSize * 2).join(' '),
        words.slice(thirdSize * 2).join(' '),
      ],
    };
  }
  if (words.length === 2) {
    return { fontSizePx: FONT_SIZE_FLOOR_PX, lines: [words[0], words[1]] };
  }
  return { fontSizePx: FONT_SIZE_FLOOR_PX, lines: [hookText] };
}

// Back-compat shim. wrapHookText() was the PR-L API — kept exported so
// any test or external caller still works. Internally PR-Y uses
// fitTextToFrame which honors the 3-line wrap + shrink priority.
/** @deprecated use fitTextToFrame instead */
export function wrapHookText(hookText, fontSizePx, containerWidth = DEFAULT_WIDTH) {
  // Behavior: try 1 line, then 2 lines at the given font size. Returns
  // [hookText] if neither fits (matches pre-PR-Y semantics for tests).
  for (let lineCount = 1; lineCount <= 2; lineCount++) {
    const lines = tryFit(hookText, fontSizePx, containerWidth, lineCount);
    if (lines) return lines;
  }
  return [hookText];
}

/**
 * Escape a string for use inside an ffmpeg drawtext `text=` argument.
 *
 * @param {string} s
 * @returns {string}
 */
export function escapeDrawtext(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%');
}

// ── PR-Y: overlay-on-video argv builder ──────────────────────────────

/**
 * Build the ffmpeg argv that overlays the hook text on top of an input
 * video for the first `durationSec` seconds. The video frames AND audio
 * pass through unchanged outside the intro window; during the intro
 * window the text renders on top via drawtext's `enable` parameter.
 *
 * Output video matches the input dimensions + frame rate + duration
 * (no concat, no prepend). We re-encode video to apply the overlay
 * (drawtext requires raw frames) but audio is copied without re-encode.
 *
 * @param {object} args
 * @param {string} args.inputVideoPath   path to the video to overlay onto
 * @param {string} args.outputPath
 * @param {string} args.hookText         already validated upstream
 * @param {number} [args.durationSec=5]  intro overlay duration
 * @param {number} [args.width=1080]
 * @param {number} [args.height=1920]
 * @param {string} [args.fontFile]       absolute Montserrat Black path
 * @returns {string[]}                   argv (ffmpeg first)
 */
export function buildIntroOverlayArgs({
  inputVideoPath,
  outputPath,
  hookText,
  durationSec = DEFAULT_DURATION_SEC,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  fontFile,
}) {
  const { fontSizePx, lines } = fitTextToFrame(hookText, width);
  const lineHeightPx = Math.round(fontSizePx * LINE_SPACING_FACTOR);

  // drawtext only renders during the intro window via `enable=`. After
  // the window the drawtext filter is a no-op and source frames pass
  // through untouched.
  const enableExpr = `between(t,0,${durationSec})`;

  // Fade alpha scoped to the intro window:
  //   t < 0.4              → fade in (alpha = t/0.4)
  //   0.4 <= t < N-0.4     → fully visible (alpha = 1)
  //   N-0.4 <= t < N       → fade out (alpha = (N-t)/0.4)
  //   t >= N               → drawtext disabled (no render), alpha irrelevant
  const fade = FADE_DURATION_SEC;
  const fadeOutStart = durationSec - fade;
  const alphaExpr = `if(lt(t,${fade}),t/${fade},if(lt(t,${fadeOutStart}),1,(${durationSec}-t)/${fade}))`;

  // Per-line drawtext filter. Chained with commas so each filter
  // operates on the previous output.
  const drawtextFilters = lines.map((line, idx) => {
    const escaped = escapeDrawtext(line);
    const fontArg = fontFile
      ? `fontfile=${escapeDrawtext(fontFile)}`
      : 'font=Montserrat\\:style=Black';

    // Y position: single line → centered via text_h; two lines → stack
    // around the vertical centre.
    const yExpr = lines.length === 1
      ? '(h-text_h)/2'
      : idx === 0
        ? `(h-${lineHeightPx * 2})/2`
        : `(h-${lineHeightPx * 2})/2 + ${lineHeightPx}`;

    return [
      `drawtext=${fontArg}`,
      `text='${escaped}'`,
      `fontcolor=white`,
      `fontsize=${fontSizePx}`,
      `borderw=8`,
      `bordercolor=black`,
      `shadowx=6`,
      `shadowy=6`,
      `shadowcolor=black@0.7`,
      `x=(w-text_w)/2`,
      `y=${yExpr}`,
      `enable='${enableExpr}'`,
      `alpha='${alphaExpr}'`,
    ].join(':');
  });

  const videoFilter = drawtextFilters.join(',');

  return [
    'ffmpeg',
    '-y',
    '-i', inputVideoPath,
    '-vf', videoFilter,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '18',
    // Copy audio — no re-encode. The overlay doesn't touch audio.
    '-c:a', 'copy',
    outputPath,
  ];
}

/**
 * Render the intro hook overlay onto an existing video. Returns metadata
 * for the orchestrator's `steps.introOverlayRender` entry.
 *
 * @param {object} args  same shape as buildIntroOverlayArgs + optional
 *   execFn (for tests) + optional fontFile (defaults to fc-match lookup)
 * @returns {Promise<{
 *   outputPath: string,
 *   durationSec: number,
 *   lines: string[],
 *   fontSizePx: number,
 *   fontFile: string | null,
 * }>}
 */
export async function renderIntroOverlay(args) {
  let fontFile = args.fontFile;
  if (fontFile === undefined) {
    fontFile = await resolveMontserratBlackPath();
    if (fontFile) {
      console.log(`[intro_card_render] resolved Montserrat Black → ${fontFile}`);
    } else {
      console.log(`[intro_card_render] WARN: could not resolve Montserrat Black via fc-match or known paths; falling back to font=Montserrat\\:style=Black (may fail if fontconfig is degraded)`);
    }
  }

  const argv = buildIntroOverlayArgs({ ...args, fontFile });
  const cmd = argv
    .map((arg, i) => (i === 0 || /^[\w/.-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`))
    .join(' ');

  const execFn = args.execFn ?? execAsync;
  await execFn(cmd, { maxBuffer: 50 * 1024 * 1024 });

  const { fontSizePx, lines } = fitTextToFrame(args.hookText ?? '', args.width ?? DEFAULT_WIDTH);
  return {
    outputPath: args.outputPath,
    durationSec: args.durationSec ?? DEFAULT_DURATION_SEC,
    lines,
    fontSizePx,
    fontFile: fontFile ?? null,
  };
}
