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
import { detectFaceOffsetX, buildCropXExpression, buildCropYExpression } from '../lib/face_detect.js';

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

test('detectFaceOffsetX: parses valid "x y" floats from stdout', async () => {
  const result = await detectFaceOffsetX('/fake/video.mp4', {
    spawnImpl: fakeSpawn({ stdout: '0.4231 0.6600\n' }),
  });
  assert.equal(result.offsetX, 0.4231);
  assert.equal(result.offsetY, 0.66);
  assert.equal(result.source, 'detected');
  assert.match(result.detail, /median face center/);
});

test('detectFaceOffsetX: missing y token → offsetY falls back to 0.5 (back-compat)', async () => {
  const result = await detectFaceOffsetX('/fake/video.mp4', {
    spawnImpl: fakeSpawn({ stdout: '0.4231\n' }),
  });
  assert.equal(result.offsetX, 0.4231);
  assert.equal(result.offsetY, 0.5);
  assert.equal(result.source, 'detected');
});

test('detectFaceOffsetX: out-of-range y → offsetY 0.5 but valid x preserved', async () => {
  const result = await detectFaceOffsetX('/fake/video.mp4', {
    spawnImpl: fakeSpawn({ stdout: '0.42 1.9\n' }),
  });
  assert.equal(result.offsetX, 0.42);
  assert.equal(result.offsetY, 0.5);
  assert.equal(result.source, 'detected');
});

test('detectFaceOffsetX: classifies exact 0.5 as fallback (no faces case)', async () => {
  // The Python script returns "0.5" both for "centered face" and "no faces".
  // We treat exact-center as fallback so the orchestrator can report
  // transparently — same behavior happens in either case (center crop).
  const result = await detectFaceOffsetX('/fake/video.mp4', {
    spawnImpl: fakeSpawn({ stdout: '0.5000 0.5000\n', stderr: 'face_detect: no faces in any...\n' }),
  });
  assert.equal(result.offsetX, 0.5);
  assert.equal(result.offsetY, 0.5);
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

// ── buildCropYExpression ──────────────────────────────────────────────

test('buildCropYExpression: 0.5 produces a headroom-biased clamped ih expression', () => {
  const expr = buildCropYExpression(0.5);
  // offsetY*ih - (0.5 + 0.10)*1920 = offsetY*ih - 1152 (center 960 + 192px
  // headroom), clamped to [0, ih-1920] (default cropHeight 1920).
  assert.match(expr, /ih/);
  assert.match(expr, /max\(0/);
  assert.match(expr, /min\(ih-1920/);
  assert.match(expr, /0\.5000\*ih-1152/);
});

test('buildCropYExpression: off-center (0.66) embeds offsetY + honors custom height + headroom', () => {
  const expr = buildCropYExpression(0.66, 1350); // 4:5 ad height
  // 1350 * (0.5 + 0.10) = 810
  assert.match(expr, /0\.6600\*ih-810/);
  assert.match(expr, /min\(ih-1350/);
});

test('buildCropYExpression: clamps out-of-range input defensively', () => {
  assert.match(buildCropYExpression(-0.5), /0\.0000\*ih-1152/);
  assert.match(buildCropYExpression(1.5), /1\.0000\*ih-1152/);
});

test('buildCropYExpression: applies a HEADROOM bias (offset > cropHeight/2 so hair is not clipped)', () => {
  // The subtracted offset must exceed half the height — that upward shift IS
  // the headroom that keeps a talking head's hair in frame on a 9:16→4:5 crop.
  const m = buildCropYExpression(0.5, 1350).match(/ih-(\d+)\)/);
  assert.ok(m, 'expression must contain ih-<offset>');
  assert.ok(Number(m[1]) > 675, `offset ${m[1]} must exceed cropHeight/2 (675) for headroom`);
});

test('buildCropYExpression: escapes commas for the ffmpeg filter graph', () => {
  const expr = buildCropYExpression(0.5);
  assert.ok(expr.includes('max(0\\,'), `expected backslash-comma after max(0; got ${expr}`);
  assert.ok(expr.includes('min(ih-1920\\,'), `expected backslash-comma after min(ih-1920; got ${expr}`);
});
