/**
 * test/pixabay_video.test.js
 *
 * Unit tests for searchPixabayVideos + downloadPixabayVideo. The actual
 * Pixabay API + axios stream are mocked via the `fetchImpl` / `axiosImpl`
 * opts hooks so the suite runs offline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { searchPixabayVideos, downloadPixabayVideo } from '../lib/pixabay_video.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'pixabay-video-response.json'), 'utf8'));

// ── Fake fetch Response factory ────────────────────────────────────────

function fakeResponse({ ok = true, status = 200, body, asJson = true }) {
  return {
    ok,
    status,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    async json() {
      if (asJson) return body;
      throw new SyntaxError('Unexpected token');
    },
  };
}

function mockFetchOK(payload) {
  return async () => fakeResponse({ body: payload });
}

function mockFetchStatus(status, payload = '') {
  return async () => fakeResponse({ ok: status >= 200 && status < 300, status, body: payload });
}

function throwingFetch(message) {
  return async () => { throw new Error(message); };
}

// ── searchPixabayVideos: happy path ────────────────────────────────────

test('searchPixabayVideos: parses valid Pixabay response into hits[]', async () => {
  const out = await searchPixabayVideos({
    query: 'family planning',
    apiKey: 'test',
    fetchImpl: mockFetchOK(FIXTURE),
  });
  assert.equal(out.ok, true);
  assert.ok(out.hits.length >= 2, `expected ≥2 hits from fixture; got ${out.hits.length}`);
  // Each hit must carry the fields stock_library_merge.adaptStockHitToLibraryRow reads.
  for (const h of out.hits) {
    assert.equal(typeof h.id, 'number');
    assert.equal(typeof h.videoUrl, 'string');
    assert.ok(h.videoUrl.startsWith('https://'));
    assert.equal(typeof h.duration, 'number');
    assert.equal(typeof h.tags, 'string');
    assert.equal(typeof h.tier, 'string');
  }
});

test('searchPixabayVideos: prefers medium tier over large/small', async () => {
  const out = await searchPixabayVideos({
    query: 'x',
    apiKey: 'test',
    fetchImpl: mockFetchOK(FIXTURE),
  });
  // First fixture hit has all four tiers — should pick medium.
  const firstHit = out.hits[0];
  assert.equal(firstHit.tier, 'medium');
  assert.match(firstHit.videoUrl, /-medium\.mp4$/);
});

test('searchPixabayVideos: falls back to next tier when medium is missing', async () => {
  // Third fixture hit has only `medium`, second has all tiers.
  // Build a custom payload with only `large` to verify the fallback.
  const payload = {
    hits: [
      {
        id: 5555,
        pageURL: 'https://pixabay.com/x',
        tags: 'large only test',
        duration: 10,
        videos: {
          large: { url: 'https://cdn.pixabay.com/x-large.mp4', width: 1920, height: 1080, size: 1 },
        },
      },
    ],
  };
  const out = await searchPixabayVideos({
    query: 'x',
    apiKey: 'test',
    fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.hits[0].tier, 'large');
});

// ── searchPixabayVideos: filtering ─────────────────────────────────────

test('searchPixabayVideos: drops hits below minDur', async () => {
  const payload = {
    hits: [
      { id: 1, duration: 2, pageURL: 'p', tags: 't', videos: { medium: { url: 'u', width: 1, height: 1, size: 1 } } },
      { id: 2, duration: 10, pageURL: 'p', tags: 't', videos: { medium: { url: 'u', width: 1, height: 1, size: 1 } } },
    ],
  };
  const out = await searchPixabayVideos({
    query: 'x', apiKey: 'k', minDur: 3, fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0].id, 2);
});

test('searchPixabayVideos: drops hits above maxDur', async () => {
  const payload = {
    hits: [
      { id: 1, duration: 10, pageURL: 'p', tags: 't', videos: { medium: { url: 'u', width: 1, height: 1, size: 1 } } },
      { id: 2, duration: 120, pageURL: 'p', tags: 't', videos: { medium: { url: 'u', width: 1, height: 1, size: 1 } } },
    ],
  };
  const out = await searchPixabayVideos({
    query: 'x', apiKey: 'k', maxDur: 60, fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0].id, 1);
});

test('searchPixabayVideos: drops hits with no usable video URL', async () => {
  const payload = {
    hits: [
      { id: 1, duration: 10, pageURL: 'p', tags: 't', videos: {} },                        // dropped
      { id: 2, duration: 10, pageURL: 'p', tags: 't', videos: { medium: { url: '', width: 1, height: 1, size: 1 } } }, // dropped (empty url)
      { id: 3, duration: 10, pageURL: 'p', tags: 't', videos: { medium: { url: 'u', width: 1, height: 1, size: 1 } } },
    ],
  };
  const out = await searchPixabayVideos({
    query: 'x', apiKey: 'k', fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0].id, 3);
});

test('searchPixabayVideos: returns kind=empty when zero hits survive filtering', async () => {
  const payload = {
    hits: [
      { id: 1, duration: 1, pageURL: 'p', tags: 't', videos: { medium: { url: 'u', width: 1, height: 1, size: 1 } } },
    ],
  };
  const out = await searchPixabayVideos({
    query: 'x', apiKey: 'k', minDur: 5, fetchImpl: mockFetchOK(payload),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'empty');
});

test('searchPixabayVideos: returns kind=empty when API returns 0 raw hits', async () => {
  const out = await searchPixabayVideos({
    query: 'x', apiKey: 'k', fetchImpl: mockFetchOK({ hits: [] }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'empty');
});

// ── searchPixabayVideos: error envelopes ───────────────────────────────

test('searchPixabayVideos: returns kind=upstream on 5xx', async () => {
  const out = await searchPixabayVideos({
    query: 'x', apiKey: 'k', fetchImpl: mockFetchStatus(503, 'service unavailable'),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'upstream');
  assert.equal(out.status, 503);
});

test('searchPixabayVideos: returns kind=upstream on 429 rate limit', async () => {
  const out = await searchPixabayVideos({
    query: 'x', apiKey: 'k', fetchImpl: mockFetchStatus(429, 'too many'),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'upstream');
  assert.equal(out.status, 429);
});

test('searchPixabayVideos: returns kind=upstream on network error', async () => {
  const out = await searchPixabayVideos({
    query: 'x', apiKey: 'k', fetchImpl: throwingFetch('ENOTFOUND'),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'upstream');
  assert.match(out.body, /ENOTFOUND/);
});

test('searchPixabayVideos: returns kind=parse on invalid JSON body', async () => {
  const out = await searchPixabayVideos({
    query: 'x',
    apiKey: 'k',
    fetchImpl: async () => fakeResponse({ body: 'not json', asJson: false }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'parse');
});

test('searchPixabayVideos: rejects empty query early (no fetch call)', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return fakeResponse({ body: FIXTURE }); };
  const out = await searchPixabayVideos({ query: '', apiKey: 'k', fetchImpl: fetcher });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'parse');
  assert.equal(calls, 0);
});

test('searchPixabayVideos: throws when apiKey missing', async () => {
  await assert.rejects(
    () => searchPixabayVideos({ query: 'x', fetchImpl: mockFetchOK(FIXTURE) }),
    /apiKey is required/,
  );
});

// ── searchPixabayVideos: URL construction ──────────────────────────────

test('searchPixabayVideos: builds URL with key + q + safesearch=true + video_type=film', async () => {
  let capturedUrl;
  const fetcher = async (url, _init) => {
    capturedUrl = url;
    return fakeResponse({ body: FIXTURE });
  };
  await searchPixabayVideos({ query: 'family planning', apiKey: 'mysecret', fetchImpl: fetcher });
  assert.match(capturedUrl, /^https:\/\/pixabay\.com\/api\/videos\/\?/);
  assert.match(capturedUrl, /key=mysecret/);
  assert.match(capturedUrl, /q=family\+planning|q=family%20planning/);
  assert.match(capturedUrl, /safesearch=true/);
  assert.match(capturedUrl, /video_type=film/);
});

test('searchPixabayVideos: clamps perPage to Pixabay minimum of 3', async () => {
  let capturedUrl;
  const fetcher = async (url) => { capturedUrl = url; return fakeResponse({ body: FIXTURE }); };
  await searchPixabayVideos({ query: 'x', apiKey: 'k', perPage: 1, fetchImpl: fetcher });
  assert.match(capturedUrl, /per_page=3/);
});

test('searchPixabayVideos: clamps perPage to Pixabay maximum of 200', async () => {
  let capturedUrl;
  const fetcher = async (url) => { capturedUrl = url; return fakeResponse({ body: FIXTURE }); };
  await searchPixabayVideos({ query: 'x', apiKey: 'k', perPage: 999, fetchImpl: fetcher });
  assert.match(capturedUrl, /per_page=200/);
});

// ── downloadPixabayVideo ───────────────────────────────────────────────

function fakeAxiosOK({ contentLength = 4200000 } = {}) {
  return {
    async get(url, opts) {
      // Return a minimal Readable-like with the methods stream/promises pipeline expects.
      const { Readable } = await import('stream');
      const stream = Readable.from([Buffer.from('fake video bytes')]);
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

test('downloadPixabayVideo: writes to <outDir>/px-video-<id>.mp4 and returns metadata', async () => {
  const tmpDir = await import('fs').then((fs) => fs.mkdtempSync(join(__dirname, 'tmp-test-')));
  try {
    const out = await downloadPixabayVideo({
      hit: { id: 7777, videoUrl: 'https://cdn/x.mp4' },
      outDir: tmpDir,
      axiosImpl: fakeAxiosOK({ contentLength: 1234 }),
    });
    assert.match(out.localPath, /px-video-7777\.mp4$/);
    assert.equal(out.bytes, 1234);
    assert.equal(out.url, 'https://cdn/x.mp4');
    // File exists.
    const fs = await import('fs');
    assert.ok(fs.existsSync(out.localPath));
  } finally {
    const fs = await import('fs');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('downloadPixabayVideo: throws on non-2xx response', async () => {
  await assert.rejects(
    () => downloadPixabayVideo({
      hit: { id: 1, videoUrl: 'https://cdn/x.mp4' },
      outDir: '/tmp',
      axiosImpl: fakeAxiosStatus(500),
    }),
    /500 for px-video-1/,
  );
});

test('downloadPixabayVideo: throws when hit.id missing', async () => {
  await assert.rejects(
    () => downloadPixabayVideo({ hit: { videoUrl: 'https://x' }, outDir: '/tmp' }),
    /hit\.id is required/,
  );
});

test('downloadPixabayVideo: throws when hit.videoUrl missing', async () => {
  await assert.rejects(
    () => downloadPixabayVideo({ hit: { id: 1 }, outDir: '/tmp' }),
    /hit\.videoUrl is required/,
  );
});

test('downloadPixabayVideo: throws when outDir missing', async () => {
  await assert.rejects(
    () => downloadPixabayVideo({ hit: { id: 1, videoUrl: 'https://x' } }),
    /outDir is required/,
  );
});
