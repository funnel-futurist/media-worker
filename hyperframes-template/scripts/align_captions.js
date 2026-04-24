#!/usr/bin/env node
/**
 * align_captions.js — Script-driven caption alignment.
 *
 * Problem: Whisper mishears proper nouns (VA→BA, GHL→"Go-ha level",
 * Metricool→"metric flow", etc.). This script uses word timing from
 * Whisper but corrects display text from a human-written script.
 *
 * Usage:
 *   node scripts/align_captions.js \
 *     --transcript assets/transcript.json \
 *     --script assets/script.txt \
 *     [--output assets/segments.js]      # write to file (default: stdout)
 *     [--inject compositions/captions.html]  # write SEGMENTS directly into captions.html
 *
 * --inject replaces the existing const SEGMENTS = [...]; block in the target file.
 * Run with --inject and you're done — no copy-paste.
 *
 * Flagged words (Whisper ≠ script, no fuzzy match) are printed to stderr
 * so you can review and manually fix if needed.
 */

const fs   = require('fs');
const path = require('path');

// ---- Parse CLI args --------------------------------------------------------
const args     = process.argv.slice(2);
const getArg   = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };
const TRANS    = getArg('--transcript', 'assets/transcript.json');
const SCRIPT   = getArg('--script',     'assets/script.txt');
const OUTPUT   = getArg('--output',     null);
const INJECT   = getArg('--inject',     null);  // path to captions.html to update in-place
const WINDOW   = parseInt(getArg('--window', '5'), 10); // lookahead window for matching

// ---- Levenshtein distance -------------------------------------------------
function levenshtein(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[a.length][b.length];
}

function normalise(w) {
  return w.replace(/[^a-z0-9']/gi, '').toLowerCase();
}

// ---- Load files ------------------------------------------------------------
if (!fs.existsSync(TRANS)) { console.error(`transcript not found: ${TRANS}`); process.exit(1); }
const transcript = JSON.parse(fs.readFileSync(TRANS, 'utf8'));

let scriptWords = [];
if (fs.existsSync(SCRIPT) && fs.statSync(SCRIPT).size > 0) {
  const raw = fs.readFileSync(SCRIPT, 'utf8');
  scriptWords = raw.split(/\s+/).filter(Boolean);
  console.error(`Script loaded: ${scriptWords.length} words`);
} else {
  console.error(`Script not found or empty (${SCRIPT}). Running in Whisper-only mode — no corrections applied.`);
}

// ---- Extract all Whisper words with timestamps ----------------------------
const whisperWords = [];
for (const seg of (transcript.segments || [])) {
  for (const w of (seg.words || [])) {
    whisperWords.push({
      word:  w.word.trim(),
      start: w.start,
      end:   w.end,
    });
  }
}
console.error(`Whisper words: ${whisperWords.length}`);

// ---- Fuzzy align script words to Whisper timing ---------------------------
const flagged = [];
let   scriptIdx = 0;

const corrected = whisperWords.map((ww, wi) => {
  if (scriptWords.length === 0) return ww;

  const wNorm = normalise(ww.word);
  let   bestScore = Infinity;
  let   bestIdx   = -1;

  // Look ahead in script within a window
  const lo = Math.max(0, scriptIdx);
  const hi = Math.min(scriptWords.length - 1, scriptIdx + WINDOW);

  for (let si = lo; si <= hi; si++) {
    const d = levenshtein(wNorm, normalise(scriptWords[si]));
    if (d < bestScore) { bestScore = d; bestIdx = si; }
  }

  const threshold = Math.max(2, Math.floor(wNorm.length * 0.4));

  if (bestScore <= threshold && bestIdx !== -1) {
    const scriptWord = scriptWords[bestIdx];
    scriptIdx = bestIdx + 1;
    if (normalise(scriptWord) !== wNorm) {
      return { ...ww, word: scriptWord, corrected: true };
    }
    return ww;
  }

  // No match — keep Whisper word, flag for review
  flagged.push({ whisper: ww.word, start: ww.start.toFixed(2) });
  return ww;
});

// ---- Group corrected words into caption segments --------------------------
// Group into ~5-word chunks with a 2.5s max window, respecting pauses
const CHUNK_SIZE = 5;
const MAX_CHUNK_DUR = 2.5;

const segments = [];
let   i = 0;
while (i < corrected.length) {
  const chunk = [corrected[i]];
  let   j = i + 1;
  while (
    j < corrected.length &&
    chunk.length < CHUNK_SIZE &&
    (corrected[j].start - chunk[0].start) < MAX_CHUNK_DUR
  ) {
    // Stop at a natural pause (>0.4s gap)
    if (corrected[j].start - corrected[j-1].end > 0.4 && chunk.length >= 2) break;
    chunk.push(corrected[j]);
    j++;
  }
  segments.push(chunk);
  i = j;
}

// ---- Build SEGMENTS JS output ---------------------------------------------
const lines = ['const SEGMENTS = ['];
for (const seg of segments) {
  lines.push('  {');
  lines.push('    words: [');
  for (const w of seg) {
    lines.push(`      { word: ${JSON.stringify(w.word)}, start: ${w.start.toFixed(2)}, end: ${w.end.toFixed(2)} },`);
  }
  lines.push('    ],');
  lines.push('  },');
}
lines.push('];');

const output = lines.join('\n');

if (INJECT) {
  // Write SEGMENTS directly into the target captions.html, replacing existing block.
  if (!fs.existsSync(INJECT)) {
    console.error(`--inject target not found: ${INJECT}`);
    process.exit(1);
  }
  let html = fs.readFileSync(INJECT, 'utf8');

  // Match: "const SEGMENTS = [" ... "];" (greedy, across newlines)
  const segmentsRegex = /const SEGMENTS = \[[\s\S]*?\];/;
  if (!segmentsRegex.test(html)) {
    console.error(`Could not find "const SEGMENTS = [...];" in ${INJECT}. Is the file the right one?`);
    process.exit(1);
  }

  html = html.replace(segmentsRegex, output);
  fs.writeFileSync(INJECT, html, 'utf8');
  console.error(`\n✅ SEGMENTS injected into ${INJECT}`);
  console.error('   Run: npx hyperframes lint  to verify no issues.');
} else if (OUTPUT) {
  fs.writeFileSync(OUTPUT, output, 'utf8');
  console.error(`\nSegments written to ${OUTPUT}`);
} else {
  console.log(output);
}

// ---- Flagged words report -------------------------------------------------
if (flagged.length > 0) {
  console.error(`\n--- Flagged (${flagged.length} unmatched Whisper words) ---`);
  for (const f of flagged) {
    console.error(`  t=${f.start}s  Whisper: "${f.whisper}"`);
  }
  console.error('These may need manual correction in captions.html.');
} else {
  console.error('\n✅ All Whisper words matched to script.');
}
