/**
 * routes/audio-loudnorm-trim.js
 *
 * Endpoint that trims the speaker's slate intro and applies EBU R128 loudnorm
 * to a source video, then writes the result to Supabase Storage. Used by
 * creative-engine's compose_pending cron to produce the face-track input for
 * the per-video Hyperframes composition pipeline.
 *
 * Order matters (Phoenix review #2): trim AT THE HEAD first, loudnorm AFTER
 * the trim, so the normalized loudness is based on real content rather than
 * the slate intro.
 *
 * Returns STABLE storage refs (Phoenix review #1): bucket + path + sha256.
 * The blueprint stores these refs and signs URLs on demand at preview/render
 * time. Signed URLs expire — paths and hashes don't.
 */

import { Router } from 'express';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, createWriteStream } from 'fs';
import { join } from 'path';
import { randomUUID, createHash } from 'crypto';
import { pipeline } from 'stream/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { google } from 'googleapis';
import { getDuration } from '../lib/media.js';

const execAsync = promisify(exec);

function getDriveClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth });
}

export const audioLoudnormTrimRouter = Router();

/**
 * POST /audio-loudnorm-trim
 *
 * Body: {
 *   sourceUrl: string,                         // for sourceType='public_url'
 *   sourceType: 'drive' | 'public_url',
 *   driveFileId?: string,                      // required when sourceType='drive'
 *   trimStartSeconds: number,                  // head trim in seconds; 0 = no trim
 *   outputBucket: string,                      // e.g. 'hyperframes-source'
 *   outputObjectPath: string,                  // e.g. '<ad_ingestion_id>.mp4'
 *   clientId: string,
 *   adIngestionId: string,
 * }
 *
 * Response: { storageBucket, storagePath, durationSeconds, assetHash }
 */
audioLoudnormTrimRouter.post('/audio-loudnorm-trim', async (req, res, next) => {
  const tmpDir = join('/tmp', `audionorm-${randomUUID()}`);
  try {
    const {
      sourceUrl,
      sourceType,
      driveFileId,
      trimStartSeconds = 0,
      outputBucket,
      outputObjectPath,
      clientId,
      adIngestionId,
    } = req.body || {};

    if (!outputBucket || !outputObjectPath) {
      return res.status(400).json({ error: 'outputBucket and outputObjectPath are required' });
    }
    if (sourceType === 'drive' && !driveFileId) {
      return res.status(400).json({ error: 'driveFileId is required when sourceType=drive' });
    }
    if (sourceType !== 'drive' && !sourceUrl) {
      return res.status(400).json({ error: 'sourceUrl is required when sourceType=public_url' });
    }
    if (typeof trimStartSeconds !== 'number' || trimStartSeconds < 0) {
      return res.status(400).json({ error: 'trimStartSeconds must be a non-negative number' });
    }

    mkdirSync(tmpDir, { recursive: true });
    const inputPath = join(tmpDir, 'in.mp4');
    const outputPath = join(tmpDir, 'out.mp4');

    // ── 1. Download source ─────────────────────────────────────────
    console.log(`[audio-loudnorm-trim] downloading ${sourceType} for ${adIngestionId ?? '(no id)'}`);
    if (sourceType === 'drive') {
      const drive = getDriveClient();
      const driveRes = await drive.files.get(
        { fileId: driveFileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );
      await pipeline(driveRes.data, createWriteStream(inputPath));
    } else {
      const { data } = await axios.get(sourceUrl, {
        responseType: 'arraybuffer',
        timeout: 180_000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      writeFileSync(inputPath, Buffer.from(data));
    }

    if (!existsSync(inputPath)) {
      throw new Error('source download produced no file on disk');
    }

    // ── 2. Trim head + loudnorm in a single ffmpeg pass ────────────
    // -ss BEFORE -i: fast seek; combined with re-encode, the trim is
    // frame-accurate (slate detection gives us a precise timestamp,
    // we don't want to drift to the nearest keyframe).
    //
    // Re-encoding video as H.264 is necessary because:
    //   1. Frame-accurate trim requires re-encode (stream copy snaps to
    //      keyframes which can drift several seconds)
    //   2. Source could be HEVC (iPhone/Mac); H.264 is safer for downstream
    //   3. Hyperframes' headless Chrome render pipeline is happiest with H.264
    //
    // The `loudnorm` filter brings audio to EBU R128 (-16 LUFS integrated,
    // -1.5 dBTP, 11 LU LRA) — same constants Phoenix used in submagic.js
    // and the same standard Instagram/TikTok/YouTube target.
    const trimArg = trimStartSeconds > 0 ? `-ss ${trimStartSeconds}` : '';
    console.log(`[audio-loudnorm-trim] ffmpeg trim=${trimStartSeconds}s + loudnorm`);
    await execAsync(
      `ffmpeg ${trimArg} -i "${inputPath}" ` +
        `-af "loudnorm=I=-16:TP=-1.5:LRA=11" ` +
        `-c:v libx264 -preset veryfast -b:v 2500k ` +
        `-c:a aac -b:a 192k ` +
        `-movflags +faststart -y "${outputPath}"`,
      { timeout: 600_000 }
    );

    if (!existsSync(outputPath)) {
      throw new Error('ffmpeg produced no output');
    }

    // ── 3. Compute duration + content hash ─────────────────────────
    const durationSeconds = await getDuration(outputPath);
    const fileBuffer = readFileSync(outputPath);
    const assetHash = createHash('sha256').update(fileBuffer).digest('hex');

    console.log(
      `[audio-loudnorm-trim] done: ${outputBucket}/${outputObjectPath} ` +
        `dur=${durationSeconds.toFixed(2)}s sha256=${assetHash.slice(0, 12)}…`
    );

    // ── 4. Upload to Supabase Storage ──────────────────────────────
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required');
    }

    await axios.post(
      `${supabaseUrl}/storage/v1/object/${outputBucket}/${outputObjectPath}`,
      fileBuffer,
      {
        headers: {
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'video/mp4',
          'x-upsert': 'true',
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );

    // ── 5. Return STABLE refs (no signed URL — caller signs on demand) ─
    res.json({
      storageBucket: outputBucket,
      storagePath: outputObjectPath,
      durationSeconds,
      assetHash,
      // Helpful echo for log correlation
      adIngestionId: adIngestionId ?? null,
      clientId: clientId ?? null,
    });
  } catch (err) {
    console.error('[audio-loudnorm-trim] error:', err?.message ?? err);
    next(err);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
