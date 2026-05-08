/**
 * test/face_detect.test.js
 *
 * Unit tests for the lib/face_detect.js Node wrapper. The Python script is
 * mocked via the `spawnImpl` opts hook so the suite stays fast + offline +
 * cross-platform (no actual python3/opencv invocation).
 *
 * What we test:
 *   - Spawn output parsing (stdout float)
 *   - Fallback to 0.5 on every failure mode (parse error, out-of-range, spawn
 *     error, process error, timeout, non-zero exit)
 *   - source='detected' vs 'fallback' classification
 *   - buildCropXExpression generates the right ffmpeg expression for various
 *     offsetX values
 *
 * What we DON'T test here:
 *   - The actual OpenCV face detection — that's the Python script's job
 *   - End-to-end ffmpeg crop behavior — that's verified by manual visual
 *     review (B11 vs B10) and by test/compose_filter.test.js (pattern match)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { detectFaceOffsetX, buildCropXExpression } from '../lib/face_detect.js';

// ── Fake child process factory ────────────────────────────────────────

/**
 * Build a fake spawn that emits the given stdout/stderr and exits with a
 * given code after `delayMs`. Returns a function with the same signature
 * as child_process.spawn.
 */
function fakeSpawn({ stdout = '', stderr = '', exitCode = 0, delayMs = 0, errorEvent = null }) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => { /* noop */ };
    setTimeout(() => {
      if (errorEvent) {
        proc.emit('error', errorEvent);
        return;
      }
      if (stdout) proc.stdout.emit('data', stdout);
      if (stderr) proc.stderr.emit('data', stderr);
      proc.emit('close', exitCode);
    }, delayMs);
    return proc;
  };
}

/** Spawn that throws synchronously (e.g. python3 not on PATH). */
function throwingSpawn(message) {
  return () => {
    throw new Error(message);
  };
}

// ── happy path ────────────────────────────────────────────────────────

test('detectFaceOffsetX: parses valid float from stdout', async () => {
  const result = await detectFaceOffsetX('/fake/video.mp4', {
    spawnImpl: fakeSpawn({ stdout: '0.4231\n' }),
  });
  assert.equal(result.offsetX, 0.4231);
  assert.equal(result.source, 'detected');
  assert.match(result.detail, /median face center/);
});

test('detectFaceOffsetX: classifies exact 0.5 as fallback (no faces case)', async () => {
  // The Python script returns "0.5" both for "centered face" and "no faces".
  // We treat exact-center as fallback so the orchestrator can report
  // transparently — same behavior happens in either case (center crop).
  const result = await detectFaceOffsetX('/fake/video.mp4', {
    spawnImpl: fakeSpawn({ stdout: '0.5000\n', stderr: 'face_detect: no faces in any...\n' }),
  });
  assert.equal(result.offsetX, 0.5);
  assert.equal(result.source, 'fallback');
  assert.match(result.detail, /no faces detected/);
});

test('detectFaceOffsetX: passes stderr through to console (operator audit)', async () => {
  // Capture console.log output to verify stderr forwarding
  const originalLog = console.log;
  const captured = [];
  console.log = (...args) => { captured.push(args.join(' ')); };
  try {
    await detectFaceOffsetX('/fake/video.mp4', {
      spawnImpl: fakeSpawn({
        stdout: '0.42\n',
        stderr: 'face_detect: 7/8 samples had faces (median=0.420)\n',
      }),
    });
  } finally {
    console.log = originalLog;
  }
  assert.ok(
    captured.some((line) => /face_detect.*samples had faces/.test(line)),
    `expected stderr forwarded to console; captured=${JSON.stringify(captured)}`,
  );
});

// ── parse failure → fallback ──────────────────────────────────────────

test('detectFaceOffsetX: non-numeric stdout → fallback', async () => {
  const result = await detectFaceOffsetX('/fake/video.mp4', {
    spawnImpl: fakeSpawn({ stdout: 'not a number\n', exitCode: 0 }),
  });
  assert.equal(result.offsetX, 0.5);
  assert.equal(result.source, 'fallback');
  assert.match(result.detail, /non-numeric/);
});

test('detectFaceOffsetX: empty stdout → fallback', async () => {
  const result = await detectFaceOffsetX('/fake/video.mp4', {
    spawnImpl: fakeSpawn({ stdout: '', exitCode: 1 }),
  });
  assert.equal(result.offsetX, 0.5);
  assert.equal(result.source, 'fallback');
});

