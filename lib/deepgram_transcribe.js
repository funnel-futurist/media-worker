/**
 * lib/deepgram_transcribe.js
 *
 * Deepgram Nova-3 transcription, structured to be a drop-in replacement
 * for lib/scribe_transcribe.js (callScribeWithRetry → callDeepgramWithRetry,
 * mapScribeResponse → mapDeepgramResponse). The wire contract emitted to
 * downstream code is the canonical
 *   { transcript, word_timestamps: [{ word, start_ms, end_ms }], _debug? }
 * shape — unchanged from the Scribe path so cut_detection.js and
 * subtitle_burn.js work without modification.
 *
 * Why Deepgram over ElevenLabs Scribe (background):
 *   - 35% cheaper per hour ($0.26 vs $0.40)
 *   - Funnel-Futurists-owned account (no shared-key billing surprises like
 *     the 2026-05-05 spike that triggered this swap)
 *   - $200 free credit on signup → ~770 hours of Nova-3 → effectively free
 *     at our throughput for years
 *   - Native word-level timestamps (start/end in seconds, alongside the
 *     punctuated word string) — same fidelity as Scribe, no post-alignment
 *     needed
 *
 * Endpoint: POST https://api.deepgram.com/v1/listen?model=nova-3&...
 * Auth:     Authorization: Token <DEEPGRAM_API_KEY>     (NOT "Bearer ...")
 * Body:     raw audio bytes via Content-Type: video/mp4 (Deepgram extracts
 *           audio server-side; no client-side ffmpeg-extract step needed)
 *
 * The ffmpeg silencedetect helper that lived alongside callScribeWithRetry
 * in lib/scribe_transcribe.js stays imported from there — silence detection
 * has nothing to do with the transcription vendor and isn't worth moving
 * just for this swap.
 */

import { createReadStream, statSync } from 'fs';
import axios from 'axios';

// Prerecorded audio endpoint. Streaming endpoint exists but isn't needed
// for the file-on-disk pipeline.
const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';

// 180s — same timeout as Scribe. Deepgram is typically ~real-time so a
// 100s talking-head finishes in ~10-30s, well under the cap.
const DEEPGRAM_TIMEOUT_MS = 180_000;

/**
 * Query parameters tuned for the talking-head reel pipeline:
 *   - model=nova-3       — newest, highest accuracy at the lowest price
 *                          ($0.26/hr at the time of writing; cheaper than
 *                          Nova-2's $0.43/hr)
 *   - smart_format=true  — capitalises proper nouns, formats numbers/dates,
 *                          inserts punctuation. Keeps the transcript field
 *                          readable; word_timestamps[] preserves the original
 *                          speech order regardless.
 *   - punctuate=true     — explicit; the cut detector relies on `.!?` to
 *                          identify sentence-ends in groupIntoLines and the
 *                          punct-end clamp.
 *   - diarize=false      — single speaker for talking-head reels
 *   - utterances=false   — we don't use Deepgram's utterance grouping;
 *                          the pipeline groups its own way in subtitle_burn.js
 *   - language=en        — explicit; matches the Scribe `language_code=eng`
 *                          we used to send. No auto-detect drift on long
 *                          monologues with rare loanwords.
 */
const DEEPGRAM_QUERY = new URLSearchParams({
  model: 'nova-3',
  smart_format: 'true',
  punctuate: 'true',
  diarize: 'false',
  utterances: 'false',
  language: 'en',
}).toString();

/**
 * Call Deepgram with one retry on transient (network / 5xx) failures.
 * Does NOT retry on 4xx — those are caller's fault (bad audio, bad key,
 * oversize payload) and a retry will just spend the same money to fail
 * the same way. Returns the raw Deepgram JSON; map it via
 * mapDeepgramResponse() to get the canonical shape.
 *
 * @param {string} apiKey   the bare key from process.env.DEEPGRAM_API_KEY
 *                          (caller is responsible for trimming whitespace)
 * @param {string} filePath absolute path to the audio/video file
 * @returns {Promise<object>} raw Deepgram JSON
 */
