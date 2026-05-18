/**
 * lib/repatch_captions.js
 *
 * PR-AF: caption-only patching for already-edited reels.
 *
 * Pipeline edits get a single end-to-end run that produces final.mp4 with
 * captions burned in. Once the reel is in QC, the only way to correct a
 * Deepgram mis-transcription ("specialist" → "special needs") used to be
 * a full re-edit — which non-deterministically changes b-roll picks,
 * stock fallback, and intro hook text. Chelsea's 2026-05 QC pass made
 * the cost of that variability explicit: she'd called out two specific
 * caption errors but didn't want the rest of the edit reshuffled.
 *
 * PR-AF preserves two intermediates in Storage at edit time:
 *   - pre-caption video (`videoForSubtitles` from the orchestrator —
 *     post-compose, post-intro-overlay, post-banner, pre-subtitle-burn)
 *   - the generated .ass file
 *
 * This module is the pure-function half of the repatch path:
 *   1. applyAssReplacements(assText, replacements) → new .ass text
 *   2. runRepatchCaptions({ inputVideoPath, assPath, outputPath }) →
 *      ffmpeg burn the patched .ass onto the unchanged pre-caption video
 *
 * The orchestrator route (routes/repatch-captions.js) downloads the
 * pre-caption assets, calls applyAssReplacements, writes the new .ass,
 * runs runRepatchCaptions, uploads the result, and POSTs the new URL
 * back to the portal callback. B-roll, cuts, music, and timing are
 * untouched.
 */

import { writeFileSync, readFileSync } from 'fs';
import { spawn } from 'child_process';

/**
 * @typedef {object} CaptionReplacement
 * @property {string} from        text to find (case-sensitive by default)
 * @property {string} to          replacement text
 * @property {'literal'|'regex'} [mode='literal']  literal substring or
 *                                regex (slash-bracketed, e.g. "\\bfoo\\b")
 * @property {boolean} [caseInsensitive=false]  applies to literal mode
 */

/**
 * Apply caption-text replacements to an .ass file's `Dialogue:` lines
 * only. Style blocks, header, and event format lines are untouched —
 * we want to swap the WORDS the burner draws, not the font.
 *
 * Each replacement runs in order over the dialogue lines; later
 * replacements see the output of earlier ones. Returns the patched .ass
 * text plus a per-replacement count so the caller can surface
 * "0 matches for 'specialist'" without grepping the file.
 *
 * @param {string} assText
 * @param {CaptionReplacement[]} replacements
 * @returns {{ text: string, results: Array<{ from: string, to: string, count: number }> }}
 */
export function applyAssReplacements(assText, replacements) {
  if (typeof assText !== 'string') {
    throw new Error('applyAssReplacements: assText must be a string');
  }
  if (!Array.isArray(replacements) || replacements.length === 0) {
    return { text: assText, results: [] };
  }

  const lines = assText.split('\n');
  // Track per-replacement match counts globally across all Dialogue lines.
  const results = replacements.map((r) => ({
    from: r.from,
    to: r.to,
    count: 0,
  }));

  const patched = lines.map((line) => {
    // Only patch `Dialogue: ...` lines — preserve `Style:`, `Format:`,
    // header, etc. exactly as written. ASS format: the 10th field
    // (0-indexed 9) after `Dialogue: ` is the text payload.
    if (!line.startsWith('Dialogue:')) return line;

    // Dialogue: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
    // First 9 commas separate the metadata; everything after the 9th
    // comma is the text payload (which may itself contain commas).
    const prefixMatch = line.match(/^(Dialogue:(?:[^,]*,){9})(.*)$/);
    if (!prefixMatch) return line; // malformed Dialogue — leave alone

    const [, prefix, textField] = prefixMatch;
    let patchedText = textField;

    replacements.forEach((rep, idx) => {
      if (!rep || typeof rep.from !== 'string' || typeof rep.to !== 'string') return;
      const mode = rep.mode === 'regex' ? 'regex' : 'literal';
      let regex;
      try {
        if (mode === 'regex') {
          regex = new RegExp(rep.from, 'g' + (rep.caseInsensitive ? 'i' : ''));
        } else {
          // Escape literal regex metacharacters so dotted/branded terms
          // don't accidentally pattern-match.
          const escaped = rep.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          regex = new RegExp(escaped, 'g' + (rep.caseInsensitive ? 'i' : ''));
        }
      } catch (err) {
        throw new Error(
          `applyAssReplacements: replacement ${idx} has invalid pattern "${rep.from}" (mode=${mode}): ${err.message}`,
        );
      }
      // Count matches first so we can report per-replacement hits even
      // when the same line matches multiple replacements.
      const matches = patchedText.match(regex);
      if (matches) results[idx].count += matches.length;
      patchedText = patchedText.replace(regex, rep.to);
    });

    return prefix + patchedText;
  });

  return { text: patched.join('\n'), results };
}

/**
 * Spawn ffmpeg to burn the (already patched) .ass onto the pre-caption
 * video. Mirrors the original subtitle-burn step's encoder settings so
 * the patched final visually matches the original final's video quality.
 *
 * Throws on any non-zero ffmpeg exit. The caller is responsible for
 * surfacing the error to the portal.
 *
 * @param {object} args
 * @param {string} args.inputVideoPath  pre-caption mp4 on disk
 * @param {string} args.assPath         patched .ass on disk
 * @param {string} args.outputPath      where to write final repatched mp4
 * @returns {Promise<void>}
 */
export function runRepatchCaptions({ inputVideoPath, assPath, outputPath }) {
  if (!inputVideoPath || !assPath || !outputPath) {
    throw new Error('runRepatchCaptions: inputVideoPath, assPath, outputPath required');
  }
  // ffmpeg subtitles filter uses `:` as field separators. On Windows
  // dev machines path strings include drive-letter colons that must be
  // escaped; on Linux this is a no-op for the colon escape but still
  // safe. Single-quoted inside the filter so spaces in the path don't
  // split the args.
  const ffmpegEscapedPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const filter = `subtitles='${ffmpegEscapedPath}'`;

  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputVideoPath,
      '-vf', filter,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'copy',
      outputPath,
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code} during repatch-captions burn`));
    });
  });
}

/**
 * Convenience wrapper for the route handler: reads the .ass, applies
 * replacements, writes the patched .ass, runs the ffmpeg burn. Returns
 * a summary so the route can surface match counts in the response.
 *
 * @param {object} args
 * @param {string} args.preCaptionVideoPath
 * @param {string} args.assPath
 * @param {string} args.patchedAssPath   where to write the patched .ass
 * @param {string} args.outputPath       where to write the final mp4
 * @param {CaptionReplacement[]} args.replacements
 * @returns {Promise<{ totalMatches: number, results: Array<{ from: string, to: string, count: number }> }>}
 */
export async function repatchCaptionsOnDisk({
  preCaptionVideoPath,
  assPath,
  patchedAssPath,
  outputPath,
  replacements,
}) {
  const originalAss = readFileSync(assPath, 'utf8');
  const { text, results } = applyAssReplacements(originalAss, replacements);
  writeFileSync(patchedAssPath, text, 'utf8');
  await runRepatchCaptions({
    inputVideoPath: preCaptionVideoPath,
    assPath: patchedAssPath,
    outputPath,
  });
  const totalMatches = results.reduce((s, r) => s + r.count, 0);
  return { totalMatches, results };
}