test('detectFaceOffsetX: out-of-range value → fallback', async () => {
  // Python script should never produce these (it always emits 0.0-1.0 or 0.5)
  // but the wrapper guards against future bugs.
  for (const bad of ['1.5', '-0.1', '99.0']) {
    const result = await detectFaceOffsetX('/fake/video.mp4', {
      spawnImpl: fakeSpawn({ stdout: `${bad}\n` }),
    });
    assert.equal(result.offsetX, 0.5, `bad value ${bad} should fallback`);
    assert.equal(result.source, 'fallback');
    assert.match(result.detail, /out-of-range/);
  }
});

// ── process failure → fallback ────────────────────────────────────────

test('detectFaceOffsetX: synchronous spawn error → fallback (e.g. python3 missing)', async () => {
  const result = await detectFaceOffsetX('/fake/video.mp4', {
    spawnImpl: throwingSpawn('spawn python3 ENOENT'),
  });
  assert.equal(result.offsetX, 0.5);
  assert.equal(result.source, 'fallback');
  assert.match(result.detail, /spawn error.*ENOENT/);
});

test("detectFaceOffsetX: process 'error' event → fallback", async () => {
  const result = await detectFaceOffsetX('/fake/video.mp4', {
    spawnImpl: fakeSpawn({ errorEvent: new Error('child died') }),
  });
  assert.equal(result.offsetX, 0.5);
  assert.equal(result.source, 'fallback');
  assert.match(result.detail, /process error.*child died/);
});

test('detectFaceOffsetX: hits timeout → fallback', async () => {
  // Use a 50ms timeout against a fake spawn that takes 200ms to exit.
  const result = await detectFaceOffsetX('/fake/video.mp4', {
    timeoutMs: 50,
    spawnImpl: fakeSpawn({ stdout: '0.42\n', delayMs: 200 }),
  });
  assert.equal(result.offsetX, 0.5);
  assert.equal(result.source, 'fallback');
  assert.match(result.detail, /timed out after 50ms/);
});

// ── buildCropXExpression ──────────────────────────────────────────────

test('buildCropXExpression: center (0.5) produces a clamped expression', () => {
  const expr = buildCropXExpression(0.5);
  // Should reference iw and use the formula offsetX*iw - 540, clamped to [0, iw-1080].
  assert.match(expr, /iw/);
  assert.match(expr, /max\(0/);
  assert.match(expr, /min\(iw-1080/);
  assert.match(expr, /0\.5000\*iw-540/);
});

test('buildCropXExpression: off-center (0.42) embeds the offsetX value to 4 decimals', () => {
  const expr = buildCropXExpression(0.4231);
  assert.match(expr, /0\.4231\*iw-540/);
});

test('buildCropXExpression: clamps out-of-range input defensively', () => {
  // Caller should already have clamped, but we don't want a malformed
  // float (negative or >1) to produce a broken filter expression that
  // crashes ffmpeg at runtime.
  const tooLow = buildCropXExpression(-0.5);
  assert.match(tooLow, /0\.0000\*iw-540/);

  const tooHigh = buildCropXExpression(1.5);
  assert.match(tooHigh, /1\.0000\*iw-540/);
});

test('buildCropXExpression: escapes commas inside max/min for ffmpeg filter graph', () => {
  // ffmpeg uses commas as filter-chain separators, so commas inside
  // function calls inside a filter argument MUST be backslash-escaped.
  // Otherwise the expression would be interpreted as multiple filter args.
  const expr = buildCropXExpression(0.5);
  // Each comma inside max() / min() should be preceded by a backslash.
  assert.ok(expr.includes('max(0\\,'), `expected backslash-comma after max(0; got ${expr}`);
  assert.ok(expr.includes('min(iw-1080\\,'), `expected backslash-comma after min(iw-1080; got ${expr}`);
});

test('buildCropXExpression: deterministic output for the same input', () => {
  // Lock-in: the same offsetX produces the same expression byte-for-byte.
  // This matters because composeFaceAndBrolls's filter graph is a string
  // we want to be reproducible across runs (helps cache / debugging).
  const a = buildCropXExpression(0.4231);
  const b = buildCropXExpression(0.4231);
  assert.equal(a, b);
});
