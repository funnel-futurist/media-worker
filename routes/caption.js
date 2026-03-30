import { Router } from 'express';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import axios from 'axios';
import FormData from 'form-data';
import { exec } from 'child_process';
import { promisify } from 'util';
import { uploadAudio } from '../lib/storage.js';
import { v2 as cloudinary } from 'cloudinary';

const execAsync = promisify(exec);

export const captionRouter = Router();

/**
 * POST /caption-video
 * Transcribe video with Whisper and burn hardcoded subtitles via ffmpeg.
 *
 * Body: {
 *   videoUrl: string,
 *   language?: string   (ISO 639-1, e.g. 'en' — helps Whisper accuracy)
 * }
 * Returns: { captionedUrl, srtUrl }
 *
 * Pipeline: download → extract audio → Whisper (SRT) → ffmpeg subtitle burn → Cloudinary
 */
captionRouter.post('/caption-video', async (req, res, next) => {
  const tmpDir = join('/tmp', `cap-${randomUUID()}`);
  try {
    const { videoUrl, language = 'en' } = req.body;
    if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required' });

    mkdirSync(tmpDir, { recursive: true });

    // 1. Download video
    const videoPath = join(tmpDir, 'input.mp4');
    const videoRes = await axios.get(videoUrl, { responseType: 'arraybuffer' });
    writeFileSync(videoPath, Buffer.from(videoRes.data));

    // 2. Extract audio for Whisper (MP3, mono, 16kHz — optimal for Whisper)
    const audioPath = join(tmpDir, 'audio.mp3');
    await execAsync(
      `ffmpeg -i "${videoPath}" -vn -ac 1 -ar 16000 -q:a 4 -y "${audioPath}"`
    );

    // 3. Transcribe with OpenAI Whisper API → SRT format
    const audioBuffer = readFileSync(audioPath);
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    form.append('model', 'whisper-1');
    form.append('response_format', 'srt');
    if (language) form.append('language', language);

    const whisperRes = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...form.getHeaders(),
        },
        maxBodyLength: Infinity,
      }
    );

    // 4. Write SRT file
    const srtPath = join(tmpDir, 'subtitles.srt');
    writeFileSync(srtPath, whisperRes.data);

    // 5. Burn subtitles into video
    // Style: white text, black outline, bottom-center, readable at mobile size
    const captionedPath = join(tmpDir, 'captioned.mp4');
    const subtitleStyle = 'FontName=Arial,FontSize=18,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2,Alignment=2';
    await execAsync(
      `ffmpeg -i "${videoPath}" -vf "subtitles='${srtPath}':force_style='${subtitleStyle}'" -c:a copy -y "${captionedPath}"`
    );

    // 6. Upload both captioned video and raw SRT to Cloudinary
    const [{ url: captionedUrl }, { url: srtUrl }] = await Promise.all([
      uploadAudio(captionedPath, 'audit-videos/captioned'),
      uploadSrt(srtPath),
    ]);

    res.json({ captionedUrl, srtUrl });
  } catch (err) {
    next(err);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Upload raw SRT as a raw file to Cloudinary
async function uploadSrt(srtPath) {
  const result = await cloudinary.uploader.upload(srtPath, {
    resource_type: 'raw',
    folder: 'audit-videos/srt',
    format: 'srt',
  });
  return { url: result.secure_url };
}
