import { Router } from 'express';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import { uploadAudio, uploadVideo } from '../lib/storage.js';
import { v2 as cloudinary } from 'cloudinary';

const execAsync = promisify(exec);

export const captionRouter = Router();

/**
 * POST /caption-video
 * Transcribe video with Gemini and burn hardcoded subtitles via ffmpeg.
 *
 * Body: {
 *   videoUrl: string,
 *   language?: string   (ISO 639-1, e.g. 'en' — hints to Gemini)
 * }
 * Returns: { captionedUrl, srtUrl }
 *
 * Pipeline: download → extract audio → Gemini Files API (SRT) → ffmpeg subtitle burn → Cloudinary
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

    // 2. Extract audio (MP3, mono, 16kHz) with +6dB boost for quiet speakers
    const audioPath = join(tmpDir, 'audio.mp3');
    await execAsync(
      `ffmpeg -i "${videoPath}" -vn -ac 1 -ar 16000 -af "volume=6dB" -q:a 4 -y "${audioPath}"`
    );

    // 3. Upload audio to Gemini Files API
    const audioBuffer = readFileSync(audioPath);
    const geminiFileUri = await uploadToGeminiFiles(audioBuffer, 'audio/mpeg', 'audio.mp3');

    // 4. Transcribe with Gemini → SRT format
    const srtContent = await transcribeWithGemini(geminiFileUri, language);

    // 5. Write SRT file
    const srtPath = join(tmpDir, 'subtitles.srt');
    console.log('[caption] SRT length:', srtContent.length, '| preview:', srtContent.slice(0, 200));
    const hasTimestamps = srtContent.includes('-->');
    if (!hasTimestamps) {
      console.warn('[caption] SRT has no timestamps — Gemini may have returned plain text instead of SRT:', srtContent);
    }
    writeFileSync(srtPath, srtContent);

    // 6. Burn subtitles into video
    const captionedPath = join(tmpDir, 'captioned.mp4');
    const subtitleStyle = 'FontName=Arial,FontSize=22,Bold=1,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=3,Shadow=0,BorderStyle=1,Alignment=2,MarginV=40';
    if (hasTimestamps) {
      // Escape path for ffmpeg filtergraph: replace : with \: and ' with \'
      const escapedSrtPath = srtPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
      await execAsync(
        `ffmpeg -i "${videoPath}" -vf "subtitles=${escapedSrtPath}:force_style='${subtitleStyle}'" -c:a copy -y "${captionedPath}"`
      );
    } else {
      // No valid SRT — copy video as-is so pipeline doesn't fail
      await execAsync(`ffmpeg -i "${videoPath}" -c copy -y "${captionedPath}"`);
    }

    // 7. Upload captioned video + SRT to Cloudinary
    const [{ url: captionedUrl }, { url: srtUrl }] = await Promise.all([
      uploadVideo(captionedPath, 'audit-videos/captioned'),
      uploadSrt(srtPath),
    ]);

    res.json({ captionedUrl, srtUrl });
  } catch (err) {
    next(err);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

/**
 * Upload audio buffer to Gemini Files API.
 * Returns the file URI for use in generateContent calls.
 */
async function uploadToGeminiFiles(buffer, mimeType, displayName) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  // Initiate resumable upload
  const initRes = await axios.post(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    { file: { display_name: displayName } },
    {
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(buffer.length),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
    }
  );

  const uploadUrl = initRes.headers['x-goog-upload-url'];
  if (!uploadUrl) throw new Error('Failed to get Gemini upload URL');

  // Upload the file
  const uploadRes = await axios.put(uploadUrl, buffer, {
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'Content-Length': String(buffer.length),
      'Content-Type': mimeType,
    },
  });

  const fileData = uploadRes.data;
  let fileState = fileData.file?.state;
  const fileName = fileData.file?.name;

  // Wait for processing
  while (fileState === 'PROCESSING') {
    await new Promise(r => setTimeout(r, 3000));
    const checkRes = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`
    );
    fileState = checkRes.data.state;
    if (fileState === 'ACTIVE') return checkRes.data.uri;
  }

  return fileData.file?.uri;
}

/**
 * Ask Gemini to transcribe audio and return SRT-formatted subtitles.
 */
async function transcribeWithGemini(fileUri, language) {
  const apiKey = process.env.GEMINI_API_KEY;

  const prompt = `Transcribe this audio and return the transcript in SRT subtitle format.
Rules:
- Use standard SRT format: index, timestamp (HH:MM:SS,mmm --> HH:MM:SS,mmm), text, blank line
- Max 4-5 words per subtitle line — split at natural speech pauses
- Each subtitle should feel like a punch: short, snappy, easy to read
- Timestamps must be accurate to the audio — sync tightly to when words are spoken
- Language: ${language}
- Return ONLY the raw SRT content, no markdown, no explanation

Example:
1
00:00:00,000 --> 00:00:01,200
They need to reflect

2
00:00:01,200 --> 00:00:02,800
on what they learned

3
00:00:02,800 --> 00:00:04,500
not just memorize facts`;

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      contents: [{
        parts: [
          { file_data: { mime_type: 'audio/mpeg', file_uri: fileUri } },
          { text: prompt },
        ],
      }],
      generationConfig: { temperature: 0.1 },
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty transcription');

  // Strip markdown code fences if present
  return text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
}

// Upload raw SRT as a raw file to Cloudinary
async function uploadSrt(srtPath) {
  const result = await cloudinary.uploader.upload(srtPath, {
    resource_type: 'raw',
    folder: 'audit-videos/srt',
    format: 'srt',
  });
  return { url: result.secure_url };
}
