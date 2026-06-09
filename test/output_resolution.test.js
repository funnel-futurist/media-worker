/**
 * test/output_resolution.test.js
 *
 * Lock-in tests for per-job output resolution. Two paths must coexist:
 *   - 1080×1920 (9:16 reel) — the existing default, must remain byte-identical
 *     when no options are passed.
 *   - 1080×1350 (4:5 ad)    — new path for ad-creative output where the
 *     source has hook text baked in at 4:5 and the pipeline must not zoom-crop
 *     it back to 9:16.
 *
 * These tests cover:
 *   1. generateAss emits the requested PlayRes + a proportionally-scaled MarginV
 *   2. buildCropXExpression respects the cropWidth parameter (defaults to 1080)
 *   3. The pipeline source threads outputWidth/outputHeight through the
 *      compose function signature, the picker call, the writeAssAndBurn call,
 *      and the option-defaults block (regression guards against partial wiring).
 *   4. The route source enforces the (1080,1920) | (1080,1350) whitelist
 *      and rejects half-specified inputs.
 *
 * Tests are deliberately string-snapshot / source-scan style to avoid spinning
 * up ffmpeg or the full Express app — they catch wiring regressions cheaply.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { generateAss } from '../lib/subtitle_burn.js';
import { buildCropXExpression } from '../lib/face_detect.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE = readFileSync(join(__dirname, '..', 'lib', 'clean_mode_pipeline.js'), 'utf8');
const ROUTE = readFileSync(join(__dirname, '..', 'routes', 'clean-mode-compose.js'), 'utf8');

// ── generateAss: 1080×1350 ad path ─────────────────────────────────────

test('generateAss: 4:5 ad → PlayResY=1350 and MarginV proportional (≈366)', () => {
  const lines = [{ start: 0, end: 1, text: 'HOOK' }];
  const ass = generateAss(lines, { playResX: 1080, playResY: 1350 });
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1350/);
  // Expected MarginV = round(520 * 1350/1920) = round(365.625) = 366
  // Anchored to the end-of-line so it matches the Style row, not a stray 366 elsewhere.
  assert.match(ass, /,2,40,40,366,1$/m,
    `expected Style line to end with Alignment=2,MarginL=40,MarginR=40,MarginV=366 ` +
    `(scaled from reel default 520 × 1350/1920); got ASS:\n${ass}`);
});

test('generateAss: 9:16 reel default (no opts) keeps MarginV=520 + PlayResY=1920 (regression guard)', () => {
  const lines = [{ start: 0, end: 1, text: 'HELLO' }];
  const ass = generateAss(lines);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /,2,40,40,520,1$/m,
    'no-opts call must produce the historical reel MarginV=520 byte-for-byte');
});

test('generateAss: explicit marginV overrides the proportional default', () => {
  const lines = [{ start: 0, end: 1, text: 'X' }];
  const ass = generateAss(lines, { playResX: 1080, playResY: 1350, marginV: 200 });
  assert.match(ass, /,2,40,40,200,1$/m,
    'explicit marginV must override the playResY-derived default');
});

test('generateAss: malformed playResX/Y falls back to reel defaults (defensive)', () => {
  const lines = [{ start: 0, end: 1, text: 'X' }];
  // 0 / negative / non-numeric → treat as missing
  for (const bad of [{ playResX: 0 }, { playResY: -100 }, { playResX: 'big' }]) {
    const ass = generateAss(lines, bad);
    assert.match(ass, /PlayResX: 1080/);
    assert.match(ass, /PlayResY: 1920/);
  }
});

// ── buildCropXExpression: cropWidth parameter ─────────────────────────

test('buildCropXExpression: default cropWidth=1080 keeps the historical reel expression', () => {
  // Regression guard: omitting cropWidth must produce the exact pre-change
  // expression so reel renders keep their bit-for-bit filter graph.
  const expr = buildCropXExpression(0.5);
  assert.match(expr, /min\(iw-1080/);
  assert.match(expr, /0\.5000\*iw-540/);
});

test('buildCropXExpression: explicit cropWidth=1080 matches the default behavior', () => {
  // 4:5 ads also use cropWidth=1080 (same width, different height), so the
  // expression should be identical to the default-arg call.
  assert.equal(buildCropXExpression(0.5), buildCropXExpression(0.5, 1080));
  assert.equal(buildCropXExpression(0.4231), buildCropXExpression(0.4231, 1080));
});

test('buildCropXExpression: cropWidth=720 produces 720-aware bounds and half-width', () => {
  // Future-proof — preview / thumbnail callers can pass a smaller width
  // without touching the helper. cropWidth=720 → half=360.
  const expr = buildCropXExpression(0.5, 720);
  assert.match(expr, /min\(iw-720/);
  assert.match(expr, /0\.5000\*iw-360/);
});

test('buildCropXExpression: odd cropWidth rounds half to the nearest integer', () => {
  // Defensive: an odd cropWidth shouldn't emit a fractional half-pixel
  // offset (ffmpeg would still accept it, but determinism matters).
  const expr = buildCropXExpression(0.5, 1081);
  // 1081/2 = 540.5 → rounds to 541
  assert.match(expr, /iw-541\)/);
});

// ── clean_mode_pipeline.js wiring: opts → compose → subtitle ──────────

test('pipeline: opts block extracts outputWidth + outputHeight with reel defaults', () => {
  // The destructuring/defaulting must accept both keys from req.options
  // and fall back to 1080×1920. Any drift (e.g. wrong default) silently
  // regresses 4:5 ad output back to 9:16.
  assert.match(
    PIPELINE,
    /outputWidth:\s*typeof req\.options\?\.outputWidth === 'number'\s*\?\s*req\.options\.outputWidth\s*:\s*1080/,
    'pipeline must read options.outputWidth with a 1080 default',
  );
  assert.match(
    PIPELINE,
    /outputHeight:\s*typeof req\.options\?\.outputHeight === 'number'\s*\?\s*req\.options\.outputHeight\s*:\s*1920/,
    'pipeline must read options.outputHeight with a 1920 default',
  );
});

test('pipeline: composeFaceAndBrolls call passes outputWidth + outputHeight from opts', () => {
  assert.match(
    PIPELINE,
    /composeFaceAndBrolls\(\{[\s\S]*?outputWidth:\s*opts\.outputWidth[\s\S]*?outputHeight:\s*opts\.outputHeight[\s\S]*?\}\)/,
    'composeFaceAndBrolls call must thread opts.outputWidth and opts.outputHeight ' +
    '(without this, the compose step always renders 1080×1920 regardless of request)',
  );
});

test('pipeline: writeAssAndBurn call passes assOpts.playResX + assOpts.playResY from opts', () => {
  assert.match(
    PIPELINE,
    /writeAssAndBurn\(\{[\s\S]*?assOpts:\s*\{\s*playResX:\s*opts\.outputWidth,\s*playResY:\s*opts\.outputHeight\s*\}[\s\S]*?\}\)/,
    'subtitle burn call must pass {playResX: opts.outputWidth, playResY: opts.outputHeight} ' +
    'so the ASS PlayRes matches the rendered frame size',
  );
});

test('pipeline: pickBrollInsertions call passes outputWidth + outputHeight to the picker', () => {
  // The Gemini system prompt names the aspect ('9:16 reel' vs '4:5 ad'),
  // so the picker needs to know the target dims to tailor advice.
  assert.match(
    PIPELINE,
    /pickBrollInsertions\(\{[\s\S]*?outputWidth:\s*opts\.outputWidth[\s\S]*?outputHeight:\s*opts\.outputHeight[\s\S]*?\}\)/,
    'pickBrollInsertions call must thread opts.outputWidth and opts.outputHeight ' +
    'so the broll picker prompt reflects the requested aspect',
  );
});

// ── reframe-when-no-compose fallback (skipBroll / 0-insertions / compose-fail) ──
// Root cause (2026-06-09): compose is the ONLY step that scales+face-crops the
// cut to opts.outputWidth×outputHeight, and it's gated behind `if (!skipBroll)`.
// With b-roll off (every ad since portal #352), compose never ran, so ads
// shipped at SOURCE dims (confirmed: a 720×1280 selfie as a "1080×1350 ad").
// These lock in the reframe fallback that runs when compose didn't.

test('pipeline: reframe fallback runs when no compose happened (videoForSubtitles === cutPath)', () => {
  assert.match(
    PIPELINE,
    /if \(videoForSubtitles === cutPath\) \{[\s\S]*?stepStart\('reframe'\)/,
    'a reframe step must run when compose did not (videoForSubtitles still === cutPath) — ' +
    'covers skipBroll (all ads since #352), 0 insertions, and compose failure',
  );
});

test('pipeline: reframe is gated on a real dimension mismatch (no-op when already at target)', () => {
  assert.match(
    PIPELINE,
    /const needsReframe = sw !== opts\.outputWidth \|\| sh !== opts\.outputHeight/,
    'reframe must only fire when source dims differ from opts.outputWidth/Height ' +
    'so an already-correct source stays a byte-identical no-op (no extra re-encode)',
  );
});

test('pipeline: reframe reuses composeFaceAndBrolls with ZERO insertions (pure reframe)', () => {
  assert.match(
    PIPELINE,
    /composeFaceAndBrolls\(\{\s*facePath: cutPath,\s*brolledPath: reframedPath,\s*insertions: \[\]/,
    'reframe fallback must call composeFaceAndBrolls with facePath:cutPath, brolledPath:reframedPath, insertions:[] ' +
    '(empty insertions degrade to one face segment = a pure face-aware scale+crop)',
  );
  assert.match(
    PIPELINE,
    /composeFaceAndBrolls\(\{[\s\S]*?insertions: \[\][\s\S]*?faceCropOffsetX: faceDetectResult\.offsetX[\s\S]*?outputWidth: opts\.outputWidth[\s\S]*?outputHeight: opts\.outputHeight[\s\S]*?\}\)/,
    'reframe fallback must thread the face_detect offsets + opts.outputWidth/Height',
  );
});

test('pipeline: reframe fallback is non-fatal (keeps source cut + warns on failure)', () => {
  assert.match(
    PIPELINE,
    /warnings\.push\(`reframe_failed:[\s\S]*?output stays at source dimensions`\)/,
    'reframe failure must be non-fatal: warn + keep the source-dimension cut and ship',
  );
});

test('pipeline: reframe records steps.reframe telemetry', () => {
  assert.match(
    PIPELINE,
    /steps\.reframe = \{[\s\S]*?reframed,[\s\S]*?sourceDims:[\s\S]*?targetDims:/,
    'reframe must record steps.reframe { reframed, sourceDims, targetDims }',
  );
});

test('pipeline: reframedPath temp file is defined alongside the other job paths', () => {
  assert.match(
    PIPELINE,
    /const reframedPath = join\(tmpDir, 'reframed\.mp4'\)/,
    'reframedPath must be defined in the per-job tmp paths block',
  );
});

// ── Route validation wiring ───────────────────────────────────────────

test('route: rejects half-specified outputWidth/outputHeight (both must be present)', () => {
  // Half-specified is a footgun — the caller almost certainly intended a
  // 4:5 ad but typed only one dimension, and the pipeline would silently
  // default the other to the reel value and render the wrong aspect.
  assert.match(
    ROUTE,
    /options\.outputWidth and options\.outputHeight must be specified together/,
    'route validation must reject half-specified outputWidth/outputHeight',
  );
});

test('route: whitelists exactly (1080,1920) and (1080,1350) for now', () => {
  // Restricted whitelist prevents accidental misuse (e.g. 540×960 preview
  // size that the pipeline isn't yet calibrated for). Widening this list
  // requires explicit code change + visual QC on the new pair.
  assert.match(
    ROUTE,
    /SUPPORTED\s*=\s*\[\s*\[1080,\s*1920\]\s*,\s*\[1080,\s*1350\]\s*\]/,
    'route SUPPORTED whitelist must include exactly (1080,1920) and (1080,1350) for v1',
  );
});

test('route: documents outputWidth + outputHeight in the route JSDoc', () => {
  // The route's doc block is the contract surface for callers. New per-job
  // options must be documented so portal/integration engineers can find them.
  assert.match(
    ROUTE,
    /outputWidth\?:\s*number,\s*outputHeight\?:\s*number/,
    'route JSDoc must document outputWidth/outputHeight in the options shape',
  );
});
