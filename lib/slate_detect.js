/**
 * lib/slate_detect.js
 *
 * Detects "slate" / meta-talk at the start of a video — the announcer-style
 * intro where the speaker says things like:
 *   "Hi, this is Justine, video 3, March 14, special needs trust funnel."
 *   "Title: Why Next Month Becomes Next Year. Selected option A."
 *
 * Returns a SlateMetadata { start: 0, end, transcribedText, identifier } when a
 * slate is detected. Returns null when the speaker dives straight into content.
 *
 * AI does the semantic judgment ("is this slate or content?"). The result is a
 * deterministic contract field the orchestrator trims by.
 *
 * Ported from creative-engine/lib/hyperframes/slate_detect.ts (PR #112) so the
 * M2 clean-mode pipeline gains the same LLM-based slate detection that the
 * production motion-graphics path uses. Replaces the prior pattern-matching
 * detector in lib/cut_detection.js (`findSlateIntro`) which missed phrases
 * like Phil's "Selected Option A" because option_take needed to appear in the
 * first sentence-bounded window — the LLM has no such limitation.
 */

import { fetchGeminiWithRetry } from './gemini_helpers.js';

// 2026-05-08 audit: Shannon's "Gemini Pro only on clean-mode AI decisions"
// directive applies here — slate detection is a clean-mode pipeline AI step,
// not an internal/diagnostic call. Bumped from gemini-2.5-flash to
// gemini-3.1-pro-preview to match the broll_picker + stock_keyword_gen models.
// Trade-off: Pro adds ~3-10s latency per call vs Flash and ~5-10x cost (still
// trivial in absolute terms — fractions of a cent per video). Quality bump on
// semantic judgments like multi-part slate intros is the offset.
//
// Lock-in: test/clean_mode_models_lock.test.js asserts this string is present
// and that no `gemini-*-flash` value drifts back into clean-mode AI files.
const GEMINI_TEXT_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent`;

const PROMPT = `You analyze the first ~30 seconds of a video's word-level transcript and decide if the speaker is doing a SLATE / META-INTRO before delivering content.

A SLATE is when the speaker is announcing identifying information — NOT delivering content. Examples:
  • "Hi this is Justine, video 3, March 14"
  • "Okay, recording for the special-needs-trust funnel, take 2"
  • "This is reel number 7 for Joburn Jewelry"
  • A short date/option marker like "April 18 option A.", "May 3 take 2", "April 13–19 Saturday talking head".
    These are studio-style takes labels — the speaker is naming the file/take, not opening the video.
  • A short title-only marker like "Tech stack basics — option B."

NOT slates (these are content):
  • A direct hook like "The truth about your family's care plan is..."
  • A question to the audience — including rhetorical questions like "If not now, when?"
  • A statement about the topic (e.g. "Thinking about planning versus deciding to plan.")
  • The speaker explicitly addressing the audience ("Hey founders," "Let me tell you...")

Return strict JSON:
{
  "isSlate": boolean,
  "slateEndSeconds": number | null,        // when content actually starts (0 if no slate)
  "transcribedText": string,                // verbatim slate text, or "" if no slate
  "identifier": string | null               // editor-facing label like "Justine - video 3 - March 14 - special needs trust", or null
}

If isSlate is false, slateEndSeconds must be 0, transcribedText "", identifier null.

