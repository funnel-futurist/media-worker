#!/usr/bin/env node
/**
 * audio_qc.js — Two-pass audio QC for Hyperframes short-form videos.
 *
 * Pass 1 (ffmpeg): Measure integrated LUFS for speech vs music.
 *   Target: music LUFS should be ≥14dB below speech LUFS.
 *   Outputs a recommended data-volume value.
 *
 * Pass 2 (Gemini 2.0 Flash): Perceptual check on the rendered draft.
 *   Extracts a 15s audio sample and asks Gemini if speech is clearly audible.
 *
 * Usage:
 *   node scripts/audio_qc.js                      # uses defaults below
 *   node scripts/audio_qc.js --speech assets/raw-trim-v2.mp4 --music assets/music.mp3 --render renders/pilot-v3-draft.mp4
 *
 * Requires: ffmpeg in PATH, GOOGLE_AI_API_KEY in env.
 */

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ---- Config ---------------------------------------------------------------
const TARGET_GAP_DB = 14;       // minimum dB difference: speech - music
const GEMINI_MODEL  = 'gemini-2.0-flash-exp';
const SAMPLE_DUR_S  = 15;       // seconds of rendered audio to send to Gemini

// Parse CLI args
const args = process.argv.slice(2);
const get  = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };
const SPEECH_SRC  = get('--speech', 'assets/raw-trim-v2.mp4');
const MUSIC_SRC   = get('--music',  'assets/music.mp3');
const RENDER_SRC  = get('--render', 'renders/pilot-v3-draft.mp4');
const SKIP_GEMINI = args.includes('--no-gemini');

// ---- Helpers ---------------------------------------------------------------
function getLUFS(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`  [skip] ${filePath} not found`);
    return null;
  }
  const result = spawnSync('ffmpeg', [
    '-i', filePath,
    '-af', 'ebur128=peak=true',
    '-f', 'null', '-'
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const output = result.stderr || '';
  const match  = output.match(/I:\s*([-\d.]+)\s*LUFS/);
  return match ? parseFloat(match[1]) : null;
}

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

// ---- Pass 1: LUFS check ----------------------------------------------------
console.log('\n=== Pass 1: Pre-mix loudness (ffmpeg LUFS) ===\n');

const speechLUFS = getLUFS(SPEECH_SRC);
const musicLUFS  = getLUFS(MUSIC_SRC);

if (speechLUFS === null || musicLUFS === null) {
  console.log('Could not measure LUFS for one or both files. Skipping Pass 1.');
} else {
  console.log(`Speech LUFS : ${speechLUFS.toFixed(1)} LUFS  (${SPEECH_SRC})`);
  console.log(`Music LUFS  : ${musicLUFS.toFixed(1)} LUFS  (${MUSIC_SRC})`);

  // Music at 100% volume; calculate what volume multiplier achieves TARGET_GAP_DB
  const targetMusicLUFS    = speechLUFS - TARGET_GAP_DB;
  const currentGapDB       = speechLUFS - musicLUFS;
  const neededReductionDB  = musicLUFS - targetMusicLUFS;
  const recommendedVolume  = dbToLinear(-neededReductionDB);
  const clampedVolume      = Math.min(Math.max(recommendedVolume, 0.02), 1.0);

  console.log(`\nCurrent gap : ${currentGapDB.toFixed(1)} dB  (target ≥ ${TARGET_GAP_DB} dB)`);
  console.log(`Target music: ${targetMusicLUFS.toFixed(1)} LUFS`);
  console.log(`\nRecommended data-volume: ${clampedVolume.toFixed(3)}`);

  if (currentGapDB >= TARGET_GAP_DB) {
    console.log('✅ Pass 1: Gap is sufficient. Current volume is acceptable.');
  } else {
    console.log(`⚠️  Pass 1: Gap too small (${currentGapDB.toFixed(1)} dB). Set data-volume="${clampedVolume.toFixed(3)}" in index.html.`);
  }
}

// ---- Pass 2: Gemini perceptual check ---------------------------------------
if (SKIP_GEMINI) {
  console.log('\n[--no-gemini] Skipping Pass 2.');
  process.exit(0);
}

if (!fs.existsSync(RENDER_SRC)) {
  console.log(`\n=== Pass 2: Gemini perceptual check ===\n`);
  console.log(`Render not found at "${RENDER_SRC}". Run draft render first, then re-run this script.`);
  process.exit(0);
}

console.log('\n=== Pass 2: Gemini perceptual check ===\n');

const samplePath = path.join(path.dirname(RENDER_SRC), '_qc-audio-sample.mp3');
console.log(`Extracting ${SAMPLE_DUR_S}s audio sample → ${samplePath}`);

try {
  execSync(`ffmpeg -y -i "${RENDER_SRC}" -t ${SAMPLE_DUR_S} -vn -ac 1 -ar 16000 "${samplePath}"`, {
    stdio: ['ignore', 'pipe', 'pipe']
  });
} catch (e) {
  console.error('ffmpeg audio extraction failed:', e.message);
  process.exit(1);
}

const apiKey = process.env.GOOGLE_AI_API_KEY;
if (!apiKey) {
  console.error('GOOGLE_AI_API_KEY not set in environment.');
  process.exit(1);
}

// Upload audio file to Gemini Files API, then run prompt
const { GoogleGenerativeAI } = (() => {
  try { return require('@google/generative-ai'); }
  catch (_) {
    console.error('Missing dependency: npm install @google/generative-ai');
    process.exit(1);
  }
})();

(async () => {
  const genAI  = new GoogleGenerativeAI(apiKey);
  const model  = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const audioData   = fs.readFileSync(samplePath);
  const base64Audio = audioData.toString('base64');

  const prompt = [
    {
      inlineData: {
        mimeType: 'audio/mpeg',
        data: base64Audio,
      }
    },
    {
      text: `Listen to this audio clip from a short-form social media video (TikTok/Reels style).
There is a person speaking with background music playing underneath.

Rate the speech intelligibility and music balance. Reply ONLY with this JSON (no markdown):
{
  "speech_score": <1-10 where 10 = crystal clear>,
  "verdict": "<good|borderline|too_loud>",
  "suggested_db_reduction": <0|-2|-3|-5>,
  "notes": "<one sentence>"
}`
    }
  ];

  try {
    const result   = await model.generateContent({ contents: [{ role: 'user', parts: prompt }] });
    const text     = result.response.text().trim();
    const jsonText = text.replace(/```json\n?|\n?```/g, '').trim();
    const parsed   = JSON.parse(jsonText);

    console.log('\nGemini verdict:');
    console.log(`  Speech score        : ${parsed.speech_score}/10`);
    console.log(`  Verdict             : ${parsed.verdict}`);
    console.log(`  Suggested reduction : ${parsed.suggested_db_reduction} dB`);
    console.log(`  Notes               : ${parsed.notes}`);

    if (parsed.verdict === 'good' && parsed.speech_score >= 8) {
      console.log('\n✅ Pass 2: Audio mix is approved for final render.');
    } else {
      const vol = speechLUFS && musicLUFS
        ? dbToLinear(-(Math.abs(parsed.suggested_db_reduction))).toFixed(3)
        : 'manual adjustment needed';
      console.log(`\n⚠️  Pass 2: Music too loud. Reduce volume in index.html. Suggested: -${Math.abs(parsed.suggested_db_reduction)} dB.`);
    }
  } catch (e) {
    console.error('Gemini check failed:', e.message);
    console.log('Raw response:', e.response?.text?.() || '(none)');
  }

  // Clean up sample file
  try { fs.unlinkSync(samplePath); } catch (_) {}
})();
