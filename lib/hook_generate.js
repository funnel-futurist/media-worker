/**
 * lib/hook_generate.js
 *
 * Gemini Pro call that generates the intro hook text for the 5-second
 * title card prepended to a clean-mode reel (PR-L, 2026-05-13).
 *
 * Contract:
 *   - Input: full transcript string + optional clientName + introMaxWords (default 8).
 *   - Output: { ok: true, hookText: string } on success.
 *           { ok: false, reason: '<short_code>', detail: string } on failure.
 *   - NEVER throws. The orchestrator inspects `ok` and skips the intro
 *     (logging a warn into the response's introHook diagnostic block) when
 *     the call fails, returns malformed JSON, or returns out-of-spec text.
 *
 * Why a separate file?
 *   - Keeps the Gemini call + post-hoc validation pure and testable
 *     without booting the full pipeline (same pattern as broll_picker.js).
 *   - The orchestrator can compose this with intro_card_render.js cleanly.
 *
 * Anti-fabrication rules in the prompt (per Shannon's PR-L approval +
 * Phoenix's photo-context warning):
 *   - Must be supported by transcript content
 *   - No clickbait / fake superlatives
 *   - NO relationship/identity claims (no "Phil's sister", "the parent")
 *     unless the speaker uses that exact label verbatim
 *   - No questions / how-to listicles / emojis / quotes / end punctuation
 *   - Title Case, ASCII only, max 8 words
 *
 * Post-hoc validation rejects model output that doesn't meet the spec
 * even if the JSON parses (reason: 'invalid_hook_text'). The orchestrator
 * treats that the same as a Gemini network failure — skip the intro,
 * don't ship a bad hook.
 */

import axios from 'axios';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.1-pro-preview';
const DEFAULT_INTRO_MAX_WORDS = 8;

// Per-attempt timeout. Hook generation is a tiny call (transcript in,
// 8 words out) so 60s is plenty — picker's 120s is for the much larger
// broll-selection output. With maxAttempts=2 the worst case is ~120s.
const HOOK_TIMEOUT_MS = 60_000;
const HOOK_MAX_ATTEMPTS = 2;
const NETWORK_BACKOFFS_MS = [2000, 5000];

/**
 * Build the system + user prompts. Pure function — exported so tests can
 * lock the wording without making network calls.
 *
 * @param {object} args
 * @param {string} args.transcriptText  full transcript as a single string
 * @param {string} [args.clientName]    optional, for tone calibration ONLY
 *   (the model is told NOT to mention the client by name in the hook)
 * @param {number} [args.introMaxWords=8]
 */
export function buildHookPrompts({ transcriptText, clientName, introMaxWords = DEFAULT_INTRO_MAX_WORDS }) {
  const systemPrompt = `You write 5-second video opening hooks for short-form reels. Given a speaker transcript, return a single hook line (max ${introMaxWords} words) that gets the viewer to keep watching. Return ONLY strict JSON of the form {"hookText": "..."}. No prose, no markdown, no commentary outside the JSON.`;

  const clientContext = clientName
    ? `\nClient (for tone calibration ONLY — DO NOT mention by name in the hook): ${clientName}\n`
    : '\n';

  const userPrompt = `Transcript:
"""
${transcriptText}
"""
${clientContext}
Rules:
- Must be directly supported by something the speaker actually says in the transcript. No inventing claims, numbers, or examples.
- No questions. Statements only.
- No clickbait ("You won't believe", "The shocking truth", etc.).
- No fake superlatives unless the speaker uses them verbatim.
- No "How to" / "5 ways to" / listicle openers.
- Do NOT name any person, family member, or relationship (e.g. "Phil's sister", "John's wife", "the parent") unless the speaker uses that exact identifier in the transcript. This is critical — invented relationship context is a hard fail.
- No emojis, no quote marks, no end punctuation.
- Title Case. ASCII only.
- Max ${introMaxWords} words.

Return ONLY {"hookText": "..."}.`;

  return { systemPrompt, userPrompt };
}

