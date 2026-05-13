/**
 * test/options_broll_duration.test.js
 *
 * PR-K: per-job b-roll insertion duration controls.
 *
 * Locks down route-level validation of options.brollMinDurationSec,
 * brollTargetDurationSec, and brollMaxDurationSec — both the range check
 * (each must be a finite number in (0, 30]) and the consistency contract
 * (min <= target <= max). Mirrors the test pattern in
 * options_per_job_ratios.test.js (PR #129).
 *
 * The downstream behavior (picker prompt substitution + normalize floor
 * drop) is covered by broll_picker_prompt.test.js and
 * normalize_insertions.test.js. This file is about the route gate.
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

// ── Range checks ─────────────────────────────────────────────────────

test('route: rejects brollMinDurationSec <= 0', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { brollMinDurationSec: 0 } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /brollMinDurationSec must be a number in \(0, 30\]/);
});

test('route: rejects brollMinDurationSec > 30', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { brollMinDurationSec: 31 } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /brollMinDurationSec/);
});

test('route: rejects brollMinDurationSec non-number', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { brollMinDurationSec: 'long' } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /brollMinDurationSec/);
});

test('route: rejects brollMaxDurationSec <= 0', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { brollMaxDurationSec: -1 } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /brollMaxDurationSec/);
});

test('route: rejects brollMaxDurationSec > 30', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { brollMaxDurationSec: 31 } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
});

test('route: rejects brollTargetDurationSec NaN/Infinity', async () => {
  const handler = getHandler();
  // Infinity passes typeof 'number' but fails Number.isFinite — guard
  // against the JSON-roundtrip path where {target: 1e500} arrives as Infinity.
  const req = { body: { ...baseBody(), options: { brollTargetDurationSec: Infinity } } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
});

// ── Consistency: min <= target <= max ────────────────────────────────

test('route: rejects brollMinDurationSec > brollTargetDurationSec', async () => {
  const handler = getHandler();
  const req = { body: {
    ...baseBody(),
    options: { brollMinDurationSec: 7, brollTargetDurationSec: 6 },
  } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /brollMinDurationSec \(7\) must be <= options\.brollTargetDurationSec \(6\)/);
});

test('route: rejects brollTargetDurationSec > brollMaxDurationSec', async () => {
  const handler = getHandler();
  const req = { body: {
    ...baseBody(),
    options: { brollTargetDurationSec: 9, brollMaxDurationSec: 8 },
  } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /brollTargetDurationSec \(9\) must be <= options\.brollMaxDurationSec \(8\)/);
});

test('route: rejects brollMinDurationSec > brollMaxDurationSec (cross-check)', async () => {
  const handler = getHandler();
  // Skip target so only min vs max comparison fires.
  const req = { body: {
    ...baseBody(),
    options: { brollMinDurationSec: 10, brollMaxDurationSec: 5 },
  } };
  const res = fakeRes();
  await handler(req, res);
  assert.equal(res._status, 400);
  assert.match(res._body.error, /brollMinDurationSec \(10\) must be <= options\.brollMaxDurationSec \(5\)/);
});

// ── Accepting valid inputs ───────────────────────────────────────────

test('route: accepts the canonical PR-K override { min: 6, target: 7, max: 8 }', async () => {
  const handler = getHandler();
  const req = { body: {
    ...baseBody(),
    options: { brollMinDurationSec: 6, brollTargetDurationSec: 7, brollMaxDurationSec: 8 },
  } };
  const res = fakeRes();
  await handler(req, res);
  // Validation should pass. The run may fail at a later step (no real
  // Supabase creds in this test), but the 400 must NOT be about
  // brollMinDurationSec / brollTargetDurationSec / brollMaxDurationSec.
  if (res._status === 400) {
    assert.doesNotMatch(res._body.error ?? '', /broll(Min|Target|Max)DurationSec/);
  }
});

test('route: accepts boundary value { min: 0.001 } (just above the floor)', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { brollMinDurationSec: 0.001 } } };
  const res = fakeRes();
  await handler(req, res);
  if (res._status === 400) {
    assert.doesNotMatch(res._body.error ?? '', /brollMinDurationSec/);
  }
});

test('route: accepts boundary value { max: 30 } (inclusive upper bound)', async () => {
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { brollMaxDurationSec: 30 } } };
  const res = fakeRes();
  await handler(req, res);
  if (res._status === 400) {
    assert.doesNotMatch(res._body.error ?? '', /brollMaxDurationSec/);
  }
});

test('route: accepts omission of all three (defaults apply at use sites)', async () => {
  const handler = getHandler();
  const req = { body: baseBody() };       // options.broll*DurationSec all absent
  const res = fakeRes();
  await handler(req, res);
  if (res._status === 400) {
    assert.doesNotMatch(res._body.error ?? '', /broll(Min|Target|Max)DurationSec/);
  }
});

test('route: partial spec — only target provided, omits min and max — accepted', async () => {
  // Operators should be able to nudge the target without rewriting all
  // three bounds. The consistency check only fires for adjacent pairs
  // that are BOTH provided; standalone target is fine.
  const handler = getHandler();
  const req = { body: { ...baseBody(), options: { brollTargetDurationSec: 7.5 } } };
  const res = fakeRes();
  await handler(req, res);
  if (res._status === 400) {
    assert.doesNotMatch(res._body.error ?? '', /broll(Min|Target|Max)DurationSec/);
  }
});

test('route: equal-bound case { min: 7, target: 7, max: 7 } — accepted (boundary)', async () => {
  // Edge: a caller could lock all three to the same value to enforce
  // a uniform 7s duration. Each comparison uses <=, so equality passes.
  const handler = getHandler();
  const req = { body: {
    ...baseBody(),
    options: { brollMinDurationSec: 7, brollTargetDurationSec: 7, brollMaxDurationSec: 7 },
  } };
  const res = fakeRes();
  await handler(req, res);
  if (res._status === 400) {
    assert.doesNotMatch(res._body.error ?? '', /broll(Min|Target|Max)DurationSec/);
  }
});
