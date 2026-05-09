/**
 * test/download_broll_assets.test.js
 *
 * Targeted unit tests for the PR-A short-circuit added to
 * `downloadBrollAssets` in `lib/clean_mode_pipeline.js`. The full function
 * is HTTP-bound on the client-row branch (axios stream + ffprobe), but the
 * short-circuit branch is pure data wiring that we can test without
 * touching the network — and it's the single new code path PR-A introduces.
 *
 * Goal: prove that when a library row has `localPath` already set
 * (Pixabay stock pre-downloaded by the orchestrator), `downloadBrollAssets`:
 *   - Does NOT make any HTTP request
 *   - Reuses the pre-probed metadata (sourceDurSec, hasVideo/Audio, w/h)
 *   - Surfaces provenance + pixabayPageURL + searchKeyword onto the
 *     returned insertion record so the response shape can render attribution
 *
 * The client-row branch is already exercised by the M2 real-video B-runs
 * (B6 through B11) and by the orchestrator's existing partial-data test
 * surface; not re-tested here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadBrollAssets } from '../lib/clean_mode_pipeline.js';

// ── stock short-circuit (the new PR-A path) ────────────────────────────

test('downloadBrollAssets: stock row with localPath skips fetch and returns merged metadata', async () => {
  const stockRow = {
    asset_id: 'px-video-1234',
    asset_title: 'Pixabay stock: family, home',
    asset_type: 'video',
    file_url: 'https://cdn.pixabay.com/video/x/1234-medium.mp4',
    storage_url: null,
    drive_file_id: null,
    provenance: 'pixabay',
    pixabayPageURL: 'https://pixabay.com/videos/family-1234/',
    searchKeyword: 'family planning home',
    localPath: '/tmp/some-job/stock-cache/px-video-1234.mp4',
    sourceDurSec: 17.5,
    hasVideo: true,
    hasAudio: false,
    width: 1280,
    height: 720,
  };
  const insertions = [
    { startSec: 5, endSec: 10, asset_id: 'px-video-1234', reason: 'test', matchedPhrase: 'phrase' },
  ];
  const out = (await downloadBrollAssets(insertions, [stockRow], '/tmp/unused')).assets;

  assert.equal(out.length, 1);
  assert.equal(out[0].asset_id, 'px-video-1234');
  assert.equal(out[0].localPath, '/tmp/some-job/stock-cache/px-video-1234.mp4',
    'should reuse pre-downloaded localPath, not write to brollDir');
  assert.equal(out[0].sourceDurSec, 17.5, 'should reuse pre-probed duration');
  assert.equal(out[0].hasVideo, true);
  assert.equal(out[0].hasAudio, false);
  assert.equal(out[0].width, 1280);
  assert.equal(out[0].height, 720);
  assert.equal(out[0].assetTitle, 'Pixabay stock: family, home');
  assert.equal(out[0].assetType, 'video');
  assert.equal(out[0].provenance, 'pixabay');
  assert.equal(out[0].pixabayPageURL, 'https://pixabay.com/videos/family-1234/');
  assert.equal(out[0].searchKeyword, 'family planning home');
  // Original insertion fields pass through.
  assert.equal(out[0].startSec, 5);
  assert.equal(out[0].endSec, 10);
  assert.equal(out[0].reason, 'test');
});

test('downloadBrollAssets: stock row preserves insertion order with multiple stock rows', async () => {
  const rows = [
    {
      asset_id: 'px-video-1', file_url: 'https://x', storage_url: null,
      provenance: 'pixabay', localPath: '/tmp/x/1.mp4',
      sourceDurSec: 5, hasVideo: true, hasAudio: false, width: 1280, height: 720,
    },
    {
      asset_id: 'px-video-2', file_url: 'https://x', storage_url: null,
      provenance: 'pixabay', localPath: '/tmp/x/2.mp4',
      sourceDurSec: 8, hasVideo: true, hasAudio: false, width: 1280, height: 720,
    },
    {
      asset_id: 'px-video-3', file_url: 'https://x', storage_url: null,
      provenance: 'pixabay', localPath: '/tmp/x/3.mp4',
      sourceDurSec: 12, hasVideo: true, hasAudio: false, width: 1280, height: 720,
    },
  ];
  const insertions = [
    { startSec: 0, endSec: 5, asset_id: 'px-video-1' },
    { startSec: 10, endSec: 18, asset_id: 'px-video-2' },
    { startSec: 30, endSec: 42, asset_id: 'px-video-3' },
  ];
  const { assets: out } = await downloadBrollAssets(insertions, rows, '/tmp/unused');
  assert.deepEqual(out.map((o) => o.asset_id), ['px-video-1', 'px-video-2', 'px-video-3']);
});

test('downloadBrollAssets: short-circuit fills sane defaults when row metadata is partial', async () => {
  // PR #110 / earlier safety: even if the pre-probe came back partial, the
  // short-circuit should produce a complete insertion record (no crash on
  // missing fields downstream).
  const minimal = {
    asset_id: 'px-video-99',
    file_url: 'https://cdn.pixabay/x.mp4',
    storage_url: null,
    provenance: 'pixabay',
    localPath: '/tmp/x/99.mp4',
    // sourceDurSec, hasVideo, hasAudio, width, height all missing
  };
  const { assets: out } = await downloadBrollAssets(
    [{ startSec: 0, endSec: 4, asset_id: 'px-video-99' }],
    [minimal],
    '/tmp/unused',
  );
  assert.equal(out[0].sourceDurSec, 0);
  assert.equal(out[0].hasVideo, false);
  assert.equal(out[0].hasAudio, false);
  assert.equal(out[0].width, 0);
  assert.equal(out[0].height, 0);
});

test('downloadBrollAssets: throws when insertion references unknown asset_id', async () => {
  // Pre-PR-A behavior preserved: missing library row is still a hard error
  // (catches picker drift that could fail later more confusingly).
  await assert.rejects(
    () => downloadBrollAssets(
      [{ startSec: 0, endSec: 4, asset_id: 'px-video-missing' }],
      [],
      '/tmp/unused',
    ),
    /Insertion references unknown asset_id=px-video-missing/,
  );
});

// Note: the client-row branch (no `localPath`) is unchanged from pre-PR-A
// code. It's exercised by every M2 real-video B-run (B6 through B11), so we
// don't unit-test it here — would require mocking axios + ffprobe + the
// streaming pipeline, with marginal value over the integration verification.

// ── PR-E: heicConvert return field (no HEIC = zeros, no failures) ──────

test('downloadBrollAssets: PR-E — heicConvert stats are zero when no HEIC rows are picked', async () => {
  const stockRow = {
    asset_id: 'px-video-1', file_url: 'https://x', storage_url: null,
    provenance: 'pixabay', localPath: '/tmp/x/1.mp4',
    sourceDurSec: 5, hasVideo: true, hasAudio: false, width: 1280, height: 720,
  };
  const result = await downloadBrollAssets(
    [{ startSec: 0, endSec: 5, asset_id: 'px-video-1' }],
    [stockRow],
    '/tmp/unused',
  );
  assert.ok(result.heicConvert);
  assert.equal(result.heicConvert.attempted, 0);
  assert.equal(result.heicConvert.converted, 0);
  assert.equal(result.heicConvert.failed, 0);
  assert.equal(result.heicConvert.ms, 0);
  assert.deepEqual(result.heicConvert.failures, []);
});

test('downloadBrollAssets: PR-E — return shape includes both `assets` and `heicConvert`', async () => {
  // Lock the new shape so a future refactor doesn't accidentally drop the
  // heicConvert field.
  const result = await downloadBrollAssets([], [], '/tmp/unused');
  assert.ok(Array.isArray(result.assets));
  assert.ok(result.heicConvert);
  assert.equal(typeof result.heicConvert.attempted, 'number');
  assert.equal(typeof result.heicConvert.converted, 'number');
  assert.equal(typeof result.heicConvert.failed, 'number');
  assert.ok(Array.isArray(result.heicConvert.failures));
});

// Note: the actual conversion path (client-row branch + HEIC conversion via
// heic-convert) is integration-tested by Phil's Railway rerun — mocking it
// here would require also mocking axios stream + writeFile + ffprobe, which
// duplicates the M2 B-run verification with marginal value.
// `lib/heic_to_jpg.js` itself has direct unit coverage in
// test/heic_to_jpg.test.js (12 cases including injectable convertImpl).
