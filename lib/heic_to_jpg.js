/**
 * lib/heic_to_jpg.js
 *
 * Pure-JS HEIC/HEIF → JPG conversion. Wraps the `heic-convert` npm package
 * (libheif compiled to WASM under the hood — no native deps, no Dockerfile
 * changes). PR-E (2026-05-09): replaces the PR #110 hard-drop of HEIC rows
 * with a real conversion path so iPhone photo libraries (Phil's 8 HEIC
 * client b-roll assets) become usable.
 *
 * Speed budget: ~1-3s per photo on Phil's typical sizes (3-5 MB HEIC). For
 * a job that picks all 8 of his HEIC photos that's ~10-25s of one-time
 * conversion overhead. If this becomes a bottleneck we can swap to `sharp`
 * (faster, native binary) — Shannon explicitly approved the tradeoff.
 *
 * The converter is dependency-injected so tests don't decode real HEIC bytes
 * (and don't need to ship a fixture). Pattern matches lib/bgm_select.js's
 * `fetchImpl`.
 */

import { readFile, writeFile, stat } from 'fs/promises';
import heicConvert from 'heic-convert';

const DEFAULT_QUALITY = 0.8;            // 0..1 per heic-convert API (≈80% JPG)
const HEIC_OR_HEIF_RE = /\.(heic|heif)(\?|$)/i;

/**
 * Cheap classifier — does this path/URL end in `.heic` or `.heif`? Used by
 * the orchestrator to decide whether to route a downloaded asset through
 * conversion. Mirrors the regex in `lib/broll_filter.js` for consistency
 * (both check the same extension class; this one operates on a local path
 * or URL, the filter operates on a library-row URL).
 *
 * @param {string|null|undefined} pathOrUrl
 * @returns {boolean}
 */
export function isHeicPath(pathOrUrl) {
  if (typeof pathOrUrl !== 'string' || pathOrUrl.length === 0) return false;
  return HEIC_OR_HEIF_RE.test(pathOrUrl);
}

/**
 * Convert a single HEIC/HEIF file on disk to a JPEG file on disk.
 *
 * Single conversion only — caller is responsible for deciding which assets
 * to convert. The orchestrator (`downloadBrollAssets` in
 * `lib/clean_mode_pipeline.js`) calls this per picked HEIC asset, swaps the
 * insertion's `localPath` to the new JPG, and continues to the probe step.
 *
 * Errors include the input path so a multi-asset failure mode (one of the
 * 8 picked HEICs is corrupt) surfaces which one in the response warning.
 *
 * @param {Object} args
 * @param {string} args.inputPath        absolute path to an existing HEIC/HEIF file
 * @param {string} args.outputPath       absolute path where the JPG will be written
 * @param {number} [args.quality=0.8]    JPG encoder quality 0..1 (heic-convert API)
 * @param {(opts: { buffer: Buffer, format: 'JPEG', quality: number }) => Promise<Buffer>} [args.convertImpl]
 *   Injectable converter for tests. Defaults to `heic-convert`.
 * @returns {Promise<{outputPath: string, bytes: number, ms: number}>}
 */
export async function convertHeicToJpg(args) {
  const { inputPath, outputPath, quality = DEFAULT_QUALITY, convertImpl = heicConvert } = args ?? {};
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('convertHeicToJpg: inputPath is required');
  }
  if (!outputPath || typeof outputPath !== 'string') {
    throw new Error('convertHeicToJpg: outputPath is required');
  }
  // Surface a clean ENOENT BEFORE we try to call the converter — easier to
  // diagnose in the response warning than a libheif "buffer empty" error.
  await stat(inputPath);

  const startedAt = Date.now();
  const inputBuffer = await readFile(inputPath);
  let outputBuffer;
  try {
    outputBuffer = await convertImpl({ buffer: inputBuffer, format: 'JPEG', quality });
  } catch (err) {
    const msg = err?.message ?? String(err);
    throw new Error(`heic_to_jpg: conversion failed for ${inputPath} — ${msg}`);
  }
  await writeFile(outputPath, outputBuffer);
  return {
    outputPath,
    bytes: outputBuffer.length,
    ms: Date.now() - startedAt,
  };
}
