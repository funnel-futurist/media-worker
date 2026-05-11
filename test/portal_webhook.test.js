/**
 * test/portal_webhook.test.js
 *
 * Tests for the PR-I v2 portal callback helper. Plan v2 swapped from a new
 * HMAC-signed webhook to the EXISTING portal endpoint
 * `POST /api/editor/callback/reel` with `x-api-key` auth and the simpler
 * payload `{ contentItemId, clientId, editedUrl, editNotes }`.
 *
 * Mocked-fetch pattern matches lib/bgm_select.js / lib/jamendo_music.js —
 * tests stay offline and deterministic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  postReelEditedCallback,
  buildReelEditedPayload,
  buildEditNotesSummary,
} from '../lib/portal_webhook.js';

const API_KEY = 'editor-shared-key';
const URL = 'https://success.funnelfuturist.com/api/editor/callback/reel';

// ── buildReelEditedPayload ──────────────────────────────────────────

test('buildReelEditedPayload: includes all required fields', () => {
  const p = buildReelEditedPayload({
    contentItemId: 'item-1',
    clientId: 'client-1',
    editedUrl: 'https://x.supabase.co/sign/abc.mp4',
    editNotes: 'AI-blend: 4 client + 2 stock.',
  });
  assert.deepEqual(p, {
    contentItemId: 'item-1',
    clientId: 'client-1',
    editedUrl: 'https://x.supabase.co/sign/abc.mp4',
    editNotes: 'AI-blend: 4 client + 2 stock.',
  });
});

test('buildReelEditedPayload: omits editNotes when empty/null', () => {
  const p = buildReelEditedPayload({
    contentItemId: 'item-1',
    clientId: 'client-1',
    editedUrl: 'https://x.supabase.co/sign/abc.mp4',
    editNotes: '',
  });
  assert.equal(p.editNotes, undefined);
  assert.equal(Object.keys(p).length, 3);
});

// ── postReelEditedCallback happy path ──────────────────────────────

test('postReelEditedCallback: POSTs with x-api-key header (NOT x-worker-signature)', async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, async text() { return ''; } };
  };
  const payload = buildReelEditedPayload({
    contentItemId: 'item-1', clientId: 'client-1',
    editedUrl: 'https://x.mp4', editNotes: 'x',
  });
  const out = await postReelEditedCallback({
    callbackUrl: URL,
    callbackApiKey: API_KEY,
    payload,
    fetchImpl: fakeFetch,
  });
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 1);
  assert.equal(captured.url, URL);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['content-type'], 'application/json');
  // Plan v2: x-api-key, NOT HMAC signature.
  assert.equal(captured.init.headers['x-api-key'], API_KEY);
  assert.equal(captured.init.headers['x-worker-signature'], undefined,
    'HMAC signature header should be absent in v2');
  assert.deepEqual(JSON.parse(captured.init.body), payload);
});

test('postReelEditedCallback: body shape matches portal endpoint contract exactly', async () => {
  // Locked: the existing endpoint reads { contentItemId, clientId, editedUrl, editNotes }
  // and 400s on anything else missing. Make sure nothing extra leaks in.
  let captured = null;
  const fakeFetch = async (_url, init) => {
    captured = init;
    return { ok: true, status: 200 };
  };
  const payload = buildReelEditedPayload({
    contentItemId: 'c-1', clientId: 'cli-1', editedUrl: 'https://x', editNotes: 'note',
  });
  await postReelEditedCallback({
    callbackUrl: URL, callbackApiKey: API_KEY, payload, fetchImpl: fakeFetch,
  });
  const sent = JSON.parse(captured.body);
  assert.deepEqual(Object.keys(sent).sort(), ['clientId', 'contentItemId', 'editNotes', 'editedUrl']);
});

// ── retry semantics ────────────────────────────────────────────────

test('postReelEditedCallback: retries once on 5xx', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503, async text() { return 'unavailable'; } };
    return { ok: true, status: 200, async text() { return ''; } };
  };
  const out = await postReelEditedCallback({
    callbackUrl: URL,
    callbackApiKey: API_KEY,
    payload: buildReelEditedPayload({
      contentItemId: 'c', clientId: 'cl', editedUrl: 'https://x',
    }),
    fetchImpl: fakeFetch,
    timeoutMs: 500,
  });
  assert.equal(calls, 2);
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
});

test('postReelEditedCallback: does NOT retry on 4xx (auth / bad payload)', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return { ok: false, status: 401, async text() { return 'Unauthorized'; } };
  };
  const out = await postReelEditedCallback({
    callbackUrl: URL,
    callbackApiKey: 'wrong-key',
    payload: buildReelEditedPayload({
      contentItemId: 'c', clientId: 'cl', editedUrl: 'https://x',
    }),
    fetchImpl: fakeFetch,
  });
  assert.equal(calls, 1);
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
  assert.match(out.error ?? '', /portal_401/);
});

test('postReelEditedCallback: retries once on network throw, surfaces last error', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    throw new Error('ECONNRESET');
  };
  const out = await postReelEditedCallback({
    callbackUrl: URL,
    callbackApiKey: API_KEY,
    payload: buildReelEditedPayload({
      contentItemId: 'c', clientId: 'cl', editedUrl: 'https://x',
    }),
    fetchImpl: fakeFetch,
    timeoutMs: 200,
  });
  assert.equal(calls, 2);
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /ECONNRESET/);
});

// ── input validation ────────────────────────────────────────────────

test('postReelEditedCallback: rejects missing callbackUrl', async () => {
  const out = await postReelEditedCallback({
    callbackApiKey: API_KEY,
    payload: buildReelEditedPayload({
      contentItemId: 'c', clientId: 'cl', editedUrl: 'https://x',
    }),
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /missing callbackUrl/);
});

test('postReelEditedCallback: rejects missing callbackApiKey', async () => {
  const out = await postReelEditedCallback({
    callbackUrl: URL,
    payload: buildReelEditedPayload({
      contentItemId: 'c', clientId: 'cl', editedUrl: 'https://x',
    }),
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(out.ok, false);
});

test('postReelEditedCallback: rejects payload without contentItemId', async () => {
  const out = await postReelEditedCallback({
    callbackUrl: URL,
    callbackApiKey: API_KEY,
    payload: { clientId: 'cl', editedUrl: 'https://x' },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /payload missing required fields/);
});

test('postReelEditedCallback: rejects payload without editedUrl', async () => {
  const out = await postReelEditedCallback({
    callbackUrl: URL,
    callbackApiKey: API_KEY,
    payload: { contentItemId: 'c', clientId: 'cl' },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /payload missing required fields/);
});

// ── buildEditNotesSummary ───────────────────────────────────────────

test('buildEditNotesSummary: full pipeline result → AI-blend + BGM + duration', () => {
  const s = buildEditNotesSummary({
    durationSec: 78.7,
    insertions: {
      clientCount: 4,
      stockCount: 2,
      sourceBalance: { mixMet: true, mixReason: 'both_sources_represented' },
    },
    audio: {
      bgm: {
        applied: true,
        track: {
          name: 'Lovely',
          artistName: 'Tryad',
          licenseCcUrl: 'http://creativecommons.org/licenses/by-sa/2.5/',
        },
      },
    },
  });
  assert.match(s, /AI-blend: 4 client \+ 2 stock pick\(s\)\./);
  assert.match(s, /BGM: "Lovely" by Tryad \(CC BY-SA 2\.5\)\./);
  assert.match(s, /78\.7s\./);
  assert.doesNotMatch(s, /Mix unmet/);
});

test('buildEditNotesSummary: mix-unmet surfaces as a hint', () => {
  const s = buildEditNotesSummary({
    durationSec: 60,
    insertions: {
      clientCount: 7, stockCount: 0,
      sourceBalance: { mixMet: false, mixReason: 'ai_chose_all_client_despite_stock_available' },
    },
  });
  assert.match(s, /Mix unmet: ai_chose_all_client_despite_stock_available/);
});

test('buildEditNotesSummary: BGM-skipped case', () => {
  const s = buildEditNotesSummary({
    durationSec: 45,
    audio: { bgm: { applied: false, skipReason: 'bgm_fetch_empty' } },
  });
  assert.match(s, /BGM: skipped \(bgm_fetch_empty\)/);
});

test('buildEditNotesSummary: empty result returns empty string', () => {
  assert.equal(buildEditNotesSummary({}), '');
  assert.equal(buildEditNotesSummary(null), '');
  assert.equal(buildEditNotesSummary(undefined), '');
});

test('buildEditNotesSummary: caps output at EDIT_NOTES_MAX_CHARS', () => {
  const s = buildEditNotesSummary({
    durationSec: 60,
    insertions: { clientCount: 4, stockCount: 2 },
    audio: {
      bgm: {
        applied: true,
        track: {
          name: 'a'.repeat(1000),
          artistName: 'b'.repeat(1000),
          licenseCcUrl: 'http://creativecommons.org/licenses/by/3.0/',
        },
      },
    },
  });
  assert.ok(s.length <= 480, `expected length<=480, got ${s.length}`);
});
