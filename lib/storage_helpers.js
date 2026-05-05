/**
 * lib/storage_helpers.js
 *
 * Supabase Storage helpers using service-role auth — no signed URLs in the
 * internal hops. Per M2 plan adjustment #2:
 *   - download / upload always use service-role REST (no TTL, no expiry)
 *   - signed URLs are reserved for the OUTBOUND response so the caller (curl
 *     in test mode; portal in M3) can play the final MP4 without a separate
 *     auth flow.
 *
 * Three exports:
 *   1. downloadFromStorage({ bucket, path, outputPath }) — writes bytes to disk
 *   2. uploadToStorage({ bucket, path, filePath, contentType }) — uploads with x-upsert
 *   3. signStorageUrl({ bucket, path, expiresIn }) — returns full signed URL
 *
 * Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY).
 */

import axios from 'axios';
import { createWriteStream, statSync, readFileSync } from 'fs';
import { pipeline } from 'stream/promises';

function getStorageConfig() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)?.trim();
  if (!url) throw new Error('SUPABASE_URL is not set');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return { url: url.replace(/\/$/, ''), key };
}

/**
 * Download an object from Supabase Storage to a local path.
 * Service-role auth — works on private buckets. Streams the response so
 * large MP4s don't blow up memory.
 *
 * @param {Object} args
 * @param {string} args.bucket
 * @param {string} args.path
 * @param {string} args.outputPath  absolute path on disk
 * @returns {Promise<{ bytes: number }>}
 */
export async function downloadFromStorage({ bucket, path, outputPath }) {
  if (!bucket || !path || !outputPath) {
    throw new Error('downloadFromStorage requires bucket, path, outputPath');
  }
  const { url, key } = getStorageConfig();
  const downloadUrl = `${url}/storage/v1/object/${bucket}/${encodePath(path)}`;
  const res = await axios.get(downloadUrl, {
    responseType: 'stream',
    timeout: 180_000,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });
  if (res.status < 200 || res.status >= 300) {
    // Drain the error body for the message — non-2xx still streams.
    const chunks = [];
    for await (const chunk of res.data) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8').slice(0, 500);
    throw new Error(`Supabase download ${res.status} for ${bucket}/${path}: ${body}`);
  }
  await pipeline(res.data, createWriteStream(outputPath));
  const bytes = statSync(outputPath).size;
  return { bytes };
}

/**
 * Upload a local file to Supabase Storage. Uses x-upsert so retries don't
 * 409 on existing objects.
 *
 * @param {Object} args
 * @param {string} args.bucket
 * @param {string} args.path
 * @param {string} args.filePath  absolute path on disk
 * @param {string} [args.contentType='video/mp4']
 * @returns {Promise<{ bytes: number }>}
 */
export async function uploadToStorage({ bucket, path, filePath, contentType = 'video/mp4' }) {
  if (!bucket || !path || !filePath) {
    throw new Error('uploadToStorage requires bucket, path, filePath');
  }
  const { url, key } = getStorageConfig();
  const buffer = readFileSync(filePath);
  const uploadUrl = `${url}/storage/v1/object/${bucket}/${encodePath(path)}`;
  const res = await axios.post(uploadUrl, buffer, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    timeout: 600_000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });
  if (res.status < 200 || res.status >= 300) {
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data).slice(0, 500);
    throw new Error(`Supabase upload ${res.status} for ${bucket}/${path}: ${body}`);
  }
  return { bytes: buffer.length };
}

/**
 * Mint a Supabase Storage signed URL for a private object. Used ONLY for the
 * outbound response (`finalUrl` in clean-mode-compose) so the caller can
 * play the result without separate auth. Internal hops use service-role REST.
 *
 * @param {Object} args
 * @param {string} args.bucket
 * @param {string} args.path
 * @param {number} [args.expiresIn=86400]  seconds, default 24h
 * @returns {Promise<string>}  full signed URL
 */
export async function signStorageUrl({ bucket, path, expiresIn = 86400 }) {
  if (!bucket || !path) throw new Error('signStorageUrl requires bucket and path');
  const { url, key } = getStorageConfig();
  const signUrl = `${url}/storage/v1/object/sign/${bucket}/${encodePath(path)}`;
  const res = await axios.post(signUrl, { expiresIn }, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    timeout: 30_000,
    validateStatus: () => true,
  });
  if (res.status < 200 || res.status >= 300) {
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data).slice(0, 500);
    throw new Error(`Supabase sign ${res.status} for ${bucket}/${path}: ${body}`);
  }
  // Response shape: { signedURL: '/object/sign/<bucket>/<path>?token=...' }
  // OR (newer): { signedUrl: '...' }. Accept both.
  const signedPath = res.data?.signedURL ?? res.data?.signedUrl;
  if (typeof signedPath !== 'string' || signedPath.length === 0) {
    throw new Error(`Supabase sign returned unexpected shape: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  // signedPath is relative; prepend SUPABASE_URL/storage/v1.
  // It usually starts with `/object/sign/...` so we just glue.
  return `${url}/storage/v1${signedPath.startsWith('/') ? signedPath : '/' + signedPath}`;
}

/**
 * Encode an object path so segments containing spaces or unicode survive the
 * Supabase REST API. Forward slashes stay as separators (Storage paths use
 * `/` for folder structure), so we encode each segment individually.
 */
function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}
