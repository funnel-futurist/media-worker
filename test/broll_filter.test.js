/**
 * test/broll_filter.test.js
 *
 * Pure-function tests for filterUnsupportedBrollAssets — the URL-class
 * filter that drops HEIC/HEIF assets from the broll library before the
 * picker sees them. PR #110 short-term unblock for Phil/Chelsea & Phil's
 * mixed `.mov` + `.heic` library.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { filterUnsupportedBrollAssets } from '../lib/broll_filter.js';

// Helper: minimal row shape — we only care about file_url + storage_url
function row(opts = {}) {
  return {
    asset_id: opts.asset_id ?? 'aid-' + Math.random().toString(36).slice(2, 8),
    file_url: opts.file_url ?? null,
    storage_url: opts.storage_url ?? null,
    ...opts,
  };
}

// ── happy path ─────────────────────────────────────────────────────────

test('filter: empty input → empty output, no warnings', () => {
  const out = filterUnsupportedBrollAssets([]);
  assert.deepEqual(out.rows, []);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.droppedHeicCount, 0);
});

test('filter: all supported (.mov, .mp4, .jpg, .png) → pass through unchanged', () => {
  const rows = [
    row({ asset_id: 'a', storage_url: 'https://x.supabase.co/storage/v1/object/public/x/clip.mov' }),
    row({ asset_id: 'b', storage_url: 'https://x.supabase.co/storage/v1/object/public/x/photo.jpg' }),
    row({ asset_id: 'c', storage_url: 'https://x.supabase.co/storage/v1/object/public/x/video.mp4' }),
    row({ asset_id: 'd', storage_url: 'https://x.supabase.co/storage/v1/object/public/x/icon.png' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 4);
  assert.deepEqual(out.rows.map((r) => r.asset_id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.droppedHeicCount, 0);
});

// ── HEIC/HEIF dropping ─────────────────────────────────────────────────

test('filter: drops .heic asset, surfaces warning with count', () => {
  const rows = [
    row({ asset_id: 'mov1', storage_url: 'https://x.supabase.co/x/clip.mov' }),
    row({ asset_id: 'heic1', storage_url: 'https://x.supabase.co/x/photo.heic' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].asset_id, 'mov1');
  assert.equal(out.droppedHeicCount, 1);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /Skipped 1 HEIC\/HEIF broll asset\b/);
  assert.match(out.warnings[0], /image conversion is not supported yet/);
});

test('filter: drops .heif asset (alternate extension)', () => {
  const rows = [
    row({ asset_id: 'heif1', storage_url: 'https://x.supabase.co/x/photo.heif' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 0);
  assert.equal(out.droppedHeicCount, 1);
});

test('filter: case-insensitive (.HEIC, .Heic, .HEIF all match)', () => {
  const rows = [
    row({ asset_id: 'a', storage_url: 'https://x/photo.HEIC' }),
    row({ asset_id: 'b', storage_url: 'https://x/photo.Heic' }),
    row({ asset_id: 'c', storage_url: 'https://x/photo.HEIF' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 0);
  assert.equal(out.droppedHeicCount, 3);
});

test('filter: warning text uses singular for 1, plural for >1', () => {
  // Only the COUNT-context word should change between singular/plural —
  // the rest of the warning text (which legitimately mentions "assets are
  // processed") stays the same. Anchor regex to the count phrase only.
  const oneHeic = filterUnsupportedBrollAssets([
    row({ storage_url: 'https://x/a.heic' }),
  ]);
  assert.match(oneHeic.warnings[0], /Skipped 1 HEIC\/HEIF broll asset because/);

  const multipleHeic = filterUnsupportedBrollAssets([
    row({ storage_url: 'https://x/a.heic' }),
    row({ storage_url: 'https://x/b.heic' }),
    row({ storage_url: 'https://x/c.heif' }),
  ]);
  assert.match(multipleHeic.warnings[0], /Skipped 3 HEIC\/HEIF broll assets because/);
});

// ── URL resolution order (file_url first, then storage_url) ────────────

test('filter: prefers file_url over storage_url for class detection', () => {
  // Mirrors `file_url ?? storage_url` resolve order in downloadBrollAssets.
  // If file_url is .mov but storage_url is .heic, the row is supported.
  const rows = [
    row({ asset_id: 'a', file_url: 'https://x/clip.mov', storage_url: 'https://x/preview.heic' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 1, 'file_url is .mov so the row should pass');
  assert.equal(out.droppedHeicCount, 0);
});

test('filter: file_url=null falls back to storage_url for class detection', () => {
  const rows = [
    row({ asset_id: 'a', file_url: null, storage_url: 'https://x/photo.heic' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 0);
  assert.equal(out.droppedHeicCount, 1);
});

// ── edge cases ─────────────────────────────────────────────────────────

test('filter: extension followed by query string still matches (.heic?token=...)', () => {
  // Signed Supabase URLs append ?token=... — make sure we catch the class
  // before the query string.
  const rows = [
    row({ storage_url: 'https://x/photo.heic?token=abc&signature=xyz' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 0);
  assert.equal(out.droppedHeicCount, 1);
});

test('filter: heic appearing mid-path (NOT as extension) does NOT trigger drop', () => {
  // `heic_demo` in a folder name shouldn't accidentally drop a valid .mp4.
  const rows = [
    row({ asset_id: 'safe', storage_url: 'https://x/uploads/heic_demo/clip.mp4' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].asset_id, 'safe');
  assert.equal(out.droppedHeicCount, 0);
});

test('filter: row with no URLs at all passes through unchanged', () => {
  // The "no URL" filter is upstream in fetchBrollLibrary — this helper's
  // job is ONLY URL-class filtering. Don't double-filter no-URL rows here;
  // they'd have been dropped earlier.
  const rows = [
    row({ asset_id: 'no-url', file_url: null, storage_url: null }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].asset_id, 'no-url');
});

test('filter: preserves input row order', () => {
  const rows = [
    row({ asset_id: '1', storage_url: 'https://x/a.mov' }),
    row({ asset_id: '2', storage_url: 'https://x/b.heic' }),     // dropped
    row({ asset_id: '3', storage_url: 'https://x/c.mp4' }),
    row({ asset_id: '4', storage_url: 'https://x/d.heif' }),     // dropped
    row({ asset_id: '5', storage_url: 'https://x/e.jpg' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.deepEqual(out.rows.map((r) => r.asset_id), ['1', '3', '5']);
  assert.equal(out.droppedHeicCount, 2);
});

test('filter: defensive — non-array input returns empty', () => {
  assert.deepEqual(filterUnsupportedBrollAssets(null), { rows: [], warnings: [], droppedHeicCount: 0 });
  assert.deepEqual(filterUnsupportedBrollAssets(undefined), { rows: [], warnings: [], droppedHeicCount: 0 });
  assert.deepEqual(filterUnsupportedBrollAssets({}), { rows: [], warnings: [], droppedHeicCount: 0 });
});
