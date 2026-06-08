/**
 * test/compose_filter.test.js
 *
 * Lock-in test for the production face/b-roll compose filter chain in
 * lib/clean_mode_pipeline.js (`composeFaceAndBrolls`). Catches any future
 * drift back to the pre-PR #111 letterbox-pad approach that left ~656px of
 * black at top and bottom of landscape sources.
 *
 * The compose function isn't exported (orchestrator-internal), so we test
 * the source file content directly. This is a deliberate source-snapshot
 * test — same pattern as subtitle_burn's "does NOT regress to old 50pt size"
 * lock-in.
 *
 * Per-job output resolution: the source now uses template literals
 * (`scale=${outputWidth}:${outputHeight}:...`) so any supported pair (1080×1920
 * reels, 1080×1350 ads) renders through the same code path. Assertions match
 * the template-literal shape, not the runtime-resolved numeric values.
 *
 * What we DON'T touch:
 *   - The contact-sheet thumbnail filter (`generateContactSheet`) intentionally
 *     keeps `decrease,pad=...` because letterbox is acceptable for the
 *     internal QA index. Its filter operates at 270×480 (hardcoded by design,
 *     separate from production output) so it's size-distinct from the
 *     production chain — no aliasing with these assertions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, '..', 'lib', 'clean_mode_pipeline.js');
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

// ── PR #111: fill-crop reframing (production path, dim-parameterized) ─

test('compose filter: uses fill-crop scale chain (parameterized W/H) — PR #111 + per-job resolution', () => {
  // Both face and broll branches in composeFaceAndBrolls use the fill-crop
  // chain. After per-job output resolution landed, the literal `1080:1920`
  // was replaced with `${outputWidth}:${outputHeight}` template tokens so
  // 4:5 ad output (1080×1350) and 9:16 reel output (1080×1920) share the
  // same code path. We expect:
  //   - the parameterized scale-increase prefix appears at least twice
  //   - the parameterized crop appears at least twice (face + broll branches)
  const FILL_CROP_SCALE = /scale=\$\{outputWidth\}:\$\{outputHeight\}:force_original_aspect_ratio=increase/g;
  const FILL_CROP_CROP = /crop=\$\{outputWidth\}:\$\{outputHeight\}/g;
  const scaleMatches = SOURCE.match(FILL_CROP_SCALE) || [];
  const cropMatches = SOURCE.match(FILL_CROP_CROP) || [];
  assert.ok(
    scaleMatches.length >= 2,
    `expected parameterized scale-increase prefix in at least both face + broll branches; ` +
    `found ${scaleMatches.length} occurrence(s)`,
  );
  assert.ok(
    cropMatches.length >= 2,
    `expected parameterized crop=\${outputWidth}:\${outputHeight} in at least both face + broll branches; ` +
    `found ${cropMatches.length} occurrence(s)`,
  );
});

test('compose filter: face branch uses face-aware crop expression (X + Y) with outputWidth/Height', () => {
  // The face branch must apply the face_detect-driven horizontal AND vertical
  // offsets. After the vertical-crop fix the shape is
  // `crop=${outputWidth}:${outputHeight}:${cropXExpr}:${cropYExpr}` — the y was
  // previously a hardcoded `:0` (top crop) that clipped low-framed speakers
  // when a tall 9:16 source was cropped to a 4:5 ad. Catches a regression to
  // either the static offset (x) or the top-pinned crop (y).
  const DYNAMIC_FACE_CROP = /crop=\$\{outputWidth\}:\$\{outputHeight\}:\$\{cropXExpr\}:\$\{cropYExpr\}/;
  assert.match(
    SOURCE,
    DYNAMIC_FACE_CROP,
    'face segment must use crop=${outputWidth}:${outputHeight}:${cropXExpr}:${cropYExpr} ' +
    'so both face_detect offsets reach ffmpeg at the requested target dimensions',
  );
  // buildCropXExpression must be called with the outputWidth so the crop
  // math centers on the correct half-width (1080/2=540 by default).
  assert.match(
    SOURCE,
    /buildCropXExpression\(faceCropOffsetX,\s*outputWidth\)/,
    'composeFaceAndBrolls must call buildCropXExpression(faceCropOffsetX, outputWidth)',
  );
  // ...and buildCropYExpression with the outputHeight for the vertical center.
  assert.match(
    SOURCE,
    /buildCropYExpression\(faceCropOffsetY,\s*outputHeight\)/,
    'composeFaceAndBrolls must call buildCropYExpression(faceCropOffsetY, outputHeight) ' +
    'so the vertical crop centers on the face instead of the top of frame',
  );
});

test('compose filter (Tier 2-b): broll branch uses per-asset face-aware crop expression', () => {
  // Tier 2-b (2026-05-28) supersedes the PR #114 assertion. The b-roll
  // branch now reads `ins.faceCropOffsetX` (default 0.5 = pre-Tier-2-b
  // center-crop behavior) and feeds it through buildCropXExpression so
  // landscape stock with off-center subjects stays in frame. Repro of the
  // bug: Thursday b9915364 at 75.7s — a Pexels woman-at-laptop with face
  // on the right was cropped down to ear+hair only by the hardcoded
  // `crop=W:H` shorthand.
  //
  // After Tier 2-b the shape is:
  //   `scale=${W}:${H}:...,crop=${W}:${H}:${brollCropXExpr}:0,setsar=...`
  // where brollCropXExpr = buildCropXExpression(brollOffsetX, outputWidth).
  assert.match(
    SOURCE,
    /const brollOffsetX = typeof ins\.faceCropOffsetX === 'number'/,
    'compose b-roll branch must read ins.faceCropOffsetX (Tier 2-b)',
  );
  assert.match(
    SOURCE,
    /const brollCropXExpr = buildCropXExpression\(brollOffsetX, outputWidth\)/,
    'compose b-roll branch must build cropXExpr via buildCropXExpression',
  );
  assert.match(
    SOURCE,
    /\$\{inputChain\},setpts=PTS-STARTPTS,[\s\S]*?scale=\$\{outputWidth\}:\$\{outputHeight\}:force_original_aspect_ratio=increase,[\s\S]*?crop=\$\{outputWidth\}:\$\{outputHeight\}:\$\{brollCropXExpr\}:0,/,
    'broll branch must emit `crop=W:H:${brollCropXExpr}:0` (face-aware), not plain `crop=W:H`',
  );
});

test('compose filter: does NOT regress to letterbox-pad — PR #111', () => {
  // Defends against drift back to the pre-PR #111 letterbox-pad approach
  // that left black bars top/bottom on landscape talking-head sources.
  // Both the hardcoded-1080:1920 form AND the new parameterized form
  // must be absent from the production compose chain.
  // (Contact-sheet at 270×480 is size-distinct and excluded by these patterns.)
  const LETTERBOX_HARDCODED = /scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920/g;
  const LETTERBOX_PARAMETERIZED = /scale=\$\{outputWidth\}:\$\{outputHeight\}:force_original_aspect_ratio=decrease,pad=\$\{outputWidth\}:\$\{outputHeight\}/g;
  const LETTERBOX_BARE = /pad=\$?\{?(?:outputWidth|1080)\}?:\$?\{?(?:outputHeight|1920)\}?:\(ow-iw\)\/2:\(oh-ih\)\/2/g;
  assert.equal(
    (SOURCE.match(LETTERBOX_HARDCODED) || []).length,
    0,
    'pre-PR #111 hardcoded letterbox "scale=1080:1920:...decrease,pad=1080:1920" must NOT appear',
  );
  assert.equal(
    (SOURCE.match(LETTERBOX_PARAMETERIZED) || []).length,
    0,
    'parameterized letterbox "scale=${outputWidth}:${outputHeight}:...decrease,pad=${outputWidth}:${outputHeight}" must NOT appear in the production chain',
  );
  assert.equal(
    (SOURCE.match(LETTERBOX_BARE) || []).length,
    0,
    'bare letterbox pad expression must NOT appear (regression guard)',
  );
});

test('compose filter: contact-sheet helper still uses letterbox-pad at 270×480 (intentional, untouched)', () => {
  // PR #111 intentionally only changes the *production output* compose path.
  // The contact-sheet thumbnail (270×480) keeps letterbox-pad because it's
  // an internal QA index where seeing the original aspect is more useful
  // than filling the thumbnail. This test confirms the contact-sheet path
  // wasn't accidentally swept up by parameterization either.
  assert.match(
    SOURCE,
    /scale=270:480:force_original_aspect_ratio=decrease,pad=270:480/,
    'contact-sheet helper must keep its letterbox-pad filter at 270×480 — ' +
    'parameterization only touches the production output chain',
  );
});

test('compose filter: production scale chain does not contain hardcoded 1080:1920 literals (parameterization gate)', () => {
  // After parameterization, the production scale+crop chain should reference
  // ${outputWidth}:${outputHeight}, not literal 1080:1920. The only places
  // 1080:1920 should still appear are: comments/docstrings, the default
  // function-parameter line, and any pre-existing buildCropXExpression
  // doc comment math. The actual filter strings must be dim-agnostic.
  const FACE_HARDCODED = /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:\$\{cropXExpr\}:0/;
  const BROLL_HARDCODED = /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar/;
  assert.doesNotMatch(SOURCE, FACE_HARDCODED,
    'face branch filter must use ${outputWidth}:${outputHeight}, not literal 1080:1920');
  assert.doesNotMatch(SOURCE, BROLL_HARDCODED,
    'broll branch filter must use ${outputWidth}:${outputHeight}, not literal 1080:1920');
});

test('compose filter: still applies setsar=1 + yuv420p (post-scale formatting intact)', () => {
  // The parameterization should not have stripped the post-scale formatting
  // (setsar=1 normalises the pixel aspect, format=yuv420p ensures the
  // x264 encoder downstream gets a compatible pixel format).
  const SETSAR_FORMAT = /setsar=1,format=yuv420p/g;
  const matches = SOURCE.match(SETSAR_FORMAT) || [];
  assert.ok(
    matches.length >= 2,
    `expected setsar=1,format=yuv420p in at least both face + broll branches; ` +
    `found ${matches.length} occurrence(s)`,
  );
});

test('compose filter: composeFaceAndBrolls signature accepts outputWidth/outputHeight with reel defaults', () => {
  // Regression guard: per-job resolution must thread through the function
  // signature with safe reel defaults. Without defaults, callers that don't
  // pass dimensions would crash; without correct defaults, the reel path
  // would silently re-render at the wrong aspect.
  assert.match(
    SOURCE,
    /async function composeFaceAndBrolls\(\{[\s\S]*?outputWidth\s*=\s*1080[\s\S]*?outputHeight\s*=\s*1920[\s\S]*?\}\)/,
    'composeFaceAndBrolls must destructure outputWidth=1080 and outputHeight=1920 ' +
    'with defaults so callers that omit them get the existing reel behavior',
  );
});
