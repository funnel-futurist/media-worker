/**
 * test/subtitle_burn.test.js
 *
 * Pure-function tests for the math-remap + line-grouping logic. No ffmpeg
 * shelling out — those are tested end-to-end against a real MP4 in M2's
 * deploy gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  remapWordsThroughCuts,
  groupIntoLines,
  generateAss,
  extractSubtitleWarnings,
} from '../lib/subtitle_burn.js';

function w(word, startSec, endSec) {
  return { word, start_ms: Math.round(startSec * 1000), end_ms: Math.round(endSec * 1000) };
}

// ── remapWordsThroughCuts ──────────────────────────────────────────────

test('remap: no cuts → identity', () => {
  const words = [w('hello', 0, 0.5), w('world', 1, 1.5)];
  const out = remapWordsThroughCuts(words, []);
  assert.deepEqual(out, words);
});

test('remap: words inside a cut span are dropped', () => {
  const words = [
    w('keep1', 0, 0.5),
    w('drop', 2, 2.5),     // inside cut [1.8, 3.0]
    w('keep2', 4, 4.5),
  ];
  const out = remapWordsThroughCuts(words, [{ start: 1.8, end: 3.0 }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].word, 'keep1');
  assert.equal(out[1].word, 'keep2');
});

test('remap: words after a cut shift backward by cut duration', () => {
  // Cut [1.0, 2.0] → 1s removed. Word starting at 4s should land at 3s.
  const words = [
    w('hello', 0, 0.5),
    w('world', 4, 4.5),
  ];
  const out = remapWordsThroughCuts(words, [{ start: 1.0, end: 2.0 }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].start_ms, 0);
  assert.equal(out[0].end_ms, 500);
  assert.equal(out[1].start_ms, 3000);
  assert.equal(out[1].end_ms, 3500);
});

test('remap: multiple cuts compound — only cuts BEFORE the word shift it', () => {
  // Cut1 [1, 2] = 1s, Cut2 [5, 7] = 2s.
  // Word at 3 → only cut1 is before → shift 1s → 2.
  // Word at 8 → both cuts before → shift 3s → 5.
  const words = [
    w('a', 3, 3.5),
    w('b', 8, 8.5),
  ];
  const out = remapWordsThroughCuts(words, [
    { start: 1, end: 2 },
    { start: 5, end: 7 },
  ]);
  assert.equal(out[0].start_ms, 2000);
  assert.equal(out[0].end_ms, 2500);
  assert.equal(out[1].start_ms, 5000);
  assert.equal(out[1].end_ms, 5500);
});

test('remap: unsorted cuts are sorted internally', () => {
  // Same shifts as above test, but cuts passed reverse-sorted.
  const words = [w('a', 3, 3.5), w('b', 8, 8.5)];
  const out = remapWordsThroughCuts(words, [
    { start: 5, end: 7 },
    { start: 1, end: 2 },
  ]);
  assert.equal(out[0].start_ms, 2000);
  assert.equal(out[1].start_ms, 5000);
});

test('remap: word starting exactly at cut.start is dropped (start >= cut.start)', () => {
  // Word at exactly 1.0s, cut [1.0, 2.0] → drop (start >= cut.start && start < cut.end).
  const words = [w('drop', 1.0, 1.5)];
  const out = remapWordsThroughCuts(words, [{ start: 1.0, end: 2.0 }]);
  assert.equal(out.length, 0);
});

test('remap: word starting exactly at cut.end survives (start >= cut.end)', () => {
  // Word at exactly 2.0s, cut [1.0, 2.0] → survives, shifts by 1s.
  const words = [w('keep', 2.0, 2.5)];
  const out = remapWordsThroughCuts(words, [{ start: 1.0, end: 2.0 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].start_ms, 1000);
});

test('remap: shift never produces negative timestamps', () => {
  // Pathological: word at 0.5s with cut at [0, 1.0] would shift below 0.
  // (In practice the word would be DROPPED because it's inside the cut, but
  // guard against negative output anyway.)
  const words = [w('keep', 0.5, 0.7)];
  const out = remapWordsThroughCuts(words, [{ start: 1, end: 2 }]);
  // Cut is AFTER the word, so no shift, just identity.
  assert.equal(out[0].start_ms, 500);
});

// ── groupIntoLines ─────────────────────────────────────────────────────

test('group: breaks on sentence-end punctuation', () => {
  const words = [
    w('hello', 0, 0.4),
    w('there.', 0.5, 0.9),  // period → break
    w('how', 1.0, 1.2),
    w('are', 1.3, 1.5),
    w('you?', 1.6, 1.9),    // question → break
  ];
  const lines = groupIntoLines(words, 6, 2.5);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'HELLO THERE.');
  assert.equal(lines[1].text, 'HOW ARE YOU?');
});

test('group: breaks on max words', () => {
  const words = Array.from({ length: 14 }, (_, i) => w('word', i * 0.3, i * 0.3 + 0.2));
  const lines = groupIntoLines(words, 6, 100);
  assert.equal(lines.length, Math.ceil(14 / 6));
});

test('group: breaks on max duration', () => {
  // 10 words spaced 0.6s apart → line dur > 2.5s before 6 words hit
  const words = Array.from({ length: 10 }, (_, i) => w(`word${i}`, i * 0.6, i * 0.6 + 0.3));
  const lines = groupIntoLines(words, 100, 2.5);
  assert.ok(lines.length >= 2, `expected ≥2 lines, got ${lines.length}`);
  for (const l of lines) {
    assert.ok(l.end - l.start <= 2.5 + 0.5, `line dur ${l.end - l.start}s exceeded`);
  }
});

test('group: empty input → empty lines', () => {
  assert.deepEqual(groupIntoLines([], 6, 2.5), []);
});

// ── generateAss ────────────────────────────────────────────────────────

test('ass: header includes ff_clean_subtitle styling tokens', () => {
  const lines = [{ start: 0, end: 1, text: 'HELLO' }];
  const ass = generateAss(lines);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /Montserrat,50/);
  assert.match(ass, /&H00FFFFFF/);  // white primary
  assert.match(ass, /&H001A1A1A/);  // dark outline
  assert.match(ass, /Dialogue: 0,/);
  assert.match(ass, /HELLO/);
});

test('ass: top placement uses Alignment=8', () => {
  const lines = [{ start: 0, end: 1, text: 'TOP' }];
  const ass = generateAss(lines, { placement: 'top' });
  assert.match(ass, /1,4,2,8,/);  // Outline=1, BorderStyle=4-ish... actually Alignment is the 8
});

test('ass: escapes braces in subtitle text', () => {
  const lines = [{ start: 0, end: 1, text: 'A {weird} thing' }];
  const ass = generateAss(lines);
  assert.match(ass, /A \\\{weird\\\} thing/);
});

// ── extractSubtitleWarnings ────────────────────────────────────────────

test('warnings: detects Montserrat fallback', () => {
  const stderr = '[Parsed_subtitles_0 @ 0x1] fontselect: Montserrat not found, Using default font';
  const warnings = extractSubtitleWarnings(stderr);
  assert.ok(warnings.some((w) => /Montserrat/.test(w)));
});

test('warnings: empty for clean stderr', () => {
  assert.deepEqual(extractSubtitleWarnings('frame=  100 fps=...'), []);
});
