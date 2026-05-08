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
 * lock-in. If the filter logic ever moves to a separate helper, swap this
 * for a behavior test against the helper's output.
 *
 * What we DON'T touch:
 *   - The contact-sheet thumbnail filter (`generateContactSheet`) intentionally
 *     keeps `decrease,pad=...` because letterbox is acceptable for the
 *     internal QA index. Its filter operates at 270×480 so it's
 *     size-distinct from the production 1080×1920 chain — no slicing needed
 *     to scope the assertions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, '..', 'lib', 'clean_mode_pipeline.js');
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

// ── PR #111: fill-crop reframing (production 1080×1920 path) ──────────

test('compose filter: uses fill-crop (increase + crop=1080:1920) — PR #111', () => {
  // Both face and broll branches in composeFaceAndBrolls use the fill-crop
  // chain. PR #114 made the FACE branch use a dynamic x-expression coming
  // from face_detect.js (`crop=1080:1920:<expr>:0`); the broll branch keeps
  // the simple `crop=1080:1920` because brolls are iPhone portrait content
  // already at the target aspect (the crop is a no-op there). So we expect:
  //   - the scale+crop prefix appears exactly twice
  //   - one occurrence is followed by a `:` (face branch with dynamic offset)
  //   - one occurrence is followed by a `,` (broll branch, plain crop)
  const FILL_CROP_PREFIX = /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920/g;
  const matches = SOURCE.match(FILL_CROP_PREFIX) || [];
  assert.equal(
    matches.length,
    2,
    `expected fill-crop prefix to appear exactly twice (face + broll segments); ` +
    `found ${matches.length} occurrence(s)`,
  );
});

test('compose filter: face branch uses face-aware crop expression — PR #114', () => {
  // The face branch must apply the face_detect-driven horizontal offset.
  // Match the shape `crop=1080:1920:<expr>:0` where <expr> is the ffmpeg
  // expression produced by buildCropXExpression — `max(0\,min(iw-1080\,...))`.
  // Catches a regression where someone reverts the dynamic offset and
  // pushes off-center subjects to the edge again.
  const DYNAMIC_FACE_CROP = /crop=1080:1920:\$\{cropXExpr\}:0/;
  assert.match(
    SOURCE,
    DYNAMIC_FACE_CROP,
    'face segment must use crop=1080:1920:${cropXExpr}:0 (PR #114) so the ' +
    'face_detect offset reaches ffmpeg',
  );
  // And buildCropXExpression must be imported and used.
  assert.match(
    SOURCE,
    /buildCropXExpression\(faceCropOffsetX\)/,
    'composeFaceAndBrolls must call buildCropXExpression(faceCropOffsetX) ' +
    'to render the dynamic crop expression',
  );
});

test('compose filter: broll branch keeps plain center crop (no offset needed) — PR #114', () => {
  // Brolls are iPhone portrait content (rotate=90 metadata) → already 9:16
  // effective. Adding a horizontal crop offset would be meaningless and
  // could destabilize the broll path. Keep the broll branch with the simple
  // `crop=1080:1920,setsar=1` chain.
  assert.match(
    SOURCE,
    /\$\{inputChain\},setpts=PTS-STARTPTS,[\s\S]*?scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,/,
    'broll branch must keep plain `crop=1080:1920,` (no dynamic offset)',
  );
});

test('compose filter: does NOT regress to letterbox-pad at production 1080×1920 — PR #111', () => {
  // Defends against drift back to the pre-PR #111 letterbox-pad approach
  // that left black bars top/bottom on landscape talking-head sources.
  // Phil B7 frame at 5s on 2026-05-08 is the canonical evidence we're
  // guarding against. Search for either the full pad chain or the bare
  // pad invocation at production size — both must be absent from this
  // file's 1080×1920 path. Contact-sheet is size-distinct (270×480) so
  // it isn't matched by these patterns.
  const LETTERBOX_FULL = /scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920/g;
  const LETTERBOX_BARE = /pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2/g;
  assert.equal(
    (SOURCE.match(LETTERBOX_FULL) || []).length,
    0,
    'pre-PR #111 letterbox filter "scale=1080:1920:...decrease,pad=1080:1920" must NOT ' +
    'appear at production size — it left ~656px of black on landscape sources',
  );
  assert.equal(
    (SOURCE.match(LETTERBOX_BARE) || []).length,
    0,
    'bare pad expression "pad=1080:1920:(ow-iw)/2:(oh-ih)/2" must NOT appear ' +
    '(regression guard against partial reverts that swap one branch back)',
  );
});

test('compose filter: contact-sheet helper still uses letterbox-pad at 270×480 (intentional, untouched)', () => {
  // PR #111 intentionally only changes the *production output* compose path.
  // The contact-sheet thumbnail (270×480) keeps letterbox-pad because it's
  // an internal QA index where seeing the original aspect is more useful
  // than filling the thumbnail. This test confirms the contact-sheet path
  // wasn't accidentally swept up in the change.
  assert.match(
    SOURCE,
    /scale=270:480:force_original_aspect_ratio=decrease,pad=270:480/,
    'contact-sheet helper must keep its letterbox-pad filter at 270×480 — ' +
    'PR #111 only changes the production 1080×1920 output path',
  );
});

test('compose filter: still applies setsar=1 + yuv420p (post-scale formatting intact)', () => {
  // The crop swap should not have stripped the post-scale formatting
  // (setsar=1 normalises the pixel aspect, format=yuv420p ensures the
  // x264 encoder downstream gets a compatible pixel format). We can't
  // assert adjacency in the source-file text because the production
  // filter is built from concatenated template literals across multiple
  // source lines — the runtime filter string IS adjacent, but the source
  // text isn't. So instead: assert the formatting tokens appear at least
  // twice (once per face + broll segment) somewhere in the file. That's
  // weaker than a sequence check but enough to catch a wholesale removal.
  const SETSAR_FORMAT = /setsar=1,format=yuv420p/g;
  const matches = SOURCE.match(SETSAR_FORMAT) || [];
  assert.ok(
    matches.length >= 2,
    `expected setsar=1,format=yuv420p in at least both face + broll branches; ` +
    `found ${matches.length} occurrence(s)`,
  );
});
