/**
 * test/stock_keyword_gen.test.js
 *
 * Mocked-Gemini tests for `generateStockKeywords`. Same `fetchImpl`
 * injection pattern used in slate_detect.test.js and bad_take_detect.test.js
 * — keeps the suite offline + reproducible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { generateStockKeywords } from '../lib/stock_keyword_gen.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'gemini-stock-keywords-success.json'), 'utf8'));

// Helpers — mirror the pattern in test/slate_detect.test.js + bad_take_detect.test.js
function fakeResponse({ ok = true, status = 200, body }) {
  return {
    ok,
    status,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    async json() { return body; },
    clone() { return fakeResponse({ ok, status, body }); },
  };
}

function geminiResponseFor(innerJson) {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify(innerJson) }] } }],
  };
}

function mockFetcher(innerJson, { ok = true, status = 200 } = {}) {
  return async () => fakeResponse({ ok, status, body: geminiResponseFor(innerJson) });
}

const SAMPLE_INPUT = {
  transcript: [
    { startSec: 0, endSec: 3, text: 'Families wait too long to plan.' },
    { startSec: 3, endSec: 7, text: 'The documents pile up on the desk.' },
  ],
  clientLibrarySize: 2,
  coverageGap: 6,
  durationSec: 60,
};

// ── happy path ────────────────────────────────────────────────────────

test('generateStockKeywords: parses keywords from Gemini envelope', async () => {
  const out = await generateStockKeywords(SAMPLE_INPUT, {
    apiKey: 'test',
    fetchImpl: async () => fakeResponse({ body: FIXTURE }),
  });
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.keywords));
  assert.ok(out.keywords.length >= 3);
  assert.ok(out.keywords.length <= 6);
  assert.equal(out.model, 'gemini-3.1-pro-preview');
  assert.match(out.reasoning, /family|planning|documents/i);
});

test('generateStockKeywords: dedupes keywords case-insensitively', async () => {
  const inner = {
    keywords: ['Family Planning', 'family planning', 'documents desk', 'DOCUMENTS DESK', 'calendar'],
    reasoning: 'test',
  };
  const out = await generateStockKeywords(SAMPLE_INPUT, {
    apiKey: 'test',
    fetchImpl: mockFetcher(inner),
  });
  assert.equal(out.ok, true);
  assert.equal(out.keywords.length, 3, `expected 3 unique; got ${JSON.stringify(out.keywords)}`);
});

test('generateStockKeywords: trims whitespace and drops empty/over-long keywords', async () => {
  const inner = {
    keywords: ['  family planning  ', '', '   ', 'a'.repeat(80), 'documents desk'],
    reasoning: '',
  };
  const out = await generateStockKeywords(SAMPLE_INPUT, {
    apiKey: 'test',
    fetchImpl: mockFetcher(inner),
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.keywords, ['family planning', 'documents desk']);
});

test('generateStockKeywords: returns ok with empty reasoning when missing', async () => {
  const out = await generateStockKeywords(SAMPLE_INPUT, {
    apiKey: 'test',
    fetchImpl: mockFetcher({ keywords: ['family', 'home', 'desk'] }),  // no reasoning field
  });
  assert.equal(out.ok, true);
  assert.equal(out.reasoning, '');
});

// ── envelope failure modes ─────────────────────────────────────────────

test('generateStockKeywords: returns kind=upstream on Gemini 5xx', async () => {
  const out = await generateStockKeywords(SAMPLE_INPUT, {
    apiKey: 'test',
    fetchImpl: async () => fakeResponse({ ok: false, status: 503, body: 'unavailable' }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'upstream');
  assert.equal(out.status, 503);
});

test('generateStockKeywords: returns kind=upstream when fetch throws', async () => {
  const out = await generateStockKeywords(SAMPLE_INPUT, {
    apiKey: 'test',
    fetchImpl: async () => { throw new Error('rate-limit retries exhausted'); },
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'upstream');
  assert.match(out.body, /rate-limit/);
});

test('generateStockKeywords: returns kind=empty when no candidates', async () => {
  const out = await generateStockKeywords(SAMPLE_INPUT, {
    apiKey: 'test',
    fetchImpl: async () => fakeResponse({ body: { candidates: [] } }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'empty');
});

test('generateStockKeywords: returns kind=parse on malformed inner JSON', async () => {
  const out = await generateStockKeywords(SAMPLE_INPUT, {
    apiKey: 'test',
    fetchImpl: async () => fakeResponse({
      body: { candidates: [{ content: { parts: [{ text: 'not json {' }] } }] },
    }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'parse');
});

test('generateStockKeywords: returns kind=shape when keywords[] missing', async () => {
  const out = await generateStockKeywords(SAMPLE_INPUT, {
    apiKey: 'test',
    fetchImpl: mockFetcher({ reasoning: 'forgot keywords' }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'shape');
});

test('generateStockKeywords: returns kind=shape when keywords are all empty after cleanup', async () => {
  const out = await generateStockKeywords(SAMPLE_INPUT, {
    apiKey: 'test',
    fetchImpl: mockFetcher({ keywords: ['', '   ', null, undefined], reasoning: '' }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'shape');
});

// ── prompt construction (verifies the request body shape) ──────────────

test('generateStockKeywords: includes transcript text in user prompt', async () => {
  let captured;
  const fetcher = async (_url, init) => {
    captured = JSON.parse(init.body);
    return fakeResponse({ body: geminiResponseFor({ keywords: ['x'], reasoning: '' }) });
  };
  await generateStockKeywords(SAMPLE_INPUT, { apiKey: 'test', fetchImpl: fetcher });
  const userText = captured.contents[0].parts[0].text;
  assert.match(userText, /Families wait too long/);
  assert.match(userText, /documents pile up/);
});

test('generateStockKeywords: includes coverage gap and library size in user prompt', async () => {
  let captured;
  const fetcher = async (_url, init) => {
    captured = JSON.parse(init.body);
    return fakeResponse({ body: geminiResponseFor({ keywords: ['x'], reasoning: '' }) });
  };
  await generateStockKeywords(
    { ...SAMPLE_INPUT, clientLibrarySize: 2, coverageGap: 6 },
    { apiKey: 'test', fetchImpl: fetcher },
  );
  const userText = captured.contents[0].parts[0].text;
  assert.match(userText, /2 usable assets/);
  assert.match(userText, /short by ~6/);
});

test('generateStockKeywords: requests JSON response with low-temperature stable output', async () => {
  let captured;
  const fetcher = async (_url, init) => {
    captured = JSON.parse(init.body);
    return fakeResponse({ body: geminiResponseFor({ keywords: ['x'], reasoning: '' }) });
  };
  await generateStockKeywords(SAMPLE_INPUT, { apiKey: 'test', fetchImpl: fetcher });
  assert.equal(captured.generationConfig.responseMimeType, 'application/json');
  assert.ok(captured.generationConfig.temperature <= 0.3, 'temperature should be ≤0.3 for stable keywords');
});

test('generateStockKeywords: defaults to gemini-3.1-pro-preview (no Flash downgrade)', async () => {
  let capturedUrl;
  const fetcher = async (url, _init) => {
    capturedUrl = url;
    return fakeResponse({ body: geminiResponseFor({ keywords: ['x'], reasoning: '' }) });
  };
  await generateStockKeywords(SAMPLE_INPUT, { apiKey: 'test', fetchImpl: fetcher });
  assert.match(capturedUrl, /gemini-3\.1-pro-preview/);
  assert.doesNotMatch(capturedUrl, /flash/i);
});

// ── env-var fallback ──────────────────────────────────────────────────

test('generateStockKeywords: throws when GEMINI_API_KEY unset and no opts.apiKey', async () => {
  const original = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(
      () => generateStockKeywords(SAMPLE_INPUT, { fetchImpl: mockFetcher({ keywords: ['x'] }) }),
      /GEMINI_API_KEY is not set/,
    );
  } finally {
    if (original !== undefined) process.env.GEMINI_API_KEY = original;
  }
});
