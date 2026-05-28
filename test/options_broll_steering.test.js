/**
 * test/options_broll_steering.test.js
 *
 * Tier 1 (2026-05-27): route-level validation for the two new steering
 * options on /clean-mode-compose:
 *   - options.contentContext        (string ≤ 2000 chars)
 *   - options.brollExcludeAssetIds  (array of non-empty strings)
 *
 * Mirrors the direct-handler pattern from options_per_job_ratios.test.js —
 * we call the bound express handler with a fake req/res and assert only the
 * validation branch (no http server, no Supabase).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanModeComposeRouter } from '../routes/clean-mode-compose.js';

function fakeRes() {
  const res = { _status: 200, _body: null };
  res.status = (n) => { res._status = n; return res; };
  res.json = (body) => { res._body = body; return res; };
  return res;
}

function getHandler() {
  const layer = cleanModeComposeRouter.stack.find(
    (l) => l.route && l.route.path === '/clean-mode-compose',
  );
  return layer.route.stack[0].handle;
}

function baseBody() {
  return {
    jobId: 'test-validate',
    sourceMP4: { bucket: 'x', path: 'y' },
    clientId: 'c',
    output: { bucket: 'x', pathPrefix: 'p/' },
    options: {},
  };
}

// ── contentContext ────────────────────────────────────────────────────

test('route: rejects contentContext non-string', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { contentContext: 123 } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /contentContext must be a string/);
});

test('route: rejects contentContext over 2000 chars', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { contentContext: 'x'.repeat(2001) } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /contentContext must be a string/);
});

test('route: a valid contentContext string does NOT 400 on contentContext', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { contentContext: 'EnableSNP family-planning; prefer warm human visuals.' } } };
  const res = fakeRes();
  await handler(req, res);
  if (res._status === 400) {
    assert.doesNotMatch(res._body.error ?? '', /contentContext/);
  }
});

// ── brollExcludeAssetIds ──────────────────────────────────────────────

test('route: rejects brollExcludeAssetIds non-array', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { brollExcludeAssetIds: 'abc-123' } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /brollExcludeAssetIds must be an array/);
});

test('route: rejects brollExcludeAssetIds with a non-string / empty entry', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { brollExcludeAssetIds: ['ok-id', ''] } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /brollExcludeAssetIds must be an array/);
});

test('route: a valid brollExcludeAssetIds array does NOT 400 on brollExcludeAssetIds', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { brollExcludeAssetIds: ['abc-123-uuid'] } } };
  const res = fakeRes();
  await handler(req, res);
  if (res._status === 400) {
    assert.doesNotMatch(res._body.error ?? '', /brollExcludeAssetIds/);
  }
});

// ── Tier 2-a: pexelsEnabled + pexelsMaxClips ──────────────────────────

test('Tier2a route: rejects pexelsEnabled non-boolean', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { pexelsEnabled: 'yes' } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /pexelsEnabled must be a boolean/);
});

test('Tier2a route: accepts pexelsEnabled true and false', async () => {
  const handler = getHandler();
  for (const v of [true, false]) {
    const req = { body: { ...baseBody(), options: { pexelsEnabled: v } } };
    const res = fakeRes();
    await handler(req, res);
    if (res._status === 400) {
      assert.doesNotMatch(res._body.error ?? '', /pexelsEnabled/);
    }
  }
});

test('Tier2a route: rejects pexelsMaxClips non-integer', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { pexelsMaxClips: 3.5 } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /pexelsMaxClips must be an integer/);
});

test('Tier2a route: rejects pexelsMaxClips ≤ 0', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { pexelsMaxClips: 0 } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /pexelsMaxClips must be an integer/);
});

test('Tier2a route: rejects pexelsMaxClips > 50', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { pexelsMaxClips: 51 } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /pexelsMaxClips must be an integer/);
});

test('Tier2a route: accepts pexelsMaxClips in valid range (1..50)', async () => {
  const handler = getHandler();
  for (const v of [1, 6, 50]) {
    const req = { body: { ...baseBody(), options: { pexelsMaxClips: v } } };
    const res = fakeRes();
    await handler(req, res);
    if (res._status === 400) {
      assert.doesNotMatch(res._body.error ?? '', /pexelsMaxClips/);
    }
  }
});
