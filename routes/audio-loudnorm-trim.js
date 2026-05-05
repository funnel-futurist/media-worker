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
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID, createHash } from 'crypto';
import axios from 'axios';
import { getDuration } from '../lib/media.js';
import { buildKeepSegments, runTrimConcat } from '../lib/ffmpeg_trim_concat.js';

export const audioLoudnormTrimRouter = Router();

/**
 * POST /audio-loudnorm-trim
 *
 * Body: {
 *   sourceUrl: string,                         // for sourceType='public_url'
 *   sourceType: 'drive' | 'public_url',
 *   driveFileId?: string,                      // required when sourceType='drive'
 *   driveToken?: string,                       // OAuth bearer token, required when sourceType='drive'
 *                                              //   (generated caller-side via getDriveToken())
 *   trimStartSeconds: number,                  // head trim in seconds; 0 = no trim (legacy slate-only path)
 *   cuts?: Array<{ start: number, end: number }>,  // optional silence/bad-take cuts in source-time;
 *                                                   //   the slate trim (if trimStartSeconds > 0) is
 *                                                   //   prepended automatically — caller passes ONE source
 *                                                   //   of truth for editorial cuts only.
 *   outputBucket: string,                      // e.g. 'hyperframes-source'
 *   outputObjectPath: string,                  // e.g. '<ad_ingestion_id>.mp4'
 *   clientId: string,
 *   adIngestionId: string,
 * }
 *
 * Response: { storageBucket, storagePath, durationSeconds, assetHash, cutsApplied }
 */
audioLoudnormTrimRouter.post('/audio-loudnorm-trim', async (req, res, next) => {
  const tmpDir = join('/tmp', `audionorm-${randomUUID()}`);
  try {
    const {
      sourceUrl,
      sourceType,
      driveFileId,
      driveToken,
      trimStartSeconds = 0,
      cuts = [],
      outputBucket,
      outputObjectPath,
      clientId,
      adIngestionId,
    } = req.body || {};

    if (!outputBucket || !outputObjectPath) {
      return res.status(400).json({ error: 'outputBucket and outputObjectPath are required' });
    }
    if (sourceType === 'drive' && (!driveFileId || !driveToken)) {
      return res.status(400).json({ error: 'driveFileId and driveToken are required when sourceType=drive' });
    }
    if (sourceType !== 'drive' && !sourceUrl) {
      return res.status(400).json({ error: 'sourceUrl is required when sourceType=public_url' });
    }
    if (typeof trimStartSeconds !== 'number' || trimStartSeconds < 0) {
      return res.status(400).json({ error: 'trimStartSeconds must be a non-negative number' });
    }
    if (!Array.isArray(cuts)) {
      return res.status(400).json({ error: 'cuts must be an array' });
    }
    for (const c of cuts) {
      if (typeof c?.start !== 'number' || typeof c?.end !== 'number' || c.end <= c.start) {
        return res.status(400).json({ error: 'each cut must be { start: number, end: number } with end > start' });
      }
    }

    mkdirSync(tmpDir, { recursive: true });
    const inputPath = join(tmpDir, 'in.mp4');
    const outputPath = join(tmpDir, 'out.mp4');

    // ── 1. Download source ─────────────────────────────────────────
    // Drive downloads use the caller-supplied bearer token (matches the
    // pattern in routes/classify.js — Railway never holds OAuth credentials,
    // creative-engine generates a short-lived token via getDriveToken()).
    console.log(`[audio-loudnorm-trim] downloading ${sourceType} for ${adIngestionId ?? '(no id)'}`);
    const downloadUrl = sourceType === 'drive'
      ? `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media&supportsAllDrives=true`
      : sourceUrl;
    const downloadHeaders = sourceType === 'drive'
      ? { Authorization: `Bearer ${driveToken}` }
      : {};
    const { data } = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 180_000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      headers: downloadHeaders,
    });
    writeFileSync(inputPath, Buffer.from(data));

    if (!existsSync(inputPath)) {
      throw new Error('source download produced no file on disk');
    }

    // ── 2. Build the unified cuts list, then derive keep-segments ──
    // Slate trim (trimStartSeconds) is treated as the first cut [0, trimStartSeconds]
    // so the rest of the pipeline only knows about ONE concept: cut windows.
    const sourceDurationSeconds = await getDuration(inputPath);
    const allCuts = [];
    if (trimStartSeconds > 0) allCuts.push({ start: 0, end: trimStartSeconds });
    for (const c of cuts) allCuts.push({ start: c.start, end: c.end });
    const keepSegments = buildKeepSegments(allCuts, sourceDurationSeconds);

    // mergedCuts are derived for the response's totalCutSeconds + cutsApplied
    // count. Compute the merged form alongside keepSegments since the lib
    // doesn't expose it.
    const sortedCuts = [...allCuts].sort((a, b) => a.start - b.start);
    const mergedCuts = [];
    for (const c of sortedCuts) {
      const last = mergedCuts[mergedCuts.length - 1];
      if (last && c.start <= last.end) {
        last.end = Math.max(last.end, c.end);
      } else {
        mergedCuts.push({ start: c.start, end: c.end });
      }
    }

    // ── 3. ffmpeg: trim each keep-segment, concat, then loudnorm ───
    // Re-encoding video as H.264 is necessary because:
    //   1. Frame-accurate trim requires re-encode (stream copy snaps to
    //      keyframes which can drift several seconds)
    //   2. Source could be HEVC (iPhone/Mac); H.264 is safer for downstream
    //   3. Hyperframes' headless Chrome render pipeline is happiest with H.264
    //
    // Loudnorm (EBU R128: -16 LUFS / -1.5 dBTP / 11 LU LRA) runs AFTER concat
    // so normalized loudness is based on kept content, not cut-out dead air.
    // Dense keyframes (-r 30 -g 30 -keyint_min 30) are required by
    // Hyperframes' parallel frame extractor.
    console.log(
      `[audio-loudnorm-trim] ffmpeg cuts=${mergedCuts.length} ` +
        `keep_segments=${keepSegments.length} src_dur=${sourceDurationSeconds.toFixed(2)}s`
    );
    await runTrimConcat(inputPath, outputPath, {
      keepSegments,
      applyLoudnorm: true,
      encoderArgs: [
        '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '2500k',
        '-r', '30', '-g', '30', '-keyint_min', '30',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
      ],
      timeoutMs: 600_000,
    });

    // ── 4. Compute duration + content hash ─────────────────────────
    const durationSeconds = await getDuration(outputPath);
    const fileBuffer = readFileSync(outputPath);
    const assetHash = createHash('sha256').update(fileBuffer).digest('hex');

    console.log(
      `[audio-loudnorm-trim] done: ${outputBucket}/${outputObjectPath} ` +
        `dur=${durationSeconds.toFixed(2)}s sha256=${assetHash.slice(0, 12)}…`
    );

    // ── 5. Upload to Supabase Storage ──────────────────────────────
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

    // ── 6. Return STABLE refs (no signed URL — caller signs on demand) ─
    const totalCutSeconds = mergedCuts.reduce((sum, c) => sum + (c.end - c.start), 0);
    res.json({
      storageBucket: outputBucket,
      storagePath: outputObjectPath,
      durationSeconds,
      assetHash,
      cutsApplied: mergedCuts.length,
      totalCutSeconds: Number(totalCutSeconds.toFixed(3)),
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
