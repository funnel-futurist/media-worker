/**
 * test/portal_webhook.test.js
 *
 * Pure-function + injectable-fetch tests for the PR-I portal callback
 * helper. Validates the HMAC signature shape + retry semantics + envelope
 * builders.
 *
 * The mocked-fetch pattern matches lib/bgm_select.js / lib/jamendo_music.js —
 * tests stay offline and deterministic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import {
  signCallback,
  postEditCompleteToPortal,
  buildSuccessEnvelope,
  buildFailureEnvelope,
} from '../lib/portal_webhook.js';

const SECRET = 'test-shared-secret';
const URL = 'https://portal.example/api/webhooks/edit-complete';

function expectedSig(body) {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

// ── signCallback ────────────────────────────────────────────────────

test('signCallback: produces a stable HMAC-SHA256 hex over the raw body', () => {
  const body = '{"jobId":"abc"}';
  assert.equal(signCallback(body, SECRET), expectedSig(body));
});

test('signCallback: different body → different signature', () => {
  const a = signCallback('{"jobId":"a"}', SECRET);
  const b = signCallback('{"jobId":"b"}', SECRET);
  assert.notEqual(a, b);
});

// ── postEditCompleteToPortal happy path ─────────────────────────────

test('postEditCompleteToPortal: signs body + POSTs with x-worker-signature', async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, async text() { return ''; } };
  };
  const payload = { jobId: 'job-1', status: 'success', result: {} };
  const out = await postEditCompleteToPortal({
    callbackUrl: URL,
    callbackSecret: SECRET,
    payload,
    fetchImpl: fakeFetch,
  });
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 1);
  assert.equal(captured.url, URL);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['content-type'], 'application/json');
  // Signature is over the exact body we send.
  assert.equal(captured.init.headers['x-worker-signature'], expectedSig(captured.init.body));
  // Body deserializes back to the payload.
  assert.deepEqual(JSON.parse(captured.init.body), payload);
});

// ── postEditCompleteToPortal retry semantics ───────────────────────

test('postEditCompleteToPortal: retries once on 5xx', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503, async text() { return 'unavailable'; } };
    return { ok: true, status: 200, async text() { return ''; } };
  };
  const out = await postEditCompleteToPortal({
    callbackUrl: URL,
    callbackSecret: SECRET,
    payload: { jobId: 'j', status: 'success', result: {} },
    fetchImpl: fakeFetch,
    timeoutMs: 1000,
  });
  assert.equal(calls, 2);
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
});

test('postEditCompleteToPortal: DOES NOT retry on 4xx (auth / bad payload — non-retryable)', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return { ok: false, status: 401, async text() { return 'unauth'; } };
  };
  const out = await postEditCompleteToPortal({
    callbackUrl: URL,
    callbackSecret: SECRET,
    payload: { jobId: 'j', status: 'success', result: {} },
    fetchImpl: fakeFetch,
  });
  assert.equal(calls, 1);
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
  assert.equal(out.attempts, 1);
  assert.match(out.error ?? '', /portal_401/);
});

test('postEditCompleteToPortal: retries once on network throw, surfaces last error', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    throw new Error('ENOTFOUND portal.example');
  };
  const out = await postEditCompleteToPortal({
    callbackUrl: URL,
    callbackSecret: SECRET,
    payload: { jobId: 'j', status: 'failed', error: { message: 'x' } },
    fetchImpl: fakeFetch,
    timeoutMs: 200,
  });
  assert.equal(calls, 2);
  assert.equal(out.ok, false);
  assert.equal(out.attempts, 2);
  assert.match(out.error ?? '', /ENOTFOUND/);
});

// ── input validation ────────────────────────────────────────────────

test('postEditCompleteToPortal: rejects missing callbackUrl', async () => {
  const out = await postEditCompleteToPortal({
    callbackSecret: SECRET,
    payload: { jobId: 'j', status: 'success', result: {} },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /missing callbackUrl/);
});

test('postEditCompleteToPortal: rejects missing callbackSecret', async () => {
  const out = await postEditCompleteToPortal({
    callbackUrl: URL,
    payload: { jobId: 'j', status: 'success', result: {} },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(out.ok, false);
});

test('postEditCompleteToPortal: rejects null payload', async () => {
  const out = await postEditCompleteToPortal({
    callbackUrl: URL,
    callbackSecret: SECRET,
    payload: null,
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /payload must be an object/);
});

// ── buildSuccessEnvelope ────────────────────────────────────────────

test('buildSuccessEnvelope: shapes a clean envelope from a full pipeline result', () => {
  const pipelineResult = {
    finalStorage: { bucket: 'client-uploads', path: 'phil/edited/abc.mp4' },
    durationSec: 78.654,
    processingMs: 150_321,
    insertions: {
      count: 6, clientCount: 4, stockCount: 2,
      clientLibraryRawCount: 13, clientLibraryUsableCount: 13,
      clientLibrarySkipped: { heic: 0, noUrl: 0 },
      pixabayCandidateCount: 4,
      sourceBalance: { mode: 'ai_blend', mixMet: true, mixReason: 'both_sources_represented' },
      stockKeywords: ['calendar', 'desk'],
    },
    steps: {
      heicConvert: { attempted: 0, converted: 0, failed: 0, ms: 0 },
      bgmSelect: { ms: 7000 },
      bgmFetch: { ms: 9000 },
      bgmMix: { ms: 3900 },
      brollPick: { ms: 32_000 },               // should NOT make it into the trimmed envelope
    },
    audio: {
      bgm: {
        applied: true,
        skipReason: null,
        track: { source: 'jamendo', name: 'Lovely', artistName: 'Tryad' },
        mix: { speechLufs: -70, musicLufsRaw: -70 },   // should NOT make it (raw mix details kept out)
      },
    },
    attribution: { required: true, entries: [{ kind: 'bgm', source: 'jamendo', text: '"Lovely" by Tryad' }] },
    streamSync: { final: { withinTolerance: true } },
    warnings: ['inputValidation: ...'],
  };
  const env = buildSuccessEnvelope('job-42', pipelineResult);
  assert.equal(env.jobId, 'job-42');
  assert.equal(env.status, 'success');
  assert.deepEqual(env.result.finalStorage, pipelineResult.finalStorage);
  assert.equal(env.result.durationSec, 78.654);
  assert.equal(env.result.processingMs, 150_321);
  assert.equal(env.result.diagnostics.streamSyncOk, true);
  assert.equal(env.result.diagnostics.insertions.sourceBalance.mode, 'ai_blend');
  assert.equal(env.result.diagnostics.audio.bgm.track.name, 'Lovely');
  // PR-I privacy: brollPick step is not surfaced (operator doesn't need raw step ms)
  assert.equal(env.result.diagnostics.steps.brollPick, undefined);
  // PR-I privacy: raw bgm mix LUFS values not surfaced
  assert.equal(env.result.diagnostics.audio.bgm.mix, undefined);
});

test('buildSuccessEnvelope: tolerates partial pipeline result (missing fields → null)', () => {
  const env = buildSuccessEnvelope('job-x', { finalStorage: { bucket: 'b', path: 'p' } });
  assert.equal(env.status, 'success');
  assert.equal(env.result.durationSec, null);
  assert.equal(env.result.diagnostics.insertions, null);
  assert.deepEqual(env.result.diagnostics.warnings, []);
});

// ── buildFailureEnvelope ────────────────────────────────────────────

test('buildFailureEnvelope: marks upstream 5xx errors as retryable', () => {
  const env = buildFailureEnvelope('job-1', { step: 'transcribe', message: 'Scribe 503 unavailable' });
  assert.equal(env.status, 'failed');
  assert.equal(env.error.step, 'transcribe');
  assert.equal(env.error.retryable, true);
});

test('buildFailureEnvelope: marks Gemini upstream errors as retryable', () => {
  const env = buildFailureEnvelope('job-1', { step: 'brollPick', message: 'broll picker failed: Gemini 503' });
  assert.equal(env.error.retryable, true);
});

test('buildFailureEnvelope: marks Pixabay upstream errors as retryable', () => {
  const env = buildFailureEnvelope('job-1', { step: 'stockSearch', message: 'Pixabay 502 bad gateway' });
  assert.equal(env.error.retryable, true);
});

test('buildFailureEnvelope: marks network errors as retryable', () => {
  const env = buildFailureEnvelope('job-1', { step: 'download', message: 'connect ETIMEDOUT' });
  assert.equal(env.error.retryable, true);
});

test('buildFailureEnvelope: marks internal-bug errors as NON-retryable', () => {
  const env = buildFailureEnvelope('job-1', {
    step: 'compose',
    message: 'composeFaceAndBrolls: insertion abc missing/invalid sourceDurSec',
  });
  assert.equal(env.error.retryable, false);
});

test('buildFailureEnvelope: marks A/V sync gate failures as NON-retryable', () => {
  const env = buildFailureEnvelope('job-1', {
    step: 'streamSync',
    message: 'verifyMP4StreamSync drift exceeds 100ms tolerance',
  });
  assert.equal(env.error.retryable, false);
});

test('buildFailureEnvelope: bare Error object still produces a usable envelope', () => {
  const env = buildFailureEnvelope('job-1', new Error('something exploded'));
  assert.equal(env.status, 'failed');
  assert.equal(env.error.step, null);
  assert.match(env.error.message, /something exploded/);
});
