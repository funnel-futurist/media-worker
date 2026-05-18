/**
 * routes/repatch-captions.js
 *
 * PR-AF: caption-only repatching for already-edited reels. The portal
 * calls this when a QC reviewer flags a transcription mistake on a
 * shipped reel — we swap the offending words in the .ass and reburn
 * captions onto the preserved pre-caption video, keeping b-roll, cuts,
 * music, and timing bit-identical.
 *
 * Wire shape:
 *   POST /repatch-captions
 *   Authorization: Bearer <WORKER_SECRET>   (global middleware)
 *   Body:
 *     {
 *       jobId: string,                           // operator-supplied, used for log correlation
 *       contentItemId: string,                   // for callback payload
 *       clientId: string,                        // for callback payload
 *       preCaptionVideoUrl: string,              // signed Storage URL (pre-caption .mp4)
 *       subtitleAssUrl: string,                  // signed Storage URL (.ass)
 *       replacements: Array<{
 *         from: string,
 *         to: string,
 *         mode?: 'literal' | 'regex',            // default 'literal'
 *         caseInsensitive?: boolean
 *       }>,
 *       output: { bucket: string, pathPrefix: string },
 *       callback?: { url: string, apiKey: string }
 *     }
 *
 * Sync mode (no callback): blocks until done, returns
 *   { ok: true, jobId, editedUrl, replacements: [...] }
 *
 * Async mode (callback present): responds 202, runs in background, POSTs
 * the existing /api/editor/callback/reel shape with the new editedUrl
 * (overwriting cs.content_items.edit_file_url) and a one-line editNotes
 * summarising the replacements.
 *
 * Failure handling matches clean-mode-compose: 4xx for caller-fault,
 * 5xx for internal, success-only callback in async mode.
 */

import { Router } from 'express';
import { promises as fsp, statSync } from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import axios from 'axios';
import { repatchCaptionsOnDisk } from '../lib/repatch_captions.js';
import { uploadToStorage, signStorageUrl } from '../lib/storage_helpers.js';
import {
  postReelEditedCallback,
  buildReelEditedPayload,
} from '../lib/portal_webhook.js';

export const repatchCaptionsRouter = Router();

// Match the existing 1-year TTL for edit_file_url so the portal's stored
// URL stays playable long-term.
const EDITED_URL_TTL_SEC = 60 * 60 * 24 * 365;

