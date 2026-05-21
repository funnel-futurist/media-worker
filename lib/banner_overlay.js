/**
 * lib/banner_overlay.js
 *
 * Adds an opaque top banner to a 1080x1350 ad video.
 *
 * The banner is a hard reserved zone (y=0 to y=bannerHeight). Nothing
 * else should render there. This function overlays a solid-color rectangle
 * with text on the top of the video, covering any face/broll content
 * that was rendered in that region by the compose step.
 *
 * Pipeline position: AFTER compose (face+broll), BEFORE subtitle burn.
 * The banner is BAKED into the final video for the entire duration —
 * it persists through both talking-head and b-roll segments.
 *
 * Supports either a 2-line layout (text + optional subtext) or the
 * approved SupportED 3-line layout (eyebrow + headline + subtext) where
 * each line can have its own color. The 3-line layout uses:
 *   line 1 (eyebrow):  gold/yellow, small, uppercase
 *   line 2 (headline): white, large, bold, uppercase
 *   line 3 (subtext):  gold/yellow, small, uppercase
 *
 * Uses ffmpeg drawbox (solid background) + drawtext per line. Requires
 * Montserrat font installed on the system (same as subtitle_burn.js).
 */

import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { resolveMontserratBlackPath, escapeDrawtext } from './intro_card_render.js';

const execAsync = promisify(exec);

const DEFAULT_BANNER_HEIGHT = 200;
const DEFAULT_BG_COLOR = '#000000';
const DEFAULT_TEXT_COLOR = '#ffffff';
const DEFAULT_EYEBROW_COLOR = '#E4A92A';
const DEFAULT_SUBTEXT_COLOR = '#E4A92A';
const DEFAULT_HEADLINE_FONT_SIZE = 56;
const DEFAULT_EYEBROW_FONT_SIZE = 30;
const DEFAULT_SUBTEXT_FONT_SIZE = 30;

/**
 * @param {Object} args
 * @param {string} args.inputPath   — the composed MP4 (face + broll at 1080x1350)
 * @param {string} args.outputPath  — output MP4 with banner overlaid
 * @param {Object} args.bannerConfig
 * @param {string} args.bannerConfig.text         — main headline (the largest, white line)
 * @param {string} [args.bannerConfig.eyebrow]    — top line above the headline (gold/yellow, small)
 * @param {string} [args.bannerConfig.subtext]    — bottom line below the headline (gold/yellow, small)
 * @param {string} [args.bannerConfig.bgColor]    — hex color for banner background (default '#000000')
 * @param {string} [args.bannerConfig.textColor]  — hex color for main headline (default '#ffffff')
 * @param {string} [args.bannerConfig.eyebrowColor] — hex color for eyebrow line (default '#E4A92A')
 * @param {string} [args.bannerConfig.subtextColor] — hex color for subtext line (default '#E4A92A')
 * @param {number} [args.bannerConfig.fontSize]   — main headline font size (default 56)
 * @param {number} [args.bannerConfig.eyebrowFontSize] — eyebrow font size (default 30)
 * @param {number} [args.bannerConfig.subtextFontSize] — subtext font size (default 30)
 * @param {number} [args.bannerConfig.height]     — banner height in pixels (default 200)
 * @param {number} [args.timeoutMs=600000]
 * @returns {Promise<{ stderr: string }>}
 */
