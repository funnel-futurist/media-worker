/**
 * lib/jamendo_music.js
 *
 * Jamendo Music search + download. BGM source for the M2 clean-mode
 * pipeline (PR-B2 — replaces the dead Pixabay-Music endpoint per the
 * 2026-05-08 feasibility check + Shannon's approval).
 *
 * Two exports:
 *   1. searchJamendoMusic({query, limit, durationMin, durationMax,
 *                          clientId, fetchImpl})
 *      Calls https://api.jamendo.com/v3.0/tracks/?client_id=X&search=...
 *      Filters:
 *        - vocalinstrumental=instrumental  (drop tracks with vocals — under-
 *                                           dialogue use case)
 *        - ccnc=0                          (drop Non-Commercial-only tracks)
 *        - ccnd=0                          (drop No-Derivatives tracks; we ARE
 *                                           creating a derivative by mixing)
 *      Result: only commercial-safe + remix-safe tracks (CC-BY / CC-BY-SA).
 *      Attribution is required for these and surfaced in the response.
 *      Returns:
 *        { ok: true, tracks: [{id, name, artistName, albumName, durationSec,
 *                              audioUrl, audioDownloadUrl, licenseCcUrl, tags,
 *                              attributionRequired: true, attributionText}] }
 *        { ok: false, kind: 'upstream'|'empty'|'parse'|'auth', status?, body? }
 *
 *   2. downloadJamendoTrack({track, outDir, axiosImpl})
 *      Streams the chosen track to `<outDir>/jamendo-<id>.mp3`. Uses the
 *      `audioDownloadUrl` field when present (lossless source); falls back
 *      to `audioUrl` (streaming MP3, also fine for our mixing).
 *      Returns { localPath, bytes, url }.
 *
 * Auth note: Jamendo uses a single `client_id` query param — no OAuth.
 * Free tier: 35 req/sec, no monthly limit. Register at
 * https://devportal.jamendo.com to get a client_id.
 *
 * IMPORTANT response shape note: Jamendo returns HTTP 200 even on auth
 * failures — failures are encoded in the response body's
 * `headers.status === 'failed'`. Our parser checks both HTTP status AND
 * the response envelope's `headers.status` to surface the real outcome.
 */

import { createWriteStream } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import axios from 'axios';

const JAMENDO_TRACKS_API = 'https://api.jamendo.com/v3.0/tracks/';
const JAMENDO_TIMEOUT_MS_DEFAULT = 60_000;
const DEFAULT_LIMIT = 10;
const DEFAULT_DURATION_MIN_SEC = 30;
const DEFAULT_DURATION_MAX_SEC = 600;

/**
 * Build a CC-BY-style attribution string from a Jamendo track.
 * Example: `"Calm Piano Reflection" by Jane Doe (CC BY 3.0) — https://...`
 *
 * Format follows Creative Commons "best practices for attribution":
 * https://wiki.creativecommons.org/wiki/best_practices_for_attribution
 */
function buildAttributionText(track) {
  const title = track?.name ?? 'Untitled';
  const artist = track?.artistName ?? 'Unknown Artist';
  const license = track?.licenseCcUrl ?? '';
  // Pull the CC license shortcode from the URL (by, by-sa, etc.) for a
  // human-readable label.
  let label = 'Creative Commons';
  if (typeof license === 'string') {
    const m = license.match(/licenses\/([\w-]+)\/(\d+\.\d+)/);
    if (m) label = `CC ${m[1].toUpperCase()} ${m[2]}`;
  }
  const sourceUrl = track?.shareUrl ?? track?.audioUrl ?? '';
  return `"${title}" by ${artist} (${label})${sourceUrl ? ` — ${sourceUrl}` : ''}`;
}

/**
 * Search Jamendo for instrumental, commercial-safe, remix-safe tracks.
 *
 * @param {Object} args
 * @param {string} args.query          free-text search (e.g. "warm acoustic folk guitar")
 * @param {number} [args.limit=10]
 * @param {number} [args.durationMin=30]   drop tracks shorter (seconds)
 * @param {number} [args.durationMax=600]  drop tracks longer (seconds)
 * @param {string} args.clientId
 * @param {number} [args.timeoutMs=60000]
 * @param {typeof fetch} [args.fetchImpl]
 * @returns {Promise<{ok: true, tracks: Array<object>} | {ok: false, kind: 'upstream'|'auth'|'empty'|'parse', status?: number, body?: string}>}
 */
