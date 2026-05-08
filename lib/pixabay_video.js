/**
 * lib/pixabay_video.js
 *
 * Pixabay video search + download. Used by the M2 clean-mode pipeline as a
 * supplemental b-roll source when the client's `marketing.broll_library`
 * doesn't have enough good matches (PR-A — Pixabay stock b-roll fallback).
 *
 * Two exports:
 *   1. searchPixabayVideos({query, perPage, minDur, maxDur, apiKey, fetchImpl})
 *      - Calls https://pixabay.com/api/videos/?key=<key>&q=...&per_page=...
 *      - Returns the canonical M2 envelope:
 *          { ok: true, hits: [{ id, pageURL, tags, duration, videoUrl, width, height, sizeBytes }] }
 *          { ok: false, kind: 'upstream'|'empty'|'parse', status?, body? }
 *      - URL selection: prefer `videos.medium.url` (good quality / reasonable
 *        size), fall back to `videos.large` then `videos.small`. Hits with no
 *        usable URL are dropped.
 *      - Duration filter: drops hits outside [minDur, maxDur] (default 3-60s)
 *        so we never pick 2s clips that won't fill a broll insertion or
 *        overly-long clips that cost bandwidth.
 *
 *   2. downloadPixabayVideo({hit, outDir, axiosImpl})
 *      - Streams the video to `<outDir>/px-video-<id>.mp4`
 *      - Returns { localPath, bytes, url }
 *      - Throws on download failure (caller decides whether to skip the hit)
 *
 * The wire contract is shaped to drop straight into the existing broll path:
 * `searchPixabayVideos` hit shape feeds into `stock_library_merge.js` which
 * adapts each hit to the `marketing.broll_library` row shape Gemini's broll
 * picker expects. `downloadPixabayVideo` produces a `localPath` that
 * `composeFaceAndBrolls` can consume directly via the
 * `downloadBrollAssets` short-circuit.
 *
 * Design notes:
 *   - No retry on Pixabay 5xx — the orchestrator's stockSearch step warns
 *     and continues (failures are non-fatal; client library still picks).
 *     If we add retry later, follow the lib/gemini_helpers.js pattern.
 *   - `fetchImpl` and `axiosImpl` injection points let tests stub the
 *     network without ever hitting Pixabay.
 */

import { createWriteStream } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import axios from 'axios';

const PIXABAY_VIDEO_API = 'https://pixabay.com/api/videos/';
const PIXABAY_VIDEO_TIMEOUT_MS_DEFAULT = 60_000;
const DEFAULT_MIN_DUR_SEC = 3;
const DEFAULT_MAX_DUR_SEC = 60;
const DEFAULT_PER_PAGE = 5;

/**
 * Pick the best video URL from a Pixabay hit's `videos` map. Prefers
 * `medium` (good quality / ~1280x720) over `large` (1920x1080, larger
 * download) over `small` (saves bandwidth but lower quality).
 * Returns `null` if no usable URL exists.
 */
function pickVideoUrl(videos) {
  if (!videos || typeof videos !== 'object') return null;
  for (const tier of ['medium', 'large', 'small', 'tiny']) {
    const v = videos[tier];
    if (v && typeof v.url === 'string' && v.url.length > 0) {
      return {
        url: v.url,
        width: typeof v.width === 'number' ? v.width : 0,
        height: typeof v.height === 'number' ? v.height : 0,
        sizeBytes: typeof v.size === 'number' ? v.size : 0,
        tier,
      };
    }
  }
  return null;
}

/**
 * Search Pixabay for stock videos matching `query`.
 *
 * @param {Object} args
 * @param {string} args.query           free-text search term, e.g. "family home planning"
 * @param {number} [args.perPage=5]     Pixabay max 200; we cap at 5 per query
 * @param {number} [args.minDur=3]      drop hits shorter than this (seconds)
 * @param {number} [args.maxDur=60]     drop hits longer than this (seconds)
 * @param {string} args.apiKey          Pixabay API key
 * @param {number} [args.timeoutMs=60000]
 * @param {typeof fetch} [args.fetchImpl]  inject for tests
 * @returns {Promise<{ok: true, hits: Array<{id, pageURL, tags, duration, videoUrl, width, height, sizeBytes, tier}>} | {ok: false, kind: 'upstream'|'empty'|'parse', status?: number, body?: string}>}
 */
