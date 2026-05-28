/**
 * test/pexels_video.test.js
 *
 * Pure-function + fetch-mock tests for lib/pexels_video.js. No network.
 * Mirrors the test posture of pixabay-related tests (which exist as
 * indirect tests through stock_library_merge.test.js / clean-mode flow);
 * this file locks the Pexels-specific shape end-to-end.
 *
 * Locked behaviors:
 *   1. searchPexelsVideos returns {ok, hits[]} envelope on happy path
 *   2. Authorization header sent as raw key (NOT "Bearer ...")
 *   3. Variant picker prefers portrait/square ≥ 720 over landscape
 *   4. Tags derived from page URL slug (Pexels has no tag array)
 *   5. Attribution fields populated from hit.user
 *   6. {ok:false, kind:'empty'} when API returns zero videos
 *   7. {ok:false, kind:'upstream', status} on 5xx
 *   8. {ok:false, kind:'parse'} on invalid query
 *   9. Rate-limit headers parsed + low-remaining warning logged
 *  10. Duration filter drops hits outside [minDur, maxDur]
 *  11. apiKey required (throws when missing)
 *
 * Tier 2-a (PR shipping with this file).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { searchPexelsVideos } from '../lib/pexels_video.js';

// Build a minimal Response-like object the search code can read.
function mockResponse({ status = 200, body = null, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        // case-insensitive lookup
        const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
        return key ? headers[key] : null;
      },
    },
    async json() {
      if (typeof body === 'string') throw new Error('not JSON');
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

// Canonical Pexels API hit fragment.
function mockHit(overrides = {}) {
  return {
    id: 1234567,
    width: 1920, height: 1080,
    duration: 12,
    url: 'https://www.pexels.com/video/a-family-meets-with-an-estate-planning-attorney-1234567/',
    user: {
      id: 42,
      name: 'Jane Doe',
      url: 'https://www.pexels.com/@jane-doe',
    },
    video_files: [
      { id: 1, link: 'https://videos.pexels.com/v/sd.mp4', width: 640, height: 360, file_type: 'video/mp4', fps: 30, quality: 'sd' },
      { id: 2, link: 'https://videos.pexels.com/v/hd.mp4', width: 1280, height: 720, file_type: 'video/mp4', fps: 30, quality: 'hd' },
    ],
    ...overrides,
  };
}

test('Tier2a Pexels: happy path → ok:true with normalized hits', async () => {
  const fetchImpl = async (url, init) => {
    // 2. Auth header is the raw key (no "Bearer " prefix)
    assert.equal(init?.headers?.Authorization, 'test-key');
    assert.match(url, /api\.pexels\.com\/videos\/search/);
    assert.match(url, /query=family/);
    return mockResponse({ status: 200, body: { videos: [mockHit()] } });
  };
  const r = await searchPexelsVideos({ query: 'family planning', apiKey: 'test-key', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.hits.length, 1);
  const h = r.hits[0];
  assert.equal(h.id, 1234567);
  assert.equal(h.duration, 12);
  // 3. Variant pick: 720p HD over 360p SD (smallest ≥ 720 on shorter axis)
  assert.equal(h.videoUrl, 'https://videos.pexels.com/v/hd.mp4');
  assert.equal(h.width, 1280);
  assert.equal(h.height, 720);
  assert.equal(h.tier, 'landscape');                // landscape since 1280×720 (h<w)
  // 4. Tags derived from slug
  assert.match(h.tags, /family meets with an estate planning attorney/i);
  // 5. Attribution
  assert.equal(h.attributionUser, 'Jane Doe');
  assert.equal(h.attributionUrl, 'https://www.pexels.com/@jane-doe');
});

test('Tier2a Pexels: variant picker prefers PORTRAIT over landscape when available', async () => {
  const fetchImpl = async () => mockResponse({
    status: 200,
    body: { videos: [mockHit({
      video_files: [
        { link: 'https://v/landscape.mp4', width: 1920, height: 1080, file_type: 'video/mp4', quality: 'hd' },
        { link: 'https://v/portrait.mp4', width: 1080, height: 1920, file_type: 'video/mp4', quality: 'hd' },
      ],
    })] },
  });
  const r = await searchPexelsVideos({ query: 'q', apiKey: 'k', fetchImpl });
  assert.equal(r.hits[0].videoUrl, 'https://v/portrait.mp4');
  assert.equal(r.hits[0].tier, 'portrait');
});

test('Tier2a Pexels: variant picker prefers smallest variant ≥ 720 (avoid 4K bloat)', async () => {
  const fetchImpl = async () => mockResponse({
    status: 200,
    body: { videos: [mockHit({
      video_files: [
        { link: 'https://v/sd.mp4',  width: 640, height: 360,  file_type: 'video/mp4', quality: 'sd' },
        { link: 'https://v/hd.mp4',  width: 1280, height: 720, file_type: 'video/mp4', quality: 'hd' },
        { link: 'https://v/uhd.mp4', width: 3840, height: 2160, file_type: 'video/mp4', quality: 'uhd' },
      ],
    })] },
  });
  const r = await searchPexelsVideos({ query: 'q', apiKey: 'k', fetchImpl });
  assert.equal(r.hits[0].videoUrl, 'https://v/hd.mp4', 'should pick 720p, not 4K');
});

test('Tier2a Pexels: drops variants with no link or non-mp4 file_type', async () => {
  const fetchImpl = async () => mockResponse({
    status: 200,
    body: { videos: [mockHit({
      video_files: [
        { link: '',                       width: 1920, height: 1080, file_type: 'video/mp4' },
        { link: 'https://v/webm.webm',    width: 1920, height: 1080, file_type: 'video/webm' },
        { link: 'https://v/good.mp4',    width: 1280, height: 720,   file_type: 'video/mp4' },
      ],
    })] },
  });
  const r = await searchPexelsVideos({ query: 'q', apiKey: 'k', fetchImpl });
  assert.equal(r.hits[0].videoUrl, 'https://v/good.mp4');
});

test('Tier2a Pexels: returns {ok:false, kind:"empty"} when API gives zero videos', async () => {
  const fetchImpl = async () => mockResponse({ status: 200, body: { videos: [] } });
  const r = await searchPexelsVideos({ query: 'no matches', apiKey: 'k', fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'empty');
});

test('Tier2a Pexels: returns {ok:false, kind:"upstream", status} on 5xx', async () => {
  const fetchImpl = async () => mockResponse({ status: 503, body: 'service unavailable' });
  const r = await searchPexelsVideos({ query: 'q', apiKey: 'k', fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'upstream');
  assert.equal(r.status, 503);
});

test('Tier2a Pexels: returns {ok:false, kind:"upstream"} on network error', async () => {
  const fetchImpl = async () => { throw new Error('ETIMEDOUT'); };
  const r = await searchPexelsVideos({ query: 'q', apiKey: 'k', fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'upstream');
  assert.match(r.body, /ETIMEDOUT/);
});

test('Tier2a Pexels: returns {ok:false, kind:"parse"} on empty query', async () => {
  const r = await searchPexelsVideos({ query: '', apiKey: 'k', fetchImpl: async () => mockResponse() });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'parse');
});

test('Tier2a Pexels: throws when apiKey missing', async () => {
  await assert.rejects(
    () => searchPexelsVideos({ query: 'q', fetchImpl: async () => mockResponse() }),
    /apiKey is required/,
  );
});

test('Tier2a Pexels: parses X-Ratelimit-Remaining + warns when <20%', async () => {
  const originalWarn = console.warn;
  let warned = null;
  console.warn = (msg) => { warned = msg; };
  try {
    const fetchImpl = async () => mockResponse({
      status: 200,
      body: { videos: [mockHit()] },
      headers: { 'X-Ratelimit-Remaining': '15', 'X-Ratelimit-Limit': '200' },
    });
    const r = await searchPexelsVideos({ query: 'q', apiKey: 'k', fetchImpl });
    assert.equal(r.rateLimitRemaining, 15);
    assert.equal(r.rateLimitLimit, 200);
    assert.match(warned, /rate-limit LOW.*15\/200/);
  } finally {
    console.warn = originalWarn;
  }
});

test('Tier2a Pexels: does NOT warn when rate-limit comfortably remains', async () => {
  const originalWarn = console.warn;
  let warned = null;
  console.warn = (msg) => { warned = msg; };
  try {
    const fetchImpl = async () => mockResponse({
      status: 200,
      body: { videos: [mockHit()] },
      headers: { 'X-Ratelimit-Remaining': '180', 'X-Ratelimit-Limit': '200' },
    });
    const r = await searchPexelsVideos({ query: 'q', apiKey: 'k', fetchImpl });
    assert.equal(r.rateLimitRemaining, 180);
    assert.equal(warned, null, 'no warning at 90% remaining');
  } finally {
    console.warn = originalWarn;
  }
});

test('Tier2a Pexels: duration filter drops hits outside [minDur, maxDur]', async () => {
  const fetchImpl = async () => mockResponse({
    status: 200,
    body: { videos: [
      mockHit({ id: 1, duration: 2  }),    // < 3 → drop
      mockHit({ id: 2, duration: 12 }),    // keep
      mockHit({ id: 3, duration: 99 }),    // > 60 → drop
    ] },
  });
  const r = await searchPexelsVideos({ query: 'q', apiKey: 'k', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].id, 2);
});

test('Tier2a Pexels: returns {ok:false, kind:"empty"} when all hits filtered out', async () => {
  const fetchImpl = async () => mockResponse({
    status: 200,
    body: { videos: [mockHit({ duration: 2 })] }, // all under minDur
  });
  const r = await searchPexelsVideos({ query: 'q', apiKey: 'k', fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'empty');
});
