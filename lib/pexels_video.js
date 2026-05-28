/**
 * lib/pexels_video.js
 *
 * Pexels video search + download. Tier 2-a (2026-05-27): second stock
 * b-roll provider alongside Pixabay (`lib/pixabay_video.js`). Used by the
 * M2 clean-mode pipeline as a SUPPLEMENTAL source when the client b-roll
 * library is thin or — per current EnableSNP guidance — disabled entirely
 * via `skipClientBroll`.
 *
 * Two exports, mirroring the Pixabay shape so the orchestrator can swap
 * providers in a polymorphic loop:
 *
 *   1. searchPexelsVideos({query, perPage, minDur, maxDur, apiKey, fetchImpl})
 *      - GET https://api.pexels.com/videos/search?query=<q>&per_page=<n>
 *        Authorization: <PEXELS_API_KEY>   (no "Bearer " prefix; Pexels'
 *        documented format).
 *      - Returns the canonical envelope:
 *          { ok: true, hits: [{ id, pageURL, tags, duration, videoUrl,
 *                                width, height, sizeBytes, tier,
 *                                attributionUser, attributionUrl }],
 *            rateLimitRemaining, rateLimitLimit }
 *          { ok: false, kind: 'upstream'|'empty'|'parse', status?, body? }
 *      - Variant pick: Pexels returns multiple `video_files[]` resolutions
 *        per hit. Prefer 9:16-friendly variants (taller than wide) when
 *        present; otherwise the smallest variant whose shorter axis is
 *        ≥ 720 (good for compose's face-crop without bandwidth bloat).
 *      - Duration filter same shape as Pixabay (default 3-60s).
 *      - Hits with no usable variant are dropped.
 *
 *   2. downloadPexelsVideo({hit, outDir, axiosImpl})
 *      - Streams the video to `<outDir>/pexels-video-<id>.mp4`
 *      - Returns { localPath, bytes, url }
 *      - Throws on download failure (caller decides whether to skip).
 *
 * Hit shape is intentionally identical to Pixabay's except:
 *   - `tags` comes from Pexels' page URL slug (Pexels doesn't return tag
 *     arrays); we synthesise a tag-like string from the slug so the
 *     existing tag-relevance and isGenericSceneryHit filters continue to
 *     work without provider-specific branches.
 *   - `attributionUser` + `attributionUrl` carry the Pexels creator. Free
 *     license doesn't require attribution, but we record it in the
 *     candidate metadata + PR-AP manifest for traceability.
 *
 * Design notes:
 *   - No retry on 5xx — matches Pixabay; the orchestrator's stockSearch
 *     step warns and continues.
 *   - `fetchImpl` / `axiosImpl` injection points let tests stub the
 *     network without ever hitting Pexels.
 *   - When `PEXELS_API_KEY` is unset, the orchestrator skips this provider
 *     entirely. This module never reads env vars itself — the caller
 *     passes the apiKey through. Throws if asked to search with no key.
 *   - Rate-limit awareness: returns `rateLimitRemaining` from Pexels'
 *     `X-Ratelimit-Remaining` header. Orchestrator can warn when low.
 *     Pexels free tier: 200/h, 20k/mo.
 */

import { createWriteStream } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import axios from 'axios';

const PEXELS_VIDEO_API = 'https://api.pexels.com/videos/search';
const PEXELS_VIDEO_TIMEOUT_MS_DEFAULT = 60_000;
const DEFAULT_MIN_DUR_SEC = 3;
const DEFAULT_MAX_DUR_SEC = 60;
const DEFAULT_PER_PAGE = 5;
const RATE_LIMIT_LOW_THRESHOLD = 0.2;  // warn when <20% remaining

/**
 * Pick the best variant from a Pexels hit's `video_files[]` array. Pexels
 * returns multiple resolutions; we want enough quality to fill a 9:16 reel
 * after face-crop without burning bandwidth on 4K when 1080p suffices.
 *
 * Strategy:
 *   1. Prefer portrait or square variants (height ≥ width) when present —
 *      9:16 reels need vertical content; landscape Pexels gets letterboxed
 *      or face-cropped harder.
 *   2. Otherwise pick the smallest variant whose shorter axis is ≥ 720.
 *   3. Otherwise the largest available variant (avoid 240p garbage).
 *
 * Skips variants with no `link` field or non-mp4 `file_type`.
 * Returns `null` if no usable variant exists.
 */
