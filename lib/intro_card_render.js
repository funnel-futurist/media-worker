/**
 * lib/intro_card_render.js
 *
 * ffmpeg drawtext renderer for the 5-second intro hook title card (PR-L,
 * 2026-05-13). Produces a polished, bold, stroked, shadowed centered
 * card on a dark slate background. NOT the default plain-drawtext look.
 *
 * Approved visual spec (Shannon, plan v2):
 *   - Background: deep neutral #0F1419 (high contrast, premium feel)
 *   - Font: Montserrat Black (resolved via fc-match at runtime — same
 *     family the subtitle burn uses)
 *   - Font size: AUTO-SCALES by word count
 *       - ≤ 4 words → 120pt
 *       - 5–6 words → 96pt
 *       - 7–8 words → 80pt
 *     Longer hooks still fit in the safe area.
 *   - Fill: white #FFFFFF
 *   - Stroke: black, 8px outline (drawtext borderw=8:bordercolor=black)
 *   - Shadow: black, 6px offset, 70% alpha
 *   - Layout: centered horizontally + vertically; 120px safe margins
 *     left/right; auto line-wrap when text won't fit on one line at the
 *     chosen font size.
 *   - Fade: 400ms in, 400ms out (alpha eased via if-expressions)
 *   - Output: 1080×1920, h264/yuv420p, 30fps, AAC silent audio of EXACT
 *     `durationSec` so concat-demuxer matches cut.mp4 byte-cleanly.
 *
 * The orchestrator concats intro.mp4 + cut.mp4 via ffmpeg's concat
 * demuxer, which refuses to merge files with different codecs / sample
 * rates / dimensions without re-encoding. This module's output is
 * locked to the same shape the rest of the clean-mode pipeline produces
 * (1080×1920, h264 yuv420p 30fps + 48000Hz stereo AAC).
 *
 * drawtext escape rules are notoriously fragile:
 *   '  → escape as \'  (drawtext quoting)
 *   :  → escape as \:  (drawtext arg separator)
 *   \  → escape as \\  (literal backslash)
 *   %  → escape as \%  (drawtext expansion)
 *
 * Plus the AAC silent track gives us a clean concat-demuxer match without
 * re-encoding (the cut.mp4 already has AAC audio).
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

const DEFAULT_WIDTH = 1080;
const DEFAULT_HEIGHT = 1920;
const DEFAULT_DURATION_SEC = 5.0;
const DEFAULT_BG_HEX = '0x0F1419';

// PR-X (2026-05-14): resolved font path. drawtext's `font=<family>`
// syntax goes through fontconfig and was failing on Railway today
// (jobId c88d5d3f: hook gen succeeded, drawtext refused to render).
// Fix: resolve to an absolute path via `fc-match` once at module load,
// pass it as `fontfile=` in drawtext args. Cached after first lookup.
//
// Fallback chain if fc-match isn't available or finds nothing:
//   1. fc-match Montserrat:weight=900   (preferred — picks Black weight)
//   2. fc-match Montserrat:style=Black  (alternate fontconfig syntax)
//   3. Known Debian/Ubuntu path for fonts-montserrat-extra
//   4. Known Debian/Ubuntu path for fonts-montserrat (regular)
//   5. null — caller falls back to font= and may fail loudly
let _cachedFontPath;
let _cachedFontPathLookupAttempted = false;

const KNOWN_FONT_PATH_CANDIDATES = [
  '/usr/share/fonts/truetype/montserrat/Montserrat-Black.ttf',
  '/usr/share/fonts/opentype/montserrat/Montserrat-Black.otf',
  '/usr/share/fonts/truetype/montserrat/Montserrat-Bold.ttf',
];

/**
 * Resolve the Montserrat Black font file path. Returns the cached value
 * if previously resolved. Synchronous fallback paths are tried after
 * fc-match. NEVER throws — returns null if nothing is found, in which
 * case buildIntroCardArgs falls back to `font=` (and the render will
 * likely fail, but at least the error message will be informative).
 *
 * Exported for tests; production code calls via getMontserratBlackPath().
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
      // fc-match always returns SOMETHING (falls back to default sans
      // when no match) — only accept if the path actually contains the
      // word "montserrat" (case-insensitive). Otherwise we'd silently
      // ship reels in DejaVu Sans or similar.
      if (path && existsSync(path) && /montserrat/i.test(path)) {
        _cachedFontPath = path;
        return path;
      }
    } catch {
      // Either fc-match isn't installed, the query failed, or the
      // command timed out. Try next query / fallback path.
    }
  }

  // fc-match couldn't find a Montserrat path — try known Debian/Ubuntu
  // package install locations directly. fonts-montserrat-extra installs
  // Black; fonts-montserrat (regular) ships Regular + Bold and is a
  // last-resort fallback.
  for (const candidate of KNOWN_FONT_PATH_CANDIDATES) {
    if (existsSync(candidate)) {
      _cachedFontPath = candidate;
      return candidate;
    }
  }

  _cachedFontPath = null;
  return null;
}

/**
 * Reset the cached font path. ONLY for tests.
 * @internal
 */
