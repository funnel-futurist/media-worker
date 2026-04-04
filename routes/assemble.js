import { Router } from 'express';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { getDuration } from '../lib/media.js';
import { uploadAudio, uploadVideo } from '../lib/storage.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const assembleRouter = Router();

/**
 * POST /video-assembly
 * Concatenate multiple video/audio clips into a single output via ffmpeg.
 *
 * Body: {
 *   clips: Array<{ url: string, trim?: { start: number, end: number } }>,
 *   outputFormat?: 'mp4' | 'mp3'  (default: 'mp4')
 * }
 * Returns: { videoUrl, duration }
 *
 * All clips must be the same resolution/codec for clean concat.
 * For audio-only output (mp3), pass outputFormat: 'mp3'.
 */
assembleRouter.post('/video-assembly', async (req, res, next) => {
  const tmpDir = join('/tmp', `asm-${randomUUID()}`);
  try {
    const { clips = [], outputFormat = 'mp4' } = req.body;
    if (!clips.length) return res.status(400).json({ error: 'clips array is required' });

    mkdirSync(tmpDir, { recursive: true });

    // Download each unique URL once, then trim segments from the cached file.
    // This avoids downloading the same video N times (e.g. 10 silence cuts = 10x download).
    const ext = outputFormat === 'mp3' ? 'mp3' : 'mp4';
    const urlToPath = new Map();
    const clipPaths = [];

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];

      // Download only if we haven't seen this URL before
      if (!urlToPath.has(clip.url)) {
        const srcPath = join(tmpDir, `src_${urlToPath.size}.${ext}`);
        const response = await axios.get(clip.url, { responseType: 'arraybuffer' });
        writeFileSync(srcPath, Buffer.from(response.data));
        urlToPath.set(clip.url, srcPath);
      }
      const srcPath = urlToPath.get(clip.url);

      if (clip.trim) {
        const trimmedPath = join(tmpDir, `trimmed_${i}.${ext}`);
        const { start = 0, end } = clip.trim;
        const duration = end ? `-t ${end - start}` : '';
        const codec = outputFormat === 'mp3'
          ? '-c:a libmp3lame -q:a 2'
          : '-threads 1 -c:v libx264 -preset ultrafast -c:a aac -movflags +faststart';
        await execAsync(
          `ffmpeg -ss ${start} ${duration} -i "${srcPath}" ${codec} -y "${trimmedPath}"`,
          { timeout: 120000 }
        );
        if (!existsSync(trimmedPath)) {
          throw new Error(`ffmpeg trim produced no output for clip ${i} (start=${start}, end=${end})`);
        }
        clipPaths.push(trimmedPath);
      } else {
        clipPaths.push(srcPath);
      }
    }

    // Clean up source files now that all trims are done
    for (const srcPath of urlToPath.values()) {
      rmSync(srcPath, { force: true });
    }

    // Write ffmpeg concat file list
    const listPath = join(tmpDir, 'filelist.txt');
    const fileList = clipPaths.map(p => `file '${p}'`).join('\n');
    writeFileSync(listPath, fileList);

    // Concatenate
    const outputPath = join(tmpDir, `output.${outputFormat}`);
    if (outputFormat === 'mp3') {
      // Audio concat — re-encode to ensure clean join
      await execAsync(
        `ffmpeg -f concat -safe 0 -i "${listPath}" -c:a libmp3lame -q:a 2 -y "${outputPath}"`
      );
    } else {
      // Video concat — all clips already H.264 from trim step, so stream copy is safe and fast.
      await execAsync(
        `ffmpeg -f concat -safe 0 -i "${listPath}" -c copy -movflags +faststart -y "${outputPath}"`,
        { timeout: 300000 }
      );
    }

    if (!existsSync(outputPath)) {
      throw new Error(`ffmpeg concat produced no output file`);
    }
    const duration = await getDuration(outputPath);
    const folder = outputFormat === 'mp3' ? 'audit-voiceovers/assembled' : 'audit-videos/assembled';
    const upload = outputFormat === 'mp3' ? uploadAudio : uploadVideo;
    const { url: videoUrl } = await upload(outputPath, folder);

    res.json({ videoUrl, duration, clipCount: clips.length });
  } catch (err) {
    next(err);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
