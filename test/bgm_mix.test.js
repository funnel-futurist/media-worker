/**
 * test/bgm_mix.test.js
 *
 * Unit tests for getLUFS / parseLufsFromStderr / dbToLinear /
 * computeBgmReductionDb / mixBgmIntoVideo. ffmpeg is mocked via the
 * `execImpl` opts hook so the suite stays fast + offline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  getLUFS,
  parseLufsFromStderr,
  dbToLinear,
  computeBgmReductionDb,
  mixBgmIntoVideo,
} from '../lib/bgm_mix.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EBUR128_STDERR_FIXTURE = readFileSync(join(__dirname, 'fixtures', 'ffmpeg-ebur128-stderr.txt'), 'utf8');

// ── parseLufsFromStderr (the parser) ──────────────────────────────────

test('parseLufsFromStderr: extracts I value from real ebur128 output', () => {
  const lufs = parseLufsFromStderr(EBUR128_STDERR_FIXTURE);
  assert.equal(lufs, -22.4, 'fixture has `I:         -22.4 LUFS`');
});

test('parseLufsFromStderr: handles tight whitespace variants', () => {
  assert.equal(parseLufsFromStderr('I: -16.5 LUFS'), -16.5);
  assert.equal(parseLufsFromStderr('I:-16.5 LUFS'), -16.5);
  assert.equal(parseLufsFromStderr('   I:    -16.5    LUFS  '), -16.5);
});

test('parseLufsFromStderr: handles positive LUFS (rare but valid)', () => {
  assert.equal(parseLufsFromStderr('I: 1.2 LUFS'), 1.2);
});

test('parseLufsFromStderr: returns null when I: line absent', () => {
  assert.equal(parseLufsFromStderr('frame=  100 fps=...\nno ebur128 output'), null);
});

test('parseLufsFromStderr: returns null on empty/non-string input', () => {
  assert.equal(parseLufsFromStderr(''), null);
  assert.equal(parseLufsFromStderr(null), null);
  assert.equal(parseLufsFromStderr(undefined), null);
});

// ── getLUFS (the ffmpeg wrapper) ──────────────────────────────────────

test('getLUFS: parses LUFS from injected exec stderr', async () => {
  const fakeExec = async () => ({ stdout: '', stderr: EBUR128_STDERR_FIXTURE });
  const out = await getLUFS('/fake/path.mp3', { execImpl: fakeExec });
  assert.equal(out, -22.4);
});

test('getLUFS: still parses LUFS when ffmpeg exits non-zero (typical for null muxer)', async () => {
  // ffmpeg with `-f null -` sometimes exits non-zero but still emits the
  // ebur128 summary in stderr. The wrapper handles that case via the catch.
  const fakeExec = async () => {
    const err = new Error('ffmpeg exit 1');
    err.stderr = EBUR128_STDERR_FIXTURE;
    throw err;
  };
  const out = await getLUFS('/fake/path.mp3', { execImpl: fakeExec });
  assert.equal(out, -22.4);
});

test('getLUFS: returns null when exec throws AND no stderr captured', async () => {
  const fakeExec = async () => { throw new Error('catastrophic'); };
  const out = await getLUFS('/fake/path.mp3', { execImpl: fakeExec });
  assert.equal(out, null);
});

test('getLUFS: throws when filePath missing', async () => {
  await assert.rejects(() => getLUFS(''), /filePath is required/);
});

test('getLUFS: passes the file path quoted into the ffmpeg command', async () => {
  let capturedCmd;
  const fakeExec = async (cmd) => {
    capturedCmd = cmd;
    return { stdout: '', stderr: EBUR128_STDERR_FIXTURE };
  };
  await getLUFS('/with spaces/file.mp4', { execImpl: fakeExec });
  assert.match(capturedCmd, /"\/with spaces\/file\.mp4"/);
  assert.match(capturedCmd, /ebur128=peak=true/);
});

// ── dbToLinear ────────────────────────────────────────────────────────

test('dbToLinear: 0 dB → 1.0', () => {
  assert.ok(Math.abs(dbToLinear(0) - 1.0) < 1e-9);
});

test('dbToLinear: -6 dB → ~0.501 (half amplitude)', () => {
  assert.ok(Math.abs(dbToLinear(-6) - 0.5012) < 0.001);
});

test('dbToLinear: -20 dB → 0.1', () => {
  assert.ok(Math.abs(dbToLinear(-20) - 0.1) < 1e-9);
});

test('dbToLinear: +6 dB → ~1.995 (double amplitude)', () => {
  assert.ok(Math.abs(dbToLinear(6) - 1.995) < 0.01);
});

// ── computeBgmReductionDb (PR #106 formula) ──────────────────────────

test('computeBgmReductionDb: PR #106 example — speech -16, music -10, target gap 14', () => {
  // musicLufsTarget = -16 - 14 = -30
  // neededReductionDb = -10 - (-30) = 20 dB
  // volume = 10 ** (-20/20) = 0.1
  const out = computeBgmReductionDb({
    speechLufs: -16, musicLufsRaw: -10, targetGapDb: 14,
  });
  assert.ok(Math.abs(out.volumeLinear - 0.1) < 0.001);
  assert.ok(Math.abs(out.appliedReductionDb - 20) < 0.001);
  assert.equal(out.musicLufsTarget, -30);
  assert.equal(out.clamped, 'none');
});

test('computeBgmReductionDb: clamps to volumeFloor when gap is enormous', () => {
  // speech -16, music +5 (very loud), target 14 → musicLufsTarget=-30
  // neededReductionDb = 5 - (-30) = 35 dB → volume = 10^-1.75 ≈ 0.0178
  // Below floor=0.02 → clamps to 0.02; appliedReductionDb back-derives to ~33.98 dB.
  const out = computeBgmReductionDb({
    speechLufs: -16, musicLufsRaw: 5, targetGapDb: 14,
    volumeFloor: 0.02,
  });
  assert.equal(out.volumeLinear, 0.02);
  assert.equal(out.clamped, 'floor');
  // Re-derived appliedReductionDb reflects the clamp
  assert.ok(Math.abs(out.appliedReductionDb - 33.98) < 0.1);
});

test('computeBgmReductionDb: clamps to volumeCeiling when music is already quiet', () => {
  // speech -16, music -40 → needed reduction = -10 dB (i.e., +10 dB amplification)
  // volume would be ~3.16; ceiling clamps to 1.0
  const out = computeBgmReductionDb({
    speechLufs: -16, musicLufsRaw: -40, targetGapDb: 14,
    volumeCeiling: 1.0,
  });
  assert.equal(out.volumeLinear, 1.0);
  assert.equal(out.clamped, 'ceiling');
});

test('computeBgmReductionDb: extraReductionDb stacks on top of computed gap', () => {
  // speech -16, music -10, target 14 → needed reduction 20 dB
  // extraReductionDb = -3 → totalReductionDb = 20 - (-3) = 23 dB
  // volume = 10 ** (-23/20) ≈ 0.0708
  const out = computeBgmReductionDb({
    speechLufs: -16, musicLufsRaw: -10, targetGapDb: 14,
    extraReductionDb: -3,
  });
  assert.ok(Math.abs(out.volumeLinear - 0.0708) < 0.001);
});

test('computeBgmReductionDb: throws on non-finite speechLufs', () => {
  assert.throws(
    () => computeBgmReductionDb({ speechLufs: NaN, musicLufsRaw: -10 }),
    /speechLufs must be a finite number/,
  );
});

test('computeBgmReductionDb: throws on non-finite musicLufsRaw', () => {
  assert.throws(
    () => computeBgmReductionDb({ speechLufs: -16, musicLufsRaw: Infinity }),
    /musicLufsRaw must be a finite number/,
  );
});

test('computeBgmReductionDb: defaults — targetGap 14, floor 0.02, ceiling 1.0', () => {
  // Smoke: invokes with only required fields, gets sensible numbers back.
  const out = computeBgmReductionDb({ speechLufs: -16, musicLufsRaw: -16 });
  // gap target hits exactly 14, so neededReductionDb = -16 - (-30) = 14 dB
  // volume = 10 ** (-14/20) ≈ 0.1995
  assert.ok(Math.abs(out.volumeLinear - 0.1995) < 0.001);
});

// ── mixBgmIntoVideo (filter graph + cmd assembly) ─────────────────────

test('mixBgmIntoVideo: builds correct filter graph + ffmpeg invocation', async () => {
  let capturedCmd;
  const fakeExec = async (cmd) => { capturedCmd = cmd; return { stdout: '', stderr: '' }; };
  const out = await mixBgmIntoVideo({
    videoPath: '/tmp/x/finalNoBgm.mp4',
    bgmPath: '/tmp/x/stock-cache/bgm-1234.mp3',
    outputPath: '/tmp/x/final.mp4',
    videoDurationSec: 82.5,
    bgmSourceDurSec: 45.0,
    volume: 0.1,
    fadeSec: 1.5,
    execImpl: fakeExec,
  });
  // ffmpeg invocation contains the right inputs + filter graph + output.
  assert.match(capturedCmd, /-i "\/tmp\/x\/finalNoBgm\.mp4"/);
  assert.match(capturedCmd, /-i "\/tmp\/x\/stock-cache\/bgm-1234\.mp3"/);
  assert.match(capturedCmd, /aloop=loop=-1/);
  assert.match(capturedCmd, /atrim=0:82\.500/);
  assert.match(capturedCmd, /volume=0\.1000/);
  assert.match(capturedCmd, /afade=t=in:st=0:d=1\.500/);
  assert.match(capturedCmd, /afade=t=out:st=81\.000:d=1\.500/);
  assert.match(capturedCmd, /amix=inputs=2:duration=first/);
  assert.match(capturedCmd, /-c:v copy/);
  assert.match(capturedCmd, /-c:a aac/);
  assert.match(capturedCmd, /-shortest/);
  assert.match(capturedCmd, /"\/tmp\/x\/final\.mp4"/);
  // loopsApplied surfaces how many full loops fit.
  assert.equal(out.loopsApplied, 1, '82.5s video / 45s music → 1 full loop fits before atrim');
});

test('mixBgmIntoVideo: loopsApplied = 0 when bgm is at least as long as video', async () => {
  const fakeExec = async () => ({ stdout: '', stderr: '' });
  const out = await mixBgmIntoVideo({
    videoPath: '/x/v.mp4', bgmPath: '/x/bgm.mp3', outputPath: '/x/out.mp4',
    videoDurationSec: 60, bgmSourceDurSec: 120, volume: 0.1,
    execImpl: fakeExec,
  });
  assert.equal(out.loopsApplied, 0);
});

test('mixBgmIntoVideo: clamps fadeSec to half the video duration', async () => {
  let capturedCmd;
  const fakeExec = async (cmd) => { capturedCmd = cmd; return {}; };
  await mixBgmIntoVideo({
    videoPath: '/x/v.mp4', bgmPath: '/x/bgm.mp3', outputPath: '/x/out.mp4',
    videoDurationSec: 4, bgmSourceDurSec: 60, volume: 0.1,
    fadeSec: 5,                          // larger than 4/2 → must clamp
    execImpl: fakeExec,
  });
  // With fadeSec clamped to ~1.99 (half of 4, minus 0.01 epsilon), the
  // afade=in start=0 / afade=out start=2.01 should appear.
  assert.match(capturedCmd, /afade=t=in:st=0:d=1\.99/);
  assert.match(capturedCmd, /afade=t=out:st=2\.01/);
});

test('mixBgmIntoVideo: omits afade filters when fadeSec=0', async () => {
  let capturedCmd;
  const fakeExec = async (cmd) => { capturedCmd = cmd; return {}; };
  await mixBgmIntoVideo({
    videoPath: '/x/v.mp4', bgmPath: '/x/bgm.mp3', outputPath: '/x/out.mp4',
    videoDurationSec: 60, bgmSourceDurSec: 60, volume: 0.1,
    fadeSec: 0,
    execImpl: fakeExec,
  });
  assert.doesNotMatch(capturedCmd, /afade=/);
});

test('mixBgmIntoVideo: throws when required paths missing', async () => {
  const fakeExec = async () => ({});
  await assert.rejects(
    () => mixBgmIntoVideo({ bgmPath: '/x', outputPath: '/x', videoDurationSec: 1, bgmSourceDurSec: 1, volume: 0.1, execImpl: fakeExec }),
    /videoPath, bgmPath, outputPath all required/,
  );
});

test('mixBgmIntoVideo: throws on non-positive videoDurationSec', async () => {
  const fakeExec = async () => ({});
  await assert.rejects(
    () => mixBgmIntoVideo({ videoPath: '/x', bgmPath: '/x', outputPath: '/x', videoDurationSec: 0, bgmSourceDurSec: 1, volume: 0.1, execImpl: fakeExec }),
    /videoDurationSec must be a positive number/,
  );
});

test('mixBgmIntoVideo: throws on negative volume', async () => {
  const fakeExec = async () => ({});
  await assert.rejects(
    () => mixBgmIntoVideo({ videoPath: '/x', bgmPath: '/x', outputPath: '/x', videoDurationSec: 60, bgmSourceDurSec: 60, volume: -0.5, execImpl: fakeExec }),
    /volume must be a non-negative number/,
  );
});
