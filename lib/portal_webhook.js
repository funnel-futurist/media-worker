/**
 * lib/portal_webhook.js
 *
 * Outbound webhook helper for the PR-I portal callback.
 *
 * When a `/clean-mode-compose` request includes a `callback: { url, secret }`
 * field, the route accepts the job (202) and runs the pipeline in the
 * background. When the pipeline finishes (success OR failure), the worker
 * POSTs a result envelope to `callback.url` with an HMAC-SHA256 signature
 * over the raw request body in the `x-worker-signature` header. The portal
 * verifies this against its own MEDIA_WORKER_CALLBACK_SECRET (see
 * ff-client-portal/app/api/webhooks/edit-complete/route.ts).
 *
 * Contract:
 *   - method:  POST
 *   - headers: { 'x-worker-signature': '<hex>', 'content-type': 'application/json' }
 *   - body:    serialized JSON of either SuccessEnvelope or FailureEnvelope
 *   - timeout: 10s
 *   - retry:   one retry on network error / 5xx after a 2s backoff
 *
 * Failure modes are LOUDLY logged but never thrown back to the orchestrator —
 * the pipeline run is over by the time we get here; the worker still returns
 * its eventual `clean-mode-compose` response (or has already returned 202).
 */

import { createHmac } from 'crypto';

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = 2000;

/**
 * Build the HMAC-SHA256 signature header value for the given body + secret.
 * Hex-encoded so the portal's `Buffer.from(sig, 'hex')` parser sees clean bytes.
 *
 * @param {string} rawBody  the exact JSON string we POST
 * @param {string} secret   shared callback secret (MEDIA_WORKER_CALLBACK_SECRET)
 * @returns {string}        hex digest
 */
export function signCallback(rawBody, secret) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * POST the callback envelope to the portal. One retry on network error / 5xx.
 *
 * @param {Object} args
 * @param {string} args.callbackUrl
 * @param {string} args.callbackSecret
 * @param {object} args.payload          the SuccessEnvelope or FailureEnvelope
 * @param {typeof fetch} [args.fetchImpl]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ ok: boolean, status?: number, attempts: number, error?: string }>}
 */
export async function postEditCompleteToPortal(args) {
  const {
    callbackUrl,
    callbackSecret,
    payload,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = args;

  if (!callbackUrl || !callbackSecret) {
    return { ok: false, attempts: 0, error: 'missing callbackUrl or callbackSecret' };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, attempts: 0, error: 'payload must be an object' };
  }

  const rawBody = JSON.stringify(payload);
  const signature = signCallback(rawBody, callbackSecret);

  let lastStatus = 0;
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(callbackUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-worker-signature': signature,
        },
        body: rawBody,
        signal: controller.signal,
      });
      clearTimeout(timer);
      lastStatus = res.status;
      if (res.ok) {
        return { ok: true, status: res.status, attempts: attempt };
      }
      lastError = `portal_${res.status}`;
      if (res.status >= 400 && res.status < 500) {
        // 4xx is non-retryable (auth, bad payload). Bail.
        return { ok: false, status: res.status, attempts: attempt, error: lastError };
      }
      // 5xx → fall through to retry backoff
    } catch (err) {
      clearTimeout(timer);
      lastError = err?.message ?? String(err);
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
    }
  }

  return { ok: false, status: lastStatus || undefined, attempts: 2, error: lastError };
}

/**
 * Shape the success envelope the portal expects (see ff-client-portal
 * app/api/webhooks/edit-complete/route.ts).
 *
 * Trims `edit_diagnostics` to the operator-useful subset rather than dumping
 * every raw step output, to keep the jsonb column small and the response
 * readable. PR-I exposes: insertions.sourceBalance + insertions.clientLibrary*
 * fields, steps.heicConvert, audio.bgm subset, attribution, warnings, top-level
 * processingMs.
 */
export function buildSuccessEnvelope(jobId, pipelineResult) {
  const r = pipelineResult ?? {};
  return {
    jobId,
    status: 'success',
    result: {
      finalStorage: r.finalStorage ?? null,
      durationSec: typeof r.durationSec === 'number' ? r.durationSec : null,
      processingMs: typeof r.processingMs === 'number' ? r.processingMs : null,
      diagnostics: {
        insertions: r.insertions ? {
          count: r.insertions.count ?? null,
          clientCount: r.insertions.clientCount ?? null,
          stockCount: r.insertions.stockCount ?? null,
          clientLibraryRawCount: r.insertions.clientLibraryRawCount ?? null,
          clientLibraryUsableCount: r.insertions.clientLibraryUsableCount ?? null,
          clientLibrarySkipped: r.insertions.clientLibrarySkipped ?? null,
          pixabayCandidateCount: r.insertions.pixabayCandidateCount ?? null,
          sourceBalance: r.insertions.sourceBalance ?? null,
          stockKeywords: r.insertions.stockKeywords ?? null,
        } : null,
        steps: r.steps ? {
          heicConvert: r.steps.heicConvert ?? null,
          bgmSelect: r.steps.bgmSelect ?? null,
          bgmFetch: r.steps.bgmFetch ?? null,
          bgmMix: r.steps.bgmMix ?? null,
        } : null,
        audio: r.audio?.bgm ? {
          bgm: {
            applied: r.audio.bgm.applied ?? false,
            skipReason: r.audio.bgm.skipReason ?? null,
            track: r.audio.bgm.track ?? null,
          },
        } : null,
        attribution: r.attribution ?? null,
        warnings: Array.isArray(r.warnings) ? r.warnings : [],
        streamSyncOk: r.streamSync?.final?.withinTolerance ?? null,
      },
    },
  };
}

/**
 * Shape the failure envelope. `retryable` follows the same convention as the
 * route's status-picker: upstream failures (Gemini/Supabase/Scribe/Pixabay 5xx)
 * are retryable; internal pipeline bugs (A/V sync gate, ffmpeg crash) are not.
 */
export function buildFailureEnvelope(jobId, error) {
  const msg = error?.message ?? String(error ?? 'unknown error');
  const step = error?.step ?? null;
  const retryable =
    /Supabase \w+ 5\d\d/.test(msg) ||
    /Scribe 5\d\d/.test(msg) ||
    /Gemini.*5\d\d/i.test(msg) ||
    /Pixabay.*5\d\d/i.test(msg) ||
    /ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(msg);
  return {
    jobId,
    status: 'failed',
    error: {
      step,
      message: msg,
      retryable,
    },
  };
}
