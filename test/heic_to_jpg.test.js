/**
 * test/heic_to_jpg.test.js
 *
 * Mocked-converter tests for `convertHeicToJpg`. The real HEIC decoding is
 * delegated to the npm package `heic-convert` — we don't re-test their
 * decoder. What we DO test is our wrapper's contract:
 *   - reads input bytes
 *   - calls the converter with the right options
 *   - writes the JPEG bytes to outputPath
 *   - returns { outputPath, bytes, ms }
 *   - propagates converter errors as our own typed error
 *
 * Pattern matches lib/bgm_select.js: injectable `convertImpl` so the test
 * doesn't burn CPU on a real HEIC decode (and doesn't require shipping an
 * HEIC fixture). Phil's Railway rerun is the real integration test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { convertHeicToJpg, isHeicPath } from '../lib/heic_to_jpg.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function tmpDir() {
  return mkdtempSync(join(__dirname, 'tmp-heic-test-'));
}

// ── isHeicPath helper ────────────────────────────────────────────────

test('isHeicPath: matches .heic and .heif (case-insensitive)', () => {
  assert.equal(isHeicPath('photo.heic'), true);
  assert.equal(isHeicPath('photo.HEIC'), true);
  assert.equal(isHeicPath('photo.Heic'), true);
  assert.equal(isHeicPath('photo.heif'), true);
  assert.equal(isHeicPath('photo.HEIF'), true);
});

test('isHeicPath: rejects non-HEIC extensions', () => {
  assert.equal(isHeicPath('photo.jpg'), false);
  assert.equal(isHeicPath('photo.png'), false);
  assert.equal(isHeicPath('photo.mov'), false);
  assert.equal(isHeicPath('photo.mp4'), false);
});

test('isHeicPath: handles full paths and tolerates query strings', () => {
  assert.equal(isHeicPath('/tmp/job123/aid-42.heic'), true);
  assert.equal(isHeicPath('https://x.supabase.co/photo.heic?token=abc'), true);
  assert.equal(isHeicPath('https://x.supabase.co/uploads/heic_demo/clip.mp4'), false);
});

test('isHeicPath: defensive against null/undefined/empty', () => {
  assert.equal(isHeicPath(null), false);
  assert.equal(isHeicPath(undefined), false);
  assert.equal(isHeicPath(''), false);
  assert.equal(isHeicPath(42), false);
});

// ── convertHeicToJpg happy path ─────────────────────────────────────

test('convertHeicToJpg: writes output JPG bytes to outputPath', async () => {
  const dir = tmpDir();
  try {
    const inputPath = join(dir, 'photo.heic');
    const outputPath = join(dir, 'photo.jpg');
    writeFileSync(inputPath, Buffer.from('fake-heic-bytes'));
    const fakeConvert = async () => Buffer.from('fake-jpg-bytes');
    const out = await convertHeicToJpg({
      inputPath,
      outputPath,
      convertImpl: fakeConvert,
    });
    assert.equal(out.outputPath, outputPath);
    assert.equal(out.bytes, 14);                                   // 'fake-jpg-bytes'.length
    assert.equal(typeof out.ms, 'number');
    assert.ok(out.ms >= 0);
    assert.ok(existsSync(outputPath));
    assert.deepEqual(readFileSync(outputPath), Buffer.from('fake-jpg-bytes'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('convertHeicToJpg: passes input buffer + format=JPEG to the converter', async () => {
  const dir = tmpDir();
  try {
    const inputPath = join(dir, 'photo.heic');
    const outputPath = join(dir, 'photo.jpg');
    const inputBytes = Buffer.from('xx HEIC payload xx');
    writeFileSync(inputPath, inputBytes);
    let captured = null;
    const fakeConvert = async (opts) => {
      captured = opts;
      return Buffer.from('out');
    };
    await convertHeicToJpg({ inputPath, outputPath, convertImpl: fakeConvert });
    assert.ok(captured, 'converter should be called');
    assert.equal(captured.format, 'JPEG');
    assert.deepEqual(captured.buffer, inputBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('convertHeicToJpg: default quality is 0.8 (JPG quality 0-1 per heic-convert API)', async () => {
  const dir = tmpDir();
  try {
    const inputPath = join(dir, 'photo.heic');
    const outputPath = join(dir, 'photo.jpg');
    writeFileSync(inputPath, Buffer.from('x'));
    let captured = null;
    const fakeConvert = async (opts) => {
      captured = opts;
      return Buffer.from('out');
    };
    await convertHeicToJpg({ inputPath, outputPath, convertImpl: fakeConvert });
    assert.equal(captured.quality, 0.8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('convertHeicToJpg: caller-supplied quality overrides default', async () => {
  const dir = tmpDir();
  try {
    const inputPath = join(dir, 'photo.heic');
    const outputPath = join(dir, 'photo.jpg');
    writeFileSync(inputPath, Buffer.from('x'));
    let captured = null;
    const fakeConvert = async (opts) => {
      captured = opts;
      return Buffer.from('out');
    };
    await convertHeicToJpg({
      inputPath, outputPath, quality: 0.95, convertImpl: fakeConvert,
    });
    assert.equal(captured.quality, 0.95);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── error handling ──────────────────────────────────────────────────

test('convertHeicToJpg: throws clear error when inputPath missing on disk', async () => {
  const dir = tmpDir();
  try {
    await assert.rejects(
      () => convertHeicToJpg({
        inputPath: join(dir, 'nope.heic'),
        outputPath: join(dir, 'nope.jpg'),
        convertImpl: async () => Buffer.from('x'),
      }),
      /ENOENT|no such file/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('convertHeicToJpg: re-throws converter failure with context (which file failed)', async () => {
  const dir = tmpDir();
  try {
    const inputPath = join(dir, 'photo.heic');
    writeFileSync(inputPath, Buffer.from('not actually a heic'));
    const failingConvert = async () => { throw new Error('libheif: not a HEIF/HEIC file'); };
    await assert.rejects(
      () => convertHeicToJpg({
        inputPath,
        outputPath: join(dir, 'photo.jpg'),
        convertImpl: failingConvert,
      }),
      /heic_to_jpg.*photo\.heic.*libheif/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('convertHeicToJpg: rejects when inputPath missing/empty', async () => {
  await assert.rejects(
    () => convertHeicToJpg({ outputPath: '/tmp/x.jpg' }),
    /inputPath is required/,
  );
});

test('convertHeicToJpg: rejects when outputPath missing/empty', async () => {
  await assert.rejects(
    () => convertHeicToJpg({ inputPath: '/tmp/x.heic' }),
    /outputPath is required/,
  );
});
