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
