import 'dotenv/config';
import express from 'express';

// Keep the process alive when a stream emits an unhandled 'error' event
// (e.g. Cloudinary upload_large ReadStream on a missing file).
// Log the error so it's visible in Railway logs, then let the route's
// try/catch or the Express error handler deal with the response.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] Process kept alive:', err.message, err.code ?? '');
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] Process kept alive:', reason);
});
import { voiceoverRouter } from './routes/voiceover.js';
import { screenshotRouter } from './routes/screenshot.js';
import { annotateRouter } from './routes/annotate.js';
import { assembleRouter } from './routes/assemble.js';
import { captionRouter } from './routes/caption.js';
import { lipsyncRouter } from './routes/lipsync.js';
import { remotionRenderRouter } from './routes/remotion-render.js';
import { extractRouter } from './routes/extract.js';
import { brollRouter } from './routes/broll.js';
import { submagicRouter } from './routes/submagic.js';
import { classifyRouter } from './routes/classify.js';
import { youtubeRouter } from './routes/youtube.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// Simple bearer token auth — set WORKER_SECRET on Railway + all callers
const WORKER_SECRET = process.env.WORKER_SECRET;
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (WORKER_SECRET && req.headers.authorization !== `Bearer ${WORKER_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Health check (no auth required — Railway uses this for liveness)
app.get('/health', (req, res) =>
  res.json({ status: 'ok', ts: new Date().toISOString() })
);

// Routes — Phase 1
app.use('/', voiceoverRouter);
app.use('/', screenshotRouter);
app.use('/', annotateRouter);
// Routes — Phase 2
app.use('/', assembleRouter);
app.use('/', captionRouter);
app.use('/', lipsyncRouter);
// Routes — Phase 3 (Remotion)
app.use('/', remotionRenderRouter);
// Routes — Phase 4 (IP Extraction)
app.use('/', extractRouter);
// Routes — Phase 5 (B-Roll Insertion)
app.use('/', brollRouter);
// Routes — Phase 6 (Submagic AI Edit)
app.use('/', submagicRouter);
// Routes — Phase 7 (Async Gemini Classification)
app.use('/', classifyRouter);
// Routes — Phase 8 (YouTube Clip Extraction)
app.use('/', youtubeRouter);

// Global error handler
app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Media worker listening on :${PORT}`));
