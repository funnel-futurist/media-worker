/**
 * lib/bgm_mix.js
 *
 * BGM mixing for the M2 clean-mode pipeline. Sits AFTER subtitle burn so
 * the existing `-c:a copy` lossless guarantee through subtitles is
 * preserved (subtitle burn writes to finalNoBgm.mp4 when bgmEnabled; bgm
 * mix reads that and writes the real final.mp4).
 *
 * Three exports:
 *   1. getLUFS(filePath, opts)
 *      Ports `creative-engine/video-projects/ff-pilot/scripts/audio_qc.js`
 *      verbatim. Runs `ffmpeg -i <f> -af 'ebur128=peak=true' -f null -`
 *      and parses `I: <X> LUFS` from stderr. Returns the float, or `null`
 *      on parse/exec failure.
 *   2. computeBgmReductionDb({speechLufs, musicLufsRaw, targetGapDb,
 *                              extraReductionDb, volumeFloor, volumeCeiling})
 *      Pure function: applies the PR #106 formula to derive the linear
 *      volume + applied dB reduction, with floor/ceiling clamping and
 *      per-job override stacking.
 *   3. mixBgmIntoVideo({videoPath, bgmPath, outputPath, videoDurationSec,
 *                       bgmSourceDurSec, volume, fadeSec, execImpl})
 *      Single ffmpeg pass that mixes the BGM under the speaker audio with
 *      `aloop` (handles short tracks), `afade` head + tail, `volume` for
 *      the adaptive level, and `amix=inputs=2:duration=first` so the
 *      output length is dictated by the input video (not the music).
 *
 * Adaptive volume strategy (from creative-engine PR #106 audio_qc.js):
 *   targetMusicLufs   = speechLufs - targetGapDb
 *   neededReductionDb = musicLufsRaw - targetMusicLufs
 *   volumeLinear      = 10 ** (-neededReductionDb / 20)
 *   clamped           = max(volumeFloor, min(volumeCeiling, volumeLinear))
 *
 * Default target gap = 14 dB (validated in the Hyperframes ff-pilot
 * template). Default floor = 0.02 (≈ -34 dB), ceiling = 1.0 (no
 * amplification). Per-job `bgmVolumeDb` override stacks on top of the
 * computed reduction (negative number → extra cut).
 *
 * Sidechain ducking + perceptual QC (Pass 2) live in lib/audio_qc.js as
 * an optional post-mix verification step, gated by req.options.bgmQcEnabled.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Measure integrated LUFS for a media file. Ports the PR #106 helper.
 *
 * @param {string} filePath  absolute path to the file
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=600000]
 * @param {(cmd: string, opts?: object) => Promise<{stderr: string, stdout: string}>} [opts.execImpl]
 *   inject for tests so we don't actually run ffmpeg
 * @returns {Promise<number | null>}  integrated LUFS, or `null` on failure
 */
