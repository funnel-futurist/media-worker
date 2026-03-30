import { Router } from 'express';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { generateTTS, generateSFX } from '../lib/elevenlabs.js';
import { bakeSpeed, mixWithSfx, getDuration } from '../lib/media.js';
import { uploadAudio } from '../lib/storage.js';

// Locked voice speed table — matches voice quality baseline v2
const VOICE_SPEEDS = {
  'eZm9vdjYgL9PZKtf7XMM': 1.5,  // Noah   — general purpose, top pick
  'cWzYlIcYTquPCigOQKX0': 1.35, // Omer   — hardest to detect as AI
  'oSA216wvYj8MfmJvIa5M': 1.5,  // Ashton — smooth male baseline
  'z283gObVAYx6lRfjSqJ3': 1.5,  // Lucas  — deep monotone backup
  'RXtWW6etvimS8QJ5nhVk': 1.5,  // Fiona  — best female option
};

export const voiceoverRouter = Router();

/**
 * POST /voiceover
 * Generate audit voiceover: ElevenLabs TTS → ffmpeg atempo → Cloudinary
 *
 * Body: { script, voice_id, speed?, contact_metadata? }
 * Returns: { audioUrl, duration, voice_id, speed }
 */
voiceoverRouter.post('/voiceover', async (req, res, next) => {
  const tmpDir = join('/tmp', `vo-${randomUUID()}`);
  try {
    const { script, voice_id, speed: speedOverride, contact_metadata = {} } = req.body;
    if (!script || !voice_id) {
      return res.status(400).json({ error: 'script and voice_id are required' });
    }

    const speed = speedOverride ?? VOICE_SPEEDS[voice_id] ?? 1.5;
    mkdirSync(tmpDir, { recursive: true });

    // 1. TTS
    const audioBuffer = await generateTTS({ text: script, voice_id });
    const rawPath = join(tmpDir, 'raw.mp3');
    writeFileSync(rawPath, audioBuffer);

    // 2. Bake speed
    const speedPath = join(tmpDir, 'speed.mp3');
    await bakeSpeed(rawPath, speedPath, speed);

    // 3. Duration + upload
    const duration = await getDuration(speedPath);
    const { url: audioUrl } = await uploadAudio(speedPath, 'audit-voiceovers');

    res.json({ audioUrl, duration, voice_id, speed, contact_metadata });
  } catch (err) {
    next(err);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

/**
 * POST /voiceover-with-sfx
 * Generate voiceover with background ambient SFX mixed at -12dB.
 *
 * Body: { script, voice_id, sfx_url?, sfx_prompt?, speed?, contact_metadata? }
 *   sfx_url:    Cloudinary URL to a stock ambient loop (preferred — natural, long)
 *   sfx_prompt: ElevenLabs SFX generation prompt (fallback — short, may sound loopy)
 *   If neither provided, picks a random stock ambient from the library.
 * Returns: { audioUrl, duration, voice_id, speed }
 */

// Pre-uploaded stock ambient loops on Cloudinary (long, natural recordings)
// Upload your own: cloudinary.uploader.upload('file.mp3', { folder: 'agency-os/stock-sfx', resource_type: 'video' })
// Custom 11Labs SFX — 30s loops, uploaded 2026-03-24
// 4 unique "windy busy day" variants. Team can flag bad ones for removal.
const STOCK_AMBIENT = [
  { key: 'wind_v1', url: 'https://res.cloudinary.com/dby8dt6md/video/upload/v1774311265/a_windy__busy_day_ba__1-1774311166034_xrbik8.mp3' },
  { key: 'wind_v2', url: 'https://res.cloudinary.com/dby8dt6md/video/upload/v1774311265/a_windy__busy_day_ba__2-1774311166034_asingc.mp3' },
  { key: 'wind_v3', url: 'https://res.cloudinary.com/dby8dt6md/video/upload/v1774311265/a_windy__busy_day_ba__3-1774311166035_vwvck4.mp3' },
  { key: 'wind_v4', url: 'https://res.cloudinary.com/dby8dt6md/video/upload/v1774311264/a_windy__busy_day_ba__4-1774311166035_jlfrs7.mp3' },
];

voiceoverRouter.post('/voiceover-with-sfx', async (req, res, next) => {
  const tmpDir = join('/tmp', `vo-sfx-${randomUUID()}`);
  try {
    const { script, voice_id, sfx_url, sfx_prompt, speed: speedOverride, contact_metadata = {} } = req.body;
    if (!script || !voice_id) {
      return res.status(400).json({ error: 'script and voice_id are required' });
    }

    const speed = speedOverride ?? VOICE_SPEEDS[voice_id] ?? 1.5;
    mkdirSync(tmpDir, { recursive: true });

    // 1. Generate TTS
    const voiceBuffer = await generateTTS({ text: script, voice_id });
    const voicePath = join(tmpDir, 'voice.mp3');
    writeFileSync(voicePath, voiceBuffer);

    // 2. Get SFX: stock URL (preferred) → ElevenLabs generation (fallback)
    const sfxPath = join(tmpDir, 'sfx.mp3');
    if (sfx_url) {
      // Download stock ambient from Cloudinary URL
      const sfxResp = await fetch(sfx_url);
      if (!sfxResp.ok) throw new Error(`Failed to download SFX from ${sfx_url}: ${sfxResp.status}`);
      const sfxBuffer = Buffer.from(await sfxResp.arrayBuffer());
      writeFileSync(sfxPath, sfxBuffer);
    } else if (sfx_prompt) {
      // Fallback: generate via ElevenLabs (short clips, may sound loopy)
      const sfxBuffer = await generateSFX({ text: sfx_prompt });
      writeFileSync(sfxPath, sfxBuffer);
    } else {
      // No SFX specified — pick a random stock ambient (default: wind)
      const available = STOCK_AMBIENT.filter(s => s.url);
      if (available.length > 0) {
        const pick = available[Math.floor(Math.random() * available.length)];
        const sfxResp = await fetch(pick.url);
        if (sfxResp.ok) {
          const sfxBuffer = Buffer.from(await sfxResp.arrayBuffer());
          writeFileSync(sfxPath, sfxBuffer);
        } else {
          // Stock download failed — fall through to speed-only
          const bakedPath = join(tmpDir, 'baked.mp3');
          await bakeSpeed(voicePath, bakedPath, speed);
          const duration = await getDuration(bakedPath);
          const { url: audioUrl } = await uploadAudio(bakedPath, 'audit-voiceovers');
          return res.json({ audioUrl, duration, voice_id, speed, sfx_key: null, contact_metadata });
        }
      } else {
        // No stock sounds available — just bake speed
        const bakedPath = join(tmpDir, 'baked.mp3');
        await bakeSpeed(voicePath, bakedPath, speed);
        const duration = await getDuration(bakedPath);
        const { url: audioUrl } = await uploadAudio(bakedPath, 'audit-voiceovers');
        return res.json({ audioUrl, duration, voice_id, speed, sfx_key: null, contact_metadata });
      }
    }

    // 2. Mix voice + SFX, bake speed
    const mixedPath = join(tmpDir, 'mixed.mp3');
    await mixWithSfx(voicePath, sfxPath, mixedPath, speed);

    // 3. Duration + upload
    const duration = await getDuration(mixedPath);
    const { url: audioUrl } = await uploadAudio(mixedPath, 'audit-voiceovers');

    res.json({ audioUrl, duration, voice_id, speed, contact_metadata });
  } catch (err) {
    next(err);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
