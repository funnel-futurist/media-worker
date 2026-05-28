/**
 * routes/recompose-broll.js
 *
 * PR-AP: surgical b-roll swap for already-edited reels. The portal/operator
 * calls this when a QC reviewer flags specific b-roll insertions on a
 * shipped reel — we replace those assets in the persisted insertions plan
 * and re-run only the post-cut steps (compose → overlay → banner → subtitle
 * burn → BGM mix). Cuts, transcript, picker output, and timing are
 * preserved. Captions are re-burned over the new brolled video but the
 * .ass file itself is unchanged.
 *
 * Required intermediates (persisted by PR-AP-a in clean_mode_pipeline.js):
 *   - <sourceJobId>-cut.mp4                — talking-head only
 *   - <sourceJobId>-recompose-manifest.json — insertions plan + compose options
 *                                            + intro hook + banner + bgm state
 *   - <sourceJobId>-subtitles.ass          — caption file
 *
 * If any are missing, returns 409 broll_recompose_missing_intermediate so
 * the caller knows the source job pre-dated PR-AP and a full re-edit is
 * needed instead.
 *
 * Wire shape (sync only for v1 — no callback complexity):
 *   POST /recompose-broll
 *   Authorization: Bearer <WORKER_SECRET>
 *   {
 *     jobId: string,             // new job id for the output
 *     sourceJobId: string,       // existing job whose intermediates we use
 *     clientId: string,          // echoed back; used for log correlation
 *     source: { bucket, pathPrefix },   // where the source intermediates live
 *     output: { bucket, pathPrefix },   // where the new final.mp4 goes
 *     replacements: Array<{
 *       atSec: number,                  // approx startSec of the insertion to swap
 *       newAsset: {
 *         downloadUrl: string,          // direct media URL (operator pre-resolved)
 *         assetId?: string,             // optional label for logs
 *         provenance?: string           // 'client' | 'pixabay' | 'manual'
 *       }
 *     }>,
 *     toleranceSec?: number             // default 1.5s — atSec match window
 *   }
 *
 * Returns:
 *   200 { ok: true, jobId, finalUrl, finalStorage, replaced: [...], steps, ... }
 *   400 invalid body shape
 *   409 broll_recompose_missing_intermediate (cut.mp4 / manifest / .ass missing)
 *   500 internal failure (with which step failed)
 */

import { Router } from 'express';
import { mkdtempSync, statSync, readFileSync, writeFileSync, rmSync, createWriteStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pipeline } from 'stream/promises';
import axios from 'axios';

import { downloadFromStorage, uploadToStorage, signStorageUrl } from '../lib/storage_helpers.js';
import { composeFaceAndBrolls } from '../lib/clean_mode_pipeline.js';
import { renderIntroOverlay } from '../lib/intro_card_render.js';
import { overlayBanner } from '../lib/banner_overlay.js';
import { burnSubtitles } from '../lib/subtitle_burn.js';
import { getLUFS, computeBgmReductionDb, mixBgmIntoVideo } from '../lib/bgm_mix.js';
import { probeStreams } from '../lib/media.js';
import { getDuration } from '../lib/media.js';

export const recomposeBrollRouter = Router();

const EDITED_URL_TTL_SEC = 60 * 60 * 24 * 365;

/**
 * PR-AP: apply operator replacements to the persisted insertions plan.
 *
 * For each replacement: find the insertion whose startSec is within
 * `toleranceSec` of replacement.atSec. The closest match wins (ties broken
 * by earliest insertion). Replace its asset_id + downloadUrl + provenance
 * with the operator's pick. Returns { plan, applied[], skipped[] } so the
 * caller can surface what changed.
 *
 * Pure function — no I/O. Exported for unit testing.
 *
 * @param {Array} insertions  manifest.insertions array (will not be mutated)
 * @param {Array} replacements  caller-supplied replacement specs
 * @param {number} toleranceSec  match window around atSec
 */
