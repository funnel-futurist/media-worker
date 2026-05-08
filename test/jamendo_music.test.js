/**
 * test/jamendo_music.test.js
 *
 * Mocked-fetch + mocked-axios tests for searchJamendoMusic +
 * downloadJamendoTrack. Same offline pattern as test/pixabay_video.test.js.
 *
 * Why Jamendo: PR-B2 (2026-05-08) — Pixabay-Music is dead (404 on
 * /api/music/), Jamendo replaces it as the automated CC-BY BGM source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { searchJamendoMusic, downloadJamendoTrack } from '../lib/jamendo_music.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'jamendo-tracks-response.json'), 'utf8'),
);

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

// ── searchJamendoMusic happy path ──────────────────────────────────────

test('searchJamendoMusic: parses success envelope into tracks[]', async () => {
  const out = await searchJamendoMusic({
    query: 'warm acoustic',
    clientId: 'test-client',
    fetchImpl: mockFetchOK(FIXTURE),
  });
  assert.equal(out.ok, true);
  assert.equal(out.tracks.length, 3);
  for (const t of out.tracks) {
    assert.equal(typeof t.id, 'string');
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.artistName, 'string');
    assert.equal(typeof t.durationSec, 'number');
    assert.ok(t.audioUrl?.startsWith('https://') || t.audioDownloadUrl?.startsWith('https://'));
    assert.equal(t.attributionRequired, true);
    assert.equal(typeof t.attributionText, 'string');
    assert.ok(t.attributionText.length > 0);
  }
});

test('searchJamendoMusic: surfaces title + artistName + albumName', async () => {
  const out = await searchJamendoMusic({
    query: 'x', clientId: 'k', fetchImpl: mockFetchOK(FIXTURE),
  });
  assert.equal(out.tracks[0].name, 'Warm Acoustic Reflection');
  assert.equal(out.tracks[0].artistName, 'Jane Doe');
  assert.equal(out.tracks[0].albumName, 'Quiet Mornings');
});

test('searchJamendoMusic: builds CC-BY attribution text', async () => {
  const out = await searchJamendoMusic({
    query: 'x', clientId: 'k', fetchImpl: mockFetchOK(FIXTURE),
  });
  // Expect: "Warm Acoustic Reflection" by Jane Doe (CC BY 3.0) — https://...
  assert.match(out.tracks[0].attributionText, /^"Warm Acoustic Reflection" by Jane Doe \(CC BY 3\.0\)/);
  assert.match(out.tracks[0].attributionText, /jamendo\.com\/track\/1781234/);
  // CC-BY-SA track gets the SA shortcode in the label.
  assert.match(out.tracks[1].attributionText, /\(CC BY-SA 4\.0\)/);
});

test('searchJamendoMusic: keeps licenseCcUrl + shareUrl on the track', async () => {
  const out = await searchJamendoMusic({
    query: 'x', clientId: 'k', fetchImpl: mockFetchOK(FIXTURE),
  });
  assert.equal(out.tracks[0].licenseCcUrl, 'https://creativecommons.org/licenses/by/3.0/');
  assert.equal(out.tracks[0].shareUrl, 'https://www.jamendo.com/track/1781234/warm-acoustic-reflection');
});

test('searchJamendoMusic: splits comma-separated tags into an array', async () => {
  const out = await searchJamendoMusic({
    query: 'x', clientId: 'k', fetchImpl: mockFetchOK(FIXTURE),
  });
  assert.deepEqual(out.tracks[0].tags, ['acoustic', 'guitar', 'calm', 'instrumental', 'reflective']);
});

// ── duration filtering ─────────────────────────────────────────────────

test('searchJamendoMusic: drops tracks below durationMin', async () => {
  const payload = {
    headers: { status: 'success', code: 0 },
    results: [
      { id: '1', name: 'a', artist_name: 'a', duration: 5,  audio: 'https://x.mp3' },
      { id: '2', name: 'b', artist_name: 'b', duration: 120, audio: 'https://y.mp3' },
    ],
  };
  const out = await searchJamendoMusic({
    query: 'x', clientId: 'k', durationMin: 60, fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.tracks.length, 1);
  assert.equal(out.tracks[0].id, '2');
});

test('searchJamendoMusic: drops tracks above durationMax', async () => {
  const payload = {
    headers: { status: 'success', code: 0 },
    results: [
      { id: '1', name: 'a', artist_name: 'a', duration: 60,  audio: 'https://x.mp3' },
      { id: '2', name: 'b', artist_name: 'b', duration: 1200, audio: 'https://y.mp3' },
    ],
  };
  const out = await searchJamendoMusic({
    query: 'x', clientId: 'k', durationMax: 600, fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.tracks.length, 1);
  assert.equal(out.tracks[0].id, '1');
});

test('searchJamendoMusic: drops tracks with no audio url at all', async () => {
  const payload = {
    headers: { status: 'success', code: 0 },
    results: [
      { id: '1', name: 'a', artist_name: 'a', duration: 60 },                    // neither
      { id: '2', name: 'b', artist_name: 'b', duration: 60, audio: 'https://ok.mp3' },
    ],
  };
  const out = await searchJamendoMusic({
    query: 'x', clientId: 'k', fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.tracks.length, 1);
  assert.equal(out.tracks[0].id, '2');
});

// ── envelope failures ─────────────────────────────────────────────────

test('searchJamendoMusic: returns kind=upstream on 5xx', async () => {
  const out = await searchJamendoMusic({
    query: 'x', clientId: 'k', fetchImpl: mockFetchStatus(503, 'unavailable'),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'upstream');
  assert.equal(out.status, 503);
});

test('searchJamendoMusic: returns kind=upstream on network throw', async () => {
  const out = await searchJamendoMusic({
    query: 'x', clientId: 'k', fetchImpl: throwingFetch('ENOTFOUND'),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'upstream');
});

test('searchJamendoMusic: returns kind=auth when envelope has code=5 (bad client_id)', async () => {
  const payload = {
    headers: { status: 'failed', code: 5, error_message: 'Your credential is not allowed' },
    results: [],
  };
  const out = await searchJamendoMusic({
    query: 'x', clientId: 'bad', fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'auth');
  assert.equal(out.status, 5);
});

test('searchJamendoMusic: returns kind=auth when envelope has code=6 (quota exceeded)', async () => {
  const payload = {
    headers: { status: 'failed', code: 6, error_message: 'Daily limit reached' },
    results: [],
  };
  const out = await searchJamendoMusic({
    query: 'x', clientId: 'k', fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'auth');
});

test('searchJamendoMusic: returns kind=upstream on generic envelope failure', async () => {
  const payload = {
    headers: { status: 'failed', code: 99, error_message: 'mystery' },
    results: [],
  };
  const out = await searchJamendoMusic({
    query: 'x', clientId: 'k', fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'upstream');
});

test('searchJamendoMusic: returns kind=empty when 0 raw results', async () => {
  const payload = { headers: { status: 'success', code: 0 }, results: [] };
  const out = await searchJamendoMusic({
    query: 'x', clientId: 'k', fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'empty');
});

test('searchJamendoMusic: returns kind=empty when all results filtered', async () => {
  const payload = {
    headers: { status: 'success', code: 0 },
    results: [{ id: '1', name: 'a', artist_name: 'a', duration: 5, audio: 'https://x.mp3' }],
  };
  const out = await searchJamendoMusic({
    query: 'x', clientId: 'k', durationMin: 60, fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'empty');
});

test('searchJamendoMusic: returns kind=parse on non-JSON body', async () => {
  const out = await searchJamendoMusic({
    query: 'x', clientId: 'k',
    fetchImpl: async () => fakeResponse({ body: 'oops', asJson: false }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'parse');
});

test('searchJamendoMusic: rejects empty query early (no fetch call)', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return fakeResponse({ body: FIXTURE }); };
  const out = await searchJamendoMusic({ query: '', clientId: 'k', fetchImpl: fetcher });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'parse');
  assert.equal(calls, 0);
});

test('searchJamendoMusic: throws when clientId missing', async () => {
  await assert.rejects(
    () => searchJamendoMusic({ query: 'x', fetchImpl: mockFetchOK(FIXTURE) }),
    /clientId is required/,
  );
});

// ── URL construction ─────────────────────────────────────────────────

test('searchJamendoMusic: builds URL with client_id + search + license filters', async () => {
  let capturedUrl;
  const fetcher = async (url) => { capturedUrl = url; return fakeResponse({ body: FIXTURE }); };
  await searchJamendoMusic({ query: 'warm folk', clientId: 'mysecret', fetchImpl: fetcher });
  assert.match(capturedUrl, /^https:\/\/api\.jamendo\.com\/v3\.0\/tracks\/\?/);
  assert.match(capturedUrl, /client_id=mysecret/);
  assert.match(capturedUrl, /search=warm\+folk|search=warm%20folk/);
  // Licensing filters: instrumental, no NC, no ND.
  assert.match(capturedUrl, /vocalinstrumental=instrumental/);
  assert.match(capturedUrl, /ccnc=0/);
  assert.match(capturedUrl, /ccnd=0/);
});

// ── downloadJamendoTrack ─────────────────────────────────────────────

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
      return {
        status,
        headers: {},
        data: { pipe: () => {}, on: () => {}, [Symbol.asyncIterator]: async function* () {} },
      };
    },
  };
}

test('downloadJamendoTrack: writes to <outDir>/jamendo-<id>.mp3', async () => {
  const fs = await import('fs');
  const tmpDir = fs.mkdtempSync(join(__dirname, 'tmp-jamendo-test-'));
  try {
    const out = await downloadJamendoTrack({
      track: { id: '9999', audioUrl: 'https://cdn/track.mp3', audioDownloadUrl: null },
      outDir: tmpDir,
      axiosImpl: fakeAxiosOK({ contentLength: 1234 }),
    });
    assert.match(out.localPath, /jamendo-9999\.mp3$/);
    assert.equal(out.bytes, 1234);
    assert.equal(out.url, 'https://cdn/track.mp3');
    assert.ok(fs.existsSync(out.localPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('downloadJamendoTrack: prefers audioDownloadUrl over audioUrl', async () => {
  const fs = await import('fs');
  const tmpDir = fs.mkdtempSync(join(__dirname, 'tmp-jamendo-test-'));
  let capturedUrl;
  const axiosImpl = {
    async get(url) {
      capturedUrl = url;
      const { Readable } = await import('stream');
      return {
        status: 200,
        headers: { 'content-length': '10' },
        data: Readable.from([Buffer.from('x')]),
      };
    },
  };
  try {
    await downloadJamendoTrack({
      track: { id: '1', audioUrl: 'https://stream/a.mp3', audioDownloadUrl: 'https://dl/a.mp3' },
      outDir: tmpDir,
      axiosImpl,
    });
    assert.equal(capturedUrl, 'https://dl/a.mp3');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('downloadJamendoTrack: falls back to audioUrl when audioDownloadUrl is null', async () => {
  const fs = await import('fs');
  const tmpDir = fs.mkdtempSync(join(__dirname, 'tmp-jamendo-test-'));
  let capturedUrl;
  const axiosImpl = {
    async get(url) {
      capturedUrl = url;
      const { Readable } = await import('stream');
      return {
        status: 200,
        headers: { 'content-length': '10' },
        data: Readable.from([Buffer.from('x')]),
      };
    },
  };
  try {
    await downloadJamendoTrack({
      track: { id: '1', audioUrl: 'https://stream/a.mp3', audioDownloadUrl: null },
      outDir: tmpDir,
      axiosImpl,
    });
    assert.equal(capturedUrl, 'https://stream/a.mp3');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('downloadJamendoTrack: throws on non-2xx', async () => {
  await assert.rejects(
    () => downloadJamendoTrack({
      track: { id: '1', audioUrl: 'https://x.mp3', audioDownloadUrl: null },
      outDir: '/tmp',
      axiosImpl: fakeAxiosStatus(500),
    }),
    /500 for jamendo-1/,
  );
});

test('downloadJamendoTrack: throws when track.id missing', async () => {
  await assert.rejects(
    () => downloadJamendoTrack({
      track: { audioUrl: 'https://x.mp3', audioDownloadUrl: null },
      outDir: '/tmp',
    }),
    /track\.id is required/,
  );
});

test('downloadJamendoTrack: throws when both audio URLs missing', async () => {
  await assert.rejects(
    () => downloadJamendoTrack({
      track: { id: '1', audioUrl: null, audioDownloadUrl: null },
      outDir: '/tmp',
    }),
    /no audioDownloadUrl or audioUrl/,
  );
});