CRITICAL — multi-part slates (PR #114): Many speakers do a multi-part slate readout in a single intro, e.g. "Monday April 27. Title: Why Next Month Becomes Next Year. Selected Option A." That is ONE slate spanning multiple sentences, not three sentences with content in between. slateEndSeconds MUST be the moment the speaker stops doing slate-style metadata and starts the actual content of the video — even if that means cutting after several sentences of slate. Do NOT stop at the first marker (e.g., the date) and leave subsequent slate content (title/option/take) un-cut.

HOWEVER — content hooks between meta markers must be PRESERVED:
Sometimes a real content hook appears between meta markers. Examples:
  • "Saturday, May 23. If not now, when? Selected option. Finding the right..."
    → "Saturday, May 23." = slate (date). "If not now, when?" = REAL CONTENT (rhetorical hook — PRESERVE IT). "Selected option." = post-hook meta (ignore here).
    → The slate ends after "May 23." — set slateEndSeconds to the end of the date sentence, NOT past the hook.
  • "Monday, May 18. Thinking about planning versus deciding to plan. And so..."
    → "Monday, May 18." = slate (date). "Thinking about planning..." = CONTENT (topic opener — PRESERVE IT).
    → The slate ends after "May 18."

The key distinction: meta markers have explicit labels (dates, "Title:", "Selected option", "Take 2", "Option A", "video N"). Content has topical substance — questions to the audience, statements about a subject, rhetorical hooks. If a sentence between meta markers does NOT contain a recognisable meta label, it is content and the slate ends BEFORE it.

Slates are typically 1–15 seconds; multi-part slates can run up to ~18 seconds. Never exceed 20 seconds. Cut at the natural sentence/breath boundary RIGHT BEFORE content actually begins (usually the period after the LAST meta marker that appears before the first content sentence).

Transcript (first 30s):
{{TRANSCRIPT}}`;

const TRANSCRIPT_CUTOFF_MS = 30_000;

// ── Post-hoc hook validator ───────────────────────────────────────────
// Deterministic safety net: if Gemini bundles a content hook (rhetorical
// question, topic opener) into the slate, shorten slateEndSeconds so the
// hook is preserved. Catches the interleaved pattern where meta markers
// appear on both sides of a real hook.
//
// Meta-marker patterns — sentences matching ANY of these are slate:
const META_MARKER_PATTERNS = [
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d+/i,
  /\b\d{1,2}\/\d{1,2}\b/,
  /\b(option|take)\s+[a-z\d]/i,
  /\bselected\s+(option|take)/i,
  /\b(video|reel)\s+(number\s+)?\d+/i,
  /\b(day|week)\s+\d+\b/i,
  /\btitle\s*:/i,
  /\b(recording\s+for|this\s+is\s+(reel|video|take))/i,
  /\b(talking\s+head|b-?roll)\b/i,
  // PR-AK additions: "Final version." / "Final cut" / "Version N"
  /\b(final|first|second|third|fourth|alternate)\s+(version|cut|take|pass)\b/i,
  /\bversion\s+\d+\b/i,
  // PR-AM additions: Deepgram on Phil's "Selected option, Final version"
  // intro keeps mis-transcribing variations Chelsea heard verbatim:
  //   - "selective options"      — likely Phil rushing "selected options"
  //   - "final revise version"   — "final revised version" mis-spaced
  //   - "final revised version"  — Phil's actual wording on some takes
  // The patterns below absorb the variation rather than chasing each
  // Deepgram spelling.
  /\bselective\s+options?\b/i,
  /\bfinal\s+(revise|revised|revision)\s+version\b/i,
  /\bfinal\s+\w{3,15}\s+version\b/i,
];

function isMetaMarker(sentence) {
  return META_MARKER_PATTERNS.some((re) => re.test(sentence));
}

/**
 * Heuristic: does this sentence look like a content hook rather than a
 * meta marker?
 *
 * Two strong signals:
 *   1. Rhetorical questions (ending in "?") — almost always content.
 *   2. Non-meta sentences ≥ 4 words — topical statements, not labels.
 */
function isContentHook(sentence) {
  const trimmed = sentence.trim();
  if (!trimmed) return false;

  // Questions are content unless they look like a slate marker ("Take 2?")
  if (/\?$/.test(trimmed)) {
    if (/\b(option|take|video|reel)\s+[\dA-Za-z]\s*\?$/i.test(trimmed)) return false;
    return true;
  }

  // Non-meta sentences with ≥ 4 real words are likely content openers
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount >= 4 && !isMetaMarker(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Post-hoc validator: if Gemini classified a content hook as part of the
 * slate, shorten slateEndSeconds to the start of that hook.
 *
 * @param {{isSlate: boolean, slateEndSeconds: number|null, transcribedText: string, identifier: string|null}} parsed
 * @param {Array<{word: string, start_ms: number, end_ms: number}>} words
 * @returns {typeof parsed}  possibly adjusted
 */
export function validateSlatePreservesHooks(parsed, words) {
  if (!parsed.isSlate || !parsed.slateEndSeconds || parsed.slateEndSeconds <= 0) {
    return parsed;
  }
  if (!Array.isArray(words) || words.length === 0) return parsed;

  const slateEndMs = parsed.slateEndSeconds * 1000;

  // Collect words inside the slate window
  const slateWords = words.filter((w) => w.start_ms < slateEndMs);
  if (slateWords.length === 0) return parsed;

  // Split into sentences at sentence-ending punctuation
  const sentences = [];
  let current = [];
  for (const w of slateWords) {
    current.push(w);
    if (/[.!?]$/.test(w.word)) {
      const text = current.map((cw) => cw.word).join(' ');
      sentences.push({
        text,
        startMs: current[0].start_ms,
        endMs: current[current.length - 1].end_ms,
      });
      current = [];
    }
  }
  // Trailing fragment (no terminal punctuation)
  if (current.length > 0) {
    const text = current.map((cw) => cw.word).join(' ');
    sentences.push({
      text,
      startMs: current[0].start_ms,
      endMs: current[current.length - 1].end_ms,
    });
  }

  // Find the first sentence that's a content hook. A hook is only
  // "real" if it's NOT followed by a meta-marker — otherwise it's a
  // title readout that happens to end in "?" (Phil's convention:
  // "Saturday, May 23. If not now, when? Selected option.").
  for (let idx = 0; idx < sentences.length; idx++) {
    const sentence = sentences[idx];
    if (isContentHook(sentence.text)) {
      // Check if the NEXT sentence is a meta-marker. If so, the "hook"
      // is really a title readout sandwiched between slate elements —
      // treat it as slate and keep scanning.
      const nextSentence = sentences[idx + 1];
      if (nextSentence && isMetaMarker(nextSentence.text)) {
        console.log(
          `[slate_detect] hook-validator: "${sentence.text}" looks like a hook ` +
            `but is followed by meta-marker "${nextSentence.text}" — treating as title readout, not content`,
        );
        continue; // skip this "hook", keep scanning
      }

      const newEndSec = sentence.startMs / 1000;
      if (newEndSec > 0) {
        // Rebuild transcribed_text from only the real slate words
        const trimmedText = slateWords
          .filter((w) => w.end_ms <= sentence.startMs)
          .map((w) => w.word)
          .join(' ');
        console.log(
          `[slate_detect] hook-validator: shortened slate ` +
            `${parsed.slateEndSeconds.toFixed(2)}s → ${newEndSec.toFixed(2)}s — ` +
            `preserved hook: "${sentence.text}"`,
        );
        return {
          ...parsed,
          slateEndSeconds: newEndSec,
          transcribedText: trimmedText,
        };
      }
    }
  }

  return parsed;
}

/**
 * PR-AK: extend Gemini's slateEndSeconds when a meta-marker sentence
 * appears AFTER it in the first 20s of the transcript. Catches the
 * case where Gemini cut the date marker but missed a follow-on
 * "Selected option." or "Final version." that should also be slate.
 *
 * Specifically for Phil's convention:
 *   "Saturday, May 23. [...] Selected option. Finding..."
 *                       ↑ Gemini ends here
 *                                            ↑ but this is slate too
 *
 * Algorithm:
 *   1. Split the first 20s of words into sentences (at .!?).
 *   2. Walk forward from the current slateEndSeconds.
 *   3. For each sentence that ENDS within 20s of source-time AND
 *      isMetaMarker() matches: extend slateEndSeconds to that
 *      sentence's end. Keep walking — there may be multiple stacked
 *      meta sentences.
 *   4. Stop at the first non-meta sentence (real content) or after
 *      20s — whichever comes first.
 *
 * Returns the parsed object with possibly-extended slateEndSeconds.
 * Never shortens.
 *
 * @param {{isSlate:boolean, slateEndSeconds:number, transcribedText:string, identifier:string|null}} parsed
 * @param {Array<{word: string, start_ms: number, end_ms: number}>} words
 */
export function extendSlateForLateMetaMarkers(parsed, words) {
  if (!parsed.isSlate || !parsed.slateEndSeconds || parsed.slateEndSeconds <= 0) {
    return parsed;
  }
  if (!Array.isArray(words) || words.length === 0) return parsed;

  // Build sentences from words within 20s (the hard slate cap).
  const earlyWords = words.filter((w) => w.end_ms <= 20_000);
  if (earlyWords.length === 0) return parsed;

  const sentences = [];
  let buf = [];
  for (const w of earlyWords) {
    buf.push(w);
    if (/[.!?]$/.test(w.word)) {
      sentences.push({
        text: buf.map((cw) => cw.word).join(' '),
        startMs: buf[0].start_ms,
        endMs: buf[buf.length - 1].end_ms,
      });
      buf = [];
    }
  }
  if (buf.length > 0) {
    sentences.push({
      text: buf.map((cw) => cw.word).join(' '),
      startMs: buf[0].start_ms,
      endMs: buf[buf.length - 1].end_ms,
    });
  }

  const currentEndMs = parsed.slateEndSeconds * 1000;
  let extendedEndMs = currentEndMs;
  const extensions = [];

  for (const sentence of sentences) {
    // Only consider sentences that START after the current slate end.
    if (sentence.startMs < currentEndMs - 100) continue;

    if (isMetaMarker(sentence.text)) {
      extendedEndMs = Math.max(extendedEndMs, sentence.endMs);
      extensions.push({ text: sentence.text, endSec: sentence.endMs / 1000 });
      continue;
    }
    // First non-meta sentence after slateEnd → stop. We don't keep
    // walking because content has begun.
    break;
  }

  if (extensions.length === 0) return parsed;

  const newEndSec = extendedEndMs / 1000;
  console.log(
    `[slate_detect] meta-extender: ${parsed.slateEndSeconds.toFixed(2)}s → ${newEndSec.toFixed(2)}s — ` +
      `extended past ${extensions.length} meta marker(s): ` +
      extensions.map((e) => `"${e.text.slice(0, 40)}"`).join(', '),
  );
  return {
    ...parsed,
    slateEndSeconds: newEndSec,
    transcribedText: parsed.transcribedText + ' ' + extensions.map((e) => e.text).join(' '),
  };
}

/**
 * PR-AL: deterministic slate floor. Runs INDEPENDENTLY of Gemini.
 *
 * Walks sentences from t=0 forward. As long as each sentence is a
 * meta-marker (date / "Selected option." / "Final version." / title /
 * take marker), advance the slate end past it. Stop at the first
 * non-meta sentence — that's content. Return null if the FIRST
 * sentence is already content (no slate to cut).
 *
 * Used to compute a guaranteed slate floor regardless of what Gemini
 * decides. detectSlate takes max(geminiEnd, deterministicEnd) so the
 * intro always gets cut when the transcript starts with markers.
 *
 * Chelsea's 2026-05-21 escalation: PR-AK's extender only walks forward
 * from Gemini's slateEndSeconds, so if Gemini returns end=0 or a small
 * value, the meta sentences after it leak. PR-AL doesn't have that
 * dependency — it ALWAYS scans from t=0.
 *
 * @param {Array<{word: string, start_ms: number, end_ms: number}>} words
 * @returns {{endSec: number, sentences: string[]} | null}
 */
export function detectDeterministicSlateFloor(words) {
  if (!Array.isArray(words) || words.length === 0) return null;
  const earlyWords = words.filter((w) => w.end_ms <= 20_000);
  if (earlyWords.length === 0) return null;

  // Split into sentences.
  const sentences = [];
  let buf = [];
  for (const w of earlyWords) {
    buf.push(w);
    if (/[.!?]$/.test(w.word)) {
      sentences.push({
        text: buf.map((cw) => cw.word).join(' '),
        startMs: buf[0].start_ms,
        endMs: buf[buf.length - 1].end_ms,
      });
      buf = [];
    }
  }
  if (buf.length > 0) {
    sentences.push({
      text: buf.map((cw) => cw.word).join(' '),
      startMs: buf[0].start_ms,
      endMs: buf[buf.length - 1].end_ms,
    });
  }

  if (sentences.length === 0) return null;

  // PR-AM: LOOK-AHEAD floor. Earlier PR-AL stopped at the first non-meta
  // sentence, but Phil's actual transcript is:
  //   "What your future self would choose, selective options final revise version"
  // (title FIRST, then meta markers). PR-AL stopped at the title and cut
  // nothing. Now we scan the ENTIRE 20s window, find the LAST meta-marker
  // sentence, and cut from t=0 through its end — pulling title sentences
  // along with the markers. Safe because:
  //   1. The 20s cap bounds the scan
  //   2. Real content sentences rarely contain meta-marker phrases in
  //      the first 20s (date/option/selective/final-version are highly
  //      specific)
  //   3. The output is then snapped to next word boundary downstream
  let lastMetaIdx = -1;
  const matched = [];
  for (let i = 0; i < sentences.length; i++) {
    if (isMetaMarker(sentences[i].text)) {
      lastMetaIdx = i;
      matched.push(sentences[i].text);
    }
  }

  if (lastMetaIdx < 0) return null;

  // Cut everything up through the end of the LAST meta-marker sentence.
  // This pulls along any non-meta sentences (titles, "what we'll talk
  // about" preambles) that appear BEFORE the last marker.
  const endMs = sentences[lastMetaIdx].endMs;
  // Also collect the non-meta sentences sandwiched between markers for
  // the audit log — useful when investigating "what got cut".
  const inSlateWindow = sentences.slice(0, lastMetaIdx + 1).map((s) => s.text);
  return { endSec: endMs / 1000, sentences: inSlateWindow, matchedMarkers: matched };
}

function buildTranscriptText(words, cutoffMs) {
  return words
    .filter((w) => w.start_ms < cutoffMs)
    .map((w) => `[${(w.start_ms / 1000).toFixed(2)}s] ${w.word}`)
    .join(' ');
}

/**
 * Snap an LLM-emitted slate end timestamp to the next clean word boundary.
 *
 * The LLM returns a fractional second like 9.04s based on its read of the
 * transcript, but Deepgram's word boundaries don't always align with that
 * estimate. On B10 (m2-e2e-018-enablesnp, 2026-05-08) Phil's slate ended
 * at 9.04s per the LLM, but the actual word "A" from "Option A" extended
 * past 9.04s — so the cut [0, 9.04] left the "A" sound at the start of
 * the final video.
 *
 * Fix (PR #114): take the LLM end and find the FIRST word in the transcript
 * that starts STRICTLY AFTER `llmEndSec + safetyPadSec`. Use that word's
 * start as the actual cut end. This guarantees:
 *   1. No partial word from the slate leaks into the final output, AND
 *   2. The cut starts the final video right at the next real word
 *      (any silence between the slate end and the next word is also
 *      removed — desirable for a clean intro).
 *
 * If no word starts after the LLM end (LLM end is past all words), return
 * the LLM end unchanged — there's nothing to snap to.
 *
 * @param {number} llmEndSec       slate end in source-time seconds (LLM output)
 * @param {Array<{start_ms: number}>} words  full Deepgram word_timestamps
 * @param {number} [safetyPadSec=0.05]  small grace period so a word whose
 *   start is essentially at the LLM end (e.g., LLM said 9.04, word starts at
 *   9.05) still gets caught and the cut extends past it
 * @returns {number}  the snapped cut end (source-time seconds)
 */
export function snapSlateEndToNextWord(llmEndSec, words, safetyPadSec = 0.05) {
  if (!Array.isArray(words) || words.length === 0) return llmEndSec;
  if (typeof llmEndSec !== 'number' || !Number.isFinite(llmEndSec)) return llmEndSec;
  const threshold = llmEndSec + safetyPadSec;
  // Words are chronological so a linear scan stops at the first hit; no need
  // to sort. Use start_ms (Deepgram's authoritative timing) and convert to s.
  for (const w of words) {
    if (typeof w?.start_ms !== 'number') continue;
    const startSec = w.start_ms / 1000;
    if (startSec > threshold) {
      return startSec;
    }
  }
  return llmEndSec;
}

/**
 * Run Gemini-based slate detection on the first ~30s of a transcript.
 *
 * @param {Object} input
 * @param {Array<{word: string, start_ms: number, end_ms: number}>} input.wordTimestamps
 * @param {number} input.sourceDuration  source-time seconds (used to clamp the slate window)
 * @param {Object} [opts]
 * @param {string} [opts.apiKey]                 defaults to process.env.GEMINI_API_KEY
 * @param {typeof fetchGeminiWithRetry} [opts.fetchImpl]  inject for tests
 * @returns {Promise<{start: number, end: number, transcribed_text: string, identifier: string|null}|null>}
 */
export async function detectSlate(input, opts = {}) {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  if (!input?.wordTimestamps || input.wordTimestamps.length === 0) {
    return null;
  }

  const transcript = buildTranscriptText(input.wordTimestamps, TRANSCRIPT_CUTOFF_MS);
  if (!transcript.trim()) return null;

  const prompt = PROMPT.replace('{{TRANSCRIPT}}', transcript);

  const fetcher = opts.fetchImpl ?? fetchGeminiWithRetry;
  const res = await fetcher(`${GEMINI_API}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    }),
  }, 'slate_detect');

  if (!res.ok) {
    throw new Error(`slate_detect: Gemini API error ${res.status} — ${await res.text()}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('slate_detect: empty Gemini response');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`slate_detect: invalid JSON response — ${err.message}\n${text}`);
  }

  // PR-AL (2026-05-21): deterministic slate floor. If the transcript
  // starts with meta-marker sentences (date / "Selected option" /
  // "Final version" / title / take), guarantee we cut past all of them
  // — regardless of what Gemini decides. Belt-and-braces against
  // Gemini under-cutting (which it kept doing on Chelsea's reels).
  const deterministicFloor = detectDeterministicSlateFloor(input.wordTimestamps);
  if (deterministicFloor) {
    const matched = deterministicFloor.matchedMarkers ?? [];
    console.log(
      `[slate_detect] deterministic-floor: ${deterministicFloor.endSec.toFixed(2)}s — ` +
        `cut window covers ${deterministicFloor.sentences.length} sentence(s) ending at ` +
        `last meta marker (matched ${matched.length}): ` +
        matched.map((s) => `"${s.slice(0, 40)}"`).join(', '),
    );
  }

  // If Gemini said no slate but deterministic found one, USE the
  // deterministic value. Pretend Gemini returned isSlate:true at the
  // deterministic end so downstream code (extender + snap + cap) runs
  // uniformly.
  if ((!parsed.isSlate || parsed.slateEndSeconds == null || parsed.slateEndSeconds <= 0)) {
    if (!deterministicFloor) return null;
    parsed = {
      isSlate: true,
      slateEndSeconds: deterministicFloor.endSec,
      transcribedText: deterministicFloor.sentences.join(' '),
      identifier: 'deterministic_floor',
    };
  } else if (deterministicFloor && deterministicFloor.endSec > parsed.slateEndSeconds) {
    // Both fired, deterministic cut more — take the larger.
    console.log(
      `[slate_detect] deterministic-floor wins: gemini=${parsed.slateEndSeconds.toFixed(2)}s → ${deterministicFloor.endSec.toFixed(2)}s`,
    );
    parsed = {
      ...parsed,
      slateEndSeconds: deterministicFloor.endSec,
      transcribedText: deterministicFloor.sentences.join(' '),
    };
  }

  // PR-AJ (2026-05-19): hook-validator DISABLED. See header comment.
  void validateSlatePreservesHooks; // export retained for tests / future use

  // PR-AK (2026-05-20): post-Gemini slate-extender guard.
  //
  // Gemini sometimes under-cuts when Phil's "Selected option." or
  // "Final version." appears in a slightly unusual position (e.g., mid-
  // breath, broken sentence boundary). Chelsea flagged this on the
  // 2026-05 batch: "Phil saying the title AND then 'Final version'
  // before the script." The fix: deterministically scan the first 20s
  // of the transcript for known meta-markers, and if any appear AFTER
  // Gemini's slateEndSeconds, extend the slate to the end of that
  // marker sentence (then snap to next word boundary as usual).
  //
  // This is the OPPOSITE direction of the PR-AH validator: we EXTEND
  // when Gemini under-cuts, rather than SHORTEN when Gemini over-cuts.
  // Under-cutting is the failure mode operators actually complained
  // about; over-cutting wasn't observed on this client.
  parsed = extendSlateForLateMetaMarkers(parsed, input.wordTimestamps);

  // Hard cap at 20s + within source duration
  const end = Math.min(
    parsed.slateEndSeconds,
    20,
    Math.max(0, (input.sourceDuration ?? Infinity) - 1),
  );
  if (end <= 0) return null;

  return {
    start: 0,
    end,
    transcribed_text: parsed.transcribedText ?? '',
    identifier: parsed.identifier ?? null,
  };
}
