/**
 * test/broll_filter.test.js
 *
 * Pure-function tests for filterUnsupportedBrollAssets — the URL-class
 * classifier for broll library rows.
 *
 * History:
 *   PR #110 (2026-05-08): filter HARD-DROPPED HEIC/HEIF rows so the picker
 *     never saw them. Phil's mixed .mov + .heic library was the trigger.
 *   PR-E (2026-05-09): flipped to TAG-AND-PASS-THROUGH. HEIC rows now get
 *     `needsHeicConversion: true` and reach the picker; the orchestrator
 *     converts them at brollDownload via lib/heic_to_jpg.js.
 *
 * These tests lock the new contract: HEIC rows are kept (not dropped),
 * tagged for conversion, and the legacy `droppedHeicCount` field stays in
 * the return shape (always 0) for callers that haven't migrated yet.
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

test('filter: empty input → empty output, no warnings, zero counts', () => {
  const out = filterUnsupportedBrollAssets([]);
  assert.deepEqual(out.rows, []);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.droppedHeicCount, 0);
  assert.equal(out.convertibleHeicCount, 0);
});

test('filter: all supported (.mov, .mp4, .jpg, .png) → pass through unchanged, no needsHeicConversion tag', () => {
  const rows = [
    row({ asset_id: 'a', storage_url: 'https://x.supabase.co/storage/v1/object/public/x/clip.mov' }),
    row({ asset_id: 'b', storage_url: 'https://x.supabase.co/storage/v1/object/public/x/photo.jpg' }),
    row({ asset_id: 'c', storage_url: 'https://x.supabase.co/storage/v1/object/public/x/video.mp4' }),
    row({ asset_id: 'd', storage_url: 'https://x.supabase.co/storage/v1/object/public/x/icon.png' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 4);
  assert.deepEqual(out.rows.map((r) => r.asset_id), ['a', 'b', 'c', 'd']);
  for (const r of out.rows) {
    assert.notEqual(r.needsHeicConversion, true, `${r.asset_id} should not be tagged`);
  }
  assert.equal(out.droppedHeicCount, 0);
  assert.equal(out.convertibleHeicCount, 0);
});

// ── HEIC/HEIF tagging (PR-E new contract) ─────────────────────────────

test('filter: PR-E — keeps .heic asset and tags it needsHeicConversion=true', () => {
  const rows = [
    row({ asset_id: 'mov1', storage_url: 'https://x.supabase.co/x/clip.mov' }),
    row({ asset_id: 'heic1', storage_url: 'https://x.supabase.co/x/photo.heic' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 2);
  const heicRow = out.rows.find((r) => r.asset_id === 'heic1');
  assert.ok(heicRow);
  assert.equal(heicRow.needsHeicConversion, true);
  const movRow = out.rows.find((r) => r.asset_id === 'mov1');
  assert.notEqual(movRow.needsHeicConversion, true);
  assert.equal(out.convertibleHeicCount, 1);
  // backward-compat: dropped count stays 0 (no pre-drop anymore)
  assert.equal(out.droppedHeicCount, 0);
  // and the legacy "Skipped N HEIC..." warning is no longer emitted by this layer
  assert.deepEqual(out.warnings, []);
});

test('filter: PR-E — keeps .heif asset (alternate extension)', () => {
  const rows = [
    row({ asset_id: 'heif1', storage_url: 'https://x.supabase.co/x/photo.heif' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].needsHeicConversion, true);
  assert.equal(out.convertibleHeicCount, 1);
});

test('filter: PR-E — case-insensitive (.HEIC, .Heic, .HEIF all tagged)', () => {
  const rows = [
    row({ asset_id: 'a', storage_url: 'https://x/photo.HEIC' }),
    row({ asset_id: 'b', storage_url: 'https://x/photo.Heic' }),
    row({ asset_id: 'c', storage_url: 'https://x/photo.HEIF' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 3);
  assert.equal(out.rows.every((r) => r.needsHeicConversion === true), true);
  assert.equal(out.convertibleHeicCount, 3);
});

// ── URL resolution order (file_url first, then storage_url) ────────────

test('filter: prefers file_url over storage_url for class detection', () => {
  // Mirrors `file_url ?? storage_url` resolve order in downloadBrollAssets.
  // If file_url is .mov but storage_url is .heic, the row is treated as a video.
  const rows = [
    row({ asset_id: 'a', file_url: 'https://x/clip.mov', storage_url: 'https://x/preview.heic' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 1, 'file_url is .mov so the row should pass without conversion tag');
  assert.notEqual(out.rows[0].needsHeicConversion, true);
  assert.equal(out.convertibleHeicCount, 0);
});

test('filter: file_url=null falls back to storage_url for class detection', () => {
  const rows = [
    row({ asset_id: 'a', file_url: null, storage_url: 'https://x/photo.heic' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].needsHeicConversion, true);
  assert.equal(out.convertibleHeicCount, 1);
});

// ── edge cases ─────────────────────────────────────────────────────────

test('filter: extension followed by query string still tagged (.heic?token=...)', () => {
  // Signed Supabase URLs append ?token=... — make sure we catch the class
  // before the query string.
  const rows = [
    row({ storage_url: 'https://x/photo.heic?token=abc&signature=xyz' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].needsHeicConversion, true);
  assert.equal(out.convertibleHeicCount, 1);
});

test('filter: heic appearing mid-path (NOT as extension) does NOT trigger conversion tag', () => {
  // `heic_demo` in a folder name shouldn't accidentally tag a valid .mp4.
  const rows = [
    row({ asset_id: 'safe', storage_url: 'https://x/uploads/heic_demo/clip.mp4' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].asset_id, 'safe');
  assert.notEqual(out.rows[0].needsHeicConversion, true);
  assert.equal(out.convertibleHeicCount, 0);
});

test('filter: row with no URLs at all passes through unchanged', () => {
  // The "no URL" filter is upstream in fetchBrollLibrary — this helper's
  // job is ONLY URL-class classification. Don't double-filter no-URL rows here;
  // they'd have been dropped earlier.
  const rows = [
    row({ asset_id: 'no-url', file_url: null, storage_url: null }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].asset_id, 'no-url');
  assert.notEqual(out.rows[0].needsHeicConversion, true);
});

test('filter: preserves input row order (mixed .mov and .heic)', () => {
  const rows = [
    row({ asset_id: '1', storage_url: 'https://x/a.mov' }),
    row({ asset_id: '2', storage_url: 'https://x/b.heic' }),     // tagged
    row({ asset_id: '3', storage_url: 'https://x/c.mp4' }),
    row({ asset_id: '4', storage_url: 'https://x/d.heif' }),     // tagged
    row({ asset_id: '5', storage_url: 'https://x/e.jpg' }),
  ];
  const out = filterUnsupportedBrollAssets(rows);
  // PR-E: ALL rows kept now, in original order.
  assert.deepEqual(out.rows.map((r) => r.asset_id), ['1', '2', '3', '4', '5']);
  assert.equal(out.convertibleHeicCount, 2);
  assert.equal(out.rows.find((r) => r.asset_id === '2').needsHeicConversion, true);
  assert.equal(out.rows.find((r) => r.asset_id === '4').needsHeicConversion, true);
  assert.notEqual(out.rows.find((r) => r.asset_id === '1').needsHeicConversion, true);
});

test('filter: defensive — non-array input returns empty + zero counts', () => {
  const empty = { rows: [], warnings: [], droppedHeicCount: 0, convertibleHeicCount: 0 };
  assert.deepEqual(filterUnsupportedBrollAssets(null), empty);
  assert.deepEqual(filterUnsupportedBrollAssets(undefined), empty);
  assert.deepEqual(filterUnsupportedBrollAssets({}), empty);
});