export async function overlayBanner({ inputPath, outputPath, bannerConfig, timeoutMs = 600_000 }) {
  if (!inputPath || !outputPath) {
    throw new Error('overlayBanner requires inputPath and outputPath');
  }
  if (!existsSync(inputPath)) {
    throw new Error(`overlayBanner: input not found: ${inputPath}`);
  }
  if (!bannerConfig || !bannerConfig.text) {
    throw new Error('overlayBanner: bannerConfig.text is required');
  }

  const height = bannerConfig.height || DEFAULT_BANNER_HEIGHT;
  const bgColor = (bannerConfig.bgColor || DEFAULT_BG_COLOR).replace('#', '');
  const textColor = (bannerConfig.textColor || DEFAULT_TEXT_COLOR).replace('#', '');
  const eyebrowColor = (bannerConfig.eyebrowColor || DEFAULT_EYEBROW_COLOR).replace('#', '');
  const subtextColor = (bannerConfig.subtextColor || DEFAULT_SUBTEXT_COLOR).replace('#', '');
  const fontSize = bannerConfig.fontSize || DEFAULT_HEADLINE_FONT_SIZE;
  const eyebrowFontSize = bannerConfig.eyebrowFontSize || DEFAULT_EYEBROW_FONT_SIZE;
  const subtextFontSize = bannerConfig.subtextFontSize || DEFAULT_SUBTEXT_FONT_SIZE;

  // Resolve Montserrat font — same path as intro_card_render.js.
  // fontfile= is required for drawtext. The fallback `font=` only accepts
  // a bare family name — ffmpeg drawtext does NOT support fontconfig's
  // `:style=Bold` syntax (confirmed: "Option not found" error).
  const fontFile = await resolveMontserratBlackPath();
  const fontArg = fontFile
    ? `fontfile=${escapeDrawtext(fontFile)}`
    : 'font=Montserrat';

  const hasEyebrow = typeof bannerConfig.eyebrow === 'string' && bannerConfig.eyebrow.length > 0;
  const hasSubtext = typeof bannerConfig.subtext === 'string' && bannerConfig.subtext.length > 0;
  const headlineText = escapeDrawtext(bannerConfig.text);
  const eyebrowText = hasEyebrow ? escapeDrawtext(bannerConfig.eyebrow) : null;
  const subtextText = hasSubtext ? escapeDrawtext(bannerConfig.subtext) : null;

  // Vertical layout planning — distribute lines through the banner area
  // with the headline in the visual center.
  //   3-line (eyebrow + headline + subtext): 18% / 50% / 78% of banner height
  //   2-line (headline + subtext):           28% / 62%
  //   2-line (eyebrow + headline):           28% / 62%
  //   1-line (headline only):                center (50%)
  let eyebrowY, headlineY, subtextY;
  if (hasEyebrow && hasSubtext) {
    eyebrowY = Math.round(height * 0.18);
    headlineY = Math.round(height * 0.42);
    subtextY = Math.round(height * 0.78);
  } else if (hasSubtext) {
    headlineY = Math.round(height * 0.28);
    subtextY = Math.round(height * 0.62);
  } else if (hasEyebrow) {
    eyebrowY = Math.round(height * 0.28);
    headlineY = Math.round(height * 0.62);
  } else {
    headlineY = Math.round(height * 0.5 - fontSize / 2);
  }

  // Build the filter chain:
  // 1. drawbox: solid opaque rectangle from y=0 to y=height (covers any
  //    b-roll/face content rendered in the banner zone by compose).
  // 2. drawtext: eyebrow (if present) — gold/yellow, small
  // 3. drawtext: headline — white, large
  // 4. drawtext: subtext (if present) — gold/yellow, small
  let filter = `drawbox=x=0:y=0:w=iw:h=${height}:color=0x${bgColor}:t=fill`;

  if (hasEyebrow) {
    filter += `,drawtext=${fontArg}:text='${eyebrowText}':fontsize=${eyebrowFontSize}:fontcolor=0x${eyebrowColor}:x=(w-text_w)/2:y=${eyebrowY}`;
  }

  filter += `,drawtext=${fontArg}:text='${headlineText}':fontsize=${fontSize}:fontcolor=0x${textColor}:x=(w-text_w)/2:y=${headlineY}`;

  if (hasSubtext) {
    filter += `,drawtext=${fontArg}:text='${subtextText}':fontsize=${subtextFontSize}:fontcolor=0x${subtextColor}:x=(w-text_w)/2:y=${subtextY}`;
  }

  const cmd =
    `ffmpeg -y -i "${inputPath}" ` +
    `-vf "${filter}" ` +
    `-c:v libx264 -preset fast -crf 20 ` +
    `-c:a copy ` +
    `"${outputPath}"`;

  const { stderr } = await execAsync(cmd, {
    timeout: timeoutMs,
    maxBuffer: 50 * 1024 * 1024,
  });

  if (!existsSync(outputPath)) {
    throw new Error('ffmpeg banner overlay produced no output');
  }

  return { stderr: stderr ?? '' };
}