function pickVideoVariant(videoFiles) {
  if (!Array.isArray(videoFiles) || videoFiles.length === 0) return null;
  const usable = videoFiles.filter((v) => {
    if (!v || typeof v.link !== 'string' || v.link.length === 0) return false;
    if (typeof v.file_type === 'string' && !/mp4/i.test(v.file_type)) return false;
    if (typeof v.width !== 'number' || typeof v.height !== 'number') return false;
    if (v.width <= 0 || v.height <= 0) return false;
    return true;
  });
  if (usable.length === 0) return null;

  const tag = (v) => ({
    link: v.link,
    width: v.width,
    height: v.height,
    fps: typeof v.fps === 'number' ? v.fps : 0,
    quality: typeof v.quality === 'string' ? v.quality : 'unknown',
    sizeBytes: 0,                                   // Pexels doesn't return content-length here
  });

  // 1. Prefer portrait/square variants (height ≥ width).
  const portrait = usable.filter((v) => v.height >= v.width);
  if (portrait.length > 0) {
    // Among portrait, pick the smallest whose shorter axis ≥ 720 (= width),
    // else the largest.
    const big = portrait.filter((v) => v.width >= 720);
    if (big.length > 0) {
      big.sort((a, b) => a.width - b.width);
      return { ...tag(big[0]), tier: 'portrait' };
    }
    portrait.sort((a, b) => b.width - a.width);
    return { ...tag(portrait[0]), tier: 'portrait-low' };
  }

  // 2. Landscape: smallest whose shorter axis (height) ≥ 720, else largest.
  const big = usable.filter((v) => v.height >= 720);
  if (big.length > 0) {
    big.sort((a, b) => a.height - b.height);
    return { ...tag(big[0]), tier: 'landscape' };
  }
  usable.sort((a, b) => b.height - a.height);
  return { ...tag(usable[0]), tier: 'landscape-low' };
}

/**
 * Pexels doesn't return a tag array — only a `url` and a `user`. We derive
 * a tag-like string from the URL slug so downstream filters
 * (`isGenericSceneryHit`, tag-overlap relevance) work uniformly across
 * providers.
 *
 * URL shape: https://www.pexels.com/video/<slug>-<id>/
 * Slug example: "a-family-meets-with-an-estate-planning-attorney"
 * We strip the trailing `-<id>`, replace dashes with spaces.
 */
function deriveTagsFromUrl(url) {
  if (typeof url !== 'string') return '';
  const m = url.match(/\/video\/([^/]+?)\/?$/i);
  if (!m) return '';
  return m[1].replace(/-\d+$/, '').replace(/-/g, ' ').trim();
}

/**
 * Search Pexels for stock videos matching `query`.
 *
 * @param {Object} args
 * @param {string} args.query           free-text search term
 * @param {number} [args.perPage=5]     Pexels max 80
 * @param {number} [args.minDur=3]      drop hits shorter than this (seconds)
 * @param {number} [args.maxDur=60]     drop hits longer than this (seconds)
 * @param {string} args.apiKey          Pexels API key (sent as Authorization)
 * @param {number} [args.timeoutMs=60000]
 * @param {typeof fetch} [args.fetchImpl]  inject for tests
 * @returns {Promise<{ok: true, hits: Array<object>, rateLimitRemaining: number|null, rateLimitLimit: number|null} | {ok: false, kind: 'upstream'|'empty'|'parse', status?: number, body?: string}>}
 */
