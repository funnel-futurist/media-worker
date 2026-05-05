/**
 * lib/subtitle_burn.js
 *
 * Subtitle generation + burn for the M2 clean-mode pipeline. Mirrors
 * creative-engine/scripts/add_subtitles.ts (now on main via PR #146) for the
 * .ass styling + ffmpeg burn, but uses **math-remap** instead of a second
 * Scribe transcription per Shannon's M2 adjustment #3.
 *
 * Why math-remap?
 *   - The cut step REMOVES segments of the source video (silences, bad takes).
 *   - The b-roll step REPLACES face video frames with broll frames at certain
 *     timestamps, but the AUDIO TRACK IS UNCHANGED (face audio plays
 *     continuously underneath brolls — that's what audio passthrough means
 *     in our compose step).
 *   - Therefore: speech timing in `brolled.mp4` is identical to speech timing
 *     in `cut.mp4`; word timestamps from the source-MP4 Scribe transcript,
 *     shifted backward by the sum of cut durations BEFORE each word, are
 *     accurate for both `cut.mp4` AND `brolled.mp4`.
 *   - Re-transcribing would yield the same timestamps (modulo Scribe's per-call
 *     drift) at extra cost (~$0.20 + ~20s per video).
 *
 * Re-transcription is preserved as a future diagnostic option (gated behind
 * an explicit `--diagnostic-retranscribe` flag) ONLY if real-world testing
 * shows visible drift. Until then: math remap is the production path.
 */

