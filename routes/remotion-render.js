import { Router } from 'express';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { chromium } from 'playwright';
import { uploadVideo } from '../lib/storage.js';

export const remotionRenderRouter = Router();

/**
 * POST /render-composition
 * Render a Remotion composition to video using the pre-built bundle.
 *
 * Uses Playwright's pre-installed Chromium (Microsoft Playwright Docker image).
 * No separate Chrome install needed — it's already in the container.
 *
 * Body: {
 *   compositionId: string        — e.g. "AuditRecap", "TestimonialClip"
 *   props: object                — composition input props (JSON-serializable)
 *   bundleUrl: string            — URL to the deployed Remotion bundle
 *                                  (e.g. https://creative.funnelfuturist.com/remotion-bundle/)
 *   outputFolder?: string        — Cloudinary folder prefix (default: "remotion-renders")
 *   codec?: string               — "h264" | "h265" | "vp8" | "vp9" (default: "h264")
 *   jpegQuality?: number         — 0–100 (default: 80)
 *   concurrency?: number         — parallel frames (default: 4)
 * }
 *
 * Returns: { videoUrl, durationInFrames, fps, width, height, compositionId }
 *
 * IMPORTANT: Never run this locally — always via Railway where Playwright + ffmpeg live.
 */
remotionRenderRouter.post('/render-composition', async (req, res, next) => {
  const tmpDir = join('/tmp', `remotion-${randomUUID()}`);
  try {
    const {
      compositionId,
      props = {},
      bundleUrl,
      outputFolder = 'remotion-renders',
      codec = 'h264',
      jpegQuality = 80,
      concurrency = 4,
    } = req.body;

    if (!compositionId) {
      return res.status(400).json({ error: 'compositionId is required' });
    }
    if (!bundleUrl) {
      return res.status(400).json({ error: 'bundleUrl is required — run npm run bundle:remotion in creative-engine and deploy to Vercel first' });
    }

    // Use Playwright's Chromium — already installed in the Microsoft Playwright Docker image.
    // This avoids a separate Chrome download and reuses the same Chrome the screenshot route uses.
    const chromiumExecutable = chromium.executablePath();
    const browserArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ];

    mkdirSync(tmpDir, { recursive: true });
    const outputPath = join(tmpDir, `${compositionId}-${randomUUID()}.mp4`);

    console.log(`[remotion] Chrome: ${chromiumExecutable}`);
    console.log(`[remotion] Selecting composition: ${compositionId}`);

    const composition = await selectComposition({
      serveUrl: bundleUrl,
      id: compositionId,
      inputProps: props,
      chromiumOptions: {
        executablePath: chromiumExecutable,
        args: browserArgs,
        ignoreCertificateErrors: true,
      },
    });

    console.log(`[remotion] Rendering ${composition.durationInFrames} frames @ ${composition.fps}fps (${composition.width}x${composition.height})`);

    await renderMedia({
      composition,
      serveUrl: bundleUrl,
      codec,
      outputLocation: outputPath,
      inputProps: props,
      jpegQuality,
      concurrency,
      chromiumOptions: {
        executablePath: chromiumExecutable,
        args: browserArgs,
        ignoreCertificateErrors: true,
      },
      onProgress: ({ renderedFrames, encodedFrames, stitchStage }) => {
        if (renderedFrames % 30 === 0) {
          console.log(
            `[remotion] Rendered ${renderedFrames}/${composition.durationInFrames} | Encoded ${encodedFrames} | Stage: ${stitchStage}`
          );
        }
      },
    });

    console.log(`[remotion] Render complete, uploading...`);
    const cloudinaryFolder = `${outputFolder}/${compositionId.toLowerCase()}`;
    const { url: videoUrl } = await uploadVideo(outputPath, cloudinaryFolder);

    console.log(`[remotion] Done: ${videoUrl}`);
    res.json({
      videoUrl,
      durationInFrames: composition.durationInFrames,
      fps: composition.fps,
      width: composition.width,
      height: composition.height,
      compositionId,
    });
  } catch (err) {
    console.error('[remotion] Render failed:', err);
    next(err);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
