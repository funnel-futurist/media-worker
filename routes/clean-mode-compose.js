/**
 * routes/clean-mode-compose.js
 *
 * Milestone 2: full clean-mode reel pipeline. Source MP4 in, final
 * captioned-and-brolled MP4 out.
 *
 * Two response modes (PR-I 2026-05-09):
 *   1. **Synchronous** (legacy / manual curl): no `callback` in body. The
 *      route blocks until the pipeline finishes and returns the full result.
 *      Wall-clock ~150s; clients must use a generous timeout.
 *   2. **Accept-and-async** (portal-triggered): `callback: { url, secret }`
 *      in body. Route validates, responds 202 immediately, runs the pipeline
 *      in the background, then POSTs the result envelope to `callback.url`
 *      with an HMAC-SHA256 signature in `x-worker-signature`. The original
 *      caller never sees the pipeline output directly — they get the
 *      eventual webhook instead. This unblocks Vercel route handlers
 *      (which have a 60s timeout) from auto-triggering edits on upload.
 *
 * Auth: bearer WORKER_SECRET (handled by global middleware in server.js).
 *
 * Pipeline operator directive (per M2 plan):
 *   - No portal repo touchpoints inside the orchestrator itself
 *   - All internal Storage I/O via service-role REST
 *   - Default model: gemini-3.1-pro-preview
 */

import { Router } from 'express';
import { runCleanModePipeline } from '../lib/clean_mode_pipeline.js';
import {
  postEditCompleteToPortal,
  buildSuccessEnvelope,
  buildFailureEnvelope,
} from '../lib/portal_webhook.js';

export const cleanModeComposeRouter = Router();

/**
 * POST /clean-mode-compose
 *
 * Body:
 *   {
 *     jobId: string,
 *     sourceMP4: { bucket: string, path: string },
 *     clientId: string,
 *     options?: {
 *       model?: string,
 *       brollDensity?: number,
 *       cutProfile?: string,
 *       skipBroll?: boolean,
 *       skipSubtitles?: boolean,
 *       pixabayEnabled?: boolean,
 *       bgmEnabled?: boolean,
 *       ...
 *     },
 *     output: { bucket: string, pathPrefix: string },
 *     callback?: { url: string, secret: string },   // PR-I: opt-in async mode
 *   }
 *
 * Sync mode (no callback):
 *   200: see lib/clean_mode_pipeline.runCleanModePipeline return shape
 *   4xx/5xx: { jobId, step, error, ... }
 *
 * Async mode (callback present):
 *   202: { jobId, accepted: true, mode: 'async' }
 *   4xx:  shape validation failures still 4xx synchronously
 *   Eventual callback POSTs SuccessEnvelope or FailureEnvelope (see
 *   lib/portal_webhook.js).
 */
cleanModeComposeRouter.post('/clean-mode-compose', async (req, res) => {
  const body = req.body || {};
  const jobId = typeof body.jobId === 'string' ? body.jobId : undefined;

  // Body-shape validation always runs synchronously (returns 400 even in
  // async mode — the portal needs immediate feedback if the request was
  // malformed).
  try {
    if (!jobId) return res.status(400).json({ error: 'jobId is required (non-empty string)' });
    if (!body.sourceMP4 || typeof body.sourceMP4.bucket !== 'string' || typeof body.sourceMP4.path !== 'string') {
      return res.status(400).json({ jobId, step: 'validate', error: 'sourceMP4 must be { bucket, path }' });
    }
    if (typeof body.clientId !== 'string' || body.clientId.length === 0) {
      return res.status(400).json({ jobId, step: 'validate', error: 'clientId is required' });
    }
    if (!body.output || typeof body.output.bucket !== 'string' || typeof body.output.pathPrefix !== 'string') {
      return res.status(400).json({ jobId, step: 'validate', error: 'output must be { bucket, pathPrefix }' });
    }
    if (body.options) {
      if (body.options.brollDensity != null && (typeof body.options.brollDensity !== 'number' || body.options.brollDensity <= 0 || body.options.brollDensity > 1)) {
        return res.status(400).json({ jobId, step: 'validate', error: 'options.brollDensity must be in (0, 1]' });
      }
    }

    // PR-I: callback shape validation if present.
    const callback = body.callback;
    const asyncMode = !!(callback && typeof callback === 'object');
    if (asyncMode) {
      if (typeof callback.url !== 'string' || !/^https?:\/\//.test(callback.url)) {
        return res.status(400).json({ jobId, step: 'validate', error: 'callback.url must be an http(s) URL' });
      }
      if (typeof callback.secret !== 'string' || callback.secret.length === 0) {
        return res.status(400).json({ jobId, step: 'validate', error: 'callback.secret is required when callback.url is present' });
      }
    }

    if (asyncMode) {
      // ── Accept-and-async mode ────────────────────────────────────────
      // 1. Acknowledge to the caller immediately so Vercel doesn't time out.
      // 2. Continue running the pipeline AFTER the response has been sent.
      // 3. POST the result envelope to callback.url when the pipeline finishes.
      console.log(`[clean-mode-compose] job=${jobId} ASYNC accepted (callback=${callback.url})`);
      res.status(202).json({ jobId, accepted: true, mode: 'async' });

      // Fire-and-forget — explicitly don't await. Any error inside is caught
      // and reported through the callback, never bubbled to the (already-sent)
      // response. Wrap in a setImmediate so the response flush completes
      // before the heavy pipeline work starts; helps the OS hand back the
      // socket promptly under load.
      setImmediate(() => {
        runAsyncJob(body, jobId, callback).catch((err) => {
          console.error(`[clean-mode-compose] job=${jobId} runAsyncJob crashed:`, err?.stack ?? err);
        });
      });
      return;
    }

    // ── Synchronous mode (legacy / curl) ────────────────────────────────
    console.log(`[clean-mode-compose] job=${jobId} SYNC client=${body.clientId} src=${body.sourceMP4.bucket}/${body.sourceMP4.path}`);
    const result = await runCleanModePipeline(body);

    // PR #103: orchestrator's catch returns a partial-data response with an
    // `error` field. Map that to a non-2xx status (preserve the partial
    // payload so the operator sees diagnostics + cuts + streamSync etc).
    if (result?.error) {
      const status = pickStatusFromMessage(result.error.message ?? '');
      console.error(
        `[clean-mode-compose] job=${jobId} step=${result.error.step ?? '?'} ` +
        `error: ${result.error.message ?? '(no message)'} (returning partial data)`,
      );
      return res.status(status).json(result);
    }

    console.log(`[clean-mode-compose] job=${jobId} OK in ${result.processingMs}ms (cuts:${result.cuts.applied} ins:${result.insertions.count} subs:${result.subtitles.lines})`);
    return res.json(result);
  } catch (err) {
    // Fallback path — only hit if the orchestrator throws BEFORE its own
    // try/catch can fire (e.g., the early validation throws like
    // "jobId is required"). Pipeline-internal errors return through the
    // partial-data path above instead.
    console.error(`[clean-mode-compose] job=${jobId ?? '?'} early error:`, err?.message ?? err);
    return res.status(500).json({
      jobId: jobId ?? null,
      step: 'pipeline',
      error: err?.message ?? String(err),
    });
  }
});

