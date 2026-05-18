/**
 * lib/portal_webhook.js
 *
 * Outbound callback helper for the PR-I → portal pipeline.
 *
 * Plan v2 (post-Phoenix-feedback, 2026-05-09): the worker POSTs to the
 * EXISTING portal endpoint `POST /api/editor/callback/reel` when a
 * /clean-mode-compose job finishes successfully. Auth is `x-api-key`
 * (not HMAC); the portal passes the apiKey + callback URL to the worker
 * in the original /clean-mode-compose request body's `callback` field.
 *
 * Contract (matches ff-client-portal/app/api/editor/callback/reel/route.ts):
 *   - method:  POST
 *   - headers: { 'x-api-key': '<EDITOR_API_KEY>', 'content-type': 'application/json' }
 *   - body:    { contentItemId, clientId, editedUrl, editNotes }
 *   - timeout: 10s
 *   - retry:   one retry on network error / 5xx after a 2s backoff
 *
 * Failure path: the existing endpoint accepts successes only. If the
 * worker's pipeline fails internally, we DO NOT post a callback (no
 * symmetric failure endpoint exists yet). The portal's hourly stuck-row
 * cron sweeps rows where pipeline_status='editing' AND editing_started_at
 * is older than 15 min and marks them 'edit_failed'.
 *
 * `editedUrl` MUST be directly downloadable (returns raw MP4 bytes, not an
 * HTML preview page) per Phoenix's constraint. The caller is responsible
 * for minting a long-lived signed URL via lib/storage_helpers.signStorageUrl
 * (use expiresIn = 60*60*24*365 = 1 year to match the portal's
 * raw_footage_url convention).
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = 2000;
const EDIT_NOTES_MAX_CHARS = 480;

/**
 * Build the editNotes summary string for the portal's Deliverables card.
 * Pulls the operator-useful subset of the pipeline result and condenses it
 * to ~150 chars. Plan v2: the existing endpoint stores this string as
 * cs.content_items.edit_notes; we use it as a quick reviewer hint.
 *
 * Example output:
 *   AI-blend: 4 client + 2 stock pick(s). BGM: "Lovely" by Tryad (CC BY-SA 2.5). 78.7s.
 *
 * @param {object} pipelineResult  full runCleanModePipeline return value
 * @returns {string}               trimmed to EDIT_NOTES_MAX_CHARS
 */
export function buildEditNotesSummary(pipelineResult) {
  const r = pipelineResult ?? {};
  const parts = [];

  const clientCount = r.insertions?.clientCount ?? 0;
  const stockCount = r.insertions?.stockCount ?? 0;
  if (clientCount > 0 || stockCount > 0) {
    parts.push(`AI-blend: ${clientCount} client + ${stockCount} stock pick(s).`);
  }

  const bgm = r.audio?.bgm;
  if (bgm?.applied && bgm.track) {
    const name = bgm.track.name ?? 'Untitled';
    const artist = bgm.track.artistName ?? 'Unknown';
    const license = bgm.track.licenseCcUrl ?? '';
    let licenseLabel = '';
    if (typeof license === 'string') {
      const m = license.match(/licenses\/([\w-]+)\/(\d+\.\d+)/);
      if (m) licenseLabel = ` (CC ${m[1].toUpperCase()} ${m[2]})`;
    }
    parts.push(`BGM: "${name}" by ${artist}${licenseLabel}.`);
  } else if (bgm && bgm.applied === false && bgm.skipReason) {
    parts.push(`BGM: skipped (${bgm.skipReason}).`);
  }

  if (typeof r.durationSec === 'number') {
    parts.push(`${r.durationSec.toFixed(1)}s.`);
  }

  // PR-D source-balance audit hook — surface mix-not-met as a hint for
  // review (e.g. "mix unmet: ai_chose_all_client_despite_stock_available").
  if (r.insertions?.sourceBalance?.mixMet === false) {
    const reason = r.insertions.sourceBalance.mixReason ?? 'unknown';
    parts.push(`Mix unmet: ${reason}.`);
  }

  const joined = parts.join(' ').trim();
  if (joined.length === 0) return '';
  return joined.slice(0, EDIT_NOTES_MAX_CHARS);
}

/**
 * Build the request body for POST /api/editor/callback/reel. Pure shape
 * function so tests can lock the contract without HTTP.
 */
export function buildReelEditedPayload({
  contentItemId,
  clientId,
  editedUrl,
  editNotes,
  preCaptionVideoUrl,
  subtitleAssUrl,
}) {
  const payload = { contentItemId, clientId, editedUrl };
  if (editNotes) payload.editNotes = editNotes;
  // PR-AF: only include the repatch URLs when both are present. Portal
  // callback treats them as optional; pre-PR-AF callers and skip-subtitle
  // paths emit a clean shape without them.
  if (preCaptionVideoUrl && subtitleAssUrl) {
    payload.preCaptionVideoUrl = preCaptionVideoUrl;
    payload.subtitleAssUrl = subtitleAssUrl;
  }
  return payload;
}

/**
 * POST the success payload to the portal's existing reel-edited endpoint.
 * One retry on network error / 5xx (2s backoff). 4xx is non-retryable
 * (auth, bad payload).
 *
 * @param {Object} args
 * @param {string} args.callbackUrl       e.g. https://success.funnelfuturist.com/api/editor/callback/reel
 * @param {string} args.callbackApiKey    matches EDITOR_API_KEY on the portal
 * @param {object} args.payload           result of buildReelEditedPayload(...)
 * @param {typeof fetch} [args.fetchImpl]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ ok: boolean, status?: number, attempts: number, error?: string }>}
 */
export async function postReelEditedCallback(args) {
  const {
    callbackUrl,
    callbackApiKey,
    payload,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = args;

  if (!callbackUrl || !callbackApiKey) {
    return { ok: false, attempts: 0, error: 'missing callbackUrl or callbackApiKey' };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, attempts: 0, error: 'payload must be an object' };
  }
  if (!payload.contentItemId || !payload.clientId || !payload.editedUrl) {
    return {
      ok: false,
      attempts: 0,
      error: 'payload missing required fields (contentItemId, clientId, editedUrl)',
    };
  }

  const rawBody = JSON.stringify(payload);

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
          'x-api-key': callbackApiKey,
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
