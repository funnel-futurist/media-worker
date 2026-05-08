/**
 * lib/pixabay_music.js
 *
 * Pixabay Music search + download. Mirrors lib/pixabay_video.js's shape for
 * BGM track selection in PR-B. Used by the M2 clean-mode pipeline as the
 * background-music source per the 2026-04-30 + 2026-05-08 decisions
 * (Pixabay-only for M2; per-client approved-music library deferred to M3).
 *
 * Two exports:
 *   1. searchPixabayMusic({query, perPage, durationMin, durationMax,
 *                         apiKey, fetchImpl})
 *      Calls https://pixabay.com/api/?key=<key>&q=...&per_page=...
 *      (Note: Pixabay's general API also serves music when the query is
 *      music-themed and `image_type` is unset; the dedicated music endpoint
 *      moved under /api/ a while back. We accept whatever audio URLs the
 *      response provides via the `audio_*` field family.)
 *      Returns:
 *        { ok: true, hits: [{id, pageURL, tags, duration, audioUrl, sizeBytes}] }
 *        { ok: false, kind: 'upstream'|'empty'|'parse', status?, body? }
 *      Drops hits outside [durationMin, durationMax]. The orchestrator passes
 *      `durationMin = ceil(finalDur * 0.5)` so picked tracks are at least
 *      half the video length — `aloop` fills the remainder with a clean
 *      crossfade (handled in lib/bgm_mix.js).
 *
 *   2. downloadPixabayMusic({hit, outDir, axiosImpl})
 *      Streams the audio to `<outDir>/bgm-<id>.mp3`.
 *      Returns { localPath, bytes, url }.
 *      Throws on download failure (caller decides whether to fall back).
 *
 * fetchImpl / axiosImpl injection lets tests stub the network without
 * hitting Pixabay.
 */

import { createWriteStream } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import axios from 'axios';

const PIXABAY_MUSIC_API = 'https://pixabay.com/api/music/';
const PIXABAY_MUSIC_TIMEOUT_MS_DEFAULT = 60_000;
const DEFAULT_MIN_DUR_SEC = 15;
const DEFAULT_MAX_DUR_SEC = 600;
const DEFAULT_PER_PAGE = 5;

/**
 * Pull a usable audio URL from a Pixabay music hit. Pixabay returns several
 * fields named `audio`, `audio_url`, `audio_url_mp3`, etc. depending on the
 * API version — we look at the most common ones in priority order.
 */
function pickAudioUrl(hit) {
  if (!hit || typeof hit !== 'object') return null;
  for (const key of ['audio', 'audio_url', 'audio_url_mp3', 'previewURL']) {
    const v = hit[key];
    if (typeof v === 'string' && v.length > 0 && v.startsWith('http')) {
      return v;
    }
  }
  return null;
}

/**
 * Search Pixabay Music for tracks matching `query`.
 *
 * @param {Object} args
 * @param {string} args.query              free-text search term, e.g. "warm acoustic"
 * @param {number} [args.perPage=5]        Pixabay floor 3, ceiling 200; we cap at 5
 * @param {number} [args.durationMin=15]   drop tracks shorter than this (seconds)
 * @param {number} [args.durationMax=600]  drop tracks longer than this (seconds)
 * @param {string} args.apiKey
 * @param {number} [args.timeoutMs=60000]
 * @param {typeof fetch} [args.fetchImpl]  inject for tests
 * @returns {Promise<{ok: true, hits: Array<{id, pageURL, tags, duration, audioUrl, sizeBytes}>} | {ok: false, kind: 'upstream'|'empty'|'parse', status?: number, body?: string}>}
 */
export async function searchPixabayMusic(args) {
  const {
    query,
    perPage = DEFAULT_PER_PAGE,
    durationMin = DEFAULT_MIN_DUR_SEC,
    durationMax = DEFAULT_MAX_DUR_SEC,
    apiKey,
    timeoutMs = PIXABAY_MUSIC_TIMEOUT_MS_DEFAULT,
    fetchImpl = fetch,
  } = args;

  if (!apiKey) throw new Error('searchPixabayMusic: apiKey is required');
  if (!query || typeof query !== 'string') {
    return { ok: false, kind: 'parse', body: 'query must be a non-empty string' };
  }

  const params = new URLSearchParams({
    key: apiKey,
    q: query,
    per_page: String(Math.max(3, Math.min(200, perPage))),
    safesearch: 'true',
  });
  const url = `${PIXABAY_MUSIC_API}?${params.toString()}`;

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
    if (dur < durationMin || dur > durationMax) continue;
    const audioUrl = pickAudioUrl(hit);
    if (!audioUrl) continue;
    cleaned.push({
      id: hit.id,
      pageURL: typeof hit.pageURL === 'string' ? hit.pageURL : null,
      tags: typeof hit.tags === 'string' ? hit.tags : '',
      duration: dur,
      audioUrl,
      // Pixabay's music API doesn't always include size; treat 0 as unknown.
      sizeBytes: typeof hit.audio_size === 'number' ? hit.audio_size : 0,
      title: typeof hit.title === 'string' ? hit.title : null,
    });
  }

  if (cleaned.length === 0) {
    return { ok: false, kind: 'empty' };
  }

  return { ok: true, hits: cleaned };
}

/**
 * Download a Pixabay music hit to disk. Streams via axios pipeline.
 *
 * @param {Object} args
 * @param {{ id: number, audioUrl: string }} args.hit
 * @param {string} args.outDir
 * @param {number} [args.timeoutMs=180000]
 * @param {typeof axios} [args.axiosImpl] inject for tests
 * @returns {Promise<{localPath: string, bytes: number, url: string}>}
 */
export async function downloadPixabayMusic(args) {
  const { hit, outDir, timeoutMs = 180_000, axiosImpl = axios } = args;

  if (!hit || typeof hit.id !== 'number') {
    throw new Error('downloadPixabayMusic: hit.id is required');
  }
  if (!hit.audioUrl) {
    throw new Error(`downloadPixabayMusic: hit.audioUrl is required (id=${hit.id})`);
  }
  if (!outDir) throw new Error('downloadPixabayMusic: outDir is required');

  const localPath = join(outDir, `bgm-${hit.id}.mp3`);

  const res = await axiosImpl.get(hit.audioUrl, {
    responseType: 'stream',
    timeout: timeoutMs,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `downloadPixabayMusic: ${res.status} for bgm-${hit.id} (${hit.audioUrl})`,
    );
  }

  const writeStream = createWriteStream(localPath);
  await pipeline(res.data, writeStream);

  const bytes = typeof res.headers?.['content-length'] === 'string'
    ? parseInt(res.headers['content-length'], 10)
    : 0;

  return { localPath, bytes, url: hit.audioUrl };
}
