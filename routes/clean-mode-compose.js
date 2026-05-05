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

  // Surface any thrown error as { jobId, step, error } so operators see
  // exactly which phase blew up without grepping logs.
  let currentStep = 'validate';
  try {
    if (!jobId) return res.status(400).json({ error: 'jobId is required (non-empty string)' });
    if (!body.sourceMP4 || typeof body.sourceMP4.bucket !== 'string' || typeof body.sourceMP4.path !== 'string') {
      return res.status(400).json({ jobId, step: currentStep, error: 'sourceMP4 must be { bucket, path }' });
    }
    if (typeof body.clientId !== 'string' || body.clientId.length === 0) {
      return res.status(400).json({ jobId, step: currentStep, error: 'clientId is required' });
    }
    if (!body.output || typeof body.output.bucket !== 'string' || typeof body.output.pathPrefix !== 'string') {
      return res.status(400).json({ jobId, step: currentStep, error: 'output must be { bucket, pathPrefix }' });
    }
    if (body.options) {
      if (body.options.brollDensity != null && (typeof body.options.brollDensity !== 'number' || body.options.brollDensity <= 0 || body.options.brollDensity > 1)) {
        return res.status(400).json({ jobId, step: currentStep, error: 'options.brollDensity must be in (0, 1]' });
      }
    }

    currentStep = 'pipeline';
    console.log(`[clean-mode-compose] job=${jobId} client=${body.clientId} src=${body.sourceMP4.bucket}/${body.sourceMP4.path}`);
    const result = await runCleanModePipeline(body);
    console.log(`[clean-mode-compose] job=${jobId} OK in ${result.processingMs}ms (cuts:${result.cuts.applied} ins:${result.insertions.count} subs:${result.subtitles.lines})`);
    return res.json(result);
  } catch (err) {
    const stepFromMsg = inferStepFromError(err?.message ?? '');
    const step = stepFromMsg ?? currentStep;
    console.error(`[clean-mode-compose] job=${jobId ?? '?'} step=${step} error:`, err?.message ?? err);
    const status = pickStatusFromError(err);
    return res.status(status).json({
      jobId: jobId ?? null,
      step,
      error: err?.message ?? String(err),
    });
  }
});

/**
 * Map an error message back to the pipeline step that produced it. Best-effort
 * — the orchestrator's per-step timing record on a successful run is the
 * authoritative breakdown. This mapping just gives the failure response a
 * step name when the orchestrator threw.
 */
function inferStepFromError(message) {
  if (/Supabase download/i.test(message)) return 'download';
  if (/Scribe/.test(message)) return 'transcribe';
  if (/silencedetect/i.test(message)) return 'silenceDetect';
  if (/cuts cover the entire source/i.test(message)) return 'cutApply';
  if (/broll_library lookup/i.test(message)) return 'libraryLookup';
  if (/broll picker failed/i.test(message)) return 'brollPick';
  if (/Broll download/i.test(message) || /no file_url/i.test(message)) return 'brollDownload';
  if (/ffmpeg compose/i.test(message)) return 'compose';
  if (/subtitles burn/i.test(message)) return 'subtitleBurn';
  if (/Supabase upload/i.test(message)) return 'upload';
  if (/Supabase sign/i.test(message)) return 'sign';
  return null;
}

/**
 * Status code policy:
 *   - 400 for caller-shape errors (already returned above before throwing)
 *   - 502 when an upstream service responds with an error (Gemini, Supabase,
 *     Scribe, etc — anything starting with "Supabase X yyy: ..." or similar)
 *   - 500 for everything else (internal pipeline bug)
 */
function pickStatusFromError(err) {
  const msg = err?.message ?? '';
  if (/Supabase \w+ \d{3}/.test(msg)) return 502;
  if (/Scribe \d{3}/.test(msg)) return 502;
  if (/broll picker failed/.test(msg)) return 502;
  if (/Broll download \d{3}/.test(msg)) return 502;
  return 500;
}