export async function getLUFS(filePath, opts = {}) {
  if (!filePath) throw new Error('getLUFS: filePath is required');
  const execFn = opts.execImpl ?? execAsync;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Quote the path so spaces survive. ebur128=peak=true emits `I: <X> LUFS`
  // in stderr at the end of the run.
  const cmd = `ffmpeg -i "${filePath}" -af "ebur128=peak=true" -f null -`;
  let stderr = '';
  try {
    const result = await execFn(cmd, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
    stderr = result?.stderr ?? '';
  } catch (err) {
    // ffmpeg may exit non-zero on `-f null -`; the LUFS line is in stderr regardless.
    stderr = err?.stderr ?? '';
    if (!stderr) return null;
  }
  return parseLufsFromStderr(stderr);
}

/**
 * Extract the integrated LUFS value from an ffmpeg ebur128 stderr blob.
 * The ebur128 filter ends with a "Summary:" block that includes the line
 * `    I:         -22.4 LUFS` (whitespace varies by ffmpeg version).
 *
 * Exported as a named utility so test/bgm_mix.test.js can verify the parser
 * against canned stderr fixtures without spawning ffmpeg.
 */
export function parseLufsFromStderr(stderr) {
  if (typeof stderr !== 'string' || stderr.length === 0) return null;
  const match = stderr.match(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  if (!match) return null;
  const v = parseFloat(match[1]);
  return Number.isFinite(v) ? v : null;
}

/**
 * Convert a dB value (positive or negative) to a linear amplitude
 * multiplier. Pure helper; -6 dB → 0.501, 0 dB → 1.0, +6 dB → 1.995.
 */
export function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

/**
 * Compute the adaptive BGM volume + applied reduction in dB. Pure function;
 * separated from `mixBgmIntoVideo` so the math is unit-testable without
 * spawning ffmpeg.
 *
 * @param {Object} args
 * @param {number} args.speechLufs         measured speech LUFS (negative number)
 * @param {number} args.musicLufsRaw       measured raw music LUFS (negative number)
 * @param {number} [args.targetGapDb=14]   target speech-music gap (dB)
 * @param {number} [args.extraReductionDb=0]  per-job override; negative for
 *                                         additional cut, positive for less cut.
 *                                         Stacks on top of the computed reduction.
 * @param {number} [args.volumeFloor=0.02] minimum linear volume (clamp)
 * @param {number} [args.volumeCeiling=1.0] maximum linear volume (clamp)
 * @returns {{
 *   volumeLinear: number,
 *   appliedReductionDb: number,
 *   musicLufsTarget: number,
 *   clamped: 'floor' | 'ceiling' | 'none'
 * }}
 */
export function computeBgmReductionDb(args) {
  const {
    speechLufs,
    musicLufsRaw,
    targetGapDb = 14,
    extraReductionDb = 0,
    volumeFloor = 0.02,
    volumeCeiling = 1.0,
  } = args;
  if (typeof speechLufs !== 'number' || !Number.isFinite(speechLufs)) {
    throw new Error('computeBgmReductionDb: speechLufs must be a finite number');
  }
  if (typeof musicLufsRaw !== 'number' || !Number.isFinite(musicLufsRaw)) {
    throw new Error('computeBgmReductionDb: musicLufsRaw must be a finite number');
  }
  const musicLufsTarget = speechLufs - targetGapDb;
  // neededReductionDb is positive when music is louder than the target,
  // negative when music is already quieter. We add the operator's
  // extraReductionDb override (negative = more cut).
  const neededReductionDb = musicLufsRaw - musicLufsTarget;
  const totalReductionDb = neededReductionDb - extraReductionDb;
  const rawVolume = dbToLinear(-totalReductionDb);
  let clamped = 'none';
  let volume = rawVolume;
  if (volume < volumeFloor) {
    volume = volumeFloor;
    clamped = 'floor';
  } else if (volume > volumeCeiling) {
    volume = volumeCeiling;
    clamped = 'ceiling';
  }
  // Re-derive the actual applied dB after clamping so the response shows
  // what really happened, not the unclamped intent.
  const appliedReductionDb = -20 * Math.log10(volume);
  return {
    volumeLinear: volume,
    appliedReductionDb,
    musicLufsTarget,
    clamped,
  };
}

/**
 * Mix a BGM track under a video's audio with adaptive volume + loop + fade.
 *
 * Filter graph:
 *   [1:a]aloop=loop=-1:size=...,atrim=0:<videoDur>,asetpts=PTS-STARTPTS,
 *        volume=<computedLinear>,
 *        afade=t=in:st=0:d=<fadeSec>,
 *        afade=t=out:st=<videoDur-fadeSec>:d=<fadeSec>[bgm]
 *   [0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0[mixedAudio]
 *
 * Outputs: video stream copied (no re-encode), audio is the mix. Subtitle
 * burn already wrote a finalNoBgm.mp4 with the right video; we copy the
 * video and replace the audio.
 *
 * @param {Object} args
 * @param {string} args.videoPath          input video (finalNoBgm.mp4)
 * @param {string} args.bgmPath            input BGM file
 * @param {string} args.outputPath         output (final.mp4)
 * @param {number} args.videoDurationSec   cleaned video duration in seconds
 * @param {number} args.bgmSourceDurSec    BGM file duration in seconds
 * @param {number} args.volume             linear volume from computeBgmReductionDb
 * @param {number} [args.fadeSec=1.5]      head + tail fade duration
 * @param {number} [args.timeoutMs=600000]
 * @param {(cmd: string, opts?: object) => Promise<any>} [args.execImpl]
 *   inject for tests; default execAsync
 * @returns {Promise<{cmd: string, loopsApplied: number}>}
 *   `cmd` is the exact ffmpeg invocation we ran (handy for diagnostics + test assertions).
 */
export async function mixBgmIntoVideo(args) {
  const {
    videoPath,
    bgmPath,
    outputPath,
    videoDurationSec,
    bgmSourceDurSec,
    volume,
    fadeSec = 1.5,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    execImpl,
  } = args;

  if (!videoPath || !bgmPath || !outputPath) {
    throw new Error('mixBgmIntoVideo: videoPath, bgmPath, outputPath all required');
  }
  if (typeof videoDurationSec !== 'number' || videoDurationSec <= 0) {
    throw new Error('mixBgmIntoVideo: videoDurationSec must be a positive number');
  }
  if (typeof bgmSourceDurSec !== 'number' || bgmSourceDurSec <= 0) {
    throw new Error('mixBgmIntoVideo: bgmSourceDurSec must be a positive number');
  }
  if (typeof volume !== 'number' || volume < 0) {
    throw new Error('mixBgmIntoVideo: volume must be a non-negative number');
  }

  // How many full BGM loops fit before the video ends? aloop=loop=-1 plays
  // forever; we use atrim to cap it. The loops counter is for the response
  // surface so the operator can see if the music had to wrap.
  const loopsApplied = bgmSourceDurSec >= videoDurationSec
    ? 0
    : Math.floor(videoDurationSec / bgmSourceDurSec);

  // Fade edges: clamp fadeSec so it doesn't exceed half the video.
  const safeFade = Math.max(0, Math.min(fadeSec, videoDurationSec / 2 - 0.01));
  const fadeOutStart = Math.max(0, videoDurationSec - safeFade);

  // Build the BGM filter chain. Loop indefinitely, trim to video duration,
  // apply linear volume reduction, then head+tail fades.
  // aloop=size= takes a sample count, but we use -1 (loop forever) and let
  // atrim cap the timeline. duration is in seconds via atrim's `end` arg.
  const bgmChain = [
    'aloop=loop=-1:size=2147483647',
    `atrim=0:${videoDurationSec.toFixed(3)}`,
    'asetpts=PTS-STARTPTS',
    `volume=${volume.toFixed(4)}`,
    safeFade > 0 ? `afade=t=in:st=0:d=${safeFade.toFixed(3)}` : null,
    safeFade > 0 ? `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${safeFade.toFixed(3)}` : null,
  ].filter(Boolean).join(',');

  // Build the full filter_complex argument. Speakers' audio = [0:a].
  // We use amix with `duration=first` so the output is exactly the video's
  // length, never the music's.
  const filterComplex = `[1:a]${bgmChain}[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0[mixedAudio]`;

  const cmd = [
    'ffmpeg -y',
    `-i "${videoPath}"`,
    `-i "${bgmPath}"`,
    `-filter_complex "${filterComplex}"`,
    '-map 0:v',                       // video copied verbatim from input 0
    '-map "[mixedAudio]"',
    '-c:v copy',                      // no re-encode of video — preserves subtitle burn
    '-c:a aac',
    '-b:a 192k',
    '-shortest',                      // safety: stop at first input EOF (the video, since amix duration=first)
    `"${outputPath}"`,
  ].join(' ');

  const execFn = execImpl ?? execAsync;
  await execFn(cmd, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });

  return { cmd, loopsApplied };
}
