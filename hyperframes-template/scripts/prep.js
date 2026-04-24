#!/usr/bin/env node
/**
 * prep.js — One-command pre-render pipeline.
 *
 * Chains: silence_cut → transcribe → align_captions (--inject) → audio_qc (LUFS check)
 *
 * Usage:
 *   node scripts/prep.js assets/raw-edit.mp4
 *   node scripts/prep.js assets/raw-edit.mp4 --start 2.88 --threshold -35 --min-dur 0.65
 *   node scripts/prep.js assets/raw-edit.mp4 --skip-cut        # skip silence cut, use existing raw-trim-v2.mp4
 *   node scripts/prep.js assets/raw-edit.mp4 --skip-transcribe  # skip transcribe, use existing transcript.json
 *   node scripts/prep.js assets/raw-edit.mp4 --skip-cut --skip-transcribe  # align + QC only
 *
 * Expects:
 *   - ffmpeg + ffprobe in PATH
 *   - hyperframes CLI: npx hyperframes transcribe
 *   - assets/script.txt — written script for caption correction
 *   - compositions/captions.html — target for --inject
 *
 * Outputs:
 *   - assets/raw-trim-v2.mp4      — silence-cut video
 *   - assets/transcript.json      — Whisper word-level timestamps
 *   - compositions/captions.html  — updated SEGMENTS block (in-place)
 *   - stdout: recommended data-volume value from LUFS check
 */

const { spawnSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');

// ---- CLI args ---------------------------------------------------------------
const args        = process.argv.slice(2);
const getFlag     = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };
const hasFlag     = (flag) => args.includes(flag);

const INPUT        = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) || 'assets/raw-edit.mp4';
const TRIMMED      = getFlag('--trimmed',   'assets/raw-trim-v2.mp4');
const TRANSCRIPT   = getFlag('--transcript','assets/transcript.json');
const SCRIPT_FILE  = getFlag('--script',    'assets/script.txt');
const CAPTIONS     = getFlag('--inject',    'compositions/captions.html');
const MUSIC        = getFlag('--music',     'assets/music.mp3');
const WHISPER_MODEL= getFlag('--model',     'small.en');
const SKIP_CUT     = hasFlag('--skip-cut');
const SKIP_TRANS   = hasFlag('--skip-transcribe');

// Silence cut passthrough flags
const START_SKIP  = getFlag('--start',     null);
const END_LIMIT   = getFlag('--end',       null);
const THRESHOLD   = getFlag('--threshold', null);
const MIN_DUR     = getFlag('--min-dur',   null);
const PAD_END     = getFlag('--pad-end',   null);

// ---- Helpers ----------------------------------------------------------------
function run(cmd, args, opts = {}) {
  const label = `${cmd} ${args.slice(0, 3).join(' ')}${args.length > 3 ? ' ...' : ''}`;
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
    ...opts,
  });
  if (r.status !== 0) {
    console.error(`\n✗ ${label} exited ${r.status}`);
    process.exit(r.status || 1);
  }
  return r;
}

function runCapture(cmd, args) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r;
}

const DIVIDER = '\n' + '─'.repeat(60);

// ---- Step 1: Silence cut ----------------------------------------------------
if (!SKIP_CUT) {
  console.log(DIVIDER);
  console.log('STEP 1 — Silence cut');
  if (!fs.existsSync(INPUT)) {
    console.error(`Input not found: ${INPUT}`);
    process.exit(1);
  }
  const cutArgs = [INPUT, '--output', TRIMMED];
  if (START_SKIP)  cutArgs.push('--start',     START_SKIP);
  if (END_LIMIT)   cutArgs.push('--end',        END_LIMIT);
  if (THRESHOLD)   cutArgs.push('--threshold',  THRESHOLD);
  if (MIN_DUR)     cutArgs.push('--min-dur',    MIN_DUR);
  if (PAD_END)     cutArgs.push('--pad-end',    PAD_END);
  run('node', ['scripts/silence_cut.js', ...cutArgs]);
} else {
  console.log('\n[--skip-cut] Using existing:', TRIMMED);
  if (!fs.existsSync(TRIMMED)) {
    console.error(`Trimmed file not found: ${TRIMMED}`);
    process.exit(1);
  }
}

// ---- Step 2: Transcribe -----------------------------------------------------
if (!SKIP_TRANS) {
  console.log(DIVIDER);
  console.log('STEP 2 — Transcribe (Whisper ' + WHISPER_MODEL + ')');
  run('npx', ['hyperframes', 'transcribe', TRIMMED, '--model', WHISPER_MODEL, '--json']);

  // Hyperframes CLI writes transcript.json to CWD; prep.js pipeline expects it
  // at assets/transcript.json. Move it there if needed.
  const cwdTranscript = path.resolve('transcript.json');
  if (!fs.existsSync(TRANSCRIPT) && fs.existsSync(cwdTranscript)) {
    fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
    fs.renameSync(cwdTranscript, TRANSCRIPT);
    console.log(`  Moved transcript → ${TRANSCRIPT}`);
  }
} else {
  console.log('\n[--skip-transcribe] Using existing:', TRANSCRIPT);
  if (!fs.existsSync(TRANSCRIPT)) {
    console.error(`Transcript not found: ${TRANSCRIPT}`);
    process.exit(1);
  }
}

// ---- Step 3: Align captions -------------------------------------------------
console.log(DIVIDER);
console.log('STEP 3 — Caption alignment (--inject into captions.html)');
if (!fs.existsSync(SCRIPT_FILE)) {
  console.log(`  [warn] Script file not found: ${SCRIPT_FILE}`);
  console.log('  Running in Whisper-only mode. Add script.txt for accurate proper nouns.');
}
run('node', [
  'scripts/align_captions.js',
  '--transcript', TRANSCRIPT,
  '--script',     SCRIPT_FILE,
  '--inject',     CAPTIONS,
]);

// ---- Step 4: Audio LUFS check -----------------------------------------------
console.log(DIVIDER);
console.log('STEP 4 — Audio QC (LUFS pre-mix check)');
if (!fs.existsSync(MUSIC)) {
  console.log(`  [skip] Music file not found: ${MUSIC}. Skipping audio QC.`);
} else {
  run('node', [
    'scripts/audio_qc.js',
    '--speech', TRIMMED,
    '--music',  MUSIC,
    '--no-gemini',
  ]);
}

// ---- Done -------------------------------------------------------------------
console.log(DIVIDER);
console.log('\n✅ prep complete');
console.log('\nNext steps:');
console.log('  1. Review flagged captions in stderr output above');
console.log('  2. Set data-volume in index.html to the recommended value above');
console.log('  3. npx hyperframes lint');
console.log('  4. npx hyperframes preview');
console.log('  5. npx hyperframes render --quality draft --output renders/draft.mp4');
console.log('  6. node scripts/audio_qc.js --speech assets/raw-trim-v2.mp4 --music assets/music.mp3 --render renders/draft.mp4');
