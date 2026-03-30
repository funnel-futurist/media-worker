import { Router } from 'express';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import { getBrowser } from '../lib/browser.js';
import { uploadImage } from '../lib/storage.js';

export const annotateRouter = Router();

/**
 * POST /annotate
 * Overlay red annotation markers on a screenshot via Playwright → Cloudinary
 *
 * Body: {
 *   screenshotUrl: string,
 *   annotations: Array<{ x: number, y: number, label?: string }>
 * }
 * Returns: { annotatedUrl }
 *
 * Annotation coordinates are in pixels relative to the original image.
 * Labels default to the annotation index (1, 2, 3...) if not provided.
 */
annotateRouter.post('/annotate', async (req, res, next) => {
  const tmpDir = join('/tmp', `ann-${randomUUID()}`);
  let context = null;
  try {
    const { screenshotUrl, annotations = [] } = req.body;
    if (!screenshotUrl) return res.status(400).json({ error: 'screenshotUrl is required' });

    mkdirSync(tmpDir, { recursive: true });

    // Build SVG markers: circle + label for each annotation point
    const svgMarkers = annotations.map((a, i) => `
      <circle cx="${a.x}" cy="${a.y}" r="22" fill="rgba(255,0,0,0.15)" stroke="#ff0000" stroke-width="3"/>
      <text x="${a.x + 28}" y="${a.y + 5}" fill="#ff0000" font-family="sans-serif" font-size="14" font-weight="bold">${a.label ?? i + 1}</text>
    `).join('');

    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    // Render screenshot with SVG overlay in a headless browser
    await page.setContent(`<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#fff">
  <div style="position:relative;display:inline-block">
    <img id="img" src="${screenshotUrl}" style="display:block"/>
    <svg id="overlay" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none">
      ${svgMarkers}
    </svg>
  </div>
</body>
</html>`);

    // Wait for image to fully load
    await page.waitForFunction(() => {
      const img = document.getElementById('img');
      return img && img.complete && img.naturalWidth > 0;
    });

    // Resize viewport to match exact image dimensions so screenshot is pixel-perfect
    const dims = await page.evaluate(() => {
      const img = document.getElementById('img');
      return { width: img.naturalWidth, height: img.naturalHeight };
    });
    await page.setViewportSize(dims);

    const annotatedPath = join(tmpDir, 'annotated.png');
    await page.screenshot({ path: annotatedPath, fullPage: true });

    const { url: annotatedUrl } = await uploadImage(annotatedPath, 'audit-screenshots/annotated');
    res.json({ annotatedUrl });
  } catch (err) {
    next(err);
  } finally {
    if (context) await context.close().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
