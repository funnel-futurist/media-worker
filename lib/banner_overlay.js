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
 *
 * Uses ffmpeg drawbox (solid background) + drawtext (headline + subtext).
 * Requires Montserrat font installed on the system (same as subtitle_burn.js).
 */

import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { resolveMontserratBlackPath, escapeDrawtext } from './intro_card_render.js';

const execAsync = promisify(exec);

const DEFAULT_BANNER_HEIGHT = 200;
const DEFAULT_BG_COLOR = '#1a1a2e';
const DEFAULT_TEXT_COLOR = '#ffffff';
const DEFAULT_FONT_SIZE = 44;
const DEFAULT_SUBTEXT_FONT_SIZE = 22;

/**
 * @param {Object} args
 * @param {string} args.inputPath   — the composed MP4 (face + broll at 1080x1350)
 * @param {string} args.outputPath  — output MP4 with banner overlaid
 * @param {Object} args.bannerConfig
 * @param {string} args.bannerConfig.text       — main headline (e.g., "Parents of AP Students")
 * @param {string} [args.bannerConfig.subtext]  — secondary line (e.g., "SupportED Tutoring")
 * @param {string} [args.bannerConfig.bgColor]  — hex color for banner background
 * @param {string} [args.bannerConfig.textColor] — hex color for text
 * @param {string} [args.bannerConfig.font]     — font family name
 * @param {number} [args.bannerConfig.fontSize]  — main text font size
 * @param {number} [args.bannerConfig.subtextFontSize] — subtext font size
 * @param {number} [args.bannerConfig.height]   — banner height in pixels
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
  const fontSize = bannerConfig.fontSize || DEFAULT_FONT_SIZE;
  const subtextFontSize = bannerConfig.subtextFontSize || DEFAULT_SUBTEXT_FONT_SIZE;

  // Resolve Montserrat font — same path as intro_card_render.js.
  // fontfile= is required for drawtext. The fallback `font=` only accepts
  // a bare family name — ffmpeg drawtext does NOT support fontconfig's
  // `:style=Bold` syntax (confirmed: "Option not found" error).
  const fontFile = await resolveMontserratBlackPath();
  const fontArg = fontFile
    ? `fontfile=${escapeDrawtext(fontFile)}`
    : 'font=Montserrat';

  const mainText = escapeDrawtext(bannerConfig.text);
  const subtext = bannerConfig.subtext ? escapeDrawtext(bannerConfig.subtext) : null;

  // Build the vf chain:
  // 1. drawbox: solid opaque rectangle from y=0 to y=height
  // 2. drawtext: main headline centered in banner area
  // 3. drawtext: optional subtext below the main headline
  //
  // Text vertical positioning:
  //   - If both text + subtext: main at y = height*0.28, subtext at y = height*0.62
  //   - If only text: main at y = height*0.35 (vertically centered)
  const mainY = subtext ? Math.round(height * 0.28) : Math.round(height * 0.35);
  const subtextY = Math.round(height * 0.62);

  let filter = `drawbox=x=0:y=0:w=iw:h=${height}:color=0x${bgColor}:t=fill`;

  filter += `,drawtext=${fontArg}:text='${mainText}':fontsize=${fontSize}:fontcolor=0x${textColor}:x=(w-text_w)/2:y=${mainY}`;

  if (subtext) {
    filter += `,drawtext=${fontArg}:text='${subtext}':fontsize=${subtextFontSize}:fontcolor=0x${textColor}:x=(w-text_w)/2:y=${subtextY}`;
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