export function _resetFontPathCacheForTests() {
  _cachedFontPath = undefined;
  _cachedFontPathLookupAttempted = false;
}

// Font-size schedule. Keys are the upper bound (inclusive) on word count.
// `Number.MAX_SAFE_INTEGER` catches anything longer (validation upstream
// caps at 8 words but we don't hard-fail here on a 9-word stray).
const FONT_SIZE_SCHEDULE = [
  { maxWords: 4,  px: 120 },
  { maxWords: 6,  px: 96 },
  { maxWords: Number.MAX_SAFE_INTEGER, px: 80 },
];

// Safe horizontal margin (each side) and line-spacing factor.
const SAFE_HORIZONTAL_MARGIN_PX = 120;
// Pixel-per-glyph estimate for Montserrat Black. Uppercased Title-Case
// English text in Montserrat Black averages ~0.58× the font size per
// character (including spaces). Used only to decide whether the hook
// needs a line wrap — drawtext will render whatever we give it; this
// math just decides one-line vs two-line layout.
const AVG_GLYPH_WIDTH_FACTOR = 0.58;
const LINE_SPACING_FACTOR = 1.15;

const FADE_DURATION_SEC = 0.4;

/**
 * Pick the font size in pixels for the given word count per the schedule.
 *
 * @param {number} wordCount
 * @returns {number}
 */
export function fontSizeForWordCount(wordCount) {
  for (const tier of FONT_SIZE_SCHEDULE) {
    if (wordCount <= tier.maxWords) return tier.px;
  }
  // Schedule's last tier uses Number.MAX_SAFE_INTEGER so we never fall through.
  return FONT_SIZE_SCHEDULE[FONT_SIZE_SCHEDULE.length - 1].px;
}

/**
 * Split a hook into one or two lines so each line fits within the safe
 * horizontal area at the chosen font size. Returns an array of 1 or 2
 * strings. Picks the split nearest to the centre that lands both halves
 * inside the budget; if no single split works (very long words), keeps
 * the hook on one line and lets the operator's visual review catch it.
 *
 * @param {string} hookText
 * @param {number} fontSizePx
 * @param {number} [containerWidth=1080]
 * @returns {string[]}  1 or 2 lines
 */
export function wrapHookText(hookText, fontSizePx, containerWidth = DEFAULT_WIDTH) {
  const safeWidth = containerWidth - 2 * SAFE_HORIZONTAL_MARGIN_PX;
  const estPx = (s) => s.length * fontSizePx * AVG_GLYPH_WIDTH_FACTOR;
  if (estPx(hookText) <= safeWidth) return [hookText];

  const words = hookText.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [hookText]; // can't split a single word

  // Try each possible 2-line split. Score = max(line1Width, line2Width).
  // Lowest max width wins (most balanced split that also fits).
  let bestSplit = null;
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const line1 = words.slice(0, i).join(' ');
    const line2 = words.slice(i).join(' ');
    const w1 = estPx(line1);
    const w2 = estPx(line2);
    const score = Math.max(w1, w2);
    if (w1 <= safeWidth && w2 <= safeWidth && score < bestScore) {
      bestScore = score;
      bestSplit = [line1, line2];
    }
  }
  return bestSplit ?? [hookText];
}

/**
 * Escape a string for use inside an ffmpeg drawtext `text=` argument.
 * drawtext is doubly-quoted so we need to escape both shell-quoting (we
 * use single-quotes around the whole filter graph) AND drawtext's own
 * special characters.
 *
 * @param {string} s
 * @returns {string}
 */