export async function searchPixabayVideos(args) {
  const {
    query,
    perPage = DEFAULT_PER_PAGE,
    minDur = DEFAULT_MIN_DUR_SEC,
    maxDur = DEFAULT_MAX_DUR_SEC,
    apiKey,
    timeoutMs = PIXABAY_VIDEO_TIMEOUT_MS_DEFAULT,
    fetchImpl = fetch,
  } = args;

  if (!apiKey) throw new Error('searchPixabayVideos: apiKey is required');
  if (!query || typeof query !== 'string') {
    return { ok: false, kind: 'parse', body: 'query must be a non-empty string' };
  }

  const params = new URLSearchParams({
    key: apiKey,
    q: query,
    per_page: String(Math.max(3, Math.min(200, perPage))),  // Pixabay enforces per_page ≥ 3
    safesearch: 'true',
    video_type: 'film',
  });
  const url = `${PIXABAY_VIDEO_API}?${params.toString()}`;

  // Use AbortController for timeout — native fetch doesn't have a built-in
  // timeout option. Matches the gemini_helpers.js pattern.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, kind: 'upstream', body: err.message ?? String(err) };
  }
  clearTimeout(timer);

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_) { /* noop */ }
    return { ok: false, kind: 'upstream', status: res.status, body: body.slice(0, 500) };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, kind: 'parse', body: `invalid JSON from Pixabay: ${err.message}` };
  }

  const rawHits = Array.isArray(data?.hits) ? data.hits : [];
  if (rawHits.length === 0) {
    return { ok: false, kind: 'empty' };
  }

  const cleaned = [];
  for (const hit of rawHits) {
    if (typeof hit?.id !== 'number') continue;
    const dur = typeof hit?.duration === 'number' ? hit.duration : 0;
    if (dur < minDur || dur > maxDur) continue;
    const picked = pickVideoUrl(hit.videos);
    if (!picked) continue;
    cleaned.push({
      id: hit.id,
      pageURL: typeof hit.pageURL === 'string' ? hit.pageURL : null,
      tags: typeof hit.tags === 'string' ? hit.tags : '',
      duration: dur,
      videoUrl: picked.url,
      width: picked.width,
      height: picked.height,
      sizeBytes: picked.sizeBytes,
      tier: picked.tier,
    });
  }

  if (cleaned.length === 0) {
    return { ok: false, kind: 'empty' };
  }

  return { ok: true, hits: cleaned };
}

/**
 * Download a Pixabay video hit to disk. Streams via axios pipeline (same
 * pattern as `downloadBrollAssets` in clean_mode_pipeline.js).
 *
 * @param {Object} args
 * @param {{ id: number, videoUrl: string }} args.hit  must have `id` and `videoUrl`
 * @param {string} args.outDir                          existing directory; output filename is `px-video-<id>.mp4`
 * @param {number} [args.timeoutMs=180000]
 * @param {typeof axios} [args.axiosImpl]               inject for tests
 * @returns {Promise<{localPath: string, bytes: number, url: string}>}
 */
export async function downloadPixabayVideo(args) {
  const { hit, outDir, timeoutMs = 180_000, axiosImpl = axios } = args;

  if (!hit || typeof hit.id !== 'number') {
    throw new Error('downloadPixabayVideo: hit.id is required');
  }
  if (!hit.videoUrl) {
    throw new Error(`downloadPixabayVideo: hit.videoUrl is required (id=${hit.id})`);
  }
  if (!outDir) throw new Error('downloadPixabayVideo: outDir is required');

  const localPath = join(outDir, `px-video-${hit.id}.mp4`);

  const res = await axiosImpl.get(hit.videoUrl, {
    responseType: 'stream',
    timeout: timeoutMs,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `downloadPixabayVideo: ${res.status} for px-video-${hit.id} (${hit.videoUrl})`,
    );
  }

  const writeStream = createWriteStream(localPath);
  await pipeline(res.data, writeStream);

  const bytes = typeof res.headers?.['content-length'] === 'string'
    ? parseInt(res.headers['content-length'], 10)
    : 0;

  return { localPath, bytes, url: hit.videoUrl };
}
