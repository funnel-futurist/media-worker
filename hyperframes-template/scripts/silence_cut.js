#!/usr/bin/env node
/**
 * silence_cut.js — Auto-detect silence and build/run the ffmpeg silence-cut concat.
 *
 * Usage:
 *   node scripts/silence_cut.js assets/raw-edit.mp4
 *   node scripts/silence_cut.js assets/raw-edit.mp4 --output assets/raw-trim-v2.mp4
 *   node scripts/silence_cut.js assets/raw-edit.mp4 --threshold -35 --min-dur 0.65 --dry-run
 *
 * Options:
 *   --output <path>      Output file path (default: assets/raw-trim-v2.mp4)
 *   --threshold <dBFS>   Silence threshold in dBFS (default: -35)
 *   --min-dur <seconds>  Minimum silence duration to cut (default: 0.65)
 *   --start <seconds>    Skip this many seconds from the start (default: 0)
 *                        Use this to cut an intro before the content begins.
 *   --end <seconds>      Stop at this time in the source (default: full duration)
 *   --pad-end <seconds>  Add N seconds of tail padding after last keep-segment (default: 0.5)
 *                        Prevents hard cut on the last word — gives a natural breath at the end.
 *   --dry-run            Print the ffmpeg command without running it
 *   --keep-gaps          Print detected keep-segments without cutting (for review)
 *
 * Requires: ffmpeg in PATH.
 */

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ---- Parse args -----------------------------------------------------------
const args    = process.argv.slice(2).filter(Boolean);
const getFlag = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };
const hasFlag = (flag) => args.includes(flag);

const INPUT      = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) || null;
const OUTPUT     = getFlag('--output',    'assets/raw-trim-v2.mp4');
const THRESHOLD  = getFlag('--threshold', '-35');
const MIN_DUR    = parseFloat(getFlag('--min-dur', '0.65'));
const START_SKIP = parseFloat(getFlag('--start',   '0'));
const END_LIMIT  = getFlag('--end', null);
const PAD_END    = parseFloat(getFlag('--pad-end', '0.5'));
const DRY_RUN    = hasFlag('--dry-run');
const KEEP_GAPS  = hasFlag('--keep-gaps');

if (!INPUT) {
  console.error('Usage: node scripts/silence_cut.js <input.mp4> [options]');
  console.error('Example: node scripts/silence_cut.js assets/raw-edit.mp4 --start 2.88');
  process.exit(1);
}

if (!fs.existsSync(INPUT)) {
  console.error(`Input not found: ${INPUT}`);
  process.exit(1);
}

// ---- Get total duration ---------------------------------------------------
function getDuration(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', file
  ], { encoding: 'utf8' });
  return parseFloat(r.stdout.trim());
}

const totalDuration = getDuration(INPUT);
const endAt = END_LIMIT ? parseFloat(END_LIMIT) : totalDuration;
console.log(`\nSource: ${INPUT}`);
console.log(`Duration: ${totalDuration.toFixed(3)}s  |  Working window: ${START_SKIP}s → ${endAt.toFixed(3)}s`);

// ---- Detect silence -------------------------------------------------------
console.log(`\nDetecting silence (noise=${THRESHOLD}dB, min_dur=${MIN_DUR}s)...`);

