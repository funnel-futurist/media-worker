import { Router } from 'express';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { getDuration } from '../lib/media.js';
import { uploadAudio, uploadVideo } from '../lib/storage.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Upload trimmed video to Supabase Storage instead of Cloudinary.
 * Returns a public URL. Used by wash step to avoid Cloudinary corruption.
 */
async function uploadToSupabase(filePath, clientId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('Supabase env vars not set for storage upload');

  const datePrefix = new Date().toISOString().split('T')[0];
  const filename = `washed_${randomUUID()}.mp4`;
  const storagePath = `washed/${clientId || 'unknown'}/${datePrefix}/${filename}`;
  const buffer = readFileSync(filePath);

  const res = await axios.post(
    `${supabaseUrl}/storage/v1/object/video-modules/${storagePath}`,
    buffer,
    {
      headers: { Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
  );

  return `${supabaseUrl}/storage/v1/object/public/video-modules/${storagePath}`;
}

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
    const { clips = [], outputFormat = 'mp4', uploadTo = 'cloudinary', clientId = null } = req.body;
    if (!clips.length) return res.status(400).json({ error: 'clips array is required' });

    mkdirSync(tmpDir, { recursive: true });

    // Download each unique URL once, then trim segments from the cached file.
    // This avoids downloading the same video N times (e.g. 10 silence cuts = 10x download).
    const ext = outputFormat === 'mp3' ? 'mp3' : 'mp4';
    const urlToPath = new Map(); // url → H.264-normalised source path
    const clipPaths = [];

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];

      // Download + normalise to H.264 once per unique URL.
      // iPhone/Mac recordings are HEVC (H.265) — decoding them N times concurrently
      // exhausts Railway's container RAM. One transcode pass up-front lets every
      // subsequent trim use -c copy (stream copy, no decode).
      if (!urlToPath.has(clip.url)) {
        const rawPath = join(tmpDir, `raw_${urlToPath.size}.${ext}`);
        const response = await axios.get(clip.url, { responseType: 'arraybuffer' });
        writeFileSync(rawPath, Buffer.from(response.data));

        if (outputFormat !== 'mp3') {
          // Normalise to H.264 at a fixed 1500 kbps so the washed video stays small
          // (under ~25 MB for a 2-min clip) regardless of the source codec or bitrate.
          // ultrafast+CRF produced files 10-20x too large for high-bitrate HEVC input.
          const normPath = join(tmpDir, `src_${urlToPath.size}.mp4`);
          await execAsync(
            `ffmpeg -i "${rawPath}" -c:v libx264 -preset veryfast -b:v 1500k -c:a aac -b:a 128k -movflags +faststart -y "${normPath}"`,
            { timeout: 300000 }
          );
          rmSync(rawPath, { force: true });
          urlToPath.set(clip.url, normPath);
        } else {
          urlToPath.set(clip.url, rawPath);
        }
      }
      const srcPath = urlToPath.get(clip.url);

      if (clip.trim) {
        const trimmedPath = join(tmpDir, `trimmed_${i}.${ext}`);
        const { start = 0, end } = clip.trim;
        const durationArg = end ? `-t ${end - start}` : '';
        // Source is now H.264 — stream copy is fast and memory-free.
        const codec = outputFormat === 'mp3' ? '-c:a libmp3lame -q:a 2' : '-c copy';
        await execAsync(
          `ffmpeg -ss ${start} ${durationArg} -i "${srcPath}" ${codec} -y "${trimmedPath}"`,
          { timeout: 60000 }
        );
        if (!existsSync(trimmedPath)) {
          throw new Error(`ffmpeg trim produced no output for clip ${i} (start=${start}, end=${end})`);
        }
        clipPaths.push(trimmedPath);
      } else {
        clipPaths.push(srcPath);
      }
    }

    // Clean up normalised source files now that all trims are done
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
    let videoUrl;
    if (uploadTo === 'supabase' && outputFormat === 'mp4') {
      videoUrl = await uploadToSupabase(outputPath, clientId);
    } else {
      const folder = outputFormat === 'mp3' ? 'audit-voiceovers/assembled' : 'audit-videos/assembled';
      const upload = outputFormat === 'mp3' ? uploadAudio : uploadVideo;
      const result = await upload(outputPath, folder);
      videoUrl = result.url;
    }

    res.json({ videoUrl, duration, clipCount: clips.length });
  } catch (err) {
    next(err);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
