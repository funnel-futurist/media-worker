/**
 * lib/broll_picker.js
 *
 * Gemini-based b-roll insertion planner. Extracted from routes/broll-picker.js
 * (M1 endpoint) so the M2 clean-mode-compose pipeline can call this directly
 * instead of doing an internal HTTP hop.
 *
 * The exported helpers are:
 *   1. getAvailableModels(apiKey) — lazily-cached model list (one extra HTTP
 *      call per worker boot). Used to validate the requested model before
 *      we burn a generateContent call on a 404.
 *   2. pickBrollInsertions({...}) — the full Gemini generateContent call:
 *      builds prompts, calls with retry, parses JSON. Returns either a
 *      success envelope or a typed-error envelope so callers can map to
 *      HTTP status codes (route) or throw (M2 pipeline).
 *
 * Mirrors scripts/add_brolls.ts:callGeminiForInsertions on the creative-engine
 * side so the contract stays identical between the local CLI flow and the
 * Railway endpoint.
 */

import axios from 'axios';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const RATE_LIMIT_BACKOFFS_MS = [3000, 10000];
const SERVER_ERROR_BACKOFFS_MS = [2000, 5000];

export const DEFAULT_MODEL = 'gemini-3.1-pro-preview';

// Module-level cache. Populated lazily on first request.
let availableModelsCache = null;

/**
 * Fetch the list of Gemini models available to the given API key. Cached
 * for the lifetime of the process — model availability changes rarely.
 *
 * @param {string} apiKey
 * @returns {Promise<string[]>}  array of model ids without the `models/` prefix
 */
