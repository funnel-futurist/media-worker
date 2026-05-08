/**
 * test/audio_qc.test.js
 *
 * Mocked tests for the optional Gemini Pro perceptual QC. Both the ffmpeg
 * sample extraction and the Gemini API call are mocked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runBgmAudioQc } from '../lib/audio_qc.js';

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

const fakeExtract = async () => ({ stdout: '', stderr: '' });
const fakeRead = () => Buffer.from('fake mp3 audio bytes');

// ── happy path ────────────────────────────────────────────────────────

test('runBgmAudioQc: parses good verdict from Gemini', async () => {
  const out = await runBgmAudioQc(
    { finalPath: '/tmp/x/final.mp4' },
    {
      apiKey: 'test',
      execImpl: fakeExtract,
      readFileImpl: fakeRead,
      fetchImpl: mockFetcher({
        speech_score: 9, verdict: 'good', suggested_db_reduction: 0,
        notes: 'voice clear, music supports without distracting',
      }),
    },
  );
  assert.equal(out.ok, true);
  assert.equal(out.speechScore, 9);
  assert.equal(out.verdict, 'good');
  assert.equal(out.suggestedDbReduction, 0);
  assert.match(out.notes, /voice clear/);
  assert.equal(out.model, 'gemini-3.1-pro-preview');
});

test('runBgmAudioQc: parses too_loud verdict + non-zero suggested reduction', async () => {
  const out = await runBgmAudioQc(
    { finalPath: '/tmp/x/final.mp4' },
    {
      apiKey: 'test',
      execImpl: fakeExtract,
      readFileImpl: fakeRead,
      fetchImpl: mockFetcher({
        speech_score: 5, verdict: 'too_loud', suggested_db_reduction: -3,
        notes: 'music swallows consonants on quiet phrases',
      }),
    },
  );
  assert.equal(out.verdict, 'too_loud');
  assert.equal(out.suggestedDbReduction, -3);
});

test('runBgmAudioQc: parses borderline verdict', async () => {
  const out = await runBgmAudioQc(
    { finalPath: '/tmp/x/final.mp4' },
    {
      apiKey: 'test', execImpl: fakeExtract, readFileImpl: fakeRead,
      fetchImpl: mockFetcher({
        speech_score: 7, verdict: 'borderline', suggested_db_reduction: -2, notes: 'ok-ish',
      }),
    },
  );
  assert.equal(out.verdict, 'borderline');
});

test('runBgmAudioQc: defaults notes to "" when missing', async () => {
  const out = await runBgmAudioQc(
    { finalPath: '/tmp/x/final.mp4' },
    {
      apiKey: 'test', execImpl: fakeExtract, readFileImpl: fakeRead,
      fetchImpl: mockFetcher({
        speech_score: 9, verdict: 'good', suggested_db_reduction: 0,
        // notes omitted
      }),
    },
  );
  assert.equal(out.notes, '');
});

// ── envelope failures ────────────────────────────────────────────────

test('runBgmAudioQc: returns kind=extract when ffmpeg sample fails', async () => {
  const out = await runBgmAudioQc(
    { finalPath: '/tmp/x/final.mp4' },
    {
      apiKey: 'test',
      execImpl: async () => { throw new Error('ffmpeg crashed'); },
      readFileImpl: fakeRead,
      fetchImpl: mockFetcher({}),
    },
  );
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'extract');
  assert.match(out.body, /ffmpeg crashed/);
});

test('runBgmAudioQc: returns kind=upstream on 5xx', async () => {
  const out = await runBgmAudioQc(
    { finalPath: '/tmp/x/final.mp4' },
    {
      apiKey: 'test',
      execImpl: fakeExtract,
      readFileImpl: fakeRead,
      fetchImpl: async () => fakeResponse({ ok: false, status: 503, body: 'unavailable' }),
    },
  );
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'upstream');
  assert.equal(out.status, 503);
});

test('runBgmAudioQc: returns kind=upstream when fetcher throws', async () => {
  const out = await runBgmAudioQc(
    { finalPath: '/tmp/x/final.mp4' },
    {
      apiKey: 'test',
      execImpl: fakeExtract,
      readFileImpl: fakeRead,
      fetchImpl: async () => { throw new Error('rate-limit'); },
    },
  );
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'upstream');
});

test('runBgmAudioQc: returns kind=empty when no candidates', async () => {
  const out = await runBgmAudioQc(
    { finalPath: '/tmp/x/final.mp4' },
    {
      apiKey: 'test', execImpl: fakeExtract, readFileImpl: fakeRead,
      fetchImpl: async () => fakeResponse({ body: { candidates: [] } }),
    },
  );
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'empty');
});

test('runBgmAudioQc: returns kind=parse on bad inner JSON', async () => {
  const out = await runBgmAudioQc(
    { finalPath: '/tmp/x/final.mp4' },
    {
      apiKey: 'test', execImpl: fakeExtract, readFileImpl: fakeRead,
      fetchImpl: async () => fakeResponse({
        body: { candidates: [{ content: { parts: [{ text: 'not json' }] } }] },
      }),
    },
  );
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'parse');
});

test('runBgmAudioQc: returns kind=shape when verdict missing', async () => {
  const out = await runBgmAudioQc(
    { finalPath: '/tmp/x/final.mp4' },
    {
      apiKey: 'test', execImpl: fakeExtract, readFileImpl: fakeRead,
      fetchImpl: mockFetcher({ speech_score: 9, suggested_db_reduction: 0 }),  // no verdict
    },
  );
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'shape');
});

test('runBgmAudioQc: returns kind=shape when verdict is unknown value', async () => {
  const out = await runBgmAudioQc(
    { finalPath: '/tmp/x/final.mp4' },
    {
      apiKey: 'test', execImpl: fakeExtract, readFileImpl: fakeRead,
      fetchImpl: mockFetcher({ speech_score: 9, verdict: 'amazing', suggested_db_reduction: 0 }),
    },
  );
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'shape');
});

// ── prompt construction ─────────────────────────────────────────────

test('runBgmAudioQc: posts inlineData with mimeType audio/mpeg + text prompt', async () => {
  let capturedBody;
  const fetcher = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return fakeResponse({ body: geminiResponseFor({
      speech_score: 9, verdict: 'good', suggested_db_reduction: 0, notes: '',
    }) });
  };
  await runBgmAudioQc(
    { finalPath: '/tmp/x/final.mp4' },
    { apiKey: 'test', execImpl: fakeExtract, readFileImpl: fakeRead, fetchImpl: fetcher },
  );
  const parts = capturedBody.contents[0].parts;
  assert.equal(parts.length, 2);
  assert.equal(parts[0].inlineData.mimeType, 'audio/mpeg');
  assert.ok(typeof parts[0].inlineData.data === 'string', 'inlineData.data must be the base64 audio');
  assert.match(parts[1].text, /speech intelligibility/);
  assert.match(parts[1].text, /JSON/);
});

test('runBgmAudioQc: defaults to gemini-3.1-pro-preview (no Flash)', async () => {
  let capturedUrl;
  const fetcher = async (url) => {
    capturedUrl = url;
    return fakeResponse({ body: geminiResponseFor({
      speech_score: 9, verdict: 'good', suggested_db_reduction: 0, notes: '',
    }) });
  };
  await runBgmAudioQc(
    { finalPath: '/tmp/x/final.mp4' },
    { apiKey: 'test', execImpl: fakeExtract, readFileImpl: fakeRead, fetchImpl: fetcher },
  );
  assert.match(capturedUrl, /gemini-3\.1-pro-preview/);
  assert.doesNotMatch(capturedUrl, /flash/i);
});

test('runBgmAudioQc: throws when finalPath missing', async () => {
  await assert.rejects(
    () => runBgmAudioQc({}, { apiKey: 'test' }),
    /finalPath is required/,
  );
});

test('runBgmAudioQc: throws when GEMINI_API_KEY unset', async () => {
  const original = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await assert.rejects(
      () => runBgmAudioQc({ finalPath: '/x/final.mp4' }, { execImpl: fakeExtract, readFileImpl: fakeRead }),
      /GEMINI_API_KEY is not set/,
    );
  } finally {
    if (original !== undefined) process.env.GEMINI_API_KEY = original;
  }
});
