/**
 * test/assemble_ad_variation.test.js
 *
 * Source-snapshot tests for POST /assemble-ad-variation. The route is pure
 * ffmpeg orchestration (download → normalise → concat → upload), which can't
 * run in CI without ffmpeg + network, so we assert the contract by reading the
 * route source — same convention as the other no-ffmpeg route tests.
 *
 * Guards the behaviours that matter for PR3:
 *   - default output is 1080x1350 (ad format)
 *   - normalise uses scale-to-fit + pad (NEVER crop → faces aren't cut)
 *   - silent-audio fallback so concat stream layout always matches
 *   - concat is -c copy after per-clip normalise (memory-safe, one at a time)
 *   - async mode returns 202 and calls back with x-api-key
 *   - validation rejects missing variationId / clientId / clips
 *   - rendered file is uploaded + signed (not a bare public URL)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '../routes/assemble-ad-variation.js'), 'utf8');

test('default output frame is 1080x1350 (ad format)', () => {
  assert.match(src, /DEFAULT_W\s*=\s*1080/);
  assert.match(src, /DEFAULT_H\s*=\s*1350/);
});

test('normalise scales-to-fit + pads (no crop → faces never cut)', () => {
  assert.match(src, /force_original_aspect_ratio=decrease/);
  assert.match(src, /pad=\$\{w\}:\$\{h\}/);
  assert.doesNotMatch(src, /crop=/); // v1 must not crop
});

test('injects silent stereo audio when a clip has no audio stream', () => {
  assert.match(src, /anullsrc=channel_layout=stereo:sample_rate=48000/);
  assert.match(src, /hasAudio/);
});

test('concat is stream-copy after per-clip normalise (memory-safe)', () => {
  assert.match(src, /-f concat -safe 0/);
  assert.match(src, /-c copy/);
  // normalise loop runs one clip at a time (no Promise.all over clips)
  assert.match(src, /for \(let i = 0; i < clips\.length; i\+\+\)/);
});

test('async mode returns 202 and posts an x-api-key callback', () => {
  assert.match(src, /status\(202\)/);
  assert.match(src, /'x-api-key': callback\.apiKey/);
  assert.match(src, /status: 'success'/);
  assert.match(src, /status: 'failed'/);
});

test('validates required fields', () => {
  assert.match(src, /variationId is required/);
  assert.match(src, /clientId is required/);
  assert.match(src, /clips must be a non-empty array/);
});

test('rendered output is uploaded then signed (1-year TTL)', () => {
  assert.match(src, /object\/sign\/video-modules/);
  assert.match(src, /RENDERED_URL_TTL_SEC\s*=\s*60 \* 60 \* 24 \* 365/);
});

test('ffmpeg failures surface the real stderr (not just the command)', () => {
  assert.match(src, /function runFfmpeg/);
  assert.match(src, /err\?\.stderr/);
  assert.match(src, /maxBuffer: EXEC_MAXBUFFER/);
  assert.doesNotMatch(src, /await execAsync\(\s*`ffmpeg -f concat/); // concat uses runFfmpeg now
});

test('downloads are validated as real video before normalising', () => {
  assert.match(src, /function assertValidVideo/);
  assert.match(src, /await assertValidVideo\(/);
  assert.match(src, /is not a valid video/);
});

test('renders are concurrency-gated to avoid Railway OOM', () => {
  assert.match(src, /MAX_CONCURRENT_RENDERS\s*=\s*2/);
  assert.match(src, /acquireRenderSlot/);
  assert.match(src, /releaseRenderSlot/);
  assert.match(src, /renderVariationQueued/);
});

test('ad-format: face-aware reframe to fill 1080x1350 (no bars)', () => {
  assert.match(src, /detectFaceOffsetX/);
  assert.match(src, /composeFaceAndBrolls/);
  assert.match(src, /insertions: \[\]/);          // pure reframe, zero b-roll
  assert.match(src, /faceCropOffsetX: face\.offsetX/);
  assert.match(src, /NORM_W\s*=\s*1080/);          // pre-concat vertical canonical
  assert.match(src, /NORM_H\s*=\s*1920/);
});

test('ad-format: SupportED banner overlay when a headline is supplied', () => {
  assert.match(src, /overlayBanner/);
  assert.match(src, /banner\.headline/);
  assert.match(src, /eyebrow/);
  assert.match(src, /subtext/);
});

test('ad-format: burned ad captions (gold) from a fresh transcript', () => {
  assert.match(src, /callDeepgramWithRetry/);
  assert.match(src, /mapDeepgramResponse/);
  assert.match(src, /groupIntoLines/);
  assert.match(src, /writeAssAndBurn/);
  assert.match(src, /captionStyle: 'ad'/);
});

test('ad-format: each styling stage degrades gracefully (never hard-fails)', () => {
  assert.match(src, /reframe_failed/);
  assert.match(src, /padReframe/);            // reframe fallback keeps output dims
  assert.match(src, /banner_failed/);
  assert.match(src, /subtitles_failed|subtitles_skipped/);
  assert.match(src, /warnings/);
});