export async function getAvailableModels(apiKey) {
  if (availableModelsCache) return availableModelsCache;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set on Railway');
  try {
    const res = await axios.get(`${GEMINI_API_BASE}?key=${apiKey}`, { timeout: 15_000 });
    const names = (res.data?.models ?? [])
      .map((m) => (typeof m?.name === 'string' ? m.name.replace(/^models\//, '') : null))
      .filter(Boolean);
    if (names.length === 0) {
      throw new Error('Gemini Models endpoint returned empty list');
    }
    availableModelsCache = names;
    return names;
  } catch (err) {
    const status = err.response?.status ?? 0;
    const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : err.message;
    throw new Error(`Failed to list Gemini models (status=${status}): ${body}`);
  }
}

/**
 * Build the system + user prompts for the b-roll picker. Pure function so
 * tests can lock down prompt wording without making network calls. Exported
 * so the prefer-client constraint (PR-D) can be snapshot-locked without
 * spawning a Gemini call.
 */
/**
 * Build the SOURCE MIX rule for the picker prompt. Internal helper for
 * `buildPrompts`. Two variants today; future modes (e.g. 'client_first'
 * for the opposite extreme) can be added without changing buildPrompts.
 *
 * Returned string is a single Constraints-bullet line ready to drop into
 * the prompt.
 */
function buildSourceMixClause(clientPreference) {
  if (clientPreference === 'minimal') {
    // Phil-style libraries: mostly static photos / repetitive imagery that
    // doesn't carry the edit well at high density. Push Gemini hard
    // toward stock; allow 1-2 client picks for brand identity only.
    return `- SOURCE MIX (MINIMAL-CLIENT MODE) — This client's b-roll library is mostly static photos or repetitive imagery that does not translate well to motion at high density. STRONGLY PREFER Pixabay stock (provenance="pixabay") for every spoken moment. Use client assets (provenance="client") ONLY when (1) the client asset is clearly and obviously the best fit for a specific moment that no stock equivalent explains as well, OR (2) to anchor 1-2 moments with authentic brand/client footage for visual identity. Default to STOCK for all other moments. Do NOT over-pick client b-roll just because it exists in the library. Aim for at most 1-2 client picks per video; the rest should be stock.`;
  }
  // Default 'balanced' — the AI-blend "USE BOTH" rule from PR-F.
  return `- SOURCE MIX — When the library contains BOTH client-provided assets (provenance="client") AND Pixabay stock assets (provenance="pixabay"), USE BOTH. The audience benefits from a healthy mix of authentic client footage and supporting stock visuals. For each spoken moment, pick the asset that best fits the line — prefer client only when relevance is genuinely similar; pick stock when it explains the moment more directly or fills a beat the client library doesn't cover well. Don't force one source; don't force the other. Aim for a healthy mix when both are available; pick exclusively from one source only when the other genuinely doesn't fit any moment.`;
}

/**
 * Build picker prompts. PR #130 (2026-05-12) adds `clientPreference`:
 *
 *   'balanced'  (default) — AI-blend "USE BOTH" rule from PR-F. Picker
 *                           treats client + stock equally per-moment.
 *                           Used by every client with a video-heavy or
 *                           good-quality client b-roll library.
 *   'minimal'             — Strong stock bias. Client b-roll is allowed
 *                           only when CLEARLY the best fit, capped at
 *                           ~1-2 picks per video for brand identity.
 *                           Used for clients whose library is mostly
 *                           static photos / repetitive images that don't
 *                           translate well to motion (Phil's library).
 *
 * The bias lives in the prompt — Gemini decides per-moment whether to
 * honor it. Post-pick enforcement (PR-F `rebalanceClientFirst`) still
 * applies, with `brollMaxStockRatio` clamping the ceiling regardless.
 */
/**
 * Compute a short aspect descriptor for the system prompt (e.g. '9:16 talking-head reel',
 * '4:5 talking-head ad', '1:1 square video'). Selection is content-flavored: 4:5 is the
 * standard ad-creative aspect, 9:16 is the standard reel/short, 1:1 is legacy square.
 * Falls back to "{W}×{H} talking-head video" for unknown aspects.
 */
function describeAspect(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '9:16 talking-head reel';
  }
  // Reduce to integer ratio for comparison.
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(width, height);
  const rw = width / g;
  const rh = height / g;
  if (rw === 9 && rh === 16) return '9:16 talking-head reel';
  if (rw === 4 && rh === 5) return '4:5 talking-head ad';
  if (rw === 1 && rh === 1) return '1:1 square talking-head video';
  if (rw === 16 && rh === 9) return '16:9 landscape talking-head video';
  return `${width}×${height} talking-head video`;
}

export function buildPrompts({
  transcript,
  library,
  totalDuration,
  brollDensity,
  clientPreference = 'balanced',
  outputWidth = 1080,
  outputHeight = 1920,
  // PR-K: per-job overrides for insertion duration. Defaults to 4/5/5s
  // (min/target/max) — picker is asked to aim for ~5s, ranging [4, 5].
  // Bumped down from 6/7/8s — 5s keeps b-roll punchy without flash.
  // Operators can override per-job via options.brollMinDurationSec etc.;
  // the route layer validates min <= target <= max.
  brollMinDurationSec = 4.0,
  brollTargetDurationSec = 5.0,
  brollMaxDurationSec = 5.0,
  // PR-AN: opener no-b-roll zone. First N seconds must be the speaker
  // establishing — no cutaway. Default 5.0s matches normalizeInsertions
  // and the introDurationSec default. Operators can tighten/loosen
  // per-job; the route validator enforces [0, 30].
  brollMinStartSec = 5.0,
  // Optional content domain context (e.g. "college admissions tutoring").
  // When present, the picker rejects b-roll that doesn't fit the domain
  // even if it loosely matches transcript words.
  contentContext,
}) {
  const aspectDescriptor = describeAspect(outputWidth, outputHeight);
  const systemPrompt = `You are an expert short-form video editor selecting b-roll insertions for a ${aspectDescriptor}. You receive a transcript with sentence-level timestamps and a library of available b-roll assets with metadata. You return a JSON insertion plan: which seconds of the video should cut to which b-roll asset, and why.

Your picks must demonstrate clear semantic relevance — each b-roll must visually reinforce, illustrate, or metaphorically represent what the speaker is saying at that exact moment. Generic or loosely related picks are worse than no b-roll at all.

Return ONLY valid JSON of shape:
{
  "insertions": [
    { "startSec": number, "endSec": number, "asset_id": string, "reason": string, "matchedPhrase": string, "match_type": "direct" | "metaphor" | "emotional", "visual_concept": string }
  ]
}

No prose, no markdown fences, no commentary outside the JSON.`;

  const floorBrollSec = totalDuration * brollDensity;
  const userPrompt = `Transcript with sentence-level timestamps:
${JSON.stringify(transcript, null, 2)}

Total video duration: ${totalDuration.toFixed(2)}s
Minimum b-roll coverage: ~${floorBrollSec.toFixed(2)}s (${(brollDensity * 100).toFixed(0)}% of total) — this is a FLOOR, not a target.

Available b-roll library:
${JSON.stringify(library, null, 2)}

B-ROLL SELECTION POLICY

Your job is to decide WHERE in the talking-head reel b-roll should appear, then pick the best library asset for each chosen moment. Coverage is opportunity-driven — go above the floor when the script supports more, and don't pad to hit a number when it doesn't.
${contentContext ? `
CONTENT DOMAIN — ${contentContext}
Every b-roll pick MUST visually support this specific domain. REJECT any asset that:
- Matches a transcript word broadly but does not fit the domain (e.g., "family baking" in an education ad because the speaker said "family" — WRONG)
- Shows generic lifestyle footage unrelated to the domain (cooking, vacation, sports, pets) unless the speaker explicitly describes that scene
- Would confuse a viewer about what the ad is selling
When in doubt, keep the speaker on camera. A clean talking-head moment is ALWAYS better than a domain-mismatched b-roll moment.
` : ''}
MATCH QUALITY RUBRIC — evaluate every potential pick against these tiers:

DIRECT (strongest): The asset visually depicts something the speaker explicitly names or describes.
  Good: Speaker says "we sat down with the family" → asset showing a family meeting or gathering.
  Good: Speaker says "we looked at the paperwork" → asset showing documents on a desk.

METAPHOR (strong): The asset concretizes an abstract concept through a recognizable visual metaphor.
  Good: Speaker says "time is running out" → clock or calendar imagery.
  Good: Speaker says "feeling the weight of that decision" → person deep in thought.

EMOTIONAL (acceptable only as last resort): The asset reinforces the emotional tone without a direct or metaphorical link.
  Good: Speaker conveys relief after a hard decision → calm, open outdoor scene.
  Use ONLY when no DIRECT or METAPHOR match exists in the library. These must still feel intentional.

REJECT (never pick): The connection is forced, cliché, or non-existent.
  Bad: Speaker says "trust" → generic stock handshake (too cliché, zero specificity).
  Bad: Speaker says "we need to plan" → random nature footage (no semantic connection).
  Bad: Speaker discusses any topic → generic office/skyline/city b-roll (filler, not illustrative).
  Bad: Any moment → asset whose when_to_use/context/emotion metadata has no overlap with the spoken content.
  If the best available match for a moment is REJECT-tier, leave the speaker on camera.

A moment is B-ROLL-WORTHY when the visual would:
- Illustrate something the speaker references concretely (a calendar, a document, a family, a place, a process, a person doing a task).
- Make an abstract concept concrete via metaphor (planning → calendar imagery; family pressure → group photo; timeline shift → clock; financial decision → paperwork). Abstract concepts ARE eligible for b-roll when a strong visual metaphor exists in the library.
- Reinforce an emotional beat (concern, relief, decision moment, anticipation).
- Cover a long talking-head stretch where the framing is static and the speaker isn't visually expressive.

A moment is BETTER ON SPEAKER FACE when:
- The speaker's expression IS the visual (a smile, a wince, a pointed look, direct eye contact).
- The line is a direct address to the viewer ("listen", "trust me", "here's the thing", "you").
- The moment is intimate and emotionally charged where a stock cut would feel cold.
- The line is a short connective phrase ("and so", "because of that", "right").
- The speaker is building to a punchline or key point — cutting away breaks momentum.

CUT TIMING
- Start each b-roll at or just before the matched phrase begins — never mid-word or mid-emphasis.
- End at a natural sentence boundary or pause, not mid-thought.
- Never cut to b-roll during the speaker's emphatic delivery, punchline, or emotional climax — those moments must land on face.
- If two b-roll-worthy moments are closer than 4s apart, pick the stronger match and skip the weaker one.

VISUAL VARIETY
- Track what each pick visually shows (its visual_concept) — e.g. "family at table", "signing documents", "sunset landscape".
- Never place two insertions with the same or very similar visual_concept consecutively — vary the visual rhythm.
- Spread distinct visual themes across the timeline. If the library has 8 assets, the audience should see diversity, not the same 2-3 concepts reused.
- Read each asset's when_to_use, context, emotion, and insight fields carefully — they describe what the asset depicts and when it fits. Do not match on asset_title alone.

COVERAGE FLOOR
- Aim for AT LEAST ${floorBrollSec.toFixed(0)}s of b-roll across the video (~${(brollDensity * 100).toFixed(0)}% of total runtime). This is the FLOOR.
- TARGET AT LEAST 10 INSERTIONS for any video over 60 seconds. This is a talking-head reel — the audience needs frequent visual breaks. More insertions (12-15) is better than fewer as long as each pick passes the MATCH QUALITY RUBRIC.
- There is NO upper cap. If the script has many b-roll-worthy moments, exceed the floor — long uncovered talking-head stretches feel boring when visual support is available.
- If the script genuinely doesn't support more coverage, stop at the floor. Do not invent moments.

ANTI-PADDING
- Never pick a b-roll whose connection to the spoken line is weak, generic, or repetitive just to hit the floor. Leaving the speaker on screen is ALWAYS better than a forced or off-topic pick.
- If you can't find a library asset that clearly fits a moment, skip that moment.
- Repetitive picks (same visual concept used twice in close succession) feel padded — vary the kinds of visuals you choose.
- Self-check each pick: "Would a viewer instantly understand why this visual appears at this moment?" If no, drop it.

Constraints:
- Variety: never reuse the same asset_id twice in this video.
- Insertion duration: bounded [${brollMinDurationSec.toFixed(1)}s, ${brollMaxDurationSec.toFixed(1)}s]; aim for ~${brollTargetDurationSec.toFixed(1)}s per insertion. Pick a span around the spoken phrase the broll pairs with — start at the utterance, extend to the target duration if the surrounding content still fits. Avoid sub-${brollMinDurationSec.toFixed(1)}s flashes; viewers need time to read each visual.
- OPENER ZONE: do not place ANY insertion whose startSec is below ${brollMinStartSec.toFixed(1)}s. The first ${brollMinStartSec.toFixed(1)} seconds MUST show the speaker on camera, establishing the talking head. A b-roll opener for a talking-head reel is objectively wrong — the viewer needs to see who is speaking before any cutaway. If a b-roll-worthy moment lands at or near second 0, skip it; the next b-roll opportunity will come.
- Min 4s spacing between consecutive brolls.
- The matchedPhrase should be the exact text of the sentence (or a substring) that justifies the broll.
- The reason should be a short sentence explaining why this specific broll fits this specific moment — reference the specific visual element in the asset that connects to the specific words being spoken.
- match_type must be "direct", "metaphor", or "emotional" per the MATCH QUALITY RUBRIC. If most of your picks are "emotional", you are over-picking — tighten your selections.
- visual_concept is a short (2-4 word) label for what the asset visually depicts (e.g. "family at table", "signing documents", "sunset landscape"). Consecutive insertions MUST have different visual_concepts.
- ASSET ID FIDELITY — Copy the full asset_id EXACTLY VERBATIM from the library candidate list. Do NOT truncate, shorten, or abbreviate UUIDs (e.g., never emit "1c2817be" when the library row is "1c2817be-8326-4f4c-a666-56d422f44612" — emit the full string with all dashes). Do NOT invent or fabricate IDs. Return only IDs that appear in the library JSON above. The downstream pipeline matches insertion.asset_id against the library by exact-string equality first.
${buildSourceMixClause(clientPreference)}

Return ONLY the JSON object described in the system prompt.`;

  return { systemPrompt, userPrompt };
}

/**
 * Call Gemini's generateContent with retry on 429 / 5xx.
 *
 * Per-attempt timeout: 120s (PR #113 — bumped from 60s after B9 attempts on
 * 2026-05-08 hit two consecutive 60s timeouts on `gemini-3.1-pro-preview` for
 * Phil's source. Pro model latency varies day-to-day; B7 ran broll_pick in
 * 21-115s on prior days but elevated to >60s on 2026-05-08. The wider budget
 * absorbs Pro's tail latency without downgrading to Flash. With maxAttempts=2,
 * worst-case wall time is ~240s before failing — acceptable for the quality
 * Pro provides on broll selection. Do NOT switch to Flash here without
 * Shannon's explicit approval.).
 *
 * @returns {Promise<{ ok: true, data: object } | { ok: false, status: number, body: string }>}
 */
async function callGeminiWithRetry(model, apiKey, body) {
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
  const maxAttempts = 2;

  let lastStatus = 0;
  let lastBody = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res;
    try {
      res = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 120_000,
        validateStatus: () => true,
      });
    } catch (err) {
      lastStatus = 0;
      lastBody = err.message;
      if (attempt === maxAttempts - 1) break;
      const delay = SERVER_ERROR_BACKOFFS_MS[attempt] ?? 5000;
      console.log(`[broll_picker] network error — retrying in ${delay}ms (attempt ${attempt + 2}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (res.status >= 200 && res.status < 300) {
      return { ok: true, data: res.data };
    }

    lastStatus = res.status;
    lastBody = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

    if (res.status !== 429 && res.status < 500) {
      return { ok: false, status: res.status, body: lastBody };
    }

    if (attempt === maxAttempts - 1) break;
    const delays = res.status === 429 ? RATE_LIMIT_BACKOFFS_MS : SERVER_ERROR_BACKOFFS_MS;
    const delay = delays[attempt] ?? delays[delays.length - 1];
    console.log(`[broll_picker] ${res.status} ${res.status === 429 ? 'rate-limited' : 'server-error'} — retrying in ${delay}ms (attempt ${attempt + 2}/${maxAttempts})`);
    await new Promise((r) => setTimeout(r, delay));
  }

  return { ok: false, status: lastStatus, body: lastBody };
}

/**
 * Plan b-roll insertions for a transcript via Gemini.
 *
 * Result envelope (keeps caller in control of HTTP status mapping):
 *   { ok: true, insertions, model }
 *   { ok: false, kind: 'upstream', status, body }       — Gemini 4xx/5xx pass-through
 *   { ok: false, kind: 'empty', rawResponse }           — Gemini returned no text
 *   { ok: false, kind: 'parse', error, rawText }        — text wasn't valid JSON
 *   { ok: false, kind: 'shape', message, rawText }      — JSON missing insertions[]
 *
 * @param {Object} args
 * @param {Array<{ startSec: number, endSec: number, text: string }>} args.transcript
 * @param {Array<object>} args.library  rows from broll_library
 * @param {number} args.totalDuration
 * @param {number} [args.brollDensity=0.55]  PR-N: floor (not target) for
 *   b-roll runtime coverage. The picker prompt treats this as a minimum;
 *   AI is encouraged to exceed it when the script supports more, and to
 *   stay at the floor when it doesn't. Was 0.35 pre-PR-N. Per-job
 *   override via options.brollDensity still wins; this is the no-override
 *   default and the value the pipeline passes when the caller omits it.
 * @param {string} [args.model='gemini-3.1-pro-preview']
 * @param {string} args.apiKey
 */
export async function pickBrollInsertions({
  transcript,
  library,
  totalDuration,
  brollDensity = 0.55,
  model = DEFAULT_MODEL,
  apiKey,
  clientPreference = 'balanced',
  outputWidth = 1080,
  outputHeight = 1920,
  contentContext,
  // PR-K: per-job duration overrides — passthrough to buildPrompts.
  brollMinDurationSec,
  brollTargetDurationSec,
  brollMaxDurationSec,
  // PR-AN: opener no-b-roll zone — passthrough to buildPrompts.
  brollMinStartSec,
}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY not provided to pickBrollInsertions');

  const { systemPrompt, userPrompt } = buildPrompts({
    transcript, library, totalDuration, brollDensity, clientPreference,
    outputWidth, outputHeight,
    contentContext,
    // Only forward when defined so buildPrompts defaults kick in cleanly
    // when the caller didn't specify (preserves backward compatibility).
    ...(brollMinDurationSec !== undefined && { brollMinDurationSec }),
    ...(brollTargetDurationSec !== undefined && { brollTargetDurationSec }),
    ...(brollMaxDurationSec !== undefined && { brollMaxDurationSec }),
    ...(brollMinStartSec !== undefined && { brollMinStartSec }),
  });
  const requestBody = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      // Bumped 8192 → 16384 on 2026-05-11 after a real production run
      // (jobId=62c08f03-458e-4d35-a57b-b5550200a434, content_item
      // 5d69189c-be10-43d0-b4ff-0277cb2052e3) failed at brollPick with
      // "Unexpected end of JSON input" — Gemini 3.1 Pro consumes a
      // variable number of tokens on internal reasoning, then emits the
      // structured JSON. Output scales with library×insertions×field
      // length (one record per pick with reason + matchedPhrase strings),
      // so 8192 ran dry mid-emit on this clip even though an earlier
      // sync-verify run on the SAME source got lucky. 16384 is well
      // within Gemini Pro's 65536 cap, and you only pay for tokens
      // actually emitted (not the cap), so the bump costs nothing
      // except removing a class of intermittent failure.
      maxOutputTokens: 16384,
    },
  };

  const PARSE_RETRY_DELAYS_MS = [3000, 6000];
  const maxParseAttempts = 1 + PARSE_RETRY_DELAYS_MS.length; // 3 total

  for (let parseAttempt = 0; parseAttempt < maxParseAttempts; parseAttempt++) {
    if (parseAttempt > 0) {
      const delay = PARSE_RETRY_DELAYS_MS[parseAttempt - 1];
      console.log(`[broll_picker] parse retry ${parseAttempt}/${PARSE_RETRY_DELAYS_MS.length} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }

    console.log(`[broll_picker] calling Gemini model=${model}, transcript=${transcript.length} sentences, library=${library.length} brolls${parseAttempt > 0 ? ` (parse retry ${parseAttempt})` : ''}`);
    const geminiResult = await callGeminiWithRetry(model, apiKey, requestBody);

    if (!geminiResult.ok) {
      return { ok: false, kind: 'upstream', status: geminiResult.status, body: geminiResult.body };
    }

    const text = geminiResult.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return { ok: false, kind: 'empty', rawResponse: JSON.stringify(geminiResult.data).slice(0, 1000) };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      if (parseAttempt < PARSE_RETRY_DELAYS_MS.length) {
        console.warn(`[broll_picker] JSON parse failed (attempt ${parseAttempt + 1}/${maxParseAttempts}): ${err.message} — will retry`);
        continue;
      }
      return { ok: false, kind: 'parse', error: err.message, rawText: text.slice(0, 1000) };
    }
    if (!Array.isArray(parsed.insertions)) {
      return { ok: false, kind: 'shape', message: "Gemini response missing 'insertions' array", rawText: text.slice(0, 1000) };
    }

    console.log(`[broll_picker] success: model=${model}, returned ${parsed.insertions.length} insertions`);
    return { ok: true, insertions: parsed.insertions, model };
  }
}
