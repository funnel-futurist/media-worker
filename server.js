import 'dotenv/config';
import express from 'express';
import { voiceoverRouter } from './routes/voiceover.js';
import { screenshotRouter } from './routes/screenshot.js';
import { annotateRouter } from './routes/annotate.js';
import { assembleRouter } from './routes/assemble.js';
import { captionRouter } from './routes/caption.js';
import { lipsyncRouter } from './routes/lipsync.js';
import { remotionRenderRouter } from './routes/remotion-render.js';
import { extractRouter } from './routes/extract.js';

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

// Global error handler
app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Media worker listening on :${PORT}`));
