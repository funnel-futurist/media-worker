/**
 * test/bgm_select.test.js
 *
 * Mocked-Gemini tests for selectBgm. Same pattern as
 * test/stock_keyword_gen.test.js + test/bad_take_detect.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { selectBgm } from '../lib/bgm_select.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'gemini-bgm-select-success.json'), 'utf8'));

function fakeResponse({ ok = true, status = 200, body }) {
  return {
    ok,
    status,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    async json() { return body; },
    clone() { return fakeResponse({ ok, status, body }); },
  };
}
function geminiResponseFor(inner) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(inner) }] } }] };
}
function mockFetcher(inner, { ok = true, status = 200 } = {}) {
  return async () => fakeResponse({ ok, status, body: geminiResponseFor(inner) });
}

const SAMPLE = {
  transcript: [
    { startSec: 0, endSec: 3, text: 'Families wait too long to plan.' },
    { startSec: 3, endSec: 7, text: 'The documents pile up on the desk.' },
  ],
  durationSec: 60,
};

// ── happy path ────────────────────────────────────────────────────────

test('selectBgm: parses mood/genre/instrumentTags/tempo/searchQuery', async () => {
  const out = await selectBgm(SAMPLE, {
    apiKey: 'test',
    fetchImpl: async () => fakeResponse({ body: FIXTURE }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.mood, 'warm, hopeful');
  assert.equal(out.genre, 'acoustic folk');
  assert.deepEqual(out.instrumentTags, ['acoustic guitar', 'soft piano']);
  assert.equal(out.tempo, 'moderate');
  assert.equal(out.searchQuery, 'warm acoustic folk guitar');
  assert.equal(out.model, 'gemini-3.1-pro-preview');
});

test('selectBgm: trims whitespace on string fields', async () => {
  const out = await selectBgm(SAMPLE, {
    apiKey: 'test',
    fetchImpl: mockFetcher({
      mood: '  warm  ', genre: ' folk ',
      instrumentTags: ['  guitar  ', ' piano '],
      tempo: 'slow', searchQuery: '  warm folk guitar  ',
    }),
  });
  assert.equal(out.mood, 'warm');
  assert.equal(out.genre, 'folk');
  assert.deepEqual(out.instrumentTags, ['guitar', 'piano']);
  assert.equal(out.searchQuery, 'warm folk guitar');
});

test('selectBgm: defaults invalid tempo to "moderate"', async () => {
  const out = await selectBgm(SAMPLE, {
    apiKey: 'test',
    fetchImpl: mockFetcher({
      mood: 'x', genre: 'x',
      instrumentTags: ['x'],
      tempo: 'lightning fast',
      searchQuery: 'x',
    }),
  });
  assert.equal(out.tempo, 'moderate');
});

test('selectBgm: caps instrumentTags at 6 entries', async () => {
  const out = await selectBgm(SAMPLE, {
    apiKey: 'test',
    fetchImpl: mockFetcher({
      mood: 'x', genre: 'x',
      instrumentTags: ['1', '2', '3', '4', '5', '6', '7', '8'],
      tempo: 'slow', searchQuery: 'x',
    }),
  });
  assert.equal(out.instrumentTags.length, 6);
});

test('selectBgm: filters non-string instrumentTags', async () => {
  const out = await selectBgm(SAMPLE, {
    apiKey: 'test',
    fetchImpl: mockFetcher({
      mood: 'x', genre: 'x',
      instrumentTags: ['ok', null, 5, 'also-ok', undefined],
      tempo: 'slow', searchQuery: 'x',
    }),
  });
  assert.deepEqual(out.instrumentTags, ['ok', 'also-ok']);
});

// ── envelope failures ─────────────────────────────────────────────────

test('selectBgm: returns kind=upstream on 5xx', async () => {
  const out = await selectBgm(SAMPLE, {
    apiKey: 'test',
    fetchImpl: async () => fakeResponse({ ok: false, status: 503, body: 'unavailable' }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'upstream');
  assert.equal(out.status, 503);
});

test('selectBgm: returns kind=upstream when fetcher throws', async () => {
  const out = await selectBgm(SAMPLE, {
    apiKey: 'test',
    fetchImpl: async () => { throw new Error('rate-limit'); },
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'upstream');
});

test('selectBgm: returns kind=empty when no candidates', async () => {
  const out = await selectBgm(SAMPLE, {
    apiKey: 'test',
    fetchImpl: async () => fakeResponse({ body: { candidates: [] } }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'empty');
});

test('selectBgm: returns kind=parse on malformed inner JSON', async () => {
  const out = await selectBgm(SAMPLE, {
    apiKey: 'test',
    fetchImpl: async () => fakeResponse({
      body: { candidates: [{ content: { parts: [{ text: 'not json' }] } }] },
    }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'parse');
});

test('selectBgm: returns kind=shape when mood/genre/searchQuery missing', async () => {
  const out = await selectBgm(SAMPLE, {
    apiKey: 'test',
    fetchImpl: mockFetcher({ mood: '', genre: 'folk', searchQuery: 'x' }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'shape');
});

// ── prompt construction ─────────────────────────────────────────────

test('selectBgm: includes transcript text in user prompt', async () => {
  let captured;
  const fetcher = async (_url, init) => {
    captured = JSON.parse(init.body);
    return fakeResponse({ body: geminiResponseFor({
      mood: 'x', genre: 'x', instrumentTags: ['x'], tempo: 'slow', searchQuery: 'x',
    }) });
  };
  await selectBgm(SAMPLE, { apiKey: 'test', fetchImpl: fetcher });
  const userText = captured.contents[0].parts[0].text;
  assert.match(userText, /Families wait too long/);
});

test('selectBgm: includes durationSec in user prompt', async () => {
  let captured;
  const fetcher = async (_url, init) => {
    captured = JSON.parse(init.body);
    return fakeResponse({ body: geminiResponseFor({
      mood: 'x', genre: 'x', instrumentTags: ['x'], tempo: 'slow', searchQuery: 'x',
    }) });
  };
  await selectBgm({ ...SAMPLE, durationSec: 88 }, { apiKey: 'test', fetchImpl: fetcher });
  const userText = captured.contents[0].parts[0].text;
  assert.match(userText, /88s/);
});

test('selectBgm: defaults to gemini-3.1-pro-preview (no Flash)', async () => {
  let capturedUrl;
  const fetcher = async (url) => {
    capturedUrl = url;
    return fakeResponse({ body: geminiResponseFor({
      mood: 'x', genre: 'x', instrumentTags: ['x'], tempo: 'slow', searchQuery: 'x',
    }) });
  };
  await selectBgm(SAMPLE, { apiKey: 'test', fetchImpl: fetcher });
  assert.match(capturedUrl, /gemini-3\.1-pro-preview/);
  assert.doesNotMatch(capturedUrl, /flash/i);
});

test('selectBgm: requests JSON response with low-temperature stable output', async () => {
  let captured;
  const fetcher = async (_url, init) => {
    captured = JSON.parse(init.body);
    return fakeResponse({ body: geminiResponseFor({
      mood: 'x', genre: 'x', instrumentTags: ['x'], tempo: 'slow', searchQuery: 'x',
    }) });
  };
  await selectBgm(SAMPLE, { apiKey: 'test', fetchImpl: fetcher });
  assert.equal(captured.generationConfig.responseMimeType, 'application/json');
  assert.ok(captured.generationConfig.temperature <= 0.5);
});

test('selectBgm: throws when GEMINI_API_KEY unset', async () => {
  const original = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(
      () => selectBgm(SAMPLE, { fetchImpl: mockFetcher({}) }),
      /GEMINI_API_KEY is not set/,
    );
  } finally {
    if (original !== undefined) process.env.GEMINI_API_KEY = original;
  }
});
