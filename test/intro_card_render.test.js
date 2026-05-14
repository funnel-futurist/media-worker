/**
 * test/intro_card_render.test.js
 *
 * Tests for lib/intro_card_render.js — the PR-Y overlay-on-existing-video
 * intro hook renderer. Locks down:
 *   - font-size auto-scale schedule (≤4 → 120, 5-6 → 96, 7-8 → 80)
 *   - PR-Y fitTextToFrame: wrap-before-shrink priority (1 → 2 → 3 lines
 *     at current font, only then shrink — per Shannon's spec)
 *   - drawtext escape rules (single quote, colon, backslash, percent)
 *   - PR-Y buildIntroOverlayArgs: overlay onto existing video (no
 *     standalone card, no anullsrc, audio copied through)
 *   - drawtext enable='between(t,0,N)' time-bounded rendering
 *   - PR-X Montserrat Black path resolution via fc-match (cached)
 *
 * No actual ffmpeg invocation. We test the pure builders + inject
 * execFn for renderIntroOverlay.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fontSizeForWordCount,
  wrapHookText,
  escapeDrawtext,
  fitTextToFrame,
  buildIntroOverlayArgs,
  resolveMontserratBlackPath,
  renderIntroOverlay,
  _resetFontPathCacheForTests,
} from '../lib/intro_card_render.js';

// ── fontSizeForWordCount ─────────────────────────────────────────────

test('fontSizeForWordCount: 1 word → 120pt', () => {
  assert.equal(fontSizeForWordCount(1), 120);
});

test('fontSizeForWordCount: 4 words (boundary) → 120pt', () => {
  assert.equal(fontSizeForWordCount(4), 120);
});

test('fontSizeForWordCount: 5 words → 96pt', () => {
  assert.equal(fontSizeForWordCount(5), 96);
});

test('fontSizeForWordCount: 6 words (boundary) → 96pt', () => {
  assert.equal(fontSizeForWordCount(6), 96);
});

test('fontSizeForWordCount: 7 words → 80pt', () => {
  assert.equal(fontSizeForWordCount(7), 80);
});

test('fontSizeForWordCount: 8 words → 80pt', () => {
  assert.equal(fontSizeForWordCount(8), 80);
});

test('fontSizeForWordCount: 9+ words (over cap) → 80pt (graceful fallback)', () => {
  assert.equal(fontSizeForWordCount(9), 80);
  assert.equal(fontSizeForWordCount(100), 80);
});

// ── wrapHookText (back-compat shim, 1-or-2 lines at fixed font) ──────

test('wrapHookText: short text fits on one line', () => {
  assert.deepEqual(wrapHookText('Plan Early', 120), ['Plan Early']);
});

test('wrapHookText: medium text wraps to 2 balanced lines at 80pt', () => {
  const lines = wrapHookText('Plan Now To Beat The Big Rush', 80);
  assert.equal(lines.length, 2);
});

test('wrapHookText: text too long even at best 2-line split → 1-line fallback', () => {
  // wrapHookText (back-compat) caps at 2 lines. fitTextToFrame uses 3.
  const lines = wrapHookText('Communication Implementation Restoration Foundation Determination Authentication Configuration Optimization', 80);
  assert.equal(lines.length, 1);
});

// ── PR-Y fitTextToFrame: 1 → 2 → 3 line wrap, shrink only after ──────

test('PR-Y fitTextToFrame: short text → 1 line at full schedule font', () => {
  const r = fitTextToFrame('Plan Early');
  assert.deepEqual(r.lines, ['Plan Early']);
  assert.equal(r.fontSizePx, 120);  // 2 words → 120pt tier
});

test('PR-Y fitTextToFrame: medium text needing wrap → 2 lines at same font (not shrunk)', () => {
  // 7 words at 80pt: 1 line overflows; balanced 2-line split fits.
  const r = fitTextToFrame('Plan Now To Beat The Big Rush');
  assert.equal(r.lines.length, 2);
  assert.equal(r.fontSizePx, 80, 'should NOT shrink font when 2-line split fits');
});

test("PR-Y fitTextToFrame: long text needing 3 lines (Shannon's example) → 3 lines at same font", () => {
  // Shannon's example: "A Special Needs Household Runs On Coordination"
  // 7 words at 80pt × 0.58 = 2134px → overflows 1 line (840 safe).
  // Best 2-line splits also overflow because individual halves are >840px.
  // 3-line split at 80pt fits: e.g. "A Special Needs" / "Household Runs" / "On Coordination"
  const r = fitTextToFrame('A Special Needs Household Runs On Coordination');
  assert.equal(r.lines.length, 3, 'should produce 3 lines for this text');
  assert.equal(r.fontSizePx, 80, 'wrap-before-shrink: stays at 80pt when 3 lines fit');
});

test('PR-Y fitTextToFrame: wrap-before-shrink — exhausts 1→2→3 line attempts at same font BEFORE shrinking', () => {
  // Construct text where 1+2 lines don't fit at 96pt but 3 lines do.
  // "Plan Early Beat The Summer Rush Today" — 7 words, 32 chars
  // At 96pt × 0.58 = 55.7 px/char → 32 chars total = 1782px → overflows 1 line
  //   2-line split: best balance ~16 chars each = 891px → overflows safe (840)
  //   3-line split at 96pt: ~11 chars/line = 612px → fits
  // Schedule says 7 words → 80pt, not 96pt. So this exact case starts at 80pt.
  // Pick a different fixture: 5 words tight enough that 3 lines at 96pt fits.
  // "Why Family Planning Matters Now" — 5 words → schedule = 96pt
  // 30 chars × 96 × 0.58 = 1670px → overflows 1 line
  // 2-line "Why Family Planning" (19) + "Matters Now" (11) → 19*55.7=1058 > 840 ✗
  // 3-line "Why Family" (10) + "Planning" (8) + "Matters Now" (11) → all ≤840 ✓
  const r = fitTextToFrame('Why Family Planning Matters Now');
  assert.equal(r.fontSizePx, 96, 'stays at schedule 96pt because 3-line fits');
  assert.equal(r.lines.length, 3);
});

test('PR-Y fitTextToFrame: only shrinks font when even 3 lines at current size overflow', () => {
  // Force the shrink path with very long words: "Communication
  // Implementation Restoration Foundation Determination Authentication
  // Configuration Optimization" — 8 words, but each is ~13-15 chars.
  // At 80pt × 0.58 = 46.4 px/char. Each word alone = ~650-700px. 3
  // lines × 3 words each = lines of ~40 chars = 1856px > 840.
  // At 72pt × 0.58 = 41.8 → 3 words × ~14 chars = 42 chars = 1755px still over.
  // Need a much smaller font for this fixture.
  const r = fitTextToFrame('Communication Implementation Restoration Foundation Determination Authentication Configuration Optimization');
  assert.ok(r.fontSizePx < 80, `should have shrunk below schedule font; got ${r.fontSizePx}`);
  assert.ok(r.fontSizePx >= 48, 'should not shrink below readability floor');
});

test('PR-Y fitTextToFrame: never shrinks below 48pt floor', () => {
  // Pathological case: 8 huge words. Should hit floor and return a
  // 3-line approximate even if it visually overflows.
  const r = fitTextToFrame(
    'Superextraordinarily Hyperinternationalizationally Pseudoanthropomorphically Counterrevolutionarily Disestablishmentarianally Antidisestablishmentarianally Overprotectivelynly Ridiculousnessibility',
  );
  assert.ok(r.fontSizePx >= 48);
});

test('PR-Y fitTextToFrame: single-word hook → 1 line regardless of length', () => {
  const r = fitTextToFrame('Plan');
  assert.deepEqual(r.lines, ['Plan']);
});

test('PR-Y fitTextToFrame: lines split at word boundaries (never mid-word)', () => {
  const r = fitTextToFrame('A Special Needs Household Runs On Coordination');
  for (const line of r.lines) {
    for (const word of line.split(/\s+/)) {
      assert.ok(/^[A-Za-z]+$/.test(word), `word "${word}" must be intact`);
    }
  }
});

// ── escapeDrawtext ───────────────────────────────────────────────────

test('escapeDrawtext: escapes single quote', () => {
  assert.equal(escapeDrawtext("don't"), "don\\'t");
});

test('escapeDrawtext: escapes colon', () => {
  assert.equal(escapeDrawtext('time: now'), 'time\\: now');
});

test('escapeDrawtext: escapes backslash', () => {
  assert.equal(escapeDrawtext('path\\to'), 'path\\\\to');
});

test('escapeDrawtext: escapes percent', () => {
  assert.equal(escapeDrawtext('50% off'), '50\\% off');
});

test('escapeDrawtext: escapes multiple specials together', () => {
  assert.equal(escapeDrawtext("a\\b'c:d%e"), "a\\\\b\\'c\\:d\\%e");
});

test('escapeDrawtext: plain ASCII passes through unchanged', () => {
  const plain = 'The Planning Mistake Families Keep Making';
  assert.equal(escapeDrawtext(plain), plain);
});

// ── PR-Y buildIntroOverlayArgs: overlay on existing video ────────────

function findArg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

test('PR-Y buildIntroOverlayArgs: argv starts with ffmpeg + -y, takes -i inputVideoPath, ends with outputPath', () => {
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/brolled.mp4',
    outputPath: '/tmp/hook_overlay.mp4',
    hookText: 'Plan Early',
  });
  assert.equal(argv[0], 'ffmpeg');
  assert.equal(argv[1], '-y');
  assert.equal(findArg(argv, '-i'), '/tmp/brolled.mp4');
  assert.equal(argv[argv.length - 1], '/tmp/hook_overlay.mp4');
});

test('PR-Y buildIntroOverlayArgs: NO lavfi color background (overlay on existing video, not standalone card)', () => {
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/brolled.mp4',
    outputPath: '/tmp/out.mp4',
    hookText: 'Plan Early',
  });
  const fullCmd = argv.join(' ');
  assert.doesNotMatch(fullCmd, /color=c=0x0F1419/, 'pre-PR-Y standalone-card background is gone');
  assert.doesNotMatch(fullCmd, /anullsrc/, 'no synthetic silent audio — original audio is copied through');
});

test('PR-Y buildIntroOverlayArgs: audio is copied through without re-encode (-c:a copy)', () => {
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/brolled.mp4',
    outputPath: '/tmp/out.mp4',
    hookText: 'Plan Early',
  });
  assert.equal(findArg(argv, '-c:a'), 'copy', 'original audio must pass through unchanged');
});

test('PR-Y buildIntroOverlayArgs: video re-encodes to libx264 yuv420p for drawtext', () => {
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/brolled.mp4',
    outputPath: '/tmp/out.mp4',
    hookText: 'Plan Early',
  });
  assert.equal(findArg(argv, '-c:v'), 'libx264');
  assert.equal(findArg(argv, '-pix_fmt'), 'yuv420p');
});

test("PR-Y buildIntroOverlayArgs: drawtext uses enable='between(t,0,N)' for time-bounded rendering", () => {
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    hookText: 'Plan Early',
    durationSec: 5,
  });
  const vf = findArg(argv, '-vf');
  assert.match(vf, /enable='between\(t,0,5\)'/, 'enable gate must wrap the drawtext in [0, durationSec]');
});

test('PR-Y buildIntroOverlayArgs: drawtext includes the polished styling (8px stroke + 6px shadow)', () => {
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    hookText: 'Plan Early',
  });
  const vf = findArg(argv, '-vf');
  assert.match(vf, /borderw=8/);
  assert.match(vf, /bordercolor=black/);
  assert.match(vf, /shadowx=6/);
  assert.match(vf, /shadowy=6/);
  assert.match(vf, /shadowcolor=black@0\.7/);
  assert.match(vf, /fontcolor=white/);
});

test('PR-Y buildIntroOverlayArgs: fade alpha boundary times correct for 5s', () => {
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    hookText: 'Plan Early',
    durationSec: 5,
  });
  const vf = findArg(argv, '-vf');
  // Fade in 0-0.4s, hold 0.4-4.6s, fade out 4.6-5s.
  assert.match(vf, /if\(lt\(t,0\.4\)/);
  assert.match(vf, /if\(lt\(t,4\.6\)/);
  assert.match(vf, /\(5-t\)\/0\.4/);
});

test('PR-Y buildIntroOverlayArgs: 4-word hook → font 120pt substituted', () => {
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    hookText: 'Plan Early This Summer',
  });
  const vf = findArg(argv, '-vf');
  assert.match(vf, /fontsize=120/);
});

test('PR-Y buildIntroOverlayArgs: 6-word hook that fits → font 96pt (schedule)', () => {
  // 6 words, short tokens — the 96pt schedule slot fits on 2 lines within
  // the 840px safe area, so wrap-before-shrink keeps the schedule size.
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    hookText: 'Plan Now Save More Buy Smart',
  });
  const vf = findArg(argv, '-vf');
  assert.match(vf, /fontsize=96/);
});

test('PR-Y buildIntroOverlayArgs: long 7-word hook (Shannon\'s case) → 3 drawtext filters at 80pt (3 lines)', () => {
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    hookText: 'A Special Needs Household Runs On Coordination',
  });
  const vf = findArg(argv, '-vf');
  const drawtextCount = (vf.match(/drawtext=/g) ?? []).length;
  assert.equal(drawtextCount, 3, 'should chain 3 drawtext filters (one per line)');
  assert.match(vf, /fontsize=80/, 'should NOT shrink below schedule when 3 lines fit');
});

// ── PR-Z: N-line stacking, line spacing, and vertical placement ────────

// Helper — pulls every `y=<num>` value out of the chained drawtext filter.
// Anchored on `:` (drawtext param separator) so we don't accidentally
// match `shadowy=6` or `borderw=8` etc.
function extractYValues(videoFilter) {
  return Array.from(videoFilter.matchAll(/:y=(\d+)/g)).map((m) => Number(m[1]));
}

test('PR-Z buildIntroOverlayArgs: 3-line render emits 3 DISTINCT y values (regression for "Planning With / \'s Harder" overlap)', () => {
  // Reproduces the jobId 432529d3 render: 6 words at 96pt wrapped to 3 lines.
  // Pre-PR-Z, lines 2 and 3 both used `y=(h-2*lh)/2 + lh`, collapsing into
  // the visible garbage Shannon flagged. PR-Z replaces the branching with
  // `blockTop + idx * lh` so every line gets a unique y.
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    hookText: 'Planning With Kids Home Is Harder',
  });
  const vf = findArg(argv, '-vf');
  const ys = extractYValues(vf);
  assert.equal(ys.length, 3, 'expected 3 numeric y values (one per line)');
  assert.equal(new Set(ys).size, 3, 'every line must have a unique y — duplicates mean overlap');
});

test('PR-Z buildIntroOverlayArgs: 3-line y values are spaced by lineHeightPx = round(fontSize × 1.30)', () => {
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    hookText: 'Planning With Kids Home Is Harder',
  });
  const vf = findArg(argv, '-vf');
  const ys = extractYValues(vf);
  // 96pt × 1.30 = 124.8 → round → 125
  const expectedStep = Math.round(96 * 1.30);
  assert.equal(ys[1] - ys[0], expectedStep, 'line 0 → line 1 spacing must equal lineHeightPx');
  assert.equal(ys[2] - ys[1], expectedStep, 'line 1 → line 2 spacing must equal lineHeightPx');
});

test('PR-Z buildIntroOverlayArgs: 3-line block is centred upper-middle (≈0.38 × height)', () => {
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    hookText: 'Planning With Kids Home Is Harder',
  });
  const vf = findArg(argv, '-vf');
  const ys = extractYValues(vf);
  // Block centre = midpoint between top of line 0 and top of line 2 + half a lineHeight
  const lh = Math.round(96 * 1.30);
  const blockCentre = ys[0] + (3 * lh) / 2;
  const expected = 1920 * 0.38; // 729.6
  // Allow a few px of rounding slack.
  assert.ok(
    Math.abs(blockCentre - expected) <= 2,
    `expected block centre near ${expected}, got ${blockCentre}`,
  );
});

test('PR-Z buildIntroOverlayArgs: single-line hook uses numeric y (not (h-text_h)/2 expression)', () => {
  // Single-line case used to short-circuit to `y=(h-text_h)/2`. With
  // numeric centring, even the 1-line case should report a fixed pixel y.
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    hookText: 'Plan',
  });
  const vf = findArg(argv, '-vf');
  assert.match(vf, /y=\d+/, 'single line must use a numeric y');
  assert.doesNotMatch(vf, /y=\(h-text_h\)\/2/, 'old expression-based y must be gone');
});

test('PR-Y buildIntroOverlayArgs: hook with single quote properly escaped', () => {
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    hookText: "Don't Wait Until Summer",
  });
  const vf = findArg(argv, '-vf');
  assert.match(vf, /Don\\'t/);
});

test('PR-Y buildIntroOverlayArgs: explicit fontFile is used as fontfile= (not fontconfig font=)', () => {
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    hookText: 'Plan Early',
    fontFile: '/usr/share/fonts/truetype/montserrat/Montserrat-Black.ttf',
  });
  const vf = findArg(argv, '-vf');
  assert.match(vf, /fontfile=\/usr\/share\/fonts\/truetype\/montserrat\/Montserrat-Black\.ttf/);
  assert.doesNotMatch(vf, /font=Montserrat\\:style=Black/);
});

test('PR-Y buildIntroOverlayArgs: missing fontFile falls back to font=Montserrat fontconfig pattern', () => {
  const argv = buildIntroOverlayArgs({
    inputVideoPath: '/tmp/in.mp4',
    outputPath: '/tmp/out.mp4',
    hookText: 'Plan Early',
    // no fontFile
  });
  const vf = findArg(argv, '-vf');
  assert.match(vf, /font=Montserrat\\:style=Black/);
});

// ── PR-X font path resolver (still applies in PR-Y) ─────────────────

test('PR-X resolveMontserratBlackPath: returns cached value on repeated calls', async () => {
  _resetFontPathCacheForTests();
  const first = await resolveMontserratBlackPath();
  const second = await resolveMontserratBlackPath();
  assert.equal(first, second);
});

// ── renderIntroOverlay end-to-end with injected execFn ───────────────

test('PR-Y renderIntroOverlay: passes fontFile through and returns it in metadata', async () => {
  let invokedCmd = null;
  const result = await renderIntroOverlay({
    inputVideoPath: '/tmp/brolled.mp4',
    outputPath: '/tmp/hook.mp4',
    hookText: 'Plan Early',
    fontFile: '/custom/MyFont.ttf',
    execFn: async (cmd) => { invokedCmd = cmd; return { stdout: '', stderr: '' }; },
  });
  assert.equal(result.fontFile, '/custom/MyFont.ttf');
  assert.match(invokedCmd, /fontfile=\/custom\/MyFont\.ttf/);
});

test('PR-Y renderIntroOverlay: returned metadata includes lines + fontSizePx for diagnostic', async () => {
  const result = await renderIntroOverlay({
    inputVideoPath: '/tmp/brolled.mp4',
    outputPath: '/tmp/hook.mp4',
    hookText: 'A Special Needs Household Runs On Coordination',
    fontFile: '/x/MyFont.ttf',
    execFn: async () => ({ stdout: '', stderr: '' }),
  });
  assert.equal(result.lines.length, 3, 'orchestrator records line count for diagnostic');
  assert.equal(result.fontSizePx, 80);
  assert.equal(result.durationSec, 5.0);
});

test("PR-Y renderIntroOverlay: when fontFile omitted, resolver runs; resolved path appears in command if found", async () => {
  _resetFontPathCacheForTests();
  let invokedCmd = null;
  const result = await renderIntroOverlay({
    inputVideoPath: '/tmp/brolled.mp4',
    outputPath: '/tmp/hook.mp4',
    hookText: 'Plan Early',
    execFn: async (cmd) => { invokedCmd = cmd; return { stdout: '', stderr: '' }; },
  });
  if (result.fontFile) {
    assert.match(invokedCmd, /fontfile=/);
  } else {
    assert.match(invokedCmd, /font=Montserrat/);
  }
});
