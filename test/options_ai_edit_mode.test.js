/**
 * test/options_ai_edit_mode.test.js
 *
 * Route-level validation for options.aiEditMode on /clean-mode-compose.
 * Mirrors the direct-handler pattern from options_broll_steering.test.js —
 * fake req/res, no http server, no Supabase.
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

// ── reject invalid enum values ────────────────────────────────────────

test('route: rejects aiEditMode unknown string', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { aiEditMode: 'clean_talking_head' } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /aiEditMode must be 'subtitles_hook_only' or 'hook_subtitles_broll'/);
});

test('route: rejects aiEditMode non-string (number)', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { aiEditMode: 1 } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /aiEditMode must be/);
});

test('route: rejects aiEditMode empty string', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { aiEditMode: '' } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
});

// ── accept the two valid values + undefined ───────────────────────────

test('route: accepts aiEditMode = "subtitles_hook_only"', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { aiEditMode: 'subtitles_hook_only' } } };
  const res = fakeRes();
  await handler(req, res);
  if (res._status === 400) {
    assert.doesNotMatch(res._body.error ?? '', /aiEditMode/);
  }
});

test('route: accepts aiEditMode = "hook_subtitles_broll"', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { aiEditMode: 'hook_subtitles_broll' } } };
  const res = fakeRes();
  await handler(req, res);
  if (res._status === 400) {
    assert.doesNotMatch(res._body.error ?? '', /aiEditMode/);
  }
});

test('route: aiEditMode omitted does NOT 400 on aiEditMode (backward-compat — pre-existing callers)', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: {} } };
  const res = fakeRes();
  await handler(req, res);
  if (res._status === 400) {
    assert.doesNotMatch(res._body.error ?? '', /aiEditMode/);
  }
});
