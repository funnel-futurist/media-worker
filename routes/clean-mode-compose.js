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
  buildReelFailedPayload,
  buildEditNotesSummary,
} from '../lib/portal_webhook.js';
import { signStorageUrl } from '../lib/storage_helpers.js';

/**
 * PR-181b: fire a failure callback to the portal so the row gets flipped
 * to edit_failed IMMEDIATELY with a specific error message — instead of
 * waiting 15 min for the stuck-row cron to mark it 'worker_timeout'.
 *
 * Best-effort: if the callback POST itself fails, we log and fall back to
 * the existing cron recovery path (no worse than before).
 *
 * @param {object} args
 * @param {object} args.body         original /clean-mode-compose body
 * @param {string} args.jobId
 * @param {object} args.callback     { url, apiKey }
 * @param {string} args.failedStep
 * @param {string} args.errorMessage
 * @param {Array<string>} [args.warnings]
 * @param {object} [args.stepTimings]
 */
async function postFailureCallback({ body, jobId, callback, failedStep, errorMessage, warnings, stepTimings }) {
  if (!callback?.url || !callback?.apiKey || !body?.contentItemId) {
    // No-op when async mode isn't configured (sync route already returned
    // the partial-data response to the caller directly).
    return;
  }
  try {
    const payload = buildReelFailedPayload({
      contentItemId: body.contentItemId,
      clientId: body.clientId,
      jobId,
      failedStep,
      errorMessage,
      warnings,
      stepTimings,
    });
    const post = await postReelEditedCallback({
      callbackUrl: callback.url,
      callbackApiKey: callback.apiKey,
      payload,
    });
    if (!post.ok) {
      console.error(
        `[clean-mode-compose] job=${jobId} FAILURE callback delivery FAILED ` +
        `(attempts=${post.attempts} status=${post.status ?? '-'} err=${post.error ?? '-'}). ` +
        `Portal cron will recover via the stuck-editing sweep after 15 min.`,
      );
    } else {
      console.log(
        `[clean-mode-compose] job=${jobId} FAILURE callback delivered ` +
        `(status=${post.status} step=${failedStep})`,
      );
    }
  } catch (err) {
    console.error(
      `[clean-mode-compose] job=${jobId} FAILURE callback threw unexpectedly:`,
      err?.stack ?? err,
    );
  }
}

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
 *       pixabayEnabled?: boolean, bgmEnabled?: boolean,
 *       // Per-job output frame size. Defaults to 1080×1920 (9:16 reel).
 *       // Supported: (1080, 1920) reels, (1080, 1350) ads. Both must be
 *       // specified together (or both omitted to use default). All
 *       // compose stages (face crop, b-roll fill, subtitle PlayRes,
 *       // caption MarginV) render at this target — no post-render crop.
 *       outputWidth?: number, outputHeight?: number,
 *       ...
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
      // PR #129: per-job source-balance ratio overrides. Both must be in
      // (0, 1] and blend ≤ max (otherwise the math is contradictory —
      // the picker's target would exceed the trim ceiling).
      const blendRaw = body.options.brollStockBlendRatio;
      const maxRaw = body.options.brollMaxStockRatio;
      if (blendRaw != null && (typeof blendRaw !== 'number' || blendRaw <= 0 || blendRaw > 1)) {
        return res.status(400).json({ jobId, step: 'validate', error: 'options.brollStockBlendRatio must be in (0, 1]' });
      }
      if (maxRaw != null && (typeof maxRaw !== 'number' || maxRaw <= 0 || maxRaw > 1)) {
        return res.status(400).json({ jobId, step: 'validate', error: 'options.brollMaxStockRatio must be in (0, 1]' });
      }
      if (blendRaw != null && maxRaw != null && blendRaw > maxRaw) {
        return res.status(400).json({
          jobId, step: 'validate',
          error: `options.brollStockBlendRatio (${blendRaw}) must be <= options.brollMaxStockRatio (${maxRaw})`,
        });
      }
      // PR #130: clientPreference enum validation.
      const prefRaw = body.options.brollClientPreference;
      if (prefRaw != null && prefRaw !== 'balanced' && prefRaw !== 'minimal') {
        return res.status(400).json({
          jobId, step: 'validate',
          error: `options.brollClientPreference must be 'balanced' or 'minimal' (got ${JSON.stringify(prefRaw)})`,
        });
      }
      // PR-131 Option B: hard client-count cap. Non-negative integer.
      // 0 = no client picks at all (full-stock); 1+ = cap to N client picks.
      // Floats and negatives rejected — the cap is a count, not a ratio.
      const maxClientRaw = body.options.brollMaxClientCount;
      if (
        maxClientRaw != null &&
        (typeof maxClientRaw !== 'number' || !Number.isInteger(maxClientRaw) || maxClientRaw < 0)
      ) {
        return res.status(400).json({
          jobId, step: 'validate',
          error: 'options.brollMaxClientCount must be a non-negative integer',
        });
      }
      // Editor-brain quality floor: composite_score threshold below which
      // picks are dropped to talking-head. 0-10, default 6.0 in the picker.
      const floorRaw = body.options.brollQualityFloor;
      if (
        floorRaw != null &&
        (typeof floorRaw !== 'number' || floorRaw < 0 || floorRaw > 10)
      ) {
        return res.status(400).json({
          jobId, step: 'validate',
          error: 'options.brollQualityFloor must be a number in [0, 10]',
        });
      }
      // Tier 1 (2026-05-27): per-client steering + inventory exclusion.
      // contentContext is the picker's domain guardrail (string, capped to
      // keep the prompt bounded). brollExcludeAssetIds removes weak/over-used
      // assets from the candidate pool (durable target = client-library ids;
      // stock px-video-* ids are ephemeral so exclusion is within-run only).
      const ctxRaw = body.options.contentContext;
      if (ctxRaw != null && (typeof ctxRaw !== 'string' || ctxRaw.length > 2000)) {
        return res.status(400).json({
          jobId, step: 'validate',
          error: 'options.contentContext must be a string ≤ 2000 characters',
        });
      }
      const excludeRaw = body.options.brollExcludeAssetIds;
      if (
        excludeRaw != null &&
        (!Array.isArray(excludeRaw) || excludeRaw.some((id) => typeof id !== 'string' || id.length === 0))
      ) {
        return res.status(400).json({
          jobId, step: 'validate',
          error: 'options.brollExcludeAssetIds must be an array of non-empty strings',
        });
      }
      // 2026-06-01: aiEditMode preset. Bundles cleanup + captions + AI hook
      // title + (optionally) b-roll into one client-facing edit-style choice.
      // The preset is a DEFAULT-SETTER — explicit `skipBroll` /
      // `introHookEnabled` in the same body still win (see lib/ai_edit_mode.js).
      const aiEditModeRaw = body.options.aiEditMode;
      if (
        aiEditModeRaw != null &&
        aiEditModeRaw !== 'subtitles_hook_only' &&
        aiEditModeRaw !== 'hook_subtitles_broll'
      ) {
        return res.status(400).json({
          jobId, step: 'validate',
          error: `options.aiEditMode must be 'subtitles_hook_only' or 'hook_subtitles_broll' (got ${JSON.stringify(aiEditModeRaw)})`,
        });
      }
      // Tier 2-a: Pexels stock provider (second source alongside Pixabay).
      // Backward-compatible: defaults apply if either field is omitted, and
      // the worker silently skips Pexels when PEXELS_API_KEY isn't set on
      // Railway. pexelsEnabled is boolean; pexelsMaxClips is an int in (0, 50].
      const pexelsEnabledRaw = body.options.pexelsEnabled;
      if (pexelsEnabledRaw != null && typeof pexelsEnabledRaw !== 'boolean') {
        return res.status(400).json({
          jobId, step: 'validate',
          error: 'options.pexelsEnabled must be a boolean',
        });
      }
      const pexelsMaxClipsRaw = body.options.pexelsMaxClips;
      if (pexelsMaxClipsRaw != null) {
        if (
          typeof pexelsMaxClipsRaw !== 'number' ||
          !Number.isInteger(pexelsMaxClipsRaw) ||
          pexelsMaxClipsRaw <= 0 ||
          pexelsMaxClipsRaw > 50
        ) {
          return res.status(400).json({
            jobId, step: 'validate',
            error: 'options.pexelsMaxClips must be an integer in (0, 50]',
          });
        }
      }
      // Per-job output resolution (default 1080×1920 reel). Whitelist:
      //   (1080, 1920) — 9:16 reel (current default)
      //   (1080, 1350) — 4:5 ad (new)
      // Restricted to known-supported pairs for now; widen later when more
      // aspects are validated end-to-end. Both must be present together to
      // avoid half-specified inputs that would silently yield the default.
      const wRaw = body.options.outputWidth;
      const hRaw = body.options.outputHeight;
      const wPresent = wRaw != null;
      const hPresent = hRaw != null;
      if (wPresent !== hPresent) {
        return res.status(400).json({
          jobId, step: 'validate',
          error: 'options.outputWidth and options.outputHeight must be specified together (or both omitted to use the 1080×1920 default)',
        });
      }
      if (wPresent && hPresent) {
        if (!Number.isInteger(wRaw) || !Number.isInteger(hRaw)) {
          return res.status(400).json({
            jobId, step: 'validate',
            error: 'options.outputWidth and options.outputHeight must be integers',
          });
        }
        const SUPPORTED = [[1080, 1920], [1080, 1350]];
        const matched = SUPPORTED.some(([w, h]) => w === wRaw && h === hRaw);
        if (!matched) {
          return res.status(400).json({
            jobId, step: 'validate',
            error: `options.outputWidth × options.outputHeight = ${wRaw}×${hRaw} is not a supported output size. Allowed: ${SUPPORTED.map(([w, h]) => `${w}×${h}`).join(', ')}`,
          });
        }
      }
      // PR-K: per-job b-roll insertion duration controls. Defaults 6/7/8s
      // (min/target/max) live at the use sites; the route only validates
      // shape + the min <= target <= max consistency contract so a bad
      // body doesn't silently produce contradictory bounds downstream.
      const checkDurField = (name) => {
        const v = body.options[name];
        if (v == null) return null;
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 30) {
          return `options.${name} must be a number in (0, 30]`;
        }
        return null;
      };
      const minDurErr = checkDurField('brollMinDurationSec');
      if (minDurErr) return res.status(400).json({ jobId, step: 'validate', error: minDurErr });
      const targetDurErr = checkDurField('brollTargetDurationSec');
      if (targetDurErr) return res.status(400).json({ jobId, step: 'validate', error: targetDurErr });
      const maxDurErr = checkDurField('brollMaxDurationSec');
      if (maxDurErr) return res.status(400).json({ jobId, step: 'validate', error: maxDurErr });
      // PR-AN: brollMinStartSec accepts [0, 30] (0 allowed so an operator
      // can explicitly disable the floor for a one-off; default 5.0s
      // applies when undefined). Reuses the shape rules from checkDurField
      // but allows zero, hence a small inline check rather than reusing.
      const minStartRaw = body.options.brollMinStartSec;
      if (minStartRaw != null) {
        if (typeof minStartRaw !== 'number' || !Number.isFinite(minStartRaw) || minStartRaw < 0 || minStartRaw > 30) {
          return res.status(400).json({
            jobId, step: 'validate',
            error: 'options.brollMinStartSec must be a number in [0, 30]',
          });
        }
      }
      // PR-AO: slateHint optional string ≤ 200 chars. Empty/whitespace
      // treated as not provided; detector trims and falls back to default
      // meta-marker behavior. Length cap so an accidental paste of a whole
      // transcript doesn't reach the detector and inflate the token match.
      const slateHintRaw = body.options.slateHint;
      if (slateHintRaw != null) {
        if (typeof slateHintRaw !== 'string') {
          return res.status(400).json({
            jobId, step: 'validate',
            error: 'options.slateHint must be a string',
          });
        }
        if (slateHintRaw.length > 200) {
          return res.status(400).json({
            jobId, step: 'validate',
            error: 'options.slateHint must be ≤ 200 characters',
          });
        }
      }
      // Consistency: each provided pair must hold min <= target <= max.
      // We check across whatever subset the caller supplied — undefined
      // values fall through to defaults at the use sites and don't
      // participate in the comparison.
      const minD = body.options.brollMinDurationSec;
      const targetD = body.options.brollTargetDurationSec;
      const maxD = body.options.brollMaxDurationSec;
      if (minD != null && targetD != null && minD > targetD) {
        return res.status(400).json({
          jobId, step: 'validate',
          error: `options.brollMinDurationSec (${minD}) must be <= options.brollTargetDurationSec (${targetD})`,
        });
      }
      if (targetD != null && maxD != null && targetD > maxD) {
        return res.status(400).json({
          jobId, step: 'validate',
          error: `options.brollTargetDurationSec (${targetD}) must be <= options.brollMaxDurationSec (${maxD})`,
        });
      }
      if (minD != null && maxD != null && minD > maxD) {
        return res.status(400).json({
          jobId, step: 'validate',
          error: `options.brollMinDurationSec (${minD}) must be <= options.brollMaxDurationSec (${maxD})`,
        });
      }
      // PR-L: intro hook validation. introHookEnabled is a boolean opt-in;
      // introDurationSec is a number in (0, 15]. Both default to off / 5.0
      // at the use site (buildPipelineOpts).
      const introEnabledRaw = body.options.introHookEnabled;
      if (introEnabledRaw != null && typeof introEnabledRaw !== 'boolean') {
        return res.status(400).json({
          jobId, step: 'validate',
          error: 'options.introHookEnabled must be a boolean',
        });
      }
      const introDurRaw = body.options.introDurationSec;
      if (introDurRaw != null) {
        if (typeof introDurRaw !== 'number' || !Number.isFinite(introDurRaw) || introDurRaw <= 0 || introDurRaw > 15) {
          return res.status(400).json({
            jobId, step: 'validate',
            error: 'options.introDurationSec must be a number in (0, 15]',
          });
        }
      }
      // Banner overlay for 1080x1350 ad format. bannerEnabled is boolean
      // opt-in; bannerConfig must have at least a text field when enabled.
      const bannerEnabledRaw = body.options.bannerEnabled;
      if (bannerEnabledRaw != null && typeof bannerEnabledRaw !== 'boolean') {
        return res.status(400).json({ jobId, step: 'validate', error: 'options.bannerEnabled must be a boolean' });
      }
      if (bannerEnabledRaw === true) {
        const bc = body.options.bannerConfig;
        if (!bc || typeof bc !== 'object' || typeof bc.text !== 'string' || bc.text.length === 0) {
          return res.status(400).json({ jobId, step: 'validate', error: 'options.bannerConfig.text is required when bannerEnabled is true' });
        }
        if (bc.height != null && (typeof bc.height !== 'number' || bc.height < 50 || bc.height > 500)) {
          return res.status(400).json({ jobId, step: 'validate', error: 'options.bannerConfig.height must be a number in [50, 500]' });
        }
      }
      // Silence detection tuning. noiseDb must be in [-60, -10] (dB);
      // minDur must be in (0, 5] (seconds). Ranges are generous — the
      // defaults (-35 / 0.6) sit comfortably in the middle.
      const noiseDbRaw = body.options.silenceNoiseDb;
      if (noiseDbRaw != null && (typeof noiseDbRaw !== 'number' || !Number.isFinite(noiseDbRaw) || noiseDbRaw < -60 || noiseDbRaw > -10)) {
        return res.status(400).json({ jobId, step: 'validate', error: 'options.silenceNoiseDb must be a number in [-60, -10]' });
      }
      const silenceMinDurRaw = body.options.silenceMinDur;
      if (silenceMinDurRaw != null && (typeof silenceMinDurRaw !== 'number' || !Number.isFinite(silenceMinDurRaw) || silenceMinDurRaw <= 0 || silenceMinDurRaw > 5)) {
        return res.status(400).json({ jobId, step: 'validate', error: 'options.silenceMinDur must be a number in (0, 5]' });
      }
      // PR-AF: Deepgram keyword boosts. Optional array of non-empty
      // strings (max 20 — Deepgram's documented limit is higher but we
      // want to fail fast on misconfigured per-client defaults). Each
      // entry is either a bare term ("special needs") or pre-formatted
      // "<term>:<intensifier>" where intensifier is 1-10.
      const dgKw = body.options.deepgramKeywords;
      if (dgKw != null) {
        if (!Array.isArray(dgKw)) {
          return res.status(400).json({ jobId, step: 'validate', error: 'options.deepgramKeywords must be an array of strings' });
        }
        if (dgKw.length > 20) {
          return res.status(400).json({ jobId, step: 'validate', error: 'options.deepgramKeywords may not exceed 20 entries' });
        }
        for (let i = 0; i < dgKw.length; i++) {
          const term = dgKw[i];
          if (typeof term !== 'string' || term.trim().length === 0) {
            return res.status(400).json({ jobId, step: 'validate', error: `options.deepgramKeywords[${i}] must be a non-empty string` });
          }
          if (term.length > 200) {
            return res.status(400).json({ jobId, step: 'validate', error: `options.deepgramKeywords[${i}] is too long (max 200 chars)` });
          }
        }
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
    // PR-181b: orchestrator hard error (uncaught throw outside PR #103's
    // own catch). Fire a failure callback so the portal flips the row
    // immediately with the actual error — no more 15-min cron wait.
    console.error(
      `[clean-mode-compose] job=${jobId} ASYNC hard error:`,
      err?.stack ?? err,
    );
    await postFailureCallback({
      body, jobId, callback,
      failedStep: 'orchestrator',
      errorMessage: err?.message ?? String(err),
    });
    return;
  }

  if (result?.error) {
    // PR-181b: PR #103 partial-data path — orchestrator caught an internal
    // throw and returned the partial result. Fire a failure callback with
    // the specific step that failed + any warnings/steps collected so far.
    console.error(
      `[clean-mode-compose] job=${jobId} ASYNC step=${result.error.step ?? '?'} ` +
      `error: ${result.error.message ?? '(no message)'}`,
    );
    await postFailureCallback({
      body, jobId, callback,
      failedStep: result.error.step ?? 'unknown',
      errorMessage: result.error.message ?? '(no message)',
      warnings: result.warnings,
      stepTimings: result.steps,
    });
    return;
  }

  if (!result?.finalStorage?.bucket || !result?.finalStorage?.path) {
    // PR-181b: pipeline didn't throw but produced no final storage path.
    // Treat as failure and notify the portal.
    console.error(
      `[clean-mode-compose] job=${jobId} ASYNC pipeline returned no finalStorage`,
    );
    await postFailureCallback({
      body, jobId, callback,
      failedStep: 'finalStorage',
      errorMessage: 'pipeline returned no finalStorage path',
      warnings: result?.warnings,
      stepTimings: result?.steps,
    });
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
    // PR-181b: file uploaded but signing failed (Supabase auth/quota glitch).
    // Notify the portal so the operator can re-sign / re-mint manually.
    console.error(
      `[clean-mode-compose] job=${jobId} ASYNC failed to mint 1-year signed URL ` +
      `for ${result.finalStorage.bucket}/${result.finalStorage.path}:`,
      err?.message ?? err,
    );
    await postFailureCallback({
      body, jobId, callback,
      failedStep: 'signStorageUrl',
      errorMessage: `Storage path ${result.finalStorage.bucket}/${result.finalStorage.path}: ${err?.message ?? String(err)}`,
      warnings: result?.warnings,
      stepTimings: result?.steps,
    });
    return;
  }

  const editNotes = buildEditNotesSummary(result);
  // PR-AF: forward repatch asset URLs to the portal callback when the
  // pipeline preserved them (subtitle burn ran + upload succeeded).
  // Ad-routing: also forward insertions count + banner/intro flags so the
  // portal can classify edit_intensity (light_edit | heavy_edit).
  const payload = buildReelEditedPayload({
    contentItemId: body.contentItemId,
    clientId: body.clientId,
    editedUrl,
    editNotes,
    preCaptionVideoUrl: result.repatchAssets?.preCaptionVideoUrl,
    subtitleAssUrl: result.repatchAssets?.subtitleAssUrl,
    insertionsCount: result.insertions?.count ?? 0,
    bannerApplied: result.steps?.bannerOverlay?.ok === true,
    introHookApplied: result.introHook?.applied === true,
    // 2026-06-01: surface the resolved aiEditMode so the portal can store it
    // on content_items.ai_edit_mode and default future edits to the same choice.
    aiEditMode: result.aiEditMode,
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
