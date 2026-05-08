/**
 * test/pixabay_music.test.js
 *
 * Mocked-fetch + mocked-axios tests for searchPixabayMusic + downloadPixabayMusic.
 * Same pattern as test/pixabay_video.test.js — keeps the suite offline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { searchPixabayMusic, downloadPixabayMusic } from '../lib/pixabay_music.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'pixabay-music-response.json'), 'utf8'));

function fakeResponse({ ok = true, status = 200, body, asJson = true }) {
  return {
    ok,
    status,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    async json() {
      if (asJson) return body;
      throw new SyntaxError('not json');
    },
  };
}
function mockFetchOK(payload) {
  return async () => fakeResponse({ body: payload });
}
function mockFetchStatus(status, body = '') {
  return async () => fakeResponse({ ok: status >= 200 && status < 300, status, body });
}
function throwingFetch(message) {
  return async () => { throw new Error(message); };
}

// ── searchPixabayMusic happy path ──────────────────────────────────────

test('searchPixabayMusic: parses Pixabay response into hits[]', async () => {
  const out = await searchPixabayMusic({
    query: 'warm acoustic',
    apiKey: 'test',
    fetchImpl: mockFetchOK(FIXTURE),
  });
  assert.equal(out.ok, true);
  assert.ok(out.hits.length >= 2);
  for (const h of out.hits) {
    assert.equal(typeof h.id, 'number');
    assert.equal(typeof h.audioUrl, 'string');
    assert.ok(h.audioUrl.startsWith('https://'));
    assert.equal(typeof h.duration, 'number');
    assert.equal(typeof h.tags, 'string');
  }
});

test('searchPixabayMusic: surfaces title for response audit', async () => {
  const out = await searchPixabayMusic({
    query: 'x', apiKey: 'k', fetchImpl: mockFetchOK(FIXTURE),
  });
  assert.equal(out.hits[0].title, 'Warm Acoustic Guitar');
});

test('searchPixabayMusic: prefers `audio` field over alternatives', async () => {
  const payload = {
    hits: [
      { id: 1, duration: 60, pageURL: 'p', tags: 't',
        audio: 'https://primary.mp3', audio_url: 'https://fallback.mp3' },
    ],
  };
  const out = await searchPixabayMusic({
    query: 'x', apiKey: 'k', fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.hits[0].audioUrl, 'https://primary.mp3');
});

test('searchPixabayMusic: falls back to audio_url when audio is missing', async () => {
  const payload = {
    hits: [
      { id: 1, duration: 60, pageURL: 'p', tags: 't', audio_url: 'https://fb.mp3' },
    ],
  };
  const out = await searchPixabayMusic({
    query: 'x', apiKey: 'k', fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.hits[0].audioUrl, 'https://fb.mp3');
});

// ── duration filtering ─────────────────────────────────────────────────

test('searchPixabayMusic: drops hits below durationMin', async () => {
  const payload = {
    hits: [
      { id: 1, duration: 5,  pageURL: 'p', tags: 't', audio: 'https://x.mp3' },
      { id: 2, duration: 60, pageURL: 'p', tags: 't', audio: 'https://x.mp3' },
    ],
  };
  const out = await searchPixabayMusic({
    query: 'x', apiKey: 'k', durationMin: 30, fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0].id, 2);
});

test('searchPixabayMusic: drops hits above durationMax', async () => {
  const payload = {
    hits: [
      { id: 1, duration: 60,  pageURL: 'p', tags: 't', audio: 'https://x.mp3' },
      { id: 2, duration: 800, pageURL: 'p', tags: 't', audio: 'https://x.mp3' },
    ],
  };
  const out = await searchPixabayMusic({
    query: 'x', apiKey: 'k', durationMax: 600, fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0].id, 1);
});

test('searchPixabayMusic: drops hits with no audio URL', async () => {
  const payload = {
    hits: [
      { id: 1, duration: 60, pageURL: 'p', tags: 't' },                      // no audio
      { id: 2, duration: 60, pageURL: 'p', tags: 't', audio: '' },           // empty
      { id: 3, duration: 60, pageURL: 'p', tags: 't', audio: 'not-a-url' },  // not http
      { id: 4, duration: 60, pageURL: 'p', tags: 't', audio: 'https://ok.mp3' },
    ],
  };
  const out = await searchPixabayMusic({
    query: 'x', apiKey: 'k', fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0].id, 4);
});

// ── envelope failures ─────────────────────────────────────────────────

test('searchPixabayMusic: returns kind=upstream on 5xx', async () => {
  const out = await searchPixabayMusic({
    query: 'x', apiKey: 'k', fetchImpl: mockFetchStatus(503, 'unavailable'),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'upstream');
  assert.equal(out.status, 503);
});

test('searchPixabayMusic: returns kind=upstream on network throw', async () => {
  const out = await searchPixabayMusic({
    query: 'x', apiKey: 'k', fetchImpl: throwingFetch('ENOTFOUND'),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'upstream');
});

test('searchPixabayMusic: returns kind=empty when 0 raw hits', async () => {
  const out = await searchPixabayMusic({
    query: 'x', apiKey: 'k', fetchImpl: mockFetchOK({ hits: [] }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'empty');
});

test('searchPixabayMusic: returns kind=empty when all hits filtered', async () => {
  const payload = {
    hits: [{ id: 1, duration: 5, pageURL: 'p', tags: 't', audio: 'https://x.mp3' }],
  };
  const out = await searchPixabayMusic({
    query: 'x', apiKey: 'k', durationMin: 30, fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'empty');
});

test('searchPixabayMusic: returns kind=parse on non-JSON body', async () => {
  const out = await searchPixabayMusic({
    query: 'x',
    apiKey: 'k',
    fetchImpl: async () => fakeResponse({ body: 'oops', asJson: false }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'parse');
});

test('searchPixabayMusic: rejects empty query early (no fetch call)', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return fakeResponse({ body: FIXTURE }); };
  const out = await searchPixabayMusic({ query: '', apiKey: 'k', fetchImpl: fetcher });
  assert.equal(out.ok, false);
  assert.equal(calls, 0);
});

test('searchPixabayMusic: throws when apiKey missing', async () => {
  await assert.rejects(
    () => searchPixabayMusic({ query: 'x', fetchImpl: mockFetchOK(FIXTURE) }),
    /apiKey is required/,
  );
});

// ── URL construction ─────────────────────────────────────────────────

test('searchPixabayMusic: builds URL with key + q + safesearch=true', async () => {
  let capturedUrl;
  const fetcher = async (url) => { capturedUrl = url; return fakeResponse({ body: FIXTURE }); };
  await searchPixabayMusic({ query: 'warm folk', apiKey: 'mysecret', fetchImpl: fetcher });
  assert.match(capturedUrl, /^https:\/\/pixabay\.com\/api\/music\/\?/);
  assert.match(capturedUrl, /key=mysecret/);
  assert.match(capturedUrl, /q=warm\+folk|q=warm%20folk/);
  assert.match(capturedUrl, /safesearch=true/);
});

// ── downloadPixabayMusic ─────────────────────────────────────────────

function fakeAxiosOK({ contentLength = 1500000 } = {}) {
  return {
    async get() {
      const { Readable } = await import('stream');
      const stream = Readable.from([Buffer.from('fake mp3 bytes')]);
      return {
        status: 200,
        headers: { 'content-length': String(contentLength) },
        data: stream,
      };
    },
  };
}
function fakeAxiosStatus(status) {
  return {
    async get() {
      return { status, headers: {}, data: { pipe: () => {}, on: () => {}, [Symbol.asyncIterator]: async function* () {} } };
    },
  };
}

test('downloadPixabayMusic: writes to <outDir>/bgm-<id>.mp3', async () => {
  const tmpDir = await import('fs').then((fs) => fs.mkdtempSync(join(__dirname, 'tmp-music-test-')));
  try {
    const out = await downloadPixabayMusic({
      hit: { id: 9999, audioUrl: 'https://cdn/bgm.mp3' },
      outDir: tmpDir,
      axiosImpl: fakeAxiosOK({ contentLength: 1234 }),
    });
    assert.match(out.localPath, /bgm-9999\.mp3$/);
    assert.equal(out.bytes, 1234);
    assert.equal(out.url, 'https://cdn/bgm.mp3');
    const fs = await import('fs');
    assert.ok(fs.existsSync(out.localPath));
  } finally {
    const fs = await import('fs');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('downloadPixabayMusic: throws on non-2xx', async () => {
  await assert.rejects(
    () => downloadPixabayMusic({
      hit: { id: 1, audioUrl: 'https://x.mp3' },
      outDir: '/tmp',
      axiosImpl: fakeAxiosStatus(500),
    }),
    /500 for bgm-1/,
  );
});

test('downloadPixabayMusic: throws when hit.id missing', async () => {
  await assert.rejects(
    () => downloadPixabayMusic({ hit: { audioUrl: 'https://x' }, outDir: '/tmp' }),
    /hit\.id is required/,
  );
});

test('downloadPixabayMusic: throws when audioUrl missing', async () => {
  await assert.rejects(
    () => downloadPixabayMusic({ hit: { id: 1 }, outDir: '/tmp' }),
    /hit\.audioUrl is required/,
  );
});
