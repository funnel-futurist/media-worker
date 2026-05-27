/**
 * test/broll_diagnostics.test.js
 *
 * Pure-function tests for formatInsertionDiagnostics — the per-insertion
 * diagnostic log that maps a timestamp to an asset_id + Gemini rationale so
 * client feedback ("the b-roll at 0:57 is wrong") is actionable without
 * rewatching. No I/O.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatInsertionDiagnostics } from '../lib/broll_diagnostics.js';

const SAMPLE = [
  {
    startSec: 10.0, endSec: 15.0, asset_id: 'px-video-123', provenance: 'pixabay',
    assetTitle: 'Pixabay stock: forest, trees', match_type: 'emotional',
    visual_concept: 'forest path', url: 'https://cdn.pixabay.com/x.mp4',
    reason: 'Calm forest reinforces the relaxed tone of waking up rested.',
    matchedPhrase: 'waking up rested',
  },
  {
    startSec: 57.5, endSec: 62.0, asset_id: 'abc-123-uuid', provenance: 'client',
    assetTitle: 'Family at the beach', match_type: 'direct',
    visual_concept: 'family beach', url: 'https://storage/family.mov',
    reason: 'Client family footage matches the present-with-kids beat.',
    matchedPhrase: 'taking your kids to the park on a Saturday',
  },
];

test('formatInsertionDiagnostics: returns one row + one line per insertion, order preserved', () => {
  const { rows, lines } = formatInsertionDiagnostics(SAMPLE);
  assert.equal(rows.length, 2);
  assert.equal(lines.length, 2);
  assert.equal(rows[0].idx, 1);
  assert.equal(rows[1].idx, 2);
  assert.equal(rows[0].assetId, 'px-video-123');
  assert.equal(rows[1].assetId, 'abc-123-uuid');
});

test('formatInsertionDiagnostics: maps provenance pixabay→stock, client→client', () => {
  const { rows } = formatInsertionDiagnostics(SAMPLE);
  assert.equal(rows[0].source, 'stock');
  assert.equal(rows[1].source, 'client');
});

test('formatInsertionDiagnostics: log line carries timestamp, source, id, url, reason, phrase', () => {
  const { lines } = formatInsertionDiagnostics(SAMPLE);
  const l0 = lines[0];
  assert.match(l0, /#1/);
  assert.match(l0, /t=10\.00–15\.00/);
  assert.match(l0, /src=stock/);
  assert.match(l0, /id=px-video-123/);
  assert.match(l0, /url=https:\/\/cdn\.pixabay\.com\/x\.mp4/);
  assert.match(l0, /reason="Calm forest/);
  assert.match(l0, /phrase="waking up rested"/);
  assert.match(l0, /match=emotional/);
  // The client pick at ~0:57 — the one Chelsea flagged — is identifiable by id.
  assert.match(lines[1], /id=abc-123-uuid/);
  assert.match(lines[1], /src=client/);
});

test('formatInsertionDiagnostics: each line is single-line (no embedded newlines)', () => {
  const multiline = [{
    startSec: 1, endSec: 2, asset_id: 'x', provenance: 'client',
    reason: 'line one\nline two\nline three', matchedPhrase: 'a\nb',
  }];
  const { lines } = formatInsertionDiagnostics(multiline);
  assert.equal(lines[0].includes('\n'), false);
});

test('formatInsertionDiagnostics: tolerates missing fields with safe fallbacks', () => {
  const { rows, lines } = formatInsertionDiagnostics([{ asset_id: 'only-id' }]);
  assert.equal(rows[0].source, 'client'); // default when provenance missing
  assert.equal(rows[0].startSec, null);
  assert.match(lines[0], /t=\?–\?/);
  assert.match(lines[0], /\(no title\)/);
  assert.match(lines[0], /match=\?/);
});

test('formatInsertionDiagnostics: empty / non-array input → empty result', () => {
  assert.deepEqual(formatInsertionDiagnostics([]), { rows: [], lines: [] });
  assert.deepEqual(formatInsertionDiagnostics(undefined), { rows: [], lines: [] });
  assert.deepEqual(formatInsertionDiagnostics(null), { rows: [], lines: [] });
});