import { existsSync, writeFileSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const PUNCT_END = /[.!?]$/;

/**
 * Remap source-MP4 word timestamps through the applied cuts list. Words
 * whose start falls INSIDE any cut span are dropped (their audio is gone);
 * surviving words have their start_ms / end_ms shifted backward by the sum
 * of cut durations BEFORE the word.
 *
 * Identical math to the Hyperframes captions runtime
 * (creative-engine/lib/hyperframes/render_blueprint.ts:emitCaptions —
 * the `transcriptShift.cuts` field).
 *
 * @param {Array<{ word: string, start_ms: number, end_ms: number }>} words
 *   from Scribe on source.mp4
 * @param {Array<{ start: number, end: number }>} appliedCuts
 *   sorted-or-unsorted seconds. Will be sorted internally.
 * @returns {Array<{ word: string, start_ms: number, end_ms: number }>}
 */
export function remapWordsThroughCuts(words, appliedCuts) {
  if (!Array.isArray(words)) throw new Error('words must be an array');
  if (!Array.isArray(appliedCuts)) throw new Error('appliedCuts must be an array');
  const cuts = [...appliedCuts]
    .filter((c) => c && typeof c.start === 'number' && typeof c.end === 'number' && c.end > c.start)
    .sort((a, b) => a.start - b.start);

  const out = [];
  for (const w of words) {
    const startSec = w.start_ms / 1000;
    if (cuts.some((c) => startSec >= c.start && startSec < c.end)) continue;
    const shiftSec = cuts
      .filter((c) => c.end <= startSec)
      .reduce((s, c) => s + (c.end - c.start), 0);
    const shiftMs = Math.round(shiftSec * 1000);
    out.push({
      word: w.word,
      start_ms: Math.max(0, w.start_ms - shiftMs),
      end_ms: Math.max(0, w.end_ms - shiftMs),
    });
  }
  return out;
}

/**
 * Group remapped words into readable subtitle lines.
 *
 * Break a line when ANY of:
 *   - last word ends with .!? (sentence end)
 *   - line duration ≥ maxDurationSec
 *   - line word count ≥ maxWords
 *   - last word in the input
 *
 * Lines are uppercased — matches the ff_clean_subtitle / Chelsea-Phil style.
 *
 * Defaults are tuned for **short-form talking-head reels** (PR-talking-head-style):
 * 4 words and 1.8 seconds per line keep captions punchy and readable on
 * mobile-first 9:16 playback. Older calls that want documentary-paced
 * pacing can pass higher values explicitly.
 *
 * @param {Array<{ word: string, start_ms: number, end_ms: number }>} words
 * @param {number} maxWords  default 4 (talking-head reel)
 * @param {number} maxDurationSec  default 1.8 (talking-head reel)
 * @returns {Array<{ start: number, end: number, text: string, wordCount: number }>}
 */
export function groupIntoLines(words, maxWords = 4, maxDurationSec = 1.8) {
  const lines = [];
  let buf = [];
  for (let i = 0; i < words.length; i++) {
    buf.push(words[i]);
    const next = words[i + 1];
    const word = words[i];
    const breakOnPunct = PUNCT_END.test(word.word);
    const lineDurSec = (buf[buf.length - 1].end_ms - buf[0].start_ms) / 1000;
    const breakOnDur = lineDurSec >= maxDurationSec;
    const breakOnMax = buf.length >= maxWords;
    if (!next || breakOnPunct || breakOnDur || breakOnMax) {
      const text = buf.map((w) => w.word).join(' ').toUpperCase();
      lines.push({
        start: buf[0].start_ms / 1000,
        end: buf[buf.length - 1].end_ms / 1000,
        text,
        wordCount: buf.length,
      });
      buf = [];
    }
  }
  return lines;
}

function formatAssTime(sec) {
  const safe = Math.max(0, sec);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const wholeSec = Math.floor(s);
  const cs = Math.round((s - wholeSec) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(wholeSec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text) {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

/**
 * Generate the .ass content for **short-form talking-head reel** subtitles
 * — the style Shannon validated visually: punchy 4-word groups, big bold
 * font, white-on-dark stroke, captions at shoulder/upper-chest level
 * (PR #106 lowered from face-covering position).
 *
 *   - Montserrat **80pt**, weight 700 (Bold=-1) — bumped from 50 for reel readability
 *   - White primary (&H00FFFFFF), dark outline (&H001A1A1A) 4pt — kept (looked good)
 *   - Soft drop shadow (Shadow=2)
 *   - PlayRes 1080×1920 (vertical 9:16 canvas)
 *   - Bottom-center alignment + **MarginV=520** → caption baseline at y≈1400,
 *     shoulder/upper-chest level (PR #106 — was 820/face level, was 200/bottom-doc)
 *
 * @param {Array<{ start, end, text }>} lines
 * @param {Object} [opts]
 * @param {'top'|'bottom'} [opts.placement='bottom']
 * @returns {string}
 */
export function generateAss(lines, opts = {}) {
  const placement = opts.placement === 'top' ? 'top' : 'bottom';
  const alignment = placement === 'top' ? 8 : 2;

  const header = `[Script Info]
Title: Generated by media-worker/lib/subtitle_burn.js
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Montserrat,80,&H00FFFFFF,&H000000FF,&H001A1A1A,&H00000000,-1,0,0,0,100,100,1,0,1,4,2,${alignment},40,40,520,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const dialogue = lines
    .map((line) =>
      `Dialogue: 0,${formatAssTime(line.start)},${formatAssTime(line.end)},Default,,0,0,0,,${escapeAssText(line.text)}`,
    )
    .join('\n');

  return header + dialogue + '\n';
}

/**
 * Burn an .ass subtitle file into a video with ffmpeg's libass `subtitles=` filter.
 *
 * Path-escape note: Linux Railway doesn't have the Windows-drive-letter colon
 * issue (the local CLI script does, hence the `escapeAssPathForFfmpeg` there).
 * On Linux, the only metacharacters libass cares about are `:` and `\` —
 * forward-slash paths with no colons (always true for /tmp/...) need no escape.
 *
 * Logs `font Montserrat not found` warnings if Montserrat isn't installed —
 * libass falls back to Arial. Caller can detect this in the surrounding
 * pipeline by capturing stderr.
 *
 * @param {Object} args
 * @param {string} args.inputPath  the brolled (or cut) MP4
 * @param {string} args.assPath    the .ass file written via writeAssFile()
 * @param {string} args.outputPath final captioned MP4
 * @param {number} [args.timeoutMs=600_000]
 * @returns {Promise<{ stderr: string }>}  stderr captured for the caller to
 *   detect Montserrat fallback warnings.
 */
export async function burnSubtitles({ inputPath, assPath, outputPath, timeoutMs = 600_000 }) {
  if (!inputPath || !assPath || !outputPath) {
    throw new Error('burnSubtitles requires inputPath, assPath, outputPath');
  }
  if (!existsSync(inputPath)) throw new Error(`burnSubtitles: input not found: ${inputPath}`);
  if (!existsSync(assPath)) throw new Error(`burnSubtitles: ass file not found: ${assPath}`);

  // /tmp/... is colon-free on Linux; libass takes the path verbatim. We single-
  // quote the path inside the filter so spaces survive (none in /tmp/<uuid>/...
  // but defensive).
  const filter = `subtitles='${assPath}'`;
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
    throw new Error('ffmpeg subtitles burn produced no output');
  }
  return { stderr: stderr ?? '' };
}

/**
 * Convenience: write the .ass content to a path and burn into the input video.
 * Returns the stderr from ffmpeg so the orchestrator can detect Montserrat
 * fallback warnings.
 *
 * @param {Object} args
 * @param {Array} args.lines  output of groupIntoLines()
 * @param {string} args.assPath
 * @param {string} args.inputPath
 * @param {string} args.outputPath
 * @param {Object} [args.assOpts]  passed to generateAss()
 * @returns {Promise<{ stderr: string, lineCount: number }>}
 */
export async function writeAssAndBurn({ lines, assPath, inputPath, outputPath, assOpts }) {
  const assContent = generateAss(lines, assOpts);
  writeFileSync(assPath, assContent, 'utf8');
  const { stderr } = await burnSubtitles({ inputPath, assPath, outputPath });
  return { stderr, lineCount: lines.length };
}

/**
 * Inspect ffmpeg stderr for libass font-fallback warnings. Used by the
 * pipeline orchestrator to populate the response `warnings[]` field.
 *
 * @param {string} stderr
 * @returns {string[]}
 */
export function extractSubtitleWarnings(stderr) {
  const warnings = [];
  if (/Glyph .* not found/.test(stderr)) {
    warnings.push('libass: glyph(s) missing in font — possible font fallback');
  }
  if (/fontselect:.*not found/i.test(stderr) || /fontselect:.*Using default/i.test(stderr)) {
    warnings.push('Montserrat font unavailable on Railway — libass fell back to system default (Arial)');
  }
  return warnings;
}