/**
 * Validate the model's hook text against the anti-fabrication rules.
 * Returns { ok: true } if valid, { ok: false, reason } otherwise.
 *
 * Pure function — exported for tests.
 *
 * @param {unknown} hookText
 * @param {number} [introMaxWords=8]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateHookText(hookText, introMaxWords = DEFAULT_INTRO_MAX_WORDS) {
  if (typeof hookText !== 'string') return { ok: false, reason: 'not_a_string' };
  const trimmed = hookText.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  // ASCII only — drops emoji, smart quotes, em-dashes that drawtext escapes
  // poorly anyway.
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(trimmed)) return { ok: false, reason: 'non_ascii' };
  // No quotes. The prompt forbids them; if the model includes them, reject.
  if (/['"]/.test(trimmed)) return { ok: false, reason: 'contains_quote' };
  // No end punctuation (?, !, .) — statement only.
  if (/[?!.]\s*$/.test(trimmed)) return { ok: false, reason: 'end_punctuation' };
  // No questions even mid-string.
  if (trimmed.includes('?')) return { ok: false, reason: 'contains_question' };
  // Word count cap.
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > introMaxWords) return { ok: false, reason: 'too_many_words' };
  if (words.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true };
}

/**
 * Generate a hook text via Gemini Pro. Never throws.
 *
 * @param {object} args
 * @param {string} args.transcriptText
 * @param {string} [args.clientName]
 * @param {number} [args.introMaxWords=8]
 * @param {string} [args.model='gemini-3.1-pro-preview']
 * @param {string} args.apiKey
 * @param {(systemPrompt: string, userPrompt: string) => Promise<{ ok: true, data: object } | { ok: false, status: number, body: string }>}
 *   [args.callGemini]  optional injection point for tests; if omitted we
 *   use the axios-backed default. The signature matches broll_picker's
 *   callGeminiWithRetry deliberately.
 * @returns {Promise<{ ok: true, hookText: string, model: string }
 *                  | { ok: false, reason: string, detail: string }>}
 */
export async function generateHookText({
  transcriptText,
  clientName,
  introMaxWords = DEFAULT_INTRO_MAX_WORDS,
  model = DEFAULT_MODEL,
  apiKey,
  callGemini,
}) {
  if (!apiKey && !callGemini) {
    return { ok: false, reason: 'missing_api_key', detail: 'GEMINI_API_KEY not provided' };
  }
  if (typeof transcriptText !== 'string' || transcriptText.trim().length === 0) {
    return { ok: false, reason: 'empty_transcript', detail: 'transcriptText required' };
  }

  const { systemPrompt, userPrompt } = buildHookPrompts({ transcriptText, clientName, introMaxWords });

  let resp;
  if (callGemini) {
    resp = await callGemini(systemPrompt, userPrompt);
  } else {
    resp = await defaultCallGemini({ model, apiKey, systemPrompt, userPrompt });
  }

  if (!resp.ok) {
    return {
      ok: false,
      reason: resp.status === 0 ? 'network_error' : `gemini_${resp.status}`,
      detail: typeof resp.body === 'string' ? resp.body.slice(0, 200) : String(resp.body),
    };
  }

  // Extract text. Gemini's JSON-response mode puts the model output in
  // candidates[0].content.parts[0].text as a JSON string.
  const textOut = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof textOut !== 'string') {
    return { ok: false, reason: 'no_candidate', detail: 'Gemini returned no text in candidates[0]' };
  }

  let parsed;
  try {
    parsed = JSON.parse(textOut);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_json',
      detail: `parse failed: ${err instanceof Error ? err.message : String(err)} — raw: ${textOut.slice(0, 120)}`,
    };
  }

  const hookText = parsed?.hookText;
  const valid = validateHookText(hookText, introMaxWords);
  if (!valid.ok) {
    return {
      ok: false,
      reason: 'invalid_hook_text',
      detail: `validation failed: ${valid.reason} — got: ${typeof hookText === 'string' ? hookText.slice(0, 120) : String(hookText)}`,
    };
  }

  return { ok: true, hookText: hookText.trim(), model };
}

// ── default network adapter (kept private so tests inject callGemini) ──

async function defaultCallGemini({ model, apiKey, systemPrompt, userPrompt }) {
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.7,
      maxOutputTokens: 256,
    },
  };

  for (let attempt = 0; attempt < HOOK_MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: HOOK_TIMEOUT_MS,
        validateStatus: () => true,
      });
    } catch (err) {
      if (attempt === HOOK_MAX_ATTEMPTS - 1) {
        return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
      }
      const delay = NETWORK_BACKOFFS_MS[attempt] ?? 5000;
      console.log(`[hook_generate] network error — retrying in ${delay}ms (attempt ${attempt + 2}/${HOOK_MAX_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (res.status >= 200 && res.status < 300) {
      return { ok: true, data: res.data };
    }

    // 429 or 5xx → retry; 4xx (other) → fail fast.
    if (res.status !== 429 && res.status < 500) {
      const bodyStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      return { ok: false, status: res.status, body: bodyStr };
    }

    if (attempt === HOOK_MAX_ATTEMPTS - 1) {
      const bodyStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      return { ok: false, status: res.status, body: bodyStr };
    }

    const delay = NETWORK_BACKOFFS_MS[attempt] ?? 5000;
    console.log(`[hook_generate] ${res.status} — retrying in ${delay}ms (attempt ${attempt + 2}/${HOOK_MAX_ATTEMPTS})`);
    await new Promise((r) => setTimeout(r, delay));
  }

  return { ok: false, status: 0, body: 'exhausted retries' };
}