export async function searchPexelsVideos(args) {
  const {
    query,
    perPage = DEFAULT_PER_PAGE,
    minDur = DEFAULT_MIN_DUR_SEC,
    maxDur = DEFAULT_MAX_DUR_SEC,
    apiKey,
    timeoutMs = PEXELS_VIDEO_TIMEOUT_MS_DEFAULT,
    fetchImpl = fetch,
  } = args;

  if (!apiKey) throw new Error('searchPexelsVideos: apiKey is required');
  if (!query || typeof query !== 'string') {
    return { ok: false, kind: 'parse', body: 'query must be a non-empty string' };
  }

  const params = new URLSearchParams({
    query,
    per_page: String(Math.max(1, Math.min(80, perPage))),
  });
  const url = `${PEXELS_VIDEO_API}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: apiKey },           // Pexels: raw key, no "Bearer " prefix
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, kind: 'upstream', body: err.message ?? String(err) };
  }
  clearTimeout(timer);

  const rateLimitRemaining = parseRateLimitHeader(res, 'X-Ratelimit-Remaining');
  const rateLimitLimit = parseRateLimitHeader(res, 'X-Ratelimit-Limit');
  if (rateLimitRemaining !== null && rateLimitLimit !== null && rateLimitLimit > 0) {
    const frac = rateLimitRemaining / rateLimitLimit;
    if (frac < RATE_LIMIT_LOW_THRESHOLD) {
      console.warn(
        `[pexels] rate-limit LOW: ${rateLimitRemaining}/${rateLimitLimit} remaining (<${Math.round(RATE_LIMIT_LOW_THRESHOLD * 100)}%)`,
      );
    }
  }

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_) { /* noop */ }
    return { ok: false, kind: 'upstream', status: res.status, body: body.slice(0, 500), rateLimitRemaining, rateLimitLimit };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, kind: 'parse', body: `invalid JSON from Pexels: ${err.message}` };
  }

  const rawHits = Array.isArray(data?.videos) ? data.videos : [];
  if (rawHits.length === 0) {
    return { ok: false, kind: 'empty', rateLimitRemaining, rateLimitLimit };
  }

  const cleaned = [];
  for (const hit of rawHits) {
    if (typeof hit?.id !== 'number') continue;
    const dur = typeof hit?.duration === 'number' ? hit.duration : 0;
    if (dur < minDur || dur > maxDur) continue;
    const picked = pickVideoVariant(hit.video_files);
    if (!picked) continue;
    cleaned.push({
      id: hit.id,
      pageURL: typeof hit.url === 'string' ? hit.url : null,
      tags: deriveTagsFromUrl(hit.url),
      duration: dur,
      videoUrl: picked.link,
      width: picked.width,
      height: picked.height,
      sizeBytes: picked.sizeBytes,
      tier: picked.tier,
      attributionUser: typeof hit.user?.name === 'string' ? hit.user.name : null,
      attributionUrl: typeof hit.user?.url === 'string' ? hit.user.url : null,
    });
  }

  if (cleaned.length === 0) {
    return { ok: false, kind: 'empty', rateLimitRemaining, rateLimitLimit };
  }

  return { ok: true, hits: cleaned, rateLimitRemaining, rateLimitLimit };
}

function parseRateLimitHeader(res, name) {
  try {
    const v = res?.headers?.get?.(name);
    if (typeof v !== 'string' || v.length === 0) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

/**
 * Download a Pexels video hit to disk. Mirrors `downloadPixabayVideo`.
 *
 * @param {Object} args
 * @param {{ id: number, videoUrl: string }} args.hit  must have `id` and `videoUrl`
 * @param {string} args.outDir                          existing directory; output filename is `pexels-video-<id>.mp4`
 * @param {number} [args.timeoutMs=180000]
 * @param {typeof axios} [args.axiosImpl]               inject for tests
 * @returns {Promise<{localPath: string, bytes: number, url: string}>}
 */
export async function downloadPexelsVideo(args) {
  const { hit, outDir, timeoutMs = 180_000, axiosImpl = axios } = args;

  if (!hit || typeof hit.id !== 'number') {
    throw new Error('downloadPexelsVideo: hit.id is required');
  }
  if (!hit.videoUrl) {
    throw new Error(`downloadPexelsVideo: hit.videoUrl is required (id=${hit.id})`);
  }
  if (!outDir) throw new Error('downloadPexelsVideo: outDir is required');

  const localPath = join(outDir, `pexels-video-${hit.id}.mp4`);

  const res = await axiosImpl.get(hit.videoUrl, {
    responseType: 'stream',
    timeout: timeoutMs,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `downloadPexelsVideo: ${res.status} for pexels-video-${hit.id} (${hit.videoUrl})`,
    );
  }

  const writeStream = createWriteStream(localPath);
  await pipeline(res.data, writeStream);

  const bytes = typeof res.headers?.['content-length'] === 'string'
    ? parseInt(res.headers['content-length'], 10)
    : 0;

  return { localPath, bytes, url: hit.videoUrl };
}
