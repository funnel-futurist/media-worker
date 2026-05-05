/**
 * routes/broll-picker.js
 *
 * Milestone 1 of the clean-mode pipeline migration: a pure JSON-in/JSON-out
 * Gemini call hosted on Railway. No Supabase, no ffmpeg, no file I/O.
 *
 * After M2 refactor: thin wrapper around lib/broll_picker.js. The orchestration
 * logic (prompt construction, retry, parsing) lives in the lib so the M2
 * clean-mode-compose pipeline can call it directly without an internal HTTP hop.
 *
 * Auth: bearer WORKER_SECRET (handled by global middleware in server.js).
 */

import { Router } from 'express';
import {
  pickBrollInsertions,
  getAvailableModels,
  DEFAULT_MODEL,
} from '../lib/broll_picker.js';

export const brollPickerRouter = Router();

/**
 * POST /broll-picker
 *
 * Body:
 *   {
 *     transcript: Array<{ startSec: number, endSec: number, text: string }>,
 *     library: Array<{
 *       asset_id: string, asset_title: string, asset_type?: string,
 *       content_strategy_type?: string, context?: string, insight?: string,
 *       emotion?: string, when_to_use?: string,
 *     }>,
 *     totalDuration: number,
 *     brollDensity?: number,           // default 0.35
 *     model?: string,                  // default 'gemini-3.1-pro-preview'
 *   }
 *
 * Response (200): { insertions: [...], model }
 */
brollPickerRouter.post('/broll-picker', async (req, res, next) => {
  try {
    const {
      transcript,
      library,
      totalDuration,
      brollDensity = 0.35,
      model: requestedModel,
    } = req.body || {};

    if (!Array.isArray(transcript) || transcript.length === 0) {
      return res.status(400).json({ error: 'transcript must be a non-empty array of { startSec, endSec, text }' });
    }
    if (!Array.isArray(library) || library.length === 0) {
      return res.status(400).json({ error: 'library must be a non-empty array of broll metadata objects' });
    }
    if (typeof totalDuration !== 'number' || totalDuration <= 0) {
      return res.status(400).json({ error: 'totalDuration must be a positive number (seconds)' });
    }
    if (typeof brollDensity !== 'number' || brollDensity <= 0 || brollDensity > 1) {
      return res.status(400).json({ error: 'brollDensity must be a number in (0, 1]' });
    }

    const model = typeof requestedModel === 'string' && requestedModel.length > 0
      ? requestedModel
      : DEFAULT_MODEL;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY not set on Railway' });
    }

    // Validate the requested model is on this key's allow-list before calling
    // generateContent (avoids burning a request on a 404).
    let availableModels;
    try {
      availableModels = await getAvailableModels(apiKey);
    } catch (err) {
      console.error('[broll-picker] could not fetch available models:', err.message);
      return res.status(502).json({ error: `Could not validate model: ${err.message}` });
    }
    if (!availableModels.includes(model)) {
      return res.status(404).json({
        error: `Model '${model}' not available on this Gemini API key`,
        availableModels,
      });
    }

    const result = await pickBrollInsertions({
      transcript,
      library,
      totalDuration,
      brollDensity,
      model,
      apiKey,
    });

    if (result.ok) {
      return res.json({ insertions: result.insertions, model: result.model });
    }

    // Map lib error envelopes → HTTP responses (matches pre-refactor behavior).
    if (result.kind === 'upstream') {
      return res.status(result.status || 502).json({
        error: 'Gemini upstream error',
        upstreamStatus: result.status,
        upstreamBody: result.body,
      });
    }
    if (result.kind === 'empty') {
      return res.status(502).json({ error: 'Gemini returned empty response', rawResponse: result.rawResponse });
    }
    if (result.kind === 'parse') {
      return res.status(502).json({ error: `Gemini returned invalid JSON: ${result.error}`, rawText: result.rawText });
    }
    if (result.kind === 'shape') {
      return res.status(502).json({ error: result.message, rawText: result.rawText });
    }
    return res.status(502).json({ error: 'Unknown broll_picker error', result });
  } catch (err) {
    console.error('[broll-picker] error:', err?.message ?? err);
    next(err);
  }
});