export function applyReplacementsToPlan(insertions, replacements, toleranceSec = 1.5) {
  const plan = insertions.map((ins) => ({ ...ins }));
  const applied = [];
  const skipped = [];
  for (const r of replacements) {
    const atSec = r?.atSec;
    if (typeof atSec !== 'number' || !Number.isFinite(atSec)) {
      skipped.push({ ...r, reason: 'atSec missing or non-numeric' });
      continue;
    }
    const newAsset = r?.newAsset;
    if (!newAsset || typeof newAsset.downloadUrl !== 'string' || newAsset.downloadUrl.length === 0) {
      skipped.push({ ...r, reason: 'newAsset.downloadUrl missing' });
      continue;
    }
    // Find the closest insertion by |startSec - atSec|; require within tolerance.
    let bestIdx = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < plan.length; i++) {
      const delta = Math.abs(plan[i].startSec - atSec);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIdx = i;
      }
    }
    if (bestIdx < 0 || bestDelta > toleranceSec) {
      skipped.push({ ...r, reason: `no insertion within ${toleranceSec.toFixed(1)}s of atSec=${atSec.toFixed(2)} (closest delta=${bestDelta === Infinity ? 'none' : bestDelta.toFixed(2)}s)` });
      continue;
    }
    const oldAssetId = plan[bestIdx].asset_id;
    plan[bestIdx] = {
      ...plan[bestIdx],
      asset_id: newAsset.assetId ?? `manual-${Date.now()}`,
      downloadUrl: newAsset.downloadUrl,
      provenance: newAsset.provenance ?? 'manual',
    };
    applied.push({
      atSec,
      insertionStartSec: insertions[bestIdx].startSec,
      insertionEndSec: insertions[bestIdx].endSec,
      oldAssetId,
      newAssetId: plan[bestIdx].asset_id,
      newAssetUrl: plan[bestIdx].downloadUrl,
      deltaSec: Number(bestDelta.toFixed(3)),
    });
  }
  return { plan, applied, skipped };
}

function validateBody(body) {
  if (typeof body.jobId !== 'string' || body.jobId.length === 0) return 'jobId is required (non-empty string)';
  if (typeof body.sourceJobId !== 'string' || body.sourceJobId.length === 0) return 'sourceJobId is required (non-empty string)';
  if (typeof body.clientId !== 'string' || body.clientId.length === 0) return 'clientId is required (non-empty string)';
  if (!body.source || typeof body.source.bucket !== 'string' || typeof body.source.pathPrefix !== 'string') {
    return 'source must be { bucket, pathPrefix }';
  }
  if (!body.output || typeof body.output.bucket !== 'string' || typeof body.output.pathPrefix !== 'string') {
    return 'output must be { bucket, pathPrefix }';
  }
  if (!Array.isArray(body.replacements) || body.replacements.length === 0) {
    return 'replacements must be a non-empty array of { atSec, newAsset: { downloadUrl, ... } }';
  }
  return null;
}

async function downloadUrlToFile(url, outPath) {
  // Plain HTTPS download — used for replacement assets the operator already
  // resolved (Pixabay direct URL, Supabase public URL, third-party CDN).
  // 5-minute timeout matches existing broll_picker download fanout.
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 300_000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`replacement download ${res.status} for ${url.slice(0, 80)}`);
  }
  await pipeline(res.data, createWriteStream(outPath));
  return statSync(outPath).size;
}

