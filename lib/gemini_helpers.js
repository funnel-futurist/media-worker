/**
 * lib/gemini_helpers.js
 *
 * Shared fetch wrapper for Gemini API calls. Ported from
 * creative-engine/lib/hyperframes/gemini_retry.ts (PR #112) so the M2
 * clean-mode pipeline can reuse the same retry policy without depending
 * on the creative-engine package.
 *
 * Retries transient errors:
 *   - 429 RESOURCE_EXHAUSTED (rate limit): backoff 3s → 10s, then give up
 *   - 5xx server errors:                   backoff 2s → 5s, then give up
 *
 * Permanent 4xx errors (400 INVALID_ARGUMENT, 401 unauth, 403 forbidden) are
 * NOT retried — they indicate the request itself is bad. Retrying just burns
 * quota and delays the failure.
 *
 * Why this exists in M2: PR #112 adds slate_detect + bad_take_detect Gemini
 * calls back-to-back after transcribe. On busy projects two Gemini calls in
 * quick succession occasionally trips the per-minute rate limit; small retry
 * loop with backoff turns the transient failure into a successful run
 * instead of a partial-data response.
 *
 * Uses native `fetch` (Node 22 has it built-in) rather than axios — keeps the
 * helper standalone and matches the upstream creative-engine implementation
 * shape so future ports stay structurally identical.
 */

const RATE_LIMIT_BACKOFFS_MS = [3000, 10000];
const SERVER_ERROR_BACKOFFS_MS = [2000, 5000];

/**
 * Fetch with automatic retry on 429 and 5xx. Returns the Response on the first
 * non-retryable status. Throws if all retries are exhausted.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {string} [label='gemini']  prefix for log lines
 * @param {number} [maxAttempts=3]   total attempts including the first
 * @returns {Promise<Response>}
 */
export async function fetchGeminiWithRetry(url, init, label = 'gemini', maxAttempts = 3) {
  let lastBody = '';
  let lastStatus = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, init);

    // Success or non-retryable client error — return as-is
    if (res.status !== 429 && res.status < 500) return res;

    lastStatus = res.status;
    lastBody = await res.clone().text();

    // Out of retries
    if (attempt === maxAttempts - 1) break;

    const delays = res.status === 429 ? RATE_LIMIT_BACKOFFS_MS : SERVER_ERROR_BACKOFFS_MS;
    const delay = delays[attempt] ?? delays[delays.length - 1];
    console.log(
      `[${label}] ${res.status} ${res.status === 429 ? 'rate-limited' : 'server-error'} — ` +
      `retrying in ${delay}ms (attempt ${attempt + 2}/${maxAttempts})`,
    );
    await new Promise((r) => setTimeout(r, delay));
  }

  throw new Error(`${label}: API error ${lastStatus} after retries — ${lastBody.slice(0, 500)}`);
}