const silenceResult = spawnSync('ffmpeg', [
  '-i', INPUT,
  '-af', `silencedetect=noise=${THRESHOLD}dB:duration=${MIN_DUR}`,
  '-f', 'null', '-'
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const stderr = silenceResult.stderr || '';

// Parse silence_start / silence_end pairs
const silenceGaps = [];
const startMatches = [...stderr.matchAll(/silence_start: ([\d.]+)/g)];
const endMatches   = [...stderr.matchAll(/silence_end: ([\d.]+)/g)];

for (let i = 0; i < startMatches.length; i++) {
  const gapStart = parseFloat(startMatches[i][1]);
  const gapEnd   = endMatches[i] ? parseFloat(endMatches[i][1]) : endAt;
  if (gapEnd - gapStart >= MIN_DUR) {
    silenceGaps.push({ start: gapStart, end: gapEnd });
  }
}

console.log(`Found ${silenceGaps.length} silence gap(s) ≥ ${MIN_DUR}s:`);
silenceGaps.forEach((g, i) => {
  console.log(`  Gap ${i + 1}: ${g.start.toFixed(3)}s → ${g.end.toFixed(3)}s (${(g.end - g.start).toFixed(3)}s)`);
});

// ---- Build keep-segments (inverse of gaps) --------------------------------
const keepSegments = [];
let cursor = START_SKIP;

for (const gap of silenceGaps) {
  if (gap.start > cursor && gap.start <= endAt) {
    // Only keep segments within our working window
    const segEnd = Math.min(gap.start, endAt);
    if (segEnd - cursor >= 0.1) {  // skip ultra-short segments
      keepSegments.push({ start: cursor, end: segEnd });
    }
  }
  cursor = Math.max(cursor, gap.end);
}

// Final segment after last gap
if (cursor < endAt - 0.1) {
  keepSegments.push({ start: cursor, end: endAt });
}

// Tail padding — extend last segment by PAD_END so the last word isn't hard-cut
if (PAD_END > 0 && keepSegments.length > 0) {
  const last = keepSegments[keepSegments.length - 1];
  last.end = Math.min(last.end + PAD_END, totalDuration);
}

const totalKept = keepSegments.reduce((sum, s) => sum + (s.end - s.start), 0);
const totalCut  = (endAt - START_SKIP) - totalKept;

console.log(`\nKeep segments (${keepSegments.length}):`);
keepSegments.forEach((s, i) => {
  console.log(`  [${i + 1}] ${s.start.toFixed(3)}s → ${s.end.toFixed(3)}s  (${(s.end - s.start).toFixed(3)}s)`);
});
console.log(`\nTotal kept:   ${totalKept.toFixed(3)}s`);
console.log(`Total cut:    ${totalCut.toFixed(3)}s`);
console.log(`Final length: ~${totalKept.toFixed(2)}s`);

if (KEEP_GAPS) {
  console.log('\n[--keep-gaps] Review complete. No files written.');
  process.exit(0);
}

if (keepSegments.length === 0) {
  console.error('\nNo keep segments found. Check --start, --end, and --threshold values.');
  process.exit(1);
}

// ---- Build ffmpeg filter_complex ------------------------------------------
const n = keepSegments.length;

let filterParts = [];
keepSegments.forEach((s, i) => {
  filterParts.push(`[0:v]trim=${s.start}:${s.end},setpts=PTS-STARTPTS[v${i}]`);
  filterParts.push(`[0:a]atrim=${s.start}:${s.end},asetpts=PTS-STARTPTS[a${i}]`);
});

const concatInputs = keepSegments.map((_, i) => `[v${i}][a${i}]`).join('');
filterParts.push(`${concatInputs}concat=n=${n}:v=1:a=1[outv][outa]`);

const filterComplex = filterParts.join(';\n  ');

const cmd = [
  'ffmpeg', '-y',
  '-i', INPUT,
  '-filter_complex', `"${filterComplex}"`,
  '-map', '"[outv]"',
  '-map', '"[outa]"',
  '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
  '-c:a', 'aac', '-b:a', '192k',
  OUTPUT
].join(' ');

if (DRY_RUN) {
  console.log('\n[--dry-run] ffmpeg command:');
  console.log(cmd);
  process.exit(0);
}

// ---- Run ffmpeg ------------------------------------------------------------
console.log(`\nRunning ffmpeg concat → ${OUTPUT}`);
console.log('(This may take 30–120s depending on source length)\n');

try {
  // Run without shell quoting of filter_complex — pass as array to avoid escaping issues
  const ffmpegArgs = [
    '-y', '-i', INPUT,
    '-filter_complex', filterComplex,
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-c:a', 'aac', '-b:a', '192k',
    OUTPUT
  ];

  const result = spawnSync('ffmpeg', ffmpegArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.status !== 0) {
    console.error('ffmpeg failed:');
    console.error(result.stderr?.slice(-3000) || '(no output)');
    process.exit(1);
  }

  const outDuration = getDuration(OUTPUT);
  console.log(`\n✅ Done: ${OUTPUT}`);
  console.log(`   Output duration: ${outDuration.toFixed(3)}s (expected ~${totalKept.toFixed(2)}s)`);
  console.log('\nNext step:');
  console.log('  npx hyperframes transcribe ' + OUTPUT + ' --model small.en --json');

} catch (e) {
  console.error('Error running ffmpeg:', e.message);
  process.exit(1);
}