/**
 * PR-I async-mode pipeline runner. Lives outside the route handler so the
 * response can be flushed before the heavy work begins.
 *
 * Sends EXACTLY ONE callback POST per request — either success or failure.
 * Logs loudly on callback delivery failure; the caller (portal) has its own
 * cron sweep that recovers stuck rows after 15 min.
 */
async function runAsyncJob(body, jobId, callback) {
  let envelope;
  try {
    const result = await runCleanModePipeline(body);
    if (result?.error) {
      // Partial-data path (orchestrator caught an internal throw)
      envelope = buildFailureEnvelope(jobId, {
        step: result.error.step ?? 'pipeline',
        message: result.error.message ?? '(no message)',
      });
      console.error(
        `[clean-mode-compose] job=${jobId} ASYNC step=${result.error.step ?? '?'} ` +
        `error: ${result.error.message ?? '(no message)'} — posting failure callback`,
      );
    } else {
      envelope = buildSuccessEnvelope(jobId, result);
      console.log(
        `[clean-mode-compose] job=${jobId} ASYNC OK in ${result.processingMs}ms — posting success callback`,
      );
    }
  } catch (err) {
    // Hit only when the orchestrator throws OUTSIDE its own catch (very rare
    // — validation throws synchronously, pipeline-internal throws are caught
    // by PR #103). Treat as a hard pipeline failure.
    envelope = buildFailureEnvelope(jobId, {
      step: 'pipeline',
      message: err?.message ?? String(err),
    });
    console.error(`[clean-mode-compose] job=${jobId} ASYNC hard error:`, err?.stack ?? err);
  }

  const post = await postEditCompleteToPortal({
    callbackUrl: callback.url,
    callbackSecret: callback.secret,
    payload: envelope,
  });
  if (!post.ok) {
    console.error(
      `[clean-mode-compose] job=${jobId} ASYNC callback delivery FAILED ` +
      `(attempts=${post.attempts} status=${post.status ?? '-'} err=${post.error ?? '-'}). ` +
      `Portal cron will recover via the stuck-editing sweep after 15 min.`,
    );
  } else {
    console.log(`[clean-mode-compose] job=${jobId} ASYNC callback delivered (status=${post.status})`);
  }
}

/**
 * Status code policy (matches the prior `pickStatusFromError`):
 *   - 502 when an upstream service responds with an error (Gemini, Supabase,
 *     Scribe, etc)
 *   - 500 for everything else (internal pipeline bug, A/V sync gate, etc)
 */
function pickStatusFromMessage(msg) {
  if (/Supabase \w+ \d{3}/.test(msg)) return 502;
  if (/Scribe \d{3}/.test(msg)) return 502;
  if (/broll picker failed/.test(msg)) return 502;
  if (/Broll download \d{3}/.test(msg)) return 502;
  return 500;
}
