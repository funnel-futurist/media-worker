/**
 * lib/stock_cache.js
 *
 * Per-job cache directory for Pixabay stock asset downloads. Lives under the
 * existing `/tmp/<jobId>/` tree so the orchestrator's existing finally-block
 * cleanup at `lib/clean_mode_pipeline.js:811-812` removes it automatically.
 *
 * No persistent (cross-job) cache by deliberate scope choice — see plan-mode
 * decision D. Persistent caching adds TTL/invalidation/disk-quota complexity
 * that's not justified for M2's volume; same query rarely repeats.
 *
 * If a future PR wants persistent caching, the natural place is to swap
 * `getStockCacheDir(jobId, tmpDir)` here for one that returns
 * `/tmp/pixabay-cache/<key>/` with a content-addressable key. The orchestrator
 * call sites won't change.
 */

import { mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Resolve (and lazily create) the per-job stock cache directory.
 *
 * @param {string} jobId   request jobId (already validated by the orchestrator)
 * @param {string} tmpDir  per-job tmpDir, e.g. `/tmp/<jobId>` — caller already created it
 * @returns {string} absolute path to the cache dir, suitable for passing as
 *   `outDir` to `downloadPixabayVideo`. Directory is guaranteed to exist
 *   (mkdirSync recursive).
 */
export function getStockCacheDir(jobId, tmpDir) {
  if (!jobId || typeof jobId !== 'string') {
    throw new Error('getStockCacheDir: jobId is required');
  }
  if (!tmpDir || typeof tmpDir !== 'string') {
    throw new Error('getStockCacheDir: tmpDir is required');
  }
  const dir = join(tmpDir, 'stock-cache');
  mkdirSync(dir, { recursive: true });
  return dir;
}