export async function callDeepgramWithRetry(apiKey, filePath) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // Deepgram accepts raw bytes streamed straight from disk via a
      // ReadStream (no multipart wrapping). This is simpler than the
      // Scribe flow and avoids loading the whole file into memory.
      const stream = createReadStream(filePath);
      const fileSize = statSync(filePath).size;

      const res = await axios.post(`${DEEPGRAM_URL}?${DEEPGRAM_QUERY}`, stream, {
        headers: {
          Authorization: `Token ${apiKey}`,
          // Content-Type must be set or Deepgram returns 400. mp4 is the
          // pipeline's source format; Deepgram's container detector handles
          // mov/webm/mkv via the same MIME if we ever broaden support.
          'Content-Type': 'video/mp4',
          'Content-Length': fileSize,
        },
        timeout: DEEPGRAM_TIMEOUT_MS,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      return res.data;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status ?? 0;
      if (status >= 400 && status < 500) {
        // Use the same `<Vendor> <status> — <body>` shape as the Scribe
        // path so inferStepFromErrorMessage in clean_mode_pipeline.js keeps
        // mapping these to step:'transcribe'.
        const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : err.message;
        throw new Error(`Deepgram ${status} — ${body}`);
      }
      if (attempt === 1) {
        console.warn(`[deepgram_transcribe] deepgram attempt 1 failed (${err.message}), retrying in 2s`);
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }
  throw new Error(`Deepgram failed after retry: ${lastErr?.message ?? lastErr}`);
}

/**
 * Map a raw Deepgram response to the canonical
 *   { transcript, word_timestamps, _debug? }
 * shape used by the rest of the pipeline.
 *
 * Deepgram response structure (relevant fields only):
 *   {
 *     results: {
 *       channels: [{
 *         alternatives: [{
 *           transcript: "the full punctuated transcript",
 *           words: [
 *             { word: "the",       start: 0.16, end: 0.24,  punctuated_word: "The" },
 *             { word: "quick",     start: 0.24, end: 0.48,  punctuated_word: "quick" },
 *             ...
 *           ]
 *         }]
 *       }]
 *     }
 *   }
 *
 * We use `punctuated_word` (with smart_format=true the field carries
 * sentence-end punctuation like ".!?" attached). The cut detector + line
 * grouper rely on those punctuation markers. Falls back to the bare `word`
 * field if `punctuated_word` is somehow absent.
 *
 * Filters:
 *   - drop entries where the word string is empty/whitespace
 *   - drop entries where end <= start (corrupt / zero-duration)
 *
 * If zero words parse, attaches a `_debug` field with raw shape info so
 * the caller can log without an extra round trip — same pattern as
 * mapScribeResponse.
 *
 * @param {object} raw raw Deepgram JSON from callDeepgramWithRetry
 * @returns {{ transcript: string, word_timestamps: Array<{word: string, start_ms: number, end_ms: number}>, _debug?: object }}
 */
export function mapDeepgramResponse(raw) {
  const alt = raw?.results?.channels?.[0]?.alternatives?.[0];
  const rawWords = Array.isArray(alt?.words) ? alt.words : [];

  const word_timestamps = rawWords
    .map((w) => {
      // smart_format=true → punctuated_word is the user-facing form.
      // Fall back to bare `word` if punctuated_word is absent (older
      // models / future API changes).
      const text = (typeof w?.punctuated_word === 'string' ? w.punctuated_word : w?.word) || '';
      const startSec = typeof w?.start === 'number' ? w.start : 0;
      const endSec = typeof w?.end === 'number' ? w.end : 0;
      return {
        word: text.trim(),
        start_ms: Math.round(startSec * 1000),
        end_ms: Math.round(endSec * 1000),
      };
    })
    .filter((w) => w.word.length > 0 && w.end_ms > w.start_ms);

  // Top-level transcript: prefer the smart-formatted version Deepgram
  // returns (already punctuated/cased). Fall back to joining filtered
  // words if the alt.transcript field is missing.
  const transcript = typeof alt?.transcript === 'string' && alt.transcript.length > 0
    ? alt.transcript.trim()
    : word_timestamps.map((w) => w.word).join(' ');

  let _debug = null;
  if (word_timestamps.length === 0) {
    const sample = JSON.stringify(raw).slice(0, 2000);
    _debug = {
      rawTopLevelKeys: raw && typeof raw === 'object' ? Object.keys(raw) : [],
      altKeys: alt && typeof alt === 'object' ? Object.keys(alt) : [],
      rawWordsLength: rawWords.length,
      rawSample: sample,
    };
  }

  return _debug
    ? { transcript, word_timestamps, _debug }
    : { transcript, word_timestamps };
}
