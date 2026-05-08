/**
 * lib/audio_qc.js
 *
 * Optional perceptual QC of a BGM-mixed final video. Ported from
 * `creative-engine/video-projects/ff-pilot/scripts/audio_qc.js` Pass 2
 * with two adaptations:
 *   1. Model swapped from `gemini-2.0-flash-exp` → `gemini-3.1-pro-preview`
 *      per Shannon's "Gemini Pro only on clean-mode AI decisions" directive
 *      (lock-in: test/clean_mode_models_lock.test.js).
 *   2. SDK dependency removed — uses plain fetch via lib/gemini_helpers.js
 *      so M2 doesn't pull in `@google/generative-ai`.
 *
 * Workflow:
 *   1. Extract a 15-second mono 16kHz audio sample from the rendered final
 *      MP4 using ffmpeg
 *   2. Read the sample, base64-encode it, send to Gemini Pro with the
 *      perceptual prompt
 *   3. Parse the verdict + speech score + suggested dB reduction
 *
 * The orchestrator only invokes this when `req.options.bgmQcEnabled=true`.
 * It's a debug / verification path, not on the hot path of normal jobs.
 * Failures are non-fatal: if QC errors, the response simply has
 * `audio.bgm.qc = null` and the BGM mix already done is preserved.
 *
 * Latency: extracting the sample is ~1-3s; Gemini Pro audio call is ~5-15s.
 * Total ~5-20s added when enabled.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fetchGeminiWithRetry } from './gemini_helpers.js';

const execAsync = promisify(exec);

const DEFAULT_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const SAMPLE_DURATION_SEC = 15;
const DEFAULT_TIMEOUT_MS = 90_000;

const QC_PROMPT = `Listen to this audio clip from a short-form social media video (TikTok/Reels style).
There is a person speaking with background music playing underneath.

Rate the speech intelligibility and music balance. Reply ONLY with this JSON (no markdown):
{
  "speech_score": <1-10 where 10 = crystal clear>,
  "verdict": "<good|borderline|too_loud>",
  "suggested_db_reduction": <0|-2|-3|-5>,
  "notes": "<one sentence>"
}`;

/**
 * Extract a 15-second mono 16kHz mp3 sample from the final video. Returns
 * the local path to the sample so the caller can read+upload it. Output
 * lands in the same dir as the input by default.
 */
async function extractAudioSample(finalPath, sampleDurationSec, opts = {}) {
  const execFn = opts.execImpl ?? execAsync;
  const samplePath = join(dirname(finalPath), '_qc-audio-sample.mp3');
  const cmd =
    `ffmpeg -y -i "${finalPath}" -t ${sampleDurationSec} ` +
    `-vn -ac 1 -ar 16000 "${samplePath}"`;
  await execFn(cmd, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  return samplePath;
}

/**
 * Gemini Pro perceptual QC of a BGM-mixed video.
 *
 * @param {Object} args
 * @param {string} args.finalPath           absolute path to the BGM-mixed final video
 * @param {Object} [opts]
 * @param {string} [opts.apiKey]            defaults to process.env.GEMINI_API_KEY
 * @param {string} [opts.model]             defaults to gemini-3.1-pro-preview
 * @param {number} [opts.sampleDurationSec=15]
 * @param {typeof fetchGeminiWithRetry} [opts.fetchImpl]
 * @param {Function} [opts.execImpl]         inject ffmpeg sample extraction for tests
 * @param {(p: string) => Buffer} [opts.readFileImpl]  inject sample-read for tests
 * @returns {Promise<{ok: true, speechScore: number, verdict: 'good'|'borderline'|'too_loud', suggestedDbReduction: number, notes: string, model: string} | {ok: false, kind: 'extract'|'upstream'|'empty'|'parse'|'shape', body?: string, status?: number}>}
 */
export async function runBgmAudioQc(args, opts = {}) {
  const { finalPath } = args;
  if (!finalPath) throw new Error('runBgmAudioQc: finalPath is required');

  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('runBgmAudioQc: GEMINI_API_KEY is not set');

  const model = opts.model ?? DEFAULT_MODEL;
  const sampleDurationSec = opts.sampleDurationSec ?? SAMPLE_DURATION_SEC;
  const fetcher = opts.fetchImpl ?? fetchGeminiWithRetry;
  const readFileFn = opts.readFileImpl ?? readFileSync;

  // 1. Extract the audio sample. If ffmpeg fails here, abort QC cleanly —
  //    we don't want this to break the pipeline.
  let samplePath;
  try {
    samplePath = await extractAudioSample(finalPath, sampleDurationSec, { execImpl: opts.execImpl });
  } catch (err) {
    return { ok: false, kind: 'extract', body: `audio sample extraction failed: ${err.message ?? err}` };
  }
  if (!opts.readFileImpl && !existsSync(samplePath)) {
    return { ok: false, kind: 'extract', body: `audio sample missing at ${samplePath}` };
  }

  // 2. Read + base64-encode the sample for the Gemini inlineData payload.
  let base64Audio;
  try {
    const buf = readFileFn(samplePath);
    base64Audio = Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(buf).toString('base64');
  } catch (err) {
    return { ok: false, kind: 'extract', body: `failed to read audio sample: ${err.message ?? err}` };
  }

  // 3. Call Gemini Pro with the audio + prompt.
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/mpeg', data: base64Audio } },
          { text: QC_PROMPT },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 256,
    },
  });

  let res;
  try {
    res = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 'audio_qc');
  } catch (err) {
    return { ok: false, kind: 'upstream', body: err.message ?? String(err) };
  }
  if (!res.ok) {
    let bodyText = '';
    try { bodyText = await res.text(); } catch (_) { /* noop */ }
    return { ok: false, kind: 'upstream', status: res.status, body: bodyText.slice(0, 500) };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, kind: 'parse', body: `invalid JSON envelope: ${err.message}` };
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return { ok: false, kind: 'empty', body: 'no candidate text' };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, kind: 'parse', body: `invalid inner JSON: ${err.message}` };
  }

  const speechScore = typeof parsed?.speech_score === 'number' ? parsed.speech_score : null;
  const verdict = ['good', 'borderline', 'too_loud'].includes(parsed?.verdict) ? parsed.verdict : null;
  const suggestedDbReduction = typeof parsed?.suggested_db_reduction === 'number' ? parsed.suggested_db_reduction : 0;
  const notes = typeof parsed?.notes === 'string' ? parsed.notes : '';

  if (speechScore === null || verdict === null) {
    return { ok: false, kind: 'shape', body: `response missing required fields. got: speech_score=${parsed?.speech_score} verdict=${parsed?.verdict}` };
  }

  return { ok: true, speechScore, verdict, suggestedDbReduction, notes, model };
}
