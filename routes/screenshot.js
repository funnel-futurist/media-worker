import { Router } from 'express';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import { getBrowser } from '../lib/browser.js';
import { uploadImage } from '../lib/storage.js';

export const screenshotRouter = Router();

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

/**
 * POST /screenshot
 * Capture full-page screenshot via Playwright → Cloudinary
 *
 * Body: { url, viewport? }  viewport: 'desktop' | 'mobile' (default: 'desktop')
 * Returns: { screenshotUrl }
 */
screenshotRouter.post('/screenshot', async (req, res, next) => {
  const tmpDir = join('/tmp', `ss-${randomUUID()}`);
  let context = null;
  try {
    const { url, viewport = 'desktop' } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    mkdirSync(tmpDir, { recursive: true });

    const browser = await getBrowser();
    context = await browser.newContext({
      viewport: VIEWPORTS[viewport] ?? VIEWPORTS.desktop,
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500); // Let lazy-loaded images settle

    const screenshotPath = join(tmpDir, 'screenshot.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const { url: screenshotUrl } = await uploadImage(screenshotPath, 'audit-screenshots');
    res.json({ screenshotUrl });
  } catch (err) {
    next(err);
  } finally {
    if (context) await context.close().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