export async function searchJamendoMusic(args) {
  const {
    query,
    limit = DEFAULT_LIMIT,
    durationMin = DEFAULT_DURATION_MIN_SEC,
    durationMax = DEFAULT_DURATION_MAX_SEC,
    clientId,
    timeoutMs = JAMENDO_TIMEOUT_MS_DEFAULT,
    fetchImpl = fetch,
  } = args;

  if (!clientId) throw new Error('searchJamendoMusic: clientId is required');
  if (!query || typeof query !== 'string') {
    return { ok: false, kind: 'parse', body: 'query must be a non-empty string' };
  }

  const params = new URLSearchParams({
    client_id: clientId,
    format: 'json',
    limit: String(Math.max(1, Math.min(200, limit))),
    search: query,
    vocalinstrumental: 'instrumental',
    ccnc: '0',                   // exclude Non-Commercial-only
    ccnd: '0',                   // exclude No-Derivatives
    order: 'popularity_total',
    audioformat: 'mp32',         // 192kbps mp3 — fine for under-dialogue mixing
  });
  // Note: durationbetween isn't a direct query param in Jamendo's API; we
  // filter client-side after the response.

  const url = `${JAMENDO_TRACKS_API}?${params.toString()}`;

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

  // Jamendo returns HTTP 200 even on auth/quota failures. We have to read
  // the body to know.
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_) { /* noop */ }
    return { ok: false, kind: 'upstream', status: res.status, body: body.slice(0, 500) };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, kind: 'parse', body: `invalid JSON: ${err.message}` };
  }

  // Jamendo envelope: { headers: {status, code, error_message, ...}, results: [...] }
  const envelopeStatus = data?.headers?.status;
  if (envelopeStatus !== 'success') {
    const code = data?.headers?.code ?? 0;
    const errorMessage = data?.headers?.error_message ?? '';
    // code 5 = invalid client_id, code 6 = quota exceeded — surface as auth.
    const kind = (code === 5 || code === 6) ? 'auth' : 'upstream';
    return { ok: false, kind, status: code, body: errorMessage.slice(0, 500) };
  }

  const rawHits = Array.isArray(data?.results) ? data.results : [];
  if (rawHits.length === 0) {
    return { ok: false, kind: 'empty' };
  }

  const cleaned = [];
  for (const hit of rawHits) {
    if (typeof hit?.id === 'undefined') continue;
    const dur = typeof hit?.duration === 'number'
      ? hit.duration
      : (typeof hit?.duration === 'string' ? parseInt(hit.duration, 10) : 0);
    if (!Number.isFinite(dur) || dur < durationMin || dur > durationMax) continue;
    const audioUrl = typeof hit?.audio === 'string' ? hit.audio : null;
    const audioDownloadUrl = typeof hit?.audiodownload === 'string' ? hit.audiodownload : null;
    if (!audioUrl && !audioDownloadUrl) continue;
    const track = {
      id: String(hit.id),
      name: typeof hit?.name === 'string' ? hit.name : `Track ${hit.id}`,
      artistName: typeof hit?.artist_name === 'string' ? hit.artist_name : 'Unknown Artist',
      albumName: typeof hit?.album_name === 'string' ? hit.album_name : null,
      durationSec: dur,
      audioUrl,
      audioDownloadUrl,
      licenseCcUrl: typeof hit?.license_ccurl === 'string' ? hit.license_ccurl : null,
      shareUrl: typeof hit?.shareurl === 'string' ? hit.shareurl : null,
      tags: typeof hit?.tags === 'string'
        ? hit.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : (Array.isArray(hit?.tags) ? hit.tags : []),
      attributionRequired: true,         // every CC-BY/CC-BY-SA track requires attribution
    };
    track.attributionText = buildAttributionText(track);
    cleaned.push(track);
  }

  if (cleaned.length === 0) {
    return { ok: false, kind: 'empty' };
  }

  return { ok: true, tracks: cleaned };
}

/**
 * Download one Jamendo track to disk.
 *
 * Prefers `audioDownloadUrl` (when present, gives the source file); falls
 * back to `audioUrl` (the streaming URL, which is also a valid MP3 over
 * HTTPS — works fine with ffmpeg).
 *
 * @param {Object} args
 * @param {{ id: string|number, audioUrl: string|null, audioDownloadUrl: string|null }} args.track
 * @param {string} args.outDir
 * @param {number} [args.timeoutMs=180000]
 * @param {typeof axios} [args.axiosImpl]
 * @returns {Promise<{localPath: string, bytes: number, url: string}>}
 */
export async function downloadJamendoTrack(args) {
  const { track, outDir, timeoutMs = 180_000, axiosImpl = axios } = args;

  if (!track || (typeof track.id !== 'string' && typeof track.id !== 'number')) {
    throw new Error('downloadJamendoTrack: track.id is required');
  }
  if (!outDir) throw new Error('downloadJamendoTrack: outDir is required');
  const downloadUrl = track.audioDownloadUrl || track.audioUrl;
  if (!downloadUrl) {
    throw new Error(`downloadJamendoTrack: track ${track.id} has no audioDownloadUrl or audioUrl`);
  }

  const localPath = join(outDir, `jamendo-${track.id}.mp3`);

  const res = await axiosImpl.get(downloadUrl, {
    responseType: 'stream',
    timeout: timeoutMs,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `downloadJamendoTrack: ${res.status} for jamendo-${track.id} (${downloadUrl})`,
    );
  }

  const writeStream = createWriteStream(localPath);
  await pipeline(res.data, writeStream);

  const bytes = typeof res.headers?.['content-length'] === 'string'
    ? parseInt(res.headers['content-length'], 10)
    : 0;

  return { localPath, bytes, url: downloadUrl };
}
