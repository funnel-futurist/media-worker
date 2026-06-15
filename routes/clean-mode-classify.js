/**
 * routes/clean-mode-classify.js
 *
 * Dry-run cut-classifier endpoint. Same upstream stages as
 * /clean-mode-compose (download → silence → Deepgram → slate → cut classify)
 * but stops before bad-take / raw-cleanup / best-take / compose / upload.
 *
 * Goal: A/B threshold options (`cutSafetyMode`, `retainSec`, etc.) in
 * ~15-30s per fire instead of ~60-100s for the full pipeline, so per-job
 * tuning is fast enough to iterate on. See lib/classify_cuts_only.js for
 * the orchestrator.
 *
 * Auth: bearer WORKER_SECRET (handled by global middleware in server.js).
 *
 * No async/callback mode — dry-runs are always synchronous (operators
 * fire them from a script and read the JSON response directly).
 */

import { Router } from 'express';
import { runClassifyCutsOnly } from '../lib/classify_cuts_only.js';
import { validateClassifyOptions } from '../lib/options_validation.js';

export const cleanModeClassifyRouter = Router();

/**
 * POST /clean-mode-classify
 *
 * Body:
 *   {
 *     jobId: string,
 *     sourceMP4: { bucket: string, path: string },
 *     clientId: string,
 *     options?: {
 *       cutSafetyMode?: 'safe_only' | 'safe_and_soft' | 'all',
 *       retainSec?: number,            // (0, 1]
 *       silenceNoiseDb?: number,       // [-60, -10]
 *       silenceMinDur?: number,        // (0, 5]
 *       slateHint?: string,            // ≤ 200 chars
 *       skipSlate?: boolean,
 *       deepgramKeywords?: string[],   // ≤ 20 entries, each ≤ 200 chars
 *     },
 *   }
 *
 * Response (200):
 *   {
 *     jobId, processingMs, sourceDurationSec,
 *     silence: { spans, mergedSpans, mergesApplied },
 *     transcript: { text, words },
 *     slate: { detected, via, endSec, snappedEndSec, identifier, error },
 *     cuts: {
 *       applied, skipped, secondsRemoved,
 *       byCategory: { applied: {...}, skipped: {...} },
 *       appliedDetail: [{ startSec, endSec, bucket, safety, safetyReason, reason, ... }],
 *       skippedDetail: [...],
 *     },
 *     steps: { download, silenceDetect, transcribe, slateDetect, cutClassify },
 *   }
 *
 * Response (4xx/5xx): { jobId, step, error }
 */
cleanModeClassifyRouter.post('/clean-mode-classify', async (req, res) => {
  const body = req.body || {};
  const jobId = typeof body.jobId === 'string' ? body.jobId : undefined;

  try {
    if (!jobId) return res.status(400).json({ error: 'jobId is required (non-empty string)' });
    if (!body.sourceMP4 || typeof body.sourceMP4.bucket !== 'string' || typeof body.sourceMP4.path !== 'string') {
      return res.status(400).json({ jobId, step: 'validate', error: 'sourceMP4 must be { bucket, path }' });
    }
    if (typeof body.clientId !== 'string' || body.clientId.length === 0) {
      return res.status(400).json({ jobId, step: 'validate', error: 'clientId is required' });
    }

    const optionsErr = validateClassifyOptions(body.options);
    if (optionsErr) {
      return res.status(400).json({ jobId, step: 'validate', error: optionsErr });
    }

    console.log(`[clean-mode-classify] job=${jobId} client=${body.clientId} src=${body.sourceMP4.bucket}/${body.sourceMP4.path}`);
    const result = await runClassifyCutsOnly(body);
    console.log(
      `[clean-mode-classify] job=${jobId} OK in ${result.processingMs}ms ` +
      `(cuts: applied=${result.cuts.applied} skipped=${result.cuts.skipped} ` +
      `secondsRemoved=${result.cuts.secondsRemoved})`,
    );
    return res.json(result);
  } catch (err) {
    console.error(`[clean-mode-classify] job=${jobId ?? '?'} error:`, err?.message ?? err);
    return res.status(500).json({
      jobId: jobId ?? null,
      step: 'pipeline',
      error: err?.message ?? String(err),
    });
  }
});