recomposeBrollRouter.post('/recompose-broll', async (req, res) => {
  const body = req.body ?? {};
  const jobId = typeof body.jobId === 'string' && body.jobId.length > 0
    ? body.jobId
    : `recompose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const log = (...args) => console.log(`[recompose-broll:${jobId}]`, ...args);

  const validationError = validateBody(body);
  if (validationError) {
    return res.status(400).json({ jobId, step: 'validate', error: validationError });
  }

  const { sourceJobId, clientId, source, output, replacements } = body;
  const toleranceSec = typeof body.toleranceSec === 'number' ? body.toleranceSec : 1.5;

  const tmpDir = mkdtempSync(join(tmpdir(), `recompose-${jobId}-`));
  const steps = {};
  const warnings = [];
  const stepStart = (name) => { steps[name] = { started: Date.now() }; return Date.now(); };

  try {
    // ── 1. Download intermediates (fail-fast if any missing) ──
    let stepT = stepStart('downloadIntermediates');
    const cutLocal = join(tmpDir, 'cut.mp4');
    const manifestLocal = join(tmpDir, 'manifest.json');
    const assLocal = join(tmpDir, 'subtitles.ass');

    const cutPath = `${source.pathPrefix}${sourceJobId}-cut.mp4`;
    const manifestPath = `${source.pathPrefix}${sourceJobId}-recompose-manifest.json`;
    const assPath = `${source.pathPrefix}${sourceJobId}-subtitles.ass`;

    try {
      await downloadFromStorage({ bucket: source.bucket, path: cutPath, outputPath: cutLocal });
    } catch (err) {
      return res.status(409).json({
        jobId, step: 'downloadIntermediates',
        error: 'broll_recompose_missing_intermediate',
        detail: `cut.mp4 missing at ${source.bucket}/${cutPath}: ${err.message?.slice(0, 200) ?? err}`,
      });
    }
    try {
      await downloadFromStorage({ bucket: source.bucket, path: manifestPath, outputPath: manifestLocal });
    } catch (err) {
      return res.status(409).json({
        jobId, step: 'downloadIntermediates',
        error: 'broll_recompose_missing_intermediate',
        detail: `recompose-manifest.json missing at ${source.bucket}/${manifestPath}: ${err.message?.slice(0, 200) ?? err}`,
      });
    }
    try {
      await downloadFromStorage({ bucket: source.bucket, path: assPath, outputPath: assLocal });
    } catch (err) {
      return res.status(409).json({
        jobId, step: 'downloadIntermediates',
        error: 'broll_recompose_missing_intermediate',
        detail: `subtitles.ass missing at ${source.bucket}/${assPath}: ${err.message?.slice(0, 200) ?? err}`,
      });
    }
    steps.downloadIntermediates = { ms: Date.now() - stepT, ok: true };

    const manifest = JSON.parse(readFileSync(manifestLocal, 'utf8'));
    log('manifest loaded', `insertions=${manifest.insertions?.length ?? 0}`, `introHook=${manifest.introHook?.applied}`, `banner=${manifest.banner?.enabled}`, `bgm=${manifest.bgm?.enabled}`);

    // ── 2. Apply operator replacements ──
    stepT = stepStart('applyReplacements');
    const planResult = applyReplacementsToPlan(manifest.insertions ?? [], replacements, toleranceSec);
    steps.applyReplacements = {
      ms: Date.now() - stepT,
      requested: replacements.length,
      applied: planResult.applied.length,
      skipped: planResult.skipped.length,
      skippedDetail: planResult.skipped,
    };
    if (planResult.applied.length === 0) {
      return res.status(400).json({
        jobId, step: 'applyReplacements',
        error: 'no_replacements_applied',
        detail: `0 of ${replacements.length} replacements matched an insertion within ${toleranceSec}s tolerance`,
        skippedDetail: planResult.skipped,
      });
    }
    log('replacements applied', planResult.applied.length, 'skipped', planResult.skipped.length);

    // ── 3. Download all assets in the new plan ──
    // Existing insertions: re-download from their original downloadUrl (cached
    // by Pixabay/Supabase CDN; cheap). Replaced insertions: download from the
    // operator's URL. We download serially to keep the I/O profile predictable.
    stepT = stepStart('assetDownload');
    const insertionsWithLocalPath = [];
    for (let i = 0; i < planResult.plan.length; i++) {
      const ins = planResult.plan[i];
      if (!ins.downloadUrl) {
        warnings.push(`insertion ${ins.asset_id} (start=${ins.startSec}s) has no downloadUrl in manifest — skipping`);
        continue;
      }
      const ext = ins.downloadUrl.match(/\.(mp4|mov|jpg|jpeg|png|webp|heic)(\?|$)/i)?.[1]?.toLowerCase() ?? 'mp4';
      const localPath = join(tmpDir, `asset-${i}-${ins.asset_id.slice(0, 20).replace(/[^a-z0-9]/gi, '_')}.${ext}`);
      try {
        const bytes = await downloadUrlToFile(ins.downloadUrl, localPath);
        // PR-AP-fix: composeFaceAndBrolls requires sourceDurSec on every
        // insertion (throws otherwise — verified on ff212f86 surgical swap
        // 2026-05-28). v1 of this route assumed manifest carried the field;
        // it does for kept insertions but NEWLY-added replacement assets
        // arrive without it. Probe locally on every download so the
        // contract is satisfied uniformly.
        let probe = null;
        try {
          probe = await probeStreams(localPath);
        } catch (probeErr) {
          warnings.push(`asset probe failed for ${ins.asset_id}: ${probeErr.message?.slice(0, 200) ?? probeErr} — insertion dropped`);
          continue;
        }
        insertionsWithLocalPath.push({
          ...ins,
          localPath,
          bytes,
          sourceDurSec: probe.container?.duration ?? 0,
          hasVideo: !!probe.video,
          hasAudio: !!probe.audio,
          width: probe.video?.width ?? ins.width ?? 0,
          height: probe.video?.height ?? ins.height ?? 0,
        });
      } catch (err) {
        warnings.push(`asset download failed for ${ins.asset_id}: ${err.message?.slice(0, 200) ?? err} — insertion dropped`);
      }
    }
    if (insertionsWithLocalPath.length === 0) {
      throw new Error('all asset downloads failed — cannot compose');
    }
    steps.assetDownload = {
      ms: Date.now() - stepT,
      ok: true,
      downloaded: insertionsWithLocalPath.length,
      droppedDueToDownloadFail: planResult.plan.length - insertionsWithLocalPath.length,
    };

    // ── 4. Re-run compose ──
    // composeFaceAndBrolls expects each insertion to carry localPath + media
    // metadata. Some downstream filters need width/height to lay out the
    // 9:16 fill — we cheat for v1 and let composeFaceAndBrolls probe assets
    // itself (it does internally for missing metadata).
    stepT = stepStart('compose');
    const brolledPath = join(tmpDir, 'brolled.mp4');
    await composeFaceAndBrolls({
      facePath: cutLocal,
      brolledPath,
      insertions: insertionsWithLocalPath,
      totalDuration: manifest.cutDurationSec,
      faceCropOffsetX: manifest.composeOptions?.faceCropOffsetX ?? 0.5,
      outputWidth: manifest.composeOptions?.outputWidth ?? 1080,
      outputHeight: manifest.composeOptions?.outputHeight ?? 1920,
    });
    steps.compose = { ms: Date.now() - stepT, ok: true, insertions: insertionsWithLocalPath.length };
    let videoForSubtitles = brolledPath;

    // ── 5. Re-apply intro hook overlay (if original had one) ──
    if (manifest.introHook?.applied && manifest.introHook.hookText) {
      stepT = stepStart('introOverlay');
      try {
        const overlayPath = join(tmpDir, 'overlay.mp4');
        await renderIntroOverlay({
          inputVideoPath: videoForSubtitles,
          outputPath: overlayPath,
          hookText: manifest.introHook.hookText,
          durationSec: manifest.introHook.durationSec ?? 5.0,
          width: manifest.composeOptions?.outputWidth ?? 1080,
          height: manifest.composeOptions?.outputHeight ?? 1920,
        });
        videoForSubtitles = overlayPath;
        steps.introOverlay = { ms: Date.now() - stepT, ok: true, hookText: manifest.introHook.hookText };
      } catch (err) {
        warnings.push(`intro overlay re-render failed (non-fatal): ${err.message?.slice(0, 200)}`);
        steps.introOverlay = { ms: Date.now() - stepT, ok: false, error: err.message?.slice(0, 200) };
      }
    }

    // ── 6. Re-apply banner overlay (if original had one) ──
    if (manifest.banner?.enabled && manifest.banner.config) {
      stepT = stepStart('bannerOverlay');
      try {
        const banneredPath = join(tmpDir, 'bannered.mp4');
        await overlayBanner({
          inputPath: videoForSubtitles,
          outputPath: banneredPath,
          bannerConfig: manifest.banner.config,
        });
        videoForSubtitles = banneredPath;
        steps.bannerOverlay = { ms: Date.now() - stepT, ok: true };
      } catch (err) {
        warnings.push(`banner overlay re-render failed (non-fatal): ${err.message?.slice(0, 200)}`);
        steps.bannerOverlay = { ms: Date.now() - stepT, ok: false, error: err.message?.slice(0, 200) };
      }
    }

    // ── 7. Re-burn subtitles ──
    stepT = stepStart('subtitleBurn');
    const subtitledPath = join(tmpDir, 'subtitled.mp4');
    await burnSubtitles({ inputPath: videoForSubtitles, assPath: assLocal, outputPath: subtitledPath });
    steps.subtitleBurn = { ms: Date.now() - stepT, ok: true };

    // ── 8. Re-apply BGM mix (if original had it) ──
    let finalLocalPath = subtitledPath;
    if (manifest.bgm?.enabled && manifest.bgm.downloadUrl) {
      stepT = stepStart('bgmMix');
      try {
        const bgmLocal = join(tmpDir, 'bgm.mp3');
        await downloadUrlToFile(manifest.bgm.downloadUrl, bgmLocal);
        const speechLufs = await getLUFS(subtitledPath);
        const musicLufsRaw = await getLUFS(bgmLocal);
        const subtitledDur = await getDuration(subtitledPath);
        // Use the exact volume the original mix landed on so the new output
        // sounds identical (operator may have tuned via bgmVolumeDb). We
        // pass the volume directly via reduction.volumeLinear rather than
        // recomputing — the original speech LUFS hasn't changed since
        // captions are bit-identical and compose only affects video.
        const finalWithBgm = join(tmpDir, 'final.mp4');
        await mixBgmIntoVideo({
          videoPath: subtitledPath,
          bgmPath: bgmLocal,
          outputPath: finalWithBgm,
          videoDurationSec: subtitledDur,
          bgmSourceDurSec: manifest.bgm.durationSec ?? subtitledDur,
          volume: manifest.bgm.appliedVolumeLinear ?? 0.5,
          fadeSec: manifest.bgm.fadeSec ?? 1.5,
        });
        finalLocalPath = finalWithBgm;
        steps.bgmMix = {
          ms: Date.now() - stepT,
          ok: true,
          appliedVolumeLinear: manifest.bgm.appliedVolumeLinear,
          speechLufs,
          musicLufsRaw,
        };
      } catch (err) {
        warnings.push(`bgm mix re-apply failed (non-fatal): ${err.message?.slice(0, 200)} — final has no BGM`);
        steps.bgmMix = { ms: Date.now() - stepT, ok: false, error: err.message?.slice(0, 200) };
      }
    }

    // ── 9. Upload new final.mp4 ──
    stepT = stepStart('finalUpload');
    const finalStoragePath = `${output.pathPrefix}${jobId}.mp4`;
    await uploadToStorage({
      bucket: output.bucket,
      path: finalStoragePath,
      filePath: finalLocalPath,
      contentType: 'video/mp4',
    });
    const finalUrl = await signStorageUrl({
      bucket: output.bucket,
      path: finalStoragePath,
      expiresIn: EDITED_URL_TTL_SEC,
    });
    const finalBytes = statSync(finalLocalPath).size;
    const finalDurationSec = await getDuration(finalLocalPath);
    steps.finalUpload = { ms: Date.now() - stepT, ok: true, bytes: finalBytes };

    return res.status(200).json({
      ok: true,
      jobId,
      sourceJobId,
      clientId,
      finalUrl,
      finalStorage: { bucket: output.bucket, path: finalStoragePath, bytes: finalBytes, durationSec: finalDurationSec },
      replaced: planResult.applied,
      skipped: planResult.skipped,
      warnings,
      steps,
    });
  } catch (err) {
    const msg = err?.message ?? String(err);
    console.error(`[recompose-broll:${jobId}] FATAL`, msg, err?.stack);
    return res.status(500).json({
      jobId, step: 'recompose-broll',
      error: msg.slice(0, 500),
      warnings,
      steps,
    });
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});
