/**
 * routes/retime-intro.js
 *
 * Cuts a set of source-time windows out of an already-edited (v1) deliverable
 * and uploads the result to Supabase Storage. Used by the creative-engine
 * revision pipeline for the `retime_intro` revisionType — the client points
 * at a phrase in the intro they want gone; creative-engine resolves that to
 * a [start, end] range against the Deepgram nova-3 transcript, then calls
 * this route to do the surgical ffmpeg cut.
 *
 * Why a separate route from /audio-loudnorm-trim (which also accepts `cuts`):
 *   - This operates on a FINISHED edit, not on raw source. Loudnorm has
 *     already been applied during the original edit, and re-applying changes
 *     the perceived levels noticeably. So this route runs trim+concat with
 *     loudnorm DISABLED.
 *   - The output goes into the client-facing deliverable bucket
 *     (`client-uploads/{slug}/edited/`), not into the Hyperframes source
 *     bucket — different lifecycle.
 *   - Conceptually it's a different operation: revision, not preparation.
 *     Keeping them separate prevents the audio-loudnorm-trim API surface
 *     from accreting flags.
 *
 * Returns STABLE storage refs ({ bucket, path, sha256 }) — caller signs the
 * URL on demand. Same convention as audio-loudnorm-trim per Phoenix's review.
 */

import { Router } from 'express';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID, createHash } from 'crypto';
import axios from 'axios';
import { getDuration } from '../lib/media.js';
import { buildKeepSegments, runTrimConcat } from '../lib/ffmpeg_trim_concat.js';

export const retimeIntroRouter = Router();

/**
 * POST /retime-intro
 *
 * Body: {
 *   sourceUrl: string,                          // signed URL to v1 edited video
 *   cuts: Array<{ start: number, end: number }>, // source-time seconds to REMOVE
 *   outputBucket: string,                       // typically 'client-uploads'
 *   outputObjectPath: string,                   // e.g. 'enablesnp/edited/<revisionId>.mp4'
 *   revisionId: string,                         // for log correlation
 *   clientId?: string,                          // for log correlation
 * }
 *
 * Response: { storageBucket, storagePath, durationSeconds, assetHash, cutsApplied, totalCutSeconds }
 *
 * Errors:
 *   - 400 on missing fields or invalid cuts
 *   - 500 if ffmpeg fails or upload fails — fail loud so the caller fail-safe
 *     escalates to Shannon rather than silently producing a broken v2.
 */
retimeIntroRouter.post('/retime-intro', async (req, res, next) => {
  const tmpDir = join('/tmp', `retime-${randomUUID()}`);
  try {
    const {
      sourceUrl,
      cuts,
      outputBucket,
      outputObjectPath,
      revisionId,
      clientId,
    } = req.body || {};

    // ── 0. Validate ────────────────────────────────────────────────
    if (!sourceUrl) {
      return res.status(400).json({ error: 'sourceUrl is required' });
    }
    if (!outputBucket || !outputObjectPath) {
      return res.status(400).json({ error: 'outputBucket and outputObjectPath are required' });
    }
    if (!Array.isArray(cuts) || cuts.length === 0) {
      return res.status(400).json({ error: 'cuts must be a non-empty array' });
    }
    for (const c of cuts) {
      if (typeof c?.start !== 'number' || typeof c?.end !== 'number' || c.end <= c.start || c.start < 0) {
        return res.status(400).json({ error: 'each cut must be { start: number, end: number } with end > start and start >= 0' });
      }
    }

    mkdirSync(tmpDir, { recursive: true });
    const inputPath = join(tmpDir, 'in.mp4');
    const outputPath = join(tmpDir, 'out.mp4');

    // ── 1. Download v1 ─────────────────────────────────────────────
    console.log(`[retime-intro] downloading v1 for revisionId=${revisionId ?? '(none)'}`);
    const { data } = await axios.get(sourceUrl, {
      responseType: 'arraybuffer',
      timeout: 180_000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    writeFileSync(inputPath, Buffer.from(data));
    if (!existsSync(inputPath)) {
      throw new Error('source download produced no file on disk');
    }

    // ── 2. Build keep-segments + safety-check cut ranges ───────────
    const sourceDurationSeconds = await getDuration(inputPath);
    for (const c of cuts) {
      if (c.end > sourceDurationSeconds + 0.5) {
        return res.status(400).json({
          error: `cut end (${c.end}s) exceeds source duration (${sourceDurationSeconds.toFixed(2)}s)`,
        });
      }
    }
    const keepSegments = buildKeepSegments(cuts, sourceDurationSeconds);

    const sortedCuts = [...cuts].sort((a, b) => a.start - b.start);
    const mergedCuts = [];
    for (const c of sortedCuts) {
      const last = mergedCuts[mergedCuts.length - 1];
      if (last && c.start <= last.end) {
        last.end = Math.max(last.end, c.end);
      } else {
        mergedCuts.push({ start: c.start, end: c.end });
      }
    }

    // ── 3. ffmpeg trim+concat (no loudnorm — v1 was already normalized) ─
    console.log(
      `[retime-intro] ffmpeg cuts=${mergedCuts.length} ` +
        `keep_segments=${keepSegments.length} src_dur=${sourceDurationSeconds.toFixed(2)}s`
    );
    await runTrimConcat(inputPath, outputPath, {
      keepSegments,
      applyLoudnorm: false,
      encoderArgs: [
        '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '2500k',
        '-r', '30', '-g', '30', '-keyint_min', '30',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
      ],
      timeoutMs: 600_000,
    });

    // ── 4. Hash + duration ─────────────────────────────────────────
    const durationSeconds = await getDuration(outputPath);
    const fileBuffer = readFileSync(outputPath);
    const assetHash = createHash('sha256').update(fileBuffer).digest('hex');

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

    const totalCutSeconds = mergedCuts.reduce((sum, c) => sum + (c.end - c.start), 0);
    console.log(
      `[retime-intro] done: ${outputBucket}/${outputObjectPath} ` +
        `dur=${durationSeconds.toFixed(2)}s cut=${totalCutSeconds.toFixed(2)}s ` +
        `sha256=${assetHash.slice(0, 12)}…`
    );

    res.json({
      storageBucket: outputBucket,
      storagePath: outputObjectPath,
      durationSeconds,
      assetHash,
      cutsApplied: mergedCuts.length,
      totalCutSeconds: Number(totalCutSeconds.toFixed(3)),
      revisionId: revisionId ?? null,
      clientId: clientId ?? null,
    });
  } catch (err) {
    console.error('[retime-intro] error:', err?.message ?? err);
    next(err);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
