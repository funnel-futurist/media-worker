/**
 * test/options_classify_route.test.js
 *
 * Route-level validation for /clean-mode-classify. Mirrors the
 * direct-handler pattern from options_broll_steering.test.js — we call
 * the bound express handler with a fake req/res and assert ONLY the
 * validation branch (no http server, no Supabase, no Deepgram).
 *
 * For passing-validation cases we expect the handler to fall through
 * into the pipeline call, which will then fail (no env, no fixture).
 * The asserts only care that the 400/error string is NOT about the
 * field we're testing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanModeClassifyRouter } from '../routes/clean-mode-classify.js';

function fakeRes() {
  const res = { _status: 200, _body: null };
  res.status = (n) => { res._status = n; return res; };
  res.json = (body) => { res._body = body; return res; };
  return res;
}

function getHandler() {
  const layer = cleanModeClassifyRouter.stack.find(
    (l) => l.route && l.route.path === '/clean-mode-classify',
  );
  return layer.route.stack[0].handle;
}

function baseBody() {
  return {
    jobId: 'test-classify-validate',
    sourceMP4: { bucket: 'x', path: 'y' },
    clientId: 'c',
    options: {},
  };
}

// ── Required body shape ───────────────────────────────────────────────

test('classify route: missing jobId → 400', async () => {
  const handler = getHandler();
  const res = fakeRes();
  await handler({ body: {} }, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /jobId/);
});

test('classify route: missing sourceMP4 → 400', async () => {
  const handler = getHandler();
  const res = fakeRes();
  await handler({ body: { jobId: 'j' } }, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /sourceMP4/);
});

test('classify route: missing clientId → 400', async () => {
  const handler = getHandler();
  const res = fakeRes();
  await handler({ body: { jobId: 'j', sourceMP4: { bucket: 'b', path: 'p' } } }, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /clientId/);
});

// ── cutSafetyMode ─────────────────────────────────────────────────────

test('classify route: rejects cutSafetyMode unknown enum', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { cutSafetyMode: 'aggressive' } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /cutSafetyMode/);
});

test('classify route: accepts each valid cutSafetyMode', async () => {
  const handler = getHandler();
  for (const v of ['safe_only', 'safe_and_soft', 'all']) {
    const req = { body: { ...baseBody(), options: { cutSafetyMode: v } } };
    const res = fakeRes();
    await handler(req, res);
    if (res._status === 400) {
      assert.doesNotMatch(res._body.error ?? '', /cutSafetyMode/, `${v} should pass validation`);
    }
  }
});

// ── retainSec ─────────────────────────────────────────────────────────

test('classify route: rejects retainSec out of (0, 1]', async () => {
  const handler = getHandler();
  for (const v of [0, -0.1, 1.01, '0.25']) {
    const req = { body: { ...baseBody(), options: { retainSec: v } } };
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res._status, 400, `retainSec=${v} should 400`);
    assert.match(res._body.error, /retainSec/);
  }
});

// ── slateHint ─────────────────────────────────────────────────────────

test('classify route: rejects slateHint over 200 chars', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { slateHint: 'x'.repeat(201) } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /slateHint/);
});

// ── skipSlate ─────────────────────────────────────────────────────────

test('classify route: rejects non-boolean skipSlate', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { skipSlate: 'yes' } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /skipSlate/);
});

// ── deepgramKeywords ──────────────────────────────────────────────────

test('classify route: rejects non-array deepgramKeywords', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { deepgramKeywords: 'term' } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /deepgramKeywords/);
});

// ── Body with valid options falls through to pipeline ─────────────────

test('classify route: a fully-valid options body does NOT 400 on options-validation', async () => {
  const handler = getHandler();
  const req = {
    body: {
      ...baseBody(),
      options: {
        cutSafetyMode: 'safe_and_soft',
        retainSec: 0.25,
        silenceNoiseDb: -30,
        silenceMinDur: 0.4,
        slateHint: 'June 14 reel',
        skipSlate: false,
        deepgramKeywords: ['special needs', 'wondered'],
        // unrelated fields the dry-run should ignore
        pixabayEnabled: true,
        bannerEnabled: true,
      },
    },
  };
  const res = fakeRes();
  await handler(req, res);
  // The handler will fail when it tries to actually run the pipeline
  // (no Supabase, no Deepgram in this test env), but if that fails it's
  // 500 / step='pipeline', NOT 400 / step='validate'.
  if (res._status === 400) {
    assert.notEqual(res._body.step, 'validate', 'validation must not reject this body');
  }
});