export function escapeDrawtext(s) {
  return s
    .replace(/\\/g, '\\\\')   // \  → \\
    .replace(/'/g, "\\'")     // '  → \'
    .replace(/:/g, '\\:')     // :  → \:
    .replace(/%/g, '\\%');    // %  → \%
}

/**
 * Build the ffmpeg argv that renders the intro card.
 *
 * Pure function. Exported so tests can lock the argv shape without
 * spawning ffmpeg. Returns the argv as an array suitable for passing to
 * `spawn` or for joining into an `exec`-style command (escaping for the
 * shell is the caller's responsibility — `renderIntroCard` below uses
 * exec with carefully constructed quoting).
 *
 * @param {object} args
 * @param {string} args.hookText                 already validated by hook_generate
 * @param {string} args.outputPath
 * @param {number} [args.durationSec=5]
 * @param {number} [args.width=1080]
 * @param {number} [args.height=1920]
 * @param {string} [args.fontFile]  absolute path to Montserrat Black ttf;
 *   when omitted we use `font=Montserrat\\:style=Black` (drawtext uses
 *   fontconfig — same path subtitle burn uses).
 * @returns {string[]}  argv (ffmpeg first)
 */
export function buildIntroCardArgs({
  hookText,
  outputPath,
  durationSec = DEFAULT_DURATION_SEC,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  fontFile,
}) {
  const words = hookText.split(/\s+/).filter(Boolean);
  const fontSizePx = fontSizeForWordCount(words.length);
  const lines = wrapHookText(hookText, fontSizePx, width);

  const lineHeightPx = Math.round(fontSizePx * LINE_SPACING_FACTOR);
  // For two-line output, position the BLOCK of two lines centered
  // vertically: y_first = (h - blockHeight) / 2; y_second = y_first + lineHeight.
  // For one line: y = (h - text_h) / 2 (drawtext computes text_h itself).

  // Fade alpha expression. drawtext supports per-frame alpha via the `alpha`
  // option. Linear fade in/out at the boundaries.
  //   - 0 → FADE_DURATION_SEC          : alpha = t / FADE
  //   - FADE → durationSec - FADE      : alpha = 1
  //   - durationSec - FADE → durationSec: alpha = (durationSec - t) / FADE
  const fade = FADE_DURATION_SEC;
  const fadeOutStart = durationSec - fade;
  const alphaExpr = `if(lt(t,${fade}),t/${fade},if(lt(t,${fadeOutStart}),1,(${durationSec}-t)/${fade}))`;

  // Build one drawtext filter per line.
  const drawtextFilters = lines.map((line, idx) => {
    const escaped = escapeDrawtext(line);
    const fontArg = fontFile
      ? `fontfile=${escapeDrawtext(fontFile)}`
      : 'font=Montserrat\\:style=Black';
    // Y position: single line → centered via text_h; two lines → stacked
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
      `alpha='${alphaExpr}'`,
    ].join(':');
  });

  // Chain the drawtext filters with commas (each subsequent one operates
  // on the previous one's output).
  const videoFilter = drawtextFilters.join(',');

  return [
    'ffmpeg',
    '-y',                                                              // overwrite if exists
    '-f', 'lavfi', '-i', `color=c=${DEFAULT_BG_HEX}:s=${width}x${height}:d=${durationSec}:r=30`,
    '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000:d=${durationSec}`,
    '-vf', videoFilter,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '18',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest',
    outputPath,
  ];
}

/**
 * Render the intro card to disk. Spawns ffmpeg. Returns the metadata
 * the orchestrator records in steps.introCardRender.
 *
 * @param {object} args  same shape as buildIntroCardArgs + optional
 *   execFn (for tests)
 * @returns {Promise<{ outputPath: string, durationSec: number, lines: string[], fontSizePx: number }>}
 */
export async function renderIntroCard(args) {
  // PR-X: resolve Montserrat Black to an absolute font file path so
  // drawtext loads the file directly instead of going through fontconfig
  // (which was failing on Railway today, jobId c88d5d3f). Callers can
  // still override by passing args.fontFile explicitly — useful for
  // tests and for forcing a specific font in the future.
  let fontFile = args.fontFile;
  if (!fontFile) {
    fontFile = await resolveMontserratBlackPath();
    if (fontFile) {
      console.log(`[intro_card_render] resolved Montserrat Black → ${fontFile}`);
    } else {
      console.log(`[intro_card_render] WARN: could not resolve Montserrat Black via fc-match or known paths; falling back to font=Montserrat\\:style=Black (may fail if fontconfig is degraded)`);
    }
  }

  const argv = buildIntroCardArgs({ ...args, fontFile });
  const cmd = argv
    // Quote any argv element that contains whitespace or a colon to make
    // it safe for exec(). The drawtext-specific characters inside the
    // -vf argument are already escaped by buildIntroCardArgs; we only
    // need shell-level quoting here.
    .map((arg, i) => (i === 0 || /^[\w/.-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`))
    .join(' ');

  const execFn = args.execFn ?? execAsync;
  await execFn(cmd, { maxBuffer: 10 * 1024 * 1024 });

  const words = (args.hookText ?? '').split(/\s+/).filter(Boolean);
  const fontSizePx = fontSizeForWordCount(words.length);
  const lines = wrapHookText(args.hookText ?? '', fontSizePx, args.width ?? DEFAULT_WIDTH);
  return {
    outputPath: args.outputPath,
    durationSec: args.durationSec ?? DEFAULT_DURATION_SEC,
    lines,
    fontSizePx,
    fontFile: fontFile ?? null,
  };
}
