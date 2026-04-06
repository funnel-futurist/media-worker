import { Router } from 'express';
import { writeFileSync, readFileSync, mkdirSync, rmSync, statSync } from 'fs';
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
captionRouter.post('/caption-video', async (req, res) => {
  // Disabled — pipeline now uses Submagic for captioning via /submagic-edit
  console.warn('[caption] /caption-video called but route is disabled — use /submagic-edit');
  return res.status(410).json({ error: 'caption-video is disabled. Use /submagic-edit instead.' });
});

captionRouter.post('/caption-video-legacy', async (req, res, next) => {
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

    // 5. Normalize SRT timestamps: Gemini sometimes emits MM:SS,mmm instead of HH:MM:SS,mmm.
    // Use negative lookbehind (?<!\d:) to avoid corrupting already-valid HH:MM:SS,mmm timestamps
    // (without it, the regex matches the SS,mmm part of a 3-part timestamp and prepends 00: again).
    const normalizedSrt = srtContent.split('\n').map(line => {
      if (!line.includes(' --> ')) return line;
      return line.replace(/(?<!\d:)\b(\d{1,2}):(\d{2}),(\d{3})\b/g, (match, p1, p2, p3) => {
        return `00:${p1.padStart(2, '0')}:${p2},${p3}`;
      });
    }).join('\n');

    // Write SRT file
    const srtPath = join(tmpDir, 'subtitles.srt');
    console.log('[caption] SRT length:', normalizedSrt.length, '| preview:', normalizedSrt.slice(0, 200));
    const hasTimestamps = normalizedSrt.includes('-->');
    if (!hasTimestamps) {
      console.warn('[caption] SRT has no timestamps — Gemini may have returned plain text instead of SRT:', normalizedSrt);
    }
    writeFileSync(srtPath, normalizedSrt);

    // 6. Burn subtitles into video.
    // Wrap srtPath in single quotes within the filtergraph — explicitly delimits the filename
    // from the :force_style option so libass can open the file correctly.
    const captionedPath = join(tmpDir, 'captioned.mp4');
    const subtitleStyle = 'FontName=Arial,FontSize=22,Bold=1,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=3,Shadow=0,BorderStyle=1,Alignment=2,MarginV=40';
    // Target 600 kbps video + 96 kbps audio = ~700 kbps total.
    // At 700 kbps: 2-min → 10 MB, 12-min → 63 MB — well under Cloudinary's 100 MB limit.
    // Using -b:v (average bitrate) rather than CRF+maxrate for reliable file size control.
    const videoFlags = '-c:v libx264 -preset fast -b:v 600k -c:a aac -b:a 96k';
    if (hasTimestamps) {
      await execAsync(
        `ffmpeg -i "${videoPath}" -vf "subtitles='${srtPath}':force_style='${subtitleStyle}'" ${videoFlags} -y "${captionedPath}"`,
        { timeout: 600000 }
      );
    } else {
      // No valid SRT — compress as-is so pipeline doesn't fail
      await execAsync(
        `ffmpeg -i "${videoPath}" ${videoFlags} -y "${captionedPath}"`,
        { timeout: 600000 }
      );
    }

    const captionedSize = statSync(captionedPath).size;
    console.log(`[caption] captioned file: ${(captionedSize / 1024 / 1024).toFixed(1)} MB`);

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
