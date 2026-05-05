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
  const lines = groupIntoLines(words, 4, 1.8);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'HELLO THERE.');
  assert.equal(lines[1].text, 'HOW ARE YOU?');
});

test('group: breaks on max words', () => {
  const words = Array.from({ length: 14 }, (_, i) => w('word', i * 0.3, i * 0.3 + 0.2));
  const lines = groupIntoLines(words, 4, 100);
  assert.equal(lines.length, Math.ceil(14 / 4));
});

test('group: breaks on max duration', () => {
  // 10 words spaced 0.5s apart → line dur > 1.8s before 4 words hit
  const words = Array.from({ length: 10 }, (_, i) => w(`word${i}`, i * 0.5, i * 0.5 + 0.2));
  const lines = groupIntoLines(words, 100, 1.8);
  assert.ok(lines.length >= 2, `expected ≥2 lines, got ${lines.length}`);
  for (const l of lines) {
    assert.ok(l.end - l.start <= 1.8 + 0.5, `line dur ${l.end - l.start}s exceeded`);
  }
});

test('group: empty input → empty lines', () => {
  assert.deepEqual(groupIntoLines([], 4, 1.8), []);
});

test('group: defaults to 4 words / 1.8s for talking-head reel style', () => {
  // Lock in the default values so future drift gets caught. 5 words spaced
  // 0.4s apart (each 0.3s long) — slow enough that maxWords=4 is the gate
  // (not maxDurationSec=1.8) for the first line.
  const words = Array.from({ length: 5 }, (_, i) => w(`word${i}`, i * 0.4, i * 0.4 + 0.3));
  const lines = groupIntoLines(words);
  // First line should be capped at 4 words (line 1 = words 0..3, line 2 = word 4)
  assert.equal(lines.length, 2);
  assert.equal(lines[0].wordCount, 4);
  assert.equal(lines[1].wordCount, 1);
});

// ── generateAss ────────────────────────────────────────────────────────

test('ass: header includes talking-head reel styling tokens', () => {
  const lines = [{ start: 0, end: 1, text: 'HELLO' }];
  const ass = generateAss(lines);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /Montserrat,80/);                       // talking-head reel size (was 50)
  assert.match(ass, /&H00FFFFFF/);                          // white primary
  assert.match(ass, /&H001A1A1A/);                          // dark outline
  assert.match(ass, /,-1,/);                                // Bold=-1
  assert.match(ass, /1,4,2,2,/);                            // BorderStyle=1, Outline=4, Shadow=2, Alignment=2 (bottom-center)
  assert.match(ass, /Dialogue: 0,/);
  assert.match(ass, /HELLO/);
});

test('ass: does NOT regress to old 50pt size', () => {
  // Lock-in test: catch any future drift back to the documentary-style 50pt.
  const lines = [{ start: 0, end: 1, text: 'HELLO' }];
  const ass = generateAss(lines);
  assert.doesNotMatch(ass, /Montserrat,50,/);
});

test('ass: subtitles positioned at shoulder/upper-chest level (MarginV=520) — PR #106', () => {
  // Lock-in test: caption baseline must land at y≈1400 (shoulder/upper-chest
  // level on a 1080×1920 canvas). With Alignment=2 (bottom-center) and
  // PlayResY=1920, MarginV=520 → baseline = 1920 - 520 = 1400.
  // Replaces PR #99's MarginV=820 (which covered the face on Justine's framing).
  const lines = [{ start: 0, end: 1, text: 'HELLO' }];
  const ass = generateAss(lines);
  // The Style line ends with `,...,2,40,40,520,1` (Alignment=2, MarginL=40,
  // MarginR=40, MarginV=520, Encoding=1). Anchor the regex to the line end.
  assert.match(ass, /,2,40,40,520,1$/m);
  // Defensive: ensure we did not regress to the old face-covering 820 value
  // (PR #99) or the bottom-documentary 200 value (pre-PR #99).
  assert.doesNotMatch(ass, /,40,40,820,1$/m);
  assert.doesNotMatch(ass, /,40,40,200,1$/m);
});

test('ass: MarginV stays in the face-safe range [400, 700]', () => {
  // Future drift guard: extract the MarginV value from the Style line and
  // assert it sits within a safe range that keeps captions off the speaker's
  // face on the standard 1080×1920 reel canvas. 400 → baseline at y=1520
  // (lower-chest); 700 → baseline at y=1220 (just above mouth). Anything
  // outside this band risks face overlap (high) or bottom-documentary
  // placement (low) and should require explicit intent.
  const lines = [{ start: 0, end: 1, text: 'HELLO' }];
  const ass = generateAss(lines);
  const m = ass.match(/,40,40,(\d+),1$/m);
  assert.ok(m, 'expected to find Style line ending with MarginV value');
  const marginV = parseInt(m[1], 10);
  assert.ok(marginV >= 400 && marginV <= 700,
    `MarginV ${marginV} outside the face-safe range [400, 700]`);
});

test('ass: top placement variant also gets the new MarginV', () => {
  // The placement override flips Alignment from 2 (bottom-center) to 8
  // (top-center), but MarginV should still be 520 (we only change the
  // vertical magnitude, not the placement-conditional value).
  const lines = [{ start: 0, end: 1, text: 'HELLO' }];
  const ass = generateAss(lines, { placement: 'top' });
  assert.match(ass, /,8,40,40,520,1$/m);
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