repatchCaptionsRouter.post('/repatch-captions', async (req, res) => {
  const body = req.body ?? {};
  const jobId = typeof body.jobId === 'string' && body.jobId.length > 0
    ? body.jobId
    : `repatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ── Validation ──────────────────────────────────────────────────────
  // Bail early with structured errors so the portal can surface them to
  // the operator without parsing free-text. 4xx errors are caller's
  // fault (malformed request); we don't dispatch a callback for them.
  const validation = validateBody(body);
  if (validation.error) {
    return res.status(400).json({ jobId, step: 'validate', error: validation.error });
  }

  const callback = body.callback;
  const asyncMode = !!(callback && typeof callback === 'object');
  if (asyncMode) {
    if (typeof callback.url !== 'string' || !/^https?:\/\//.test(callback.url)) {
      return res.status(400).json({ jobId, step: 'validate', error: 'callback.url must be an http(s) URL' });
    }
    if (typeof callback.apiKey !== 'string' || callback.apiKey.length === 0) {
      return res.status(400).json({ jobId, step: 'validate', error: 'callback.apiKey is required when callback.url is present' });
    }
  }

  if (asyncMode) {
    res.status(202).json({ jobId, accepted: true });
    console.log(
      `[repatch-captions] job=${jobId} ASYNC accepted ` +
      `(callback=${callback.url}, contentItemId=${body.contentItemId})`,
    );
    runAsyncRepatch(body, jobId, callback).catch((err) => {
      console.error(
        `[repatch-captions] job=${jobId} ASYNC uncaught error:`,
        err?.message ?? err,
      );
    });
    return;
  }

  // Synchronous mode.
  try {
    const result = await executeRepatch(body, jobId);
    return res.json({ ok: true, jobId, ...result });
  } catch (err) {
    console.error(`[repatch-captions] job=${jobId} sync error:`, err?.message ?? err);
    return res.status(500).json({ jobId, step: 'execute', error: err?.message ?? String(err) });
  }
});

function validateBody(body) {
  if (typeof body.contentItemId !== 'string' || !body.contentItemId) {
    return { error: 'contentItemId is required' };
  }
  if (typeof body.clientId !== 'string' || !body.clientId) {
    return { error: 'clientId is required' };
  }
  if (typeof body.preCaptionVideoUrl !== 'string' || !/^https?:\/\//.test(body.preCaptionVideoUrl)) {
    return { error: 'preCaptionVideoUrl must be an http(s) URL' };
  }
  if (typeof body.subtitleAssUrl !== 'string' || !/^https?:\/\//.test(body.subtitleAssUrl)) {
    return { error: 'subtitleAssUrl must be an http(s) URL' };
  }
  if (!Array.isArray(body.replacements) || body.replacements.length === 0) {
    return { error: 'replacements must be a non-empty array' };
  }
  if (body.replacements.length > 50) {
    return { error: 'replacements may not exceed 50 entries' };
  }
  for (let i = 0; i < body.replacements.length; i++) {
    const r = body.replacements[i];
    if (!r || typeof r.from !== 'string' || typeof r.to !== 'string') {
      return { error: `replacements[${i}] must have string from + to` };
    }
    if (r.from.length === 0) {
      return { error: `replacements[${i}].from must not be empty` };
    }
    if (r.mode !== undefined && r.mode !== 'literal' && r.mode !== 'regex') {
      return { error: `replacements[${i}].mode must be 'literal' or 'regex'` };
    }
  }
  if (!body.output || typeof body.output.bucket !== 'string' || typeof body.output.pathPrefix !== 'string') {
    return { error: 'output.bucket + output.pathPrefix are required' };
  }
  return { error: null };
}

async function runAsyncRepatch(body, jobId, callback) {
  let result;
  try {
    result = await executeRepatch(body, jobId);
  } catch (err) {
    console.error(
      `[repatch-captions] job=${jobId} ASYNC pipeline failed — NO callback fired ` +
      `(portal cron will detect via edit_file_url freshness):`,
      err?.message ?? err,
    );
    return;
  }

  // Mint a 1-year signed URL — matches clean-mode-compose convention.
  let editedUrl;
  try {
    editedUrl = await signStorageUrl({
      bucket: result.finalStorage.bucket,
      path: result.finalStorage.path,
      expiresIn: EDITED_URL_TTL_SEC,
    });
  } catch (err) {
    console.error(
      `[repatch-captions] job=${jobId} ASYNC failed to sign 1-year URL:`,
      err?.message ?? err,
    );
    return;
  }

  // editNotes summarises the swap so the operator sees what changed in
  // the portal's QC message without opening the diff.
  const editNotes = buildRepatchEditNotes(result.replacements);
  const payload = buildReelEditedPayload({
    contentItemId: body.contentItemId,
    clientId: body.clientId,
    editedUrl,
    editNotes,
    // Re-emit the same intermediate URLs so a second repatch round is
    // still possible from the same content row (we don't reupload them,
    // they're the originals).
    preCaptionVideoUrl: body.preCaptionVideoUrl,
    subtitleAssUrl: body.subtitleAssUrl,
  });

  const post = await postReelEditedCallback({
    callbackUrl: callback.url,
    callbackApiKey: callback.apiKey,
    payload,
  });
  if (!post.ok) {
    console.error(
      `[repatch-captions] job=${jobId} ASYNC callback delivery FAILED ` +
      `(attempts=${post.attempts} status=${post.status ?? '-'} err=${post.error ?? '-'})`,
    );
  } else {
    console.log(
      `[repatch-captions] job=${jobId} ASYNC callback delivered ` +
      `(status=${post.status} contentItemId=${body.contentItemId})`,
    );
  }
}

async function executeRepatch(body, jobId) {
  const t0 = Date.now();
  const workDir = mkdtempSync(join(tmpdir(), `repatch-${jobId}-`));
  const preCaptionPath = join(workDir, 'pre_caption.mp4');
  const assPath = join(workDir, 'subtitles.ass');
  const patchedAssPath = join(workDir, 'subtitles.patched.ass');
  const outputPath = join(workDir, 'final.mp4');

  console.log(`[repatch-captions] job=${jobId} downloading inputs to ${workDir}`);
  await downloadToFile(body.preCaptionVideoUrl, preCaptionPath);
  await downloadToFile(body.subtitleAssUrl, assPath);

  const downloadMs = Date.now() - t0;
  console.log(
    `[repatch-captions] job=${jobId} downloaded ` +
    `pre_caption=${statSync(preCaptionPath).size}B, .ass=${statSync(assPath).size}B in ${downloadMs}ms`,
  );

  const burnStart = Date.now();
  const { totalMatches, results } = await repatchCaptionsOnDisk({
    preCaptionVideoPath: preCaptionPath,
    assPath,
    patchedAssPath,
    outputPath,
    replacements: body.replacements,
  });
  const burnMs = Date.now() - burnStart;

  if (totalMatches === 0) {
    // Zero matches doesn't fail the route — the reel still got reburned
    // and is byte-identical to the original, so it's a safe no-op. But
    // surface it loudly so the operator knows their `from` text was
    // wrong before they go telling the client it's fixed.
    console.warn(
      `[repatch-captions] job=${jobId} WARNING: ${body.replacements.length} replacement(s) yielded 0 total matches in the .ass — ` +
      `nothing was changed. Check the source text spelling/casing.`,
    );
  } else {
    console.log(
      `[repatch-captions] job=${jobId} burned patched .ass in ${burnMs}ms ` +
      `(${totalMatches} match${totalMatches === 1 ? '' : 'es'} across ${results.length} replacement${results.length === 1 ? '' : 's'})`,
    );
  }

  // Upload the new final to the same bucket as the original under a
  // -repatched-<timestamp> suffix so the original Storage object stays
  // available for diffing if needed.
  const stamp = Date.now();
  const finalStoragePath = `${body.output.pathPrefix}${jobId}-repatched-${stamp}.mp4`;
  const finalStorage = { bucket: body.output.bucket, path: finalStoragePath };
  await uploadToStorage({
    bucket: body.output.bucket,
    path: finalStoragePath,
    filePath: outputPath,
    contentType: 'video/mp4',
  });

  // Best-effort cleanup. Failure here doesn't undo the work above.
  try {
    await fsp.rm(workDir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[repatch-captions] job=${jobId} tmp cleanup failed (non-fatal):`, err?.message ?? err);
  }

  const totalMs = Date.now() - t0;
  console.log(
    `[repatch-captions] job=${jobId} DONE in ${totalMs}ms ` +
    `(download=${downloadMs}ms, burn=${burnMs}ms)`,
  );

  return {
    finalStorage,
    replacements: results,
    totalMatches,
    timing: { downloadMs, burnMs, totalMs },
  };
}

async function downloadToFile(url, destPath) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120_000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  await fsp.writeFile(destPath, Buffer.from(res.data));
}

function buildRepatchEditNotes(results) {
  const hits = results.filter((r) => r.count > 0);
  if (hits.length === 0) {
    return 'Caption repatch: 0 matches (no change).';
  }
  const summary = hits
    .map((r) => `"${r.from}" → "${r.to}" (${r.count}×)`)
    .slice(0, 5)
    .join(', ');
  const overflow = hits.length > 5 ? ` (+${hits.length - 5} more)` : '';
  return `Caption repatch: ${summary}${overflow}`;
}
