import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Bake playback speed into an MP3 via ffmpeg atempo filter.
 * All locked voice speeds (1.35x, 1.5x) are within the single-filter range (0.5–2.0).
 */
export async function bakeSpeed(inputPath, outputPath, speed) {
  await execAsync(
    `ffmpeg -i "${inputPath}" -filter:a "atempo=${speed}" -y "${outputPath}"`
  );
}

/**
 * Mix voice + SFX background, then bake speed.
 * SFX sits at -12dB (~0.25 amplitude) — audible ambient, doesn't overpower voice.
 * SFX is looped (-stream_loop -1) so it plays for the ENTIRE voice duration,
 * not just the length of the generated SFX clip (~5-10s from ElevenLabs).
 * Pipeline: [voice 0dB] + [sfx looped -12dB] → amix (voice length) → atempo → output
 */
export async function mixWithSfx(voicePath, sfxPath, outputPath, speed) {
  const sfxVol = 0.60; // -4.5dB — locked 2026-03-24
  await execAsync(
    `ffmpeg -i "${voicePath}" -stream_loop -1 -i "${sfxPath}" ` +
    `-filter_complex "[1:a]volume=${sfxVol}[sfx];[0:a][sfx]amix=inputs=2:duration=first:dropout_transition=0[mixed];[mixed]atempo=${speed}[out]" ` +
    `-map "[out]" -y "${outputPath}"`
  );
}

/**
 * Get audio duration in seconds via ffprobe.
 */
export async function getDuration(filePath) {
  const { stdout } = await execAsync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
  );
  return parseFloat(stdout.trim());
}

/**
 * Probe a media file for per-stream + container metadata in a single ffprobe
 * invocation. Used by the M2 clean-mode pipeline for two purposes:
 *   1. Asset capability checks before composing (broll source duration, dims)
 *   2. Per-stream A/V sync verification after each ffmpeg pass
 *
 * Returns a normalized object — null video/audio when the stream is missing.
 *
 * @param {string} filePath
 * @returns {Promise<{
 *   container: { duration: number },
 *   video: { duration: number, width: number, height: number, codec: string } | null,
 *   audio: { duration: number, codec: string, sampleRate: number, channels: number } | null,
 * }>}
 */
export async function probeStreams(filePath) {
  const { stdout } = await execAsync(
    `ffprobe -v error -show_format -show_streams -of json "${filePath}"`,
    { maxBuffer: 5 * 1024 * 1024 },
  );
  const probe = JSON.parse(stdout);
  const containerDur = parseFloat(probe.format?.duration ?? 'NaN');
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video') ?? null;
  const audioStream = streams.find((s) => s.codec_type === 'audio') ?? null;

  // Stream-level duration falls back to container duration when missing — some
  // muxers omit per-stream duration but the container value is still valid.
  const streamDur = (s) => {
    if (!s) return null;
    const d = parseFloat(s.duration ?? 'NaN');
    return Number.isFinite(d) ? d : containerDur;
  };

  return {
    container: { duration: Number.isFinite(containerDur) ? containerDur : 0 },
    video: videoStream
      ? {
          duration: streamDur(videoStream),
          width: parseInt(videoStream.width, 10) || 0,
          height: parseInt(videoStream.height, 10) || 0,
          codec: videoStream.codec_name ?? '',
        }
      : null,
    audio: audioStream
      ? {
          duration: streamDur(audioStream),
          codec: audioStream.codec_name ?? '',
          sampleRate: parseInt(audioStream.sample_rate, 10) || 0,
          channels: parseInt(audioStream.channels, 10) || 0,
        }
      : null,
  };
}
