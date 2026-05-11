/**
 * routes/clean-mode-compose.js
 *
 * Milestone 2: full clean-mode reel pipeline. Source MP4 in, final
 * captioned-and-brolled MP4 out.
 *
 * Two response modes (PR-I 2026-05-09 — plan v2):
 *   1. **Synchronous** (legacy / manual curl): no `callback` in body. The
 *      route blocks until the pipeline finishes and returns the full result.
 *      Wall-clock ~150s; clients must use a generous timeout.
 *   2. **Accept-and-async** (portal-triggered): `callback: { url, apiKey }`
 *      in body. Route validates, responds 202 immediately, runs the pipeline
 *      in the background, then POSTs to the EXISTING portal endpoint
 *      `POST /api/editor/callback/reel` with the simpler payload
 *      `{ contentItemId, clientId, editedUrl, editNotes }` and `x-api-key`
 *      auth. The original caller never sees the pipeline output directly —
 *      the portal handles the eventual Slack/UI/Metricool wiring via its
 *      existing endpoint contract.
 *
 *      Failure path: success-only callback (matches portal endpoint shape).
 *      If the pipeline fails internally, we DO NOT POST anything; the
 *      portal's hourly stuck-row cron flips rows that stay in 'editing'
 *      for > 15 min to 'edit_failed'.
 *
 * Auth: bearer WORKER_SECRET (handled by global middleware in server.js).
 *
 * Pipeline operator directive (per M2 plan):
 *   - All internal Storage I/O via service-role REST
 *   - Default model: gemini-3.1-pro-preview
 */

import { Router } from 'express';
import { runCleanModePipeline } from '../lib/clean_mode_pipeline.js';
import {
  postReelEditedCallback,
  buildReelEditedPayload,
  buildEditNotesSummary,
} from '../lib/portal_webhook.js';
import { signStorageUrl } from '../lib/storage_helpers.js';

export const cleanModeComposeRouter = Router();

// Match the portal's raw_footage_url TTL convention (1 year) for the
// editedUrl that gets stored on cs.content_items.edit_file_url.
const EDITED_URL_TTL_SEC = 60 * 60 * 24 * 365;

/**
 * POST /clean-mode-compose
 *
 * Body:
 *   {
 *     jobId: string,
 *     contentItemId?: string,                  // PR-I v2: required when callback present
 *     sourceMP4: { bucket: string, path: string },
 *     clientId: string,
 *     options?: {
 *       model?: string, brollDensity?: number, cutProfile?: string,
 *       skipBroll?: boolean, skipSubtitles?: boolean,
 *       pixabayEnabled?: boolean, bgmEnabled?: boolean, ...
 *     },
 *     output: { bucket: string, pathPrefix: string },
 *     callback?: { url: string, apiKey: string }   // PR-I v2: opt-in async mode
 *   }
 *
 * Sync mode (no callback):
 *   200: see lib/clean_mode_pipeline.runCleanModePipeline return shape
 *   4xx/5xx: { jobId, step, error, ... }
 *
 * Async mode (callback present):
 *   202: { jobId, accepted: true, mode: 'async' }
 *   4xx: shape validation failures still 4xx synchronously
 *   Eventual callback POSTs { contentItemId, clientId, editedUrl, editNotes }
 *   to <callback.url> with `x-api-key: <callback.apiKey>`.
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

    // PR-I v2: callback shape validation. The async-mode contract requires
    // contentItemId because the portal endpoint matches by that field.
    const callback = body.callback;
    const asyncMode = !!(callback && typeof callback === 'object');
    if (asyncMode) {
      if (typeof callback.url !== 'string' || !/^https?:\/\//.test(callback.url)) {
        return res.status(400).json({ jobId, step: 'validate', error: 'callback.url must be an http(s) URL' });
      }
      if (typeof callback.apiKey !== 'string' || callback.apiKey.length === 0) {
        return res.status(400).json({ jobId, step: 'validate', error: 'callback.apiKey is required when callback.url is present' });
      }
      if (typeof body.contentItemId !== 'string' || body.contentItemId.length === 0) {
        return res.status(400).json({ jobId, step: 'validate', error: 'contentItemId is required when callback is present' });
      }
    }

    if (asyncMode) {
      // ── Accept-and-async mode ────────────────────────────────────────
      // 1. Acknowledge to the caller immediately so Vercel doesn't time out.
      // 2. Continue running the pipeline AFTER the response has been sent.
      // 3. On success, POST to the existing portal endpoint. On failure,
      //    log loudly — the portal's stuck-row cron recovers it after
      //    15 min (plan v2 keeps the failure path simple).
      console.log(`[clean-mode-compose] job=${jobId} ASYNC accepted (callback=${callback.url}, contentItemId=${body.contentItemId})`);
      res.status(202).json({ jobId, accepted: true, mode: 'async' });

      // Fire-and-forget — explicitly don't await. Errors inside are caught
      // and reported (success-only callback ⇒ failures just log + rely on
      // the portal-side cron). Wrap in setImmediate so the response flush
      // completes before the heavy pipeline work starts.
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
 * PR-I v2 async-mode pipeline runner. Lives outside the route handler so
 * the response can be flushed before the heavy work begins.
 *
 * Sends EXACTLY ONE callback POST per request — only on SUCCESS. Failures
 * are logged loudly and recovered by the portal's stuck-row cron after
 * 15 min. Per plan v2 / Phoenix feedback: no failure callback in this
 * first cut.
 */
