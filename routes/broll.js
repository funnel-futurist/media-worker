import { Router } from 'express';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { getDuration } from '../lib/media.js';
import { uploadVideo } from '../lib/storage.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const brollRouter = Router();

/**
 * POST /broll-insert
 * Insert client b-roll clips into a main video at specific timestamps.
 * The original speaker audio plays throughout — under the b-roll video too.
 *
 * Body: {
 *   mainVideoUrl: string,
 *   brollCues: Array<{
 *     time_seconds: number,     // when to start showing b-roll
 *     duration_seconds: number, // how long to show it
 *     brollUrl: string          // the b-roll clip URL
 *   }>
 * }
 * Returns: { videoUrl, duration }
 *
 * Flow:
 * 1. Download main video + all b-roll clips
 * 2. Extract full audio from main (speaker voice stays throughout)
 * 3. For each gap between cues → cut main video segment (video + audio)
 * 4. For each cue → b-roll video + main audio slice for that window
 * 5. Concat all segments in order
 */
brollRouter.post('/broll-insert', async (req, res, next) => {
  const tmpDir = join('/tmp', `broll-${randomUUID()}`);
  try {
    const { mainVideoUrl, brollCues = [] } = req.body;
    if (!mainVideoUrl) return res.status(400).json({ error: 'mainVideoUrl is required' });
    if (!brollCues.length) return res.status(400).json({ error: 'brollCues array is required' });

    mkdirSync(tmpDir, { recursive: true });

    // ── 1. Download main video ─────────────────────────────────────────
    const mainPath = join(tmpDir, 'main.mp4');
    const mainRes = await axios.get(mainVideoUrl, { responseType: 'arraybuffer' });
    writeFileSync(mainPath, Buffer.from(mainRes.data));
    const mainDuration = await getDuration(mainPath);

    // ── 2. Sort + clamp cues ───────────────────────────────────────────
    const cues = brollCues
      .map(c => ({
        time: Math.max(0, Number(c.time_seconds)),
        duration: Number(c.duration_seconds),
        url: c.brollUrl,
      }))
      .filter(c => c.time < mainDuration && c.duration > 0)
      .sort((a, b) => a.time - b.time);

    if (!cues.length) {
      // All cues were out of bounds — return original video
      const { url: videoUrl } = await uploadVideo(mainPath, 'audit-videos/broll-inserted');
      return res.json({ videoUrl, duration: mainDuration });
    }

    // ── 3. Extract full main audio (speaker voice for entire video) ────
    const mainAudioPath = join(tmpDir, 'main_audio.aac');
    await execAsync(
      `ffmpeg -i "${mainPath}" -vn -c:a aac -b:a 128k -y "${mainAudioPath}"`
    );

    // ── 4. Build segments ──────────────────────────────────────────────
    const segments = [];
    let cursor = 0;

    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      const cueEnd = Math.min(cue.time + cue.duration, mainDuration);

      // Main video segment before this b-roll
      if (cursor < cue.time) {
        const segPath = join(tmpDir, `main_seg_${i}.mp4`);
        await execAsync(
          `ffmpeg -ss ${cursor} -t ${cue.time - cursor} -i "${mainPath}" ` +
          `-c:v libx264 -c:a aac -b:a 128k -movflags +faststart -y "${segPath}"`
        );
        segments.push(segPath);
      }

      // Download b-roll clip
      const brollRawPath = join(tmpDir, `broll_${i}_raw.mp4`);
      const brollRes = await axios.get(cue.url, { responseType: 'arraybuffer' });
      writeFileSync(brollRawPath, Buffer.from(brollRes.data));

      // Slice main audio for this b-roll window
      const brollAudioPath = join(tmpDir, `broll_audio_${i}.aac`);
      const segDuration = cueEnd - cue.time;
      await execAsync(
        `ffmpeg -ss ${cue.time} -t ${segDuration} -i "${mainAudioPath}" ` +
        `-c:a aac -b:a 128k -y "${brollAudioPath}"`
      );

      // Combine: b-roll video + main audio slice
      // Re-encode video to ensure consistent codec/resolution with rest of video
      const brollSegPath = join(tmpDir, `broll_seg_${i}.mp4`);
      await execAsync(
        `ffmpeg -t ${segDuration} -i "${brollRawPath}" -i "${brollAudioPath}" ` +
        `-c:v libx264 -c:a aac -b:a 128k -map 0:v:0 -map 1:a:0 ` +
        `-movflags +faststart -y "${brollSegPath}"`
      );
      segments.push(brollSegPath);

      cursor = cueEnd;
    }

    // Trailing main video segment after last b-roll
    if (cursor < mainDuration) {
      const tailPath = join(tmpDir, 'main_tail.mp4');
      await execAsync(
        `ffmpeg -ss ${cursor} -t ${mainDuration - cursor} -i "${mainPath}" ` +
        `-c:v libx264 -c:a aac -b:a 128k -movflags +faststart -y "${tailPath}"`
      );
      segments.push(tailPath);
    }

    // ── 5. Concat all segments ─────────────────────────────────────────
    const listPath = join(tmpDir, 'filelist.txt');
    writeFileSync(listPath, segments.map(p => `file '${p}'`).join('\n'));

    const outputPath = join(tmpDir, 'output.mp4');
    await execAsync(
      `ffmpeg -f concat -safe 0 -i "${listPath}" -c copy -movflags +faststart -y "${outputPath}"`
    );

    const duration = await getDuration(outputPath);
    const { url: videoUrl } = await uploadVideo(outputPath, 'audit-videos/broll-inserted');

    res.json({ videoUrl, duration });
  } catch (err) {
    next(err);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
