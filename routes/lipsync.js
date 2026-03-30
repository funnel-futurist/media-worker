import { Router } from 'express';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import FormData from 'form-data';
import { uploadAudio } from '../lib/storage.js';
import { generateTTS } from '../lib/elevenlabs.js';

const execAsync = promisify(exec);

export const lipsyncRouter = Router();

const API_KEY = () => process.env.ELEVENLABS_API_KEY;
const BASE = 'https://api.elevenlabs.io/v1';

/**
 * POST /lip-sync
 * Generate lip-synced video from an image + audio using ElevenLabs Dubbing API.
 *
 * Two modes:
 * A) imageUrl + audioUrl  — sync existing audio to an image
 * B) imageUrl + script + voice_id  — generate TTS first, then sync
 *
 * Body: {
 *   imageUrl: string,
 *   audioUrl?: string,
 *   script?: string,
 *   voice_id?: string,
 * }
 * Returns: { videoUrl, dubbingId }
 *
 * ElevenLabs lip-sync uses async processing — this endpoint polls until complete (max 90s).
 */
lipsyncRouter.post('/lip-sync', async (req, res, next) => {
  const tmpDir = join('/tmp', `ls-${randomUUID()}`);
  try {
    const { imageUrl, audioUrl, script, voice_id } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required' });
    if (!audioUrl && !(script && voice_id)) {
      return res.status(400).json({ error: 'provide audioUrl OR script+voice_id' });
    }

    mkdirSync(tmpDir, { recursive: true });

    // 1. Get audio buffer — either from URL or generate via TTS
    let audioBuffer;
    if (audioUrl) {
      const res = await axios.get(audioUrl, { responseType: 'arraybuffer' });
      audioBuffer = Buffer.from(res.data);
    } else {
      audioBuffer = await generateTTS({ text: script, voice_id });
    }

    // 2. Download image
    const imageRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageRes.data);

    // 3. Convert image to short video loop so ElevenLabs dubbing has a video input
    //    ElevenLabs lip-sync requires video input, not static image
    const imagePath = join(tmpDir, 'source.jpg');
    const audioPath = join(tmpDir, 'audio.mp3');
    const loopVideoPath = join(tmpDir, 'loop.mp4');
    writeFileSync(imagePath, imageBuffer);
    writeFileSync(audioPath, audioBuffer);

    // Get audio duration to set loop length
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
    );
    const audioDuration = parseFloat(stdout.trim());

    // Create video loop from static image matching audio length
    await execAsync(
      `ffmpeg -loop 1 -i "${imagePath}" -i "${audioPath}" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -shortest -pix_fmt yuv420p -y "${loopVideoPath}"`
    );

    // 4. Submit to ElevenLabs Dubbing API (lip-sync mode)
    const form = new FormData();
    form.append('mode', 'automatic');
    form.append('video', readFileSync(loopVideoPath), {
      filename: 'source.mp4',
      contentType: 'video/mp4',
    });
    form.append('audio', audioBuffer, {
      filename: 'audio.mp3',
      contentType: 'audio/mpeg',
    });
    form.append('target_lang', 'en');
    form.append('num_speakers', '1');

    const createRes = await axios.post(`${BASE}/dubbing`, form, {
      headers: {
        'xi-api-key': API_KEY(),
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
    });

    const { dubbing_id, expected_duration_sec } = createRes.data;

    // 5. Poll for completion (max 90s)
    const maxWait = 90000;
    const pollInterval = 3000;
    const deadline = Date.now() + maxWait;
    let status = 'dubbing';

    while (status === 'dubbing' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollInterval));
      const statusRes = await axios.get(`${BASE}/dubbing/${dubbing_id}`, {
        headers: { 'xi-api-key': API_KEY() },
      });
      status = statusRes.data.status;
    }

    if (status !== 'dubbed') {
      return res.status(504).json({
        error: `Lip-sync timed out or failed. Status: ${status}. dubbing_id: ${dubbing_id}`,
        dubbing_id,
      });
    }

    // 6. Download the lip-synced video
    const videoRes = await axios.get(`${BASE}/dubbing/${dubbing_id}/audio/en`, {
      headers: { 'xi-api-key': API_KEY() },
      responseType: 'arraybuffer',
    });

    const outputPath = join(tmpDir, 'lipsync.mp4');
    writeFileSync(outputPath, Buffer.from(videoRes.data));

    // 7. Upload to Cloudinary
    const { url: videoUrl } = await uploadAudio(outputPath, 'audit-videos/lipsync');

    res.json({ videoUrl, dubbingId: dubbing_id, duration: audioDuration });
  } catch (err) {
    next(err);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