async function runAsyncJob(body, jobId, callback) {
  let result;
  try {
    result = await runCleanModePipeline(body);
  } catch (err) {
    // Hit only when the orchestrator throws OUTSIDE its own catch (very rare
    // — validation throws synchronously, pipeline-internal throws are caught
    // by PR #103). Log loudly; the portal cron picks this up.
    console.error(
      `[clean-mode-compose] job=${jobId} ASYNC hard error (no callback fired):`,
      err?.stack ?? err,
    );
    return;
  }

  if (result?.error) {
    // Partial-data path (orchestrator caught an internal throw). Plan v2:
    // no failure callback. Portal stuck-row cron will recover.
    console.error(
      `[clean-mode-compose] job=${jobId} ASYNC step=${result.error.step ?? '?'} ` +
      `error: ${result.error.message ?? '(no message)'} — NO callback fired ` +
      `(portal cron will mark edit_failed after 15 min)`,
    );
    return;
  }

  if (!result?.finalStorage?.bucket || !result?.finalStorage?.path) {
    console.error(
      `[clean-mode-compose] job=${jobId} ASYNC pipeline returned no finalStorage — ` +
      `cannot post callback`,
    );
    return;
  }

  // Mint a 1-year signed URL — matches the portal's raw_footage_url TTL
  // convention so the stored edit_file_url stays playable long-term.
  let editedUrl;
  try {
    editedUrl = await signStorageUrl({
      bucket: result.finalStorage.bucket,
      path: result.finalStorage.path,
      expiresIn: EDITED_URL_TTL_SEC,
    });
  } catch (err) {
    console.error(
      `[clean-mode-compose] job=${jobId} ASYNC failed to mint 1-year signed URL ` +
      `for ${result.finalStorage.bucket}/${result.finalStorage.path}:`,
      err?.message ?? err,
    );
    return;
  }

  const editNotes = buildEditNotesSummary(result);
  const payload = buildReelEditedPayload({
    contentItemId: body.contentItemId,
    clientId: body.clientId,
    editedUrl,
    editNotes,
  });

  const post = await postReelEditedCallback({
    callbackUrl: callback.url,
    callbackApiKey: callback.apiKey,
    payload,
  });
  if (!post.ok) {
    console.error(
      `[clean-mode-compose] job=${jobId} ASYNC callback delivery FAILED ` +
      `(attempts=${post.attempts} status=${post.status ?? '-'} err=${post.error ?? '-'}). ` +
      `Portal cron will recover via the stuck-editing sweep after 15 min.`,
    );
  } else {
    console.log(
      `[clean-mode-compose] job=${jobId} ASYNC callback delivered ` +
      `(status=${post.status} contentItemId=${body.contentItemId})`,
    );
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
