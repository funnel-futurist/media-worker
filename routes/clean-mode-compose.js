/**
 * routes/clean-mode-compose.js
 *
 * Milestone 2: full clean-mode reel pipeline. Source MP4 in, final
 * captioned-and-brolled MP4 out. Synchronous response (M2 test mode) — long
 * videos may take 5+ minutes; clients must use a generous timeout. M3 will
 * switch to async fire-and-forget with status writes on cs.content_items.
 *
 * Auth: bearer WORKER_SECRET (handled by global middleware in server.js).
 *
 * Pipeline operator directive (per M2 plan):
 *   - No portal repo touchpoints
 *   - No Vercel cron, no schema migrations
 *   - All internal Storage I/O via service-role REST
 *   - Default model: gemini-3.1-pro-preview
 *   - Math-remap subtitles (no second Scribe call per job)
 *   - file_url required on every broll asset (no Drive OAuth resolution)
 */

import { Router } from 'express';
import { runCleanModePipeline } from '../lib/clean_mode_pipeline.js';

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
 *     },
 *     output: { bucket: string, pathPrefix: string },
 *   }
 *
 * 200: see lib/clean_mode_pipeline.runCleanModePipeline return shape
 * 4xx/5xx: { jobId, step, error, upstream?, warnings? }
 */
cleanModeComposeRouter.post('/clean-mode-compose', async (req, res) => {
  const body = req.body || {};
  const jobId = typeof body.jobId === 'string' ? body.jobId : undefined;

  // Body-shape validation runs here (returns 400 with `step:'validate'`).
  // Pipeline failures are caught INSIDE runCleanModePipeline (PR #103) and
  // returned as a partial-data shape with an `error` field — which lets the
  // operator see what data was collected before the throw.
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

    console.log(`[clean-mode-compose] job=${jobId} client=${body.clientId} src=${body.sourceMP4.bucket}/${body.sourceMP4.path}`);
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
