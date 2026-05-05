/**
 * lib/cut_detection.js
 *
 * VENDORED FROM creative-engine/lib/hyperframes/deterministic_cuts.ts.
 * KEEP IN SYNC. Updates to either side must mirror to the other until
 * this is extracted as a shared package.
 *
 * Pure-function editorial cut detector. JS port of the TS source — same
 * algorithm 1:1, no behavior changes, no type runtime checks. Unit-test
 * parity is verified in test/cut_detection.test.js against the same
 * fixtures the TS test suite uses.
 *
 * Three categories:
 *   1. SILENCE     — gap >= minGapSec (default 0.6s); plus leading/trailing.
 *   2. REPEAT_WORD — adjacent identical words within maxRepeatGap (0.5s).
 *   3. FILLER      — exact-match against fillerWords (default um/uh/etc).
 * Plus BAD_TAKE markers ("wait", "let me start over", etc) and silent
 * restart n-gram detection.
 *
 * Output: { start, end, reason, category, safety, safetyReason,
 *           contextBefore, contextAfter } in source-time seconds.
 */

/**
 * @typedef {{ word: string, start_ms: number, end_ms: number }} WordTimestamp
 *
 * @typedef {'safe' | 'soft' | 'risky'} CutSafety
 *
 * @typedef {'safe_only' | 'safe_and_soft' | 'all'} CutSafetyMode
 *
 * @typedef {Object} DeterministicCut
 * @property {number} start
 * @property {number} end
 * @property {string} reason
 * @property {'silence' | 'repeat_word' | 'filler' | 'bad_take'} category
 * @property {CutSafety} [safety]
 * @property {string} [safetyReason]
 * @property {string} [contextBefore]
 * @property {string} [contextAfter]
 *
 * @typedef {Object} CutDetectionResult
 * @property {DeterministicCut[]} applied
 * @property {DeterministicCut[]} skipped
 * @property {DeterministicCut[]} all
 *
 * @typedef {Object} DetectCutsOptions
 * @property {number} [startAfterSec]
 * @property {number} [sourceDuration]
 * @property {number} [minGapSec]
 * @property {number} [retainSec]
 * @property {Array<{ start: number, end: number }>} [externalSilences]
 * @property {boolean} [enableRepeatedWords]
 * @property {number} [maxRepeatGap]
 * @property {boolean} [enableFillers]
 * @property {string[]} [fillerWords]
 * @property {boolean} [enableBadTakes]
 * @property {string[]} [badTakeMarkers]
 * @property {number} [maxCutFraction]
 * @property {number} [minCutDurationSec]
 * @property {number} [maxSingleCutSec]
 * @property {boolean} [preserveEmphasisPauses]
 * @property {number} [preservePostSentenceSec]
 * @property {number} [preservePostCommaSec]
 * @property {number} [preservePrePunchlineSec]
 * @property {boolean} [enableSilentRestartDetection]
 * @property {CutSafetyMode} [cutSafetyMode]
 * @property {number} [cutMidSentenceLongerThan]
 * @property {boolean} [detectSlateFromTranscript]
 * @property {number} [cutBeyondLastWordPadSec]
 * @property {boolean} [relaxClampForGhostWords]
 *   PR #105: when true (and `externalSilences` is also provided), the
 *   word-boundary clamp ignores Scribe "ghost words" — long word entries
 *   whose timing mostly overlaps an ffmpeg silencedetect span. These are
 *   transcription artifacts (a single word reported with a 2–3s duration
 *   that drifts deep into a real silence) which would otherwise pull the
 *   cut.end backward through the silence and undo PR #102's adjacent-
 *   silence merge. Default false to preserve the existing 48-test parity
 *   suite. Enabled only by the clean-mode orchestrator.
 */

// ── 200 most common English words (vendored from common_words.ts) ──────
const COMMON_WORDS_200 = new Set([
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
  'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
  'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she',
  'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
  'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me',
  'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
  'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other',
  'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also',
  'back', 'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way',
  'even', 'new', 'want', 'because', 'any', 'these', 'give', 'day', 'most', 'us',
  'is', 'was', 'are', 'were', 'been', 'being', 'has', 'had', 'does', 'did',
  'doing', 'done', 'gets', 'got', 'gotten', 'getting', 'goes', 'going', 'gone',
  'went', 'said', 'says', 'making', 'made', 'makes', 'taking', 'took', 'taken',
  'takes', 'thinking', 'thought', 'thinks', 'looking', 'looked', 'looks',
  'using', 'used', 'uses', 'wanting', 'wanted', 'wants', 'giving', 'gave',
  'given', 'gives', 'seeing', 'saw', 'seen', 'sees', 'coming',
  'came', 'comes', 'know', 'knew', 'known', 'knows', 'thing', 'things',
  'something', 'anything', 'nothing', 'everything', 'someone', 'anyone',
  'everyone', 'no-one', 'where', 'why', 'while', 'because', 'though',
  'although', 'really', 'very', 'much', 'many', 'lot', 'lots', 'okay',
  'yeah', 'yes', 'right', 'left', 'pretty', 'kind', 'sort', 'bit', 'little',
  'big', 'small', 'such', 'same', 'different', 'sure', 'maybe', 'probably',
  'actually', 'literally', 'basically',
]);

function isCommonWord(rawWord) {
  const norm = rawWord.toLowerCase().replace(/[^a-z']/g, '');
  if (!norm) return true;
  return COMMON_WORDS_200.has(norm);
}

// Default thresholds for the silence-ghost-word detector (PR #105).
// Both validated against Justine's 1:11–1:13 source-time fixture, where
// Scribe reported "The" as a single 2.71s word (87.24 → 89.95) that lies
// 90% inside ffmpeg silencedetect span [87.31, 89.75]. Setting either
// threshold lower would risk pulling normal short pauses into ghost
// territory; higher would miss the fixture case entirely.
const GHOST_WORD_MIN_DURATION_SEC = 0.8;
const GHOST_WORD_MIN_OVERLAP_RATIO = 0.7;

/**
 * Decide whether a Scribe word is a "silence ghost" — i.e., a long word
 * entry whose timing mostly drifts into an ffmpeg silencedetect span. These
 * are transcription artifacts: Scribe sometimes reports a short utterance
 * (e.g. "The") with a 2–3s duration that bleeds into a true silence span.
 * The word-boundary clamp would treat such a word as real speech and pull
 * the cut.end backward through the silence, undoing PR #102's adjacent-
 * silence merge.
 *
 * Returns true when:
 *   - word duration ≥ GHOST_WORD_MIN_DURATION_SEC (0.8s; normal speech words
 *     are well under this), AND
 *   - ≥ GHOST_WORD_MIN_OVERLAP_RATIO (70%) of the word's duration falls
 *     inside any of the provided externalSilences spans.
 *
 * Both thresholds validated against the Justine 1:11–1:13 fixture (Scribe
 * "The" word at [87.24, 89.95] = 2.71s, with 90% overlap into silencedetect
 * span [87.31, 89.75]).
 *
 * @param {{ start_ms: number, end_ms: number, word: string }} w
 * @param {Array<{ start: number, end: number }>} externalSilences  in seconds
 * @returns {boolean}
 */
export function isSilenceGhostWord(w, externalSilences) {
  if (!externalSilences || externalSilences.length === 0) return false;
  const wStart = w.start_ms / 1000;
  const wEnd = w.end_ms / 1000;
  const wDur = wEnd - wStart;
  if (wDur < GHOST_WORD_MIN_DURATION_SEC) return false;
  let overlap = 0;
  for (const s of externalSilences) {
    const ovStart = Math.max(wStart, s.start);
    const ovEnd = Math.min(wEnd, s.end);
    if (ovEnd > ovStart) overlap += ovEnd - ovStart;
  }
  return overlap / wDur >= GHOST_WORD_MIN_OVERLAP_RATIO;
}

const DEFAULT_FILLERS = ['um', 'uh', 'uhm', 'umm', 'hmm'];

const DEFAULT_BAD_TAKE_MARKERS = [
  'wait',
  'hold on',
  'let me start over',
  'let me restart',
  'let me try again',
  'scratch that',
  'start over',
  'actually scratch',
  'nope',
];

function normalizeWord(w) {
  return w.toLowerCase().replace(/[^\w]/g, '');
}

const STRONG_DEPENDENT_TRAILING_WORDS = new Set([
  'to',
  'the', 'a', 'an',
  'of', 'in', 'on', 'at', 'with', 'for', 'from', 'by', 'about', 'into', 'over',
  'under', 'between', 'through', 'after', 'before',
]);

const DEPENDENT_TRAILING_WORDS = new Set([
  ...STRONG_DEPENDENT_TRAILING_WORDS,
  'and', 'or', 'but', 'so', 'because', 'although', 'while', 'if', 'when',
  'then', 'that', 'which', 'who', 'whose', 'whom', 'where', 'whether', 'as',
  'this', 'these', 'those',
  'is', 'was', 'are', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  'i', 'you', 'he', 'she', 'we', 'they', 'it',
]);

const CONTINUATION_START_WORDS = new Set([
  'and', 'or', 'but', 'so', 'because', 'although', 'while', 'if', 'when',
  'then', 'that', 'which', 'as',
]);

// ── Slate-intro signal patterns ─────────────────────────────────────────
const SLATE_SIGNALS = [
  { name: 'date_month_day', re: /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d+/i },
  { name: 'date_slash', re: /\b\d+\/\d+\b/ },
  { name: 'option_take', re: /\b(option|take)\s+[a-z\d]\b/i },
  { name: 'video_n', re: /\bvideo\s+\d+/i },
  { name: 'day_week_n', re: /\b(day|week)\s+\d+\b/i },
];

const SLATE_REAL_SPEECH_MARKERS = new Set([
  'i', 'we', 'you', 'he', 'she', 'they', 'it',
  'and', 'but', 'because', 'so', 'when', 'while', 'if', 'although',
]);

function findSlateIntro(words) {
  if (words.length === 0) return null;

  const maxIdx = Math.min(20, words.length);
  let endIdx = -1;
  for (let i = 0; i < maxIdx; i++) {
    const w = words[i];
    if (/[.!?]$/.test(w.word)) {
      endIdx = i;
      break;
    }
    if (i > 0) {
      const gap = (w.start_ms - words[i - 1].end_ms) / 1000;
      if (gap >= 1.5) {
        endIdx = i - 1;
        break;
      }
    }
  }
  if (endIdx === -1) return null;

  const sentenceWords = words.slice(0, endIdx + 1);
  const sentenceText = sentenceWords.map((w) => w.word).join(' ');
  const wordCount = sentenceWords.length;

  const matchedSignals = [];
  for (const sig of SLATE_SIGNALS) {
    if (sig.re.test(sentenceText)) matchedSignals.push(sig.name);
  }
  if (matchedSignals.length === 0) return null;

  if (matchedSignals.length >= 2) {
    return {
      endTimeSec: sentenceWords[sentenceWords.length - 1].end_ms / 1000,
      signals: matchedSignals,
      reason: 'multi_signal',
    };
  }

  if (wordCount <= 8) {
    const hasRealSpeechMarker = sentenceWords.some((w) =>
      SLATE_REAL_SPEECH_MARKERS.has(normalizeWord(w.word)),
    );
    if (!hasRealSpeechMarker) {
      return {
        endTimeSec: sentenceWords[sentenceWords.length - 1].end_ms / 1000,
        signals: matchedSignals,
        reason: 'short_editor_phrase',
      };
    }
  }

  return null;
}

export function totalDeterministicCutSeconds(cuts) {
  return cuts.reduce((sum, c) => sum + (c.end - c.start), 0);
}

export function detectDeterministicCuts(words, options = {}) {
  const startAfter = options.startAfterSec ?? 0;
  const sourceDuration = options.sourceDuration ?? null;
  const minGap = options.minGapSec ?? 0.6;
  const retain = options.retainSec ?? 0.15;
  const externalSilences = options.externalSilences ?? null;
  const enableRepeated = options.enableRepeatedWords ?? true;
  const maxRepeatGap = options.maxRepeatGap ?? 0.5;
  const enableFillers = options.enableFillers ?? true;
  const fillerSet = new Set(
    (options.fillerWords ?? DEFAULT_FILLERS).map((w) => w.toLowerCase()),
  );
  const enableBadTakes = options.enableBadTakes ?? true;
  const badTakeMarkers = (options.badTakeMarkers ?? DEFAULT_BAD_TAKE_MARKERS)
    .map((m) => m.toLowerCase().split(/\s+/).map(normalizeWord).filter(Boolean));
  const maxCutFraction = options.maxCutFraction ?? 0.4;
  const minCutDur = options.minCutDurationSec ?? 0.2;
  const maxSingleCut = options.maxSingleCutSec ?? 4.0;
  const preserveEmphasis = options.preserveEmphasisPauses ?? false;
  const preservePostSentence = options.preservePostSentenceSec ?? 0.5;
  const preservePostComma = options.preservePostCommaSec ?? 0.3;
  const preservePrePunchline = options.preservePrePunchlineSec ?? 0.4;
  const enableSilentRestart = options.enableSilentRestartDetection ?? false;
  const relaxClampForGhostWords = options.relaxClampForGhostWords ?? false;

  if (!words || words.length === 0) return [];

  const cuts = [];

  // ── 1. Filler cuts ──
  if (enableFillers) {
    for (const w of words) {
      const startSec = w.start_ms / 1000;
      const endSec = w.end_ms / 1000;
      if (startSec < startAfter) continue;
      if (endSec - startSec < minCutDur) continue;
      const norm = normalizeWord(w.word);
      if (!fillerSet.has(norm)) continue;
      cuts.push({
        start: startSec,
        end: endSec,
        reason: `filler: ${norm}`,
        category: 'filler',
      });
    }
  }

  // ── 2. Repeated word cuts ──
  if (enableRepeated) {
    for (let i = 0; i < words.length - 1; i++) {
      const wA = words[i];
      const wB = words[i + 1];
      const startSec = wA.start_ms / 1000;
      if (startSec < startAfter) continue;
      const a = normalizeWord(wA.word);
      const b = normalizeWord(wB.word);
      if (!a || a !== b) continue;
      const gapBetween = (wB.start_ms - wA.end_ms) / 1000;
      if (gapBetween > maxRepeatGap) continue;
      const cutStart = wA.start_ms / 1000;
      const cutEnd = wA.end_ms / 1000;
      if (cutEnd - cutStart < minCutDur) continue;
      cuts.push({
        start: cutStart,
        end: cutEnd,
        reason: `repeat: ${a}`,
        category: 'repeat_word',
      });
    }
  }

  // ── 2b. Bad-take cuts (verbal-restart markers) ──
  if (enableBadTakes && badTakeMarkers.length > 0) {
    const normalizedWords = words.map((w) => normalizeWord(w.word));
    for (let i = 0; i < words.length; i++) {
      for (const markerWords of badTakeMarkers) {
        if (i + markerWords.length > words.length) continue;
        let matches = true;
        for (let k = 0; k < markerWords.length; k++) {
          if (normalizedWords[i + k] !== markerWords[k]) {
            matches = false;
            break;
          }
        }
        if (!matches) continue;

        let sentenceStartIdx = i;
        for (let j = i - 1; j >= 0; j--) {
          const prevWord = words[j].word;
          if (/[.!?]$/.test(prevWord)) {
            sentenceStartIdx = j + 1;
            break;
          }
          if (words[j].end_ms / 1000 < startAfter) {
            sentenceStartIdx = j + 1;
            break;
          }
          sentenceStartIdx = j;
        }

        const cutStart = words[sentenceStartIdx].start_ms / 1000;
        const lastMarkerWord = words[i + markerWords.length - 1];
        const cutEnd = lastMarkerWord.end_ms / 1000;
        if (cutStart < startAfter) break;
        if (cutEnd - cutStart < minCutDur) break;
        cuts.push({
          start: cutStart,
          end: cutEnd,
          reason: `bad_take: ${markerWords.join(' ')}`,
          category: 'bad_take',
        });
        i = i + markerWords.length - 1;
        break;
      }
    }
  }

  // ── 2c. Silent-restart detection ──
  if (enableSilentRestart) {
    const restartCuts = detectSilentRestarts(words, startAfter, minCutDur);
    cuts.push(...restartCuts);
  }

  // ── 3. Silence cuts ──

  function findGapContext(silStart, silEnd) {
    const slack = retain + 0.2;
    let prevWord = null;
    let nextWord = null;
    for (const w of words) {
      const wStart = w.start_ms / 1000;
      const wEnd = w.end_ms / 1000;
      if (wEnd <= silStart && silStart - wEnd <= slack) {
        if (!prevWord || wEnd > prevWord.end_ms / 1000) prevWord = w;
      }
      if (wStart >= silEnd && wStart - silEnd <= slack) {
        if (!nextWord || wStart < nextWord.start_ms / 1000) nextWord = w;
      }
    }
    return { prevWord, nextWord };
  }

  const wordCounts = new Map();
  for (const w of words) {
    const norm = normalizeWord(w.word);
    if (norm) wordCounts.set(norm, (wordCounts.get(norm) ?? 0) + 1);
  }
  function isPunchlineWord(w) {
    if (!w) return false;
    if (isCommonWord(w.word)) return false;
    const norm = normalizeWord(w.word);
    return (wordCounts.get(norm) ?? 0) === 1;
  }

  function getPreserveCeiling(prevWord, nextWord) {
    if (!preserveEmphasis) return 0;
    let ceiling = 0;
    if (prevWord) {
      if (/[.!?]$/.test(prevWord.word)) ceiling = Math.max(ceiling, preservePostSentence);
      else if (/[,—–-]$/.test(prevWord.word)) ceiling = Math.max(ceiling, preservePostComma);
    }
    if (nextWord && isPunchlineWord(nextWord)) {
      ceiling = Math.max(ceiling, preservePrePunchline);
    }
    return ceiling;
  }

  if (externalSilences && externalSilences.length > 0) {
    for (const span of externalSilences) {
      if (typeof span?.start !== 'number' || typeof span?.end !== 'number') continue;
      if (span.end <= span.start) continue;
      if (span.end <= startAfter) continue;
      const rawStart = Math.max(span.start, startAfter);
      const rawEnd = sourceDuration != null ? Math.min(span.end, sourceDuration) : span.end;
      const dur = rawEnd - rawStart;
      if (dur < minGap) continue;

      const { prevWord, nextWord } = findGapContext(rawStart, rawEnd);
      const preserveCeil = getPreserveCeiling(prevWord, nextWord);
      const cutStart = rawStart + Math.max(retain, preserveCeil);
      const cutEnd = rawEnd - retain;
      if (cutEnd - cutStart < minCutDur) continue;
      cuts.push({
        start: cutStart,
        end: cutEnd,
        reason: preserveCeil > retain
          ? `silence ${(cutEnd - cutStart).toFixed(2)}s (audio,pres=${preserveCeil.toFixed(1)})`
          : `silence ${(cutEnd - cutStart).toFixed(2)}s (audio)`,
        category: 'silence',
      });
    }
  } else {
    if (words[0].start_ms / 1000 - startAfter >= minGap) {
      const cutStart = startAfter + retain;
      const cutEnd = words[0].start_ms / 1000 - retain;
      if (cutEnd - cutStart >= minCutDur) {
        cuts.push({
          start: cutStart,
          end: cutEnd,
          reason: `silence ${(cutEnd - cutStart).toFixed(2)}s (leading)`,
          category: 'silence',
        });
      }
    }

    for (let i = 0; i < words.length - 1; i++) {
      const gapStart = words[i].end_ms / 1000;
      const gapEnd = words[i + 1].start_ms / 1000;
      if (gapStart < startAfter) continue;
      const gap = gapEnd - gapStart;
      if (gap < minGap) continue;
      const preserveCeil = getPreserveCeiling(words[i], words[i + 1]);
      const cutStart = gapStart + Math.max(retain, preserveCeil);
      const cutEnd = gapEnd - retain;
      if (cutEnd - cutStart < minCutDur) continue;
      cuts.push({
        start: cutStart,
        end: cutEnd,
        reason: preserveCeil > retain
          ? `silence ${gap.toFixed(2)}s (pres=${preserveCeil.toFixed(1)})`
          : `silence ${gap.toFixed(2)}s`,
        category: 'silence',
      });
    }

    if (sourceDuration != null) {
      const lastEnd = words[words.length - 1].end_ms / 1000;
      if (sourceDuration - lastEnd >= minGap) {
        const cutStart = lastEnd + retain;
        const cutEnd = sourceDuration - retain;
        if (cutEnd - cutStart >= minCutDur && cutStart >= startAfter) {
          cuts.push({
            start: cutStart,
            end: cutEnd,
            reason: `silence ${(cutEnd - cutStart).toFixed(2)}s (trailing)`,
            category: 'silence',
          });
        }
      }
    }
  }

  // ── Slate intro deterministic cut ──
  if (options.detectSlateFromTranscript && startAfter === 0) {
    const slate = findSlateIntro(words);
    if (slate) {
      const cutEnd = Math.min(slate.endTimeSec + 0.3, sourceDuration ?? slate.endTimeSec + 0.3);
      if (cutEnd > 0 && cutEnd - 0 >= minCutDur) {
        cuts.push({
          start: 0,
          end: cutEnd,
          reason: `slate_intro: [${slate.signals.join(',')}] via ${slate.reason}`,
          category: 'silence',
        });
      }
    }
  }

  // ── Camera-shutoff trim ──
  const MAX_REALISTIC_WORD_DUR = 1.5;
  if (
    options.cutBeyondLastWordPadSec != null &&
    sourceDuration != null &&
    words.length > 0
  ) {
    const lastWord = words[words.length - 1];
    const rawLastEnd = lastWord.end_ms / 1000;
    const rawLastStart = lastWord.start_ms / 1000;

    let lastSpeechEnd;
    if (externalSilences && externalSilences.length > 0) {
      const trailingSilence = externalSilences
        .filter((s) => s.start >= rawLastStart - 0.05)
        .sort((a, b) => a.start - b.start)[0];
      if (trailingSilence) {
        lastSpeechEnd = trailingSilence.start;
      } else {
        lastSpeechEnd = Math.min(rawLastEnd, rawLastStart + MAX_REALISTIC_WORD_DUR);
      }
    } else {
      lastSpeechEnd = Math.min(rawLastEnd, rawLastStart + MAX_REALISTIC_WORD_DUR);
    }

    const cutStart = lastSpeechEnd + options.cutBeyondLastWordPadSec;
    const usedFfmpegBoundary = lastSpeechEnd < Math.min(rawLastEnd, rawLastStart + MAX_REALISTIC_WORD_DUR);

    if (cutStart < sourceDuration && sourceDuration - cutStart >= minCutDur) {
      for (let i = cuts.length - 1; i >= 0; i--) {
        if (cuts[i].start >= lastSpeechEnd) cuts.splice(i, 1);
      }
      cuts.push({
        start: cutStart,
        end: sourceDuration,
        reason: `camera_shutoff: ${(sourceDuration - cutStart).toFixed(2)}s past speech end + ${options.cutBeyondLastWordPadSec}s pad${usedFfmpegBoundary ? ' (via ffmpeg silence boundary)' : (rawLastEnd - rawLastStart > MAX_REALISTIC_WORD_DUR ? ' (last-word clamped)' : '')}`,
        category: 'silence',
      });
    }
  }

  // ── Sort + merge overlapping cuts ──
  cuts.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const c of cuts) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end);
      last.reason = `${last.reason}+${c.reason}`.slice(0, 80);
      if (last.category !== c.category) last.category = 'silence';
    } else {
      merged.push({ ...c });
    }
  }

  // ── Boundary clamp: drop 0-length cuts ──
  for (let i = merged.length - 1; i >= 0; i--) {
    const c = merged[i];
    if (!(c.end > c.start)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[deterministic_cuts] dropping 0-length cut after merge: ` +
          `[${c.start.toFixed(3)}, ${c.end.toFixed(3)}] (${c.category}: ${c.reason})`,
      );
      merged.splice(i, 1);
    }
  }

  // ── Word-boundary clamp ──
  // PR #105: when `relaxClampForGhostWords` is on AND externalSilences are
  // provided, build a per-word "ghost" lookup once so the inner clamp loops
  // can skip Scribe artifacts in O(1). Empty/falsy when the option is off,
  // which preserves the original 48-test parity behavior unchanged.
  const ghostWordSet = (relaxClampForGhostWords && externalSilences && externalSilences.length > 0)
    ? new Set(words.filter((w) => isSilenceGhostWord(w, externalSilences)))
    : null;

  const wordClampPad = 0.05;
  for (let i = merged.length - 1; i >= 0; i--) {
    const c = merged[i];
    if (c.reason.startsWith('camera_shutoff')) continue;
    let newStart = c.start;
    let newEnd = c.end;
    let stableStart = false;
    while (!stableStart) {
      stableStart = true;
      for (const w of words) {
        if (ghostWordSet && ghostWordSet.has(w)) continue;
        const wStart = w.start_ms / 1000;
        const wEnd = w.end_ms / 1000;
        if (wStart < newStart && wEnd > newStart) {
          newStart = wEnd + wordClampPad;
          stableStart = false;
          break;
        }
      }
    }
    let stableEnd = false;
    while (!stableEnd) {
      stableEnd = true;
      for (const w of words) {
        if (ghostWordSet && ghostWordSet.has(w)) continue;
        const wStart = w.start_ms / 1000;
        const wEnd = w.end_ms / 1000;
        if (wStart < newEnd && wEnd > newEnd) {
          newEnd = wStart - wordClampPad;
          stableEnd = false;
          break;
        }
      }
    }
    if (newEnd - newStart >= minCutDur) {
      if (newStart !== c.start || newEnd !== c.end) {
        c.start = newStart;
        c.end = newEnd;
      }
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[deterministic_cuts] dropping cut after word-boundary clamp: ` +
          `[${c.start.toFixed(3)}, ${c.end.toFixed(3)}] -> ` +
          `[${newStart.toFixed(3)}, ${newEnd.toFixed(3)}] (${c.reason})`,
      );
      merged.splice(i, 1);
    }
  }

  // ── Context-aware split when a single merged cut exceeds maxSingleCutSec ──
  const splitMerged = [];
  for (const c of merged) {
    const dur = c.end - c.start;
    if (c.category !== 'silence' || dur <= maxSingleCut) {
      splitMerged.push(c);
      continue;
    }

    const adjacencySlack = retain + 0.2;
    let prevWord = null;
    let nextWord = null;
    for (const w of words) {
      const wEnd = w.end_ms / 1000;
      const wStart = w.start_ms / 1000;
      if (wEnd <= c.start && c.start - wEnd <= adjacencySlack) {
        if (!prevWord || wEnd > prevWord.end_ms / 1000) prevWord = w;
      }
      if (wStart >= c.end && wStart - c.end <= adjacencySlack) {
        if (!nextWord || wStart < nextWord.start_ms / 1000) nextWord = w;
      }
    }

    const sentenceClose = !!(prevWord && /[.!?]$/.test(prevWord.word));
    const strongContentStart = !!(nextWord && /^[A-Z]/.test(nextWord.word.trim()));
    const isEmphasisPause = sentenceClose || strongContentStart;

    if (!isEmphasisPause) {
      splitMerged.push(c);
      continue;
    }

    const beatSec = 0.25;
    const halfDur = (dur - beatSec) / 2;
    if (halfDur < minCutDur) {
      splitMerged.push(c);
      continue;
    }
    const firstEnd = c.start + halfDur;
    const secondStart = c.end - halfDur;
    splitMerged.push({
      start: c.start,
      end: firstEnd,
      reason: `${c.reason} [split-1]`.slice(0, 80),
      category: c.category,
    });
    splitMerged.push({
      start: secondStart,
      end: c.end,
      reason: `${c.reason} [split-2]`.slice(0, 80),
      category: c.category,
    });
  }

  // ── Apply cap (e.g. 40% of sourceDuration) ──
  let postCap;
  if (sourceDuration != null && sourceDuration > 0) {
    const maxTotalSec = sourceDuration * maxCutFraction;
    const capped = [];
    let runningTotal = 0;
    for (const c of splitMerged) {
      const dur = c.end - c.start;
      if (runningTotal + dur > maxTotalSec) {
        const dropped = splitMerged.length - capped.length;
        // eslint-disable-next-line no-console
        console.warn(
          `[deterministic_cuts] cap reached at ${maxTotalSec.toFixed(2)}s — dropped ${dropped} later cuts`,
        );
        break;
      }
      capped.push(c);
      runningTotal += dur;
    }
    postCap = capped;
  } else {
    postCap = splitMerged;
  }

  // ── Classify safety on every surviving cut ──
  const classified = postCap.map((c) => annotateSafety(c, words, options));

  // ── Filter based on cutSafetyMode ──
  const safetyMode = options.cutSafetyMode ?? 'all';
  const allowedSafety =
    safetyMode === 'safe_only' ? ['safe'] :
    safetyMode === 'safe_and_soft' ? ['safe', 'soft'] :
    ['safe', 'soft', 'risky'];
  const applied = classified.filter((c) => allowedSafety.includes(c.safety));

  return applied;
}

export function detectAndClassifyCuts(words, options = {}) {
  const allClassified = detectDeterministicCuts(words, { ...options, cutSafetyMode: 'all' });

  const safetyMode = options.cutSafetyMode ?? 'safe_only';
  const allowedSafety =
    safetyMode === 'safe_only' ? ['safe'] :
    safetyMode === 'safe_and_soft' ? ['safe', 'soft'] :
    ['safe', 'soft', 'risky'];
  const applied = allClassified.filter((c) => allowedSafety.includes(c.safety));
  const skipped = allClassified.filter((c) => !allowedSafety.includes(c.safety));

  return { applied, skipped, all: allClassified };
}

// ── Safety classifier ───────────────────────────────────────────────────

const PUNCT_SENTENCE_END = /[.!?]$/;
const PUNCT_PHRASE_END = /[,—–-]$/;
const STARTS_WITH_CAPITAL = /^[A-Z]/;

function annotateSafety(cut, words, options = {}) {
  const slack = 0.8;
  let prevWord = null;
  let nextWord = null;
  for (const w of words) {
    const wEnd = w.end_ms / 1000;
    const wStart = w.start_ms / 1000;
    if (wEnd <= cut.start && cut.start - wEnd <= slack) {
      if (!prevWord || wEnd > prevWord.end_ms / 1000) prevWord = w;
    }
    if (wStart >= cut.end && wStart - cut.end <= slack) {
      if (!nextWord || wStart < nextWord.start_ms / 1000) nextWord = w;
    }
  }

  const before = [];
  const after = [];
  for (const w of words) {
    const wEnd = w.end_ms / 1000;
    const wStart = w.start_ms / 1000;
    if (wEnd <= cut.start) before.push(w.word);
    else if (wStart >= cut.end) after.push(w.word);
  }
  const contextBefore = before.slice(-7).join(' ');
  const contextAfter = after.slice(0, 7).join(' ');

  if (cut.category === 'bad_take') {
    const reason = cut.reason.startsWith('silent_restart') ? 'silent_restart_n_gram' : 'verbal_restart_marker';
    return { ...cut, safety: 'safe', safetyReason: reason, contextBefore, contextAfter };
  }
  if (cut.category === 'filler') {
    return { ...cut, safety: 'safe', safetyReason: 'filler_word', contextBefore, contextAfter };
  }
  if (cut.category === 'repeat_word') {
    return { ...cut, safety: 'safe', safetyReason: 'repeat_word_stutter', contextBefore, contextAfter };
  }
  if (cut.reason.includes('(leading)')) {
    return { ...cut, safety: 'safe', safetyReason: 'leading_silence', contextBefore, contextAfter };
  }
  if (cut.reason.includes('(trailing)')) {
    return { ...cut, safety: 'safe', safetyReason: 'trailing_silence', contextBefore, contextAfter };
  }

  if (after.length === 0) {
    return { ...cut, safety: 'safe', safetyReason: 'trailing_silence', contextBefore, contextAfter };
  }
  if (before.length === 0) {
    return { ...cut, safety: 'safe', safetyReason: 'leading_silence', contextBefore, contextAfter };
  }

  const lastBeforeWord = before[before.length - 1];
  const firstAfterWord = after[0];
  const lastBeforeEndsSentence = lastBeforeWord ? PUNCT_SENTENCE_END.test(lastBeforeWord) : false;
  const firstAfterStartsCapital = firstAfterWord ? STARTS_WITH_CAPITAL.test(firstAfterWord) : false;

  if (!prevWord) {
    if (lastBeforeEndsSentence) {
      return { ...cut, safety: 'safe', safetyReason: 'post_sentence_dead_air', contextBefore, contextAfter };
    }
    return { ...cut, safety: 'risky', safetyReason: 'no_adjacent_prev_word', contextBefore, contextAfter };
  }
  if (!nextWord) {
    const prevEndsInSent = PUNCT_SENTENCE_END.test(prevWord.word);
    if (prevEndsInSent || lastBeforeEndsSentence) {
      return { ...cut, safety: 'safe', safetyReason: 'post_sentence_dead_air', contextBefore, contextAfter };
    }
    if (firstAfterStartsCapital) {
      return { ...cut, safety: 'safe', safetyReason: 'pre_sentence_dead_air', contextBefore, contextAfter };
    }
    return { ...cut, safety: 'risky', safetyReason: 'no_adjacent_next_word', contextBefore, contextAfter };
  }

  const prevNorm = normalizeWord(prevWord.word);
  const nextNorm = normalizeWord(nextWord.word);
  const prevEndsInSentence = PUNCT_SENTENCE_END.test(prevWord.word);
  const prevEndsInPhrase = PUNCT_PHRASE_END.test(prevWord.word);

  if (STRONG_DEPENDENT_TRAILING_WORDS.has(prevNorm)) {
    return {
      ...cut,
      safety: 'risky',
      safetyReason: `dependent_trailing_word: '${prevNorm}'`,
      contextBefore,
      contextAfter,
    };
  }

  if (prevEndsInPhrase && CONTINUATION_START_WORDS.has(nextNorm)) {
    return {
      ...cut,
      safety: 'risky',
      safetyReason: `comma_then_continuation: '${nextNorm}'`,
      contextBefore,
      contextAfter,
    };
  }

  if (prevEndsInSentence) {
    return {
      ...cut,
      safety: 'safe',
      safetyReason: 'sentence_boundary',
      contextBefore,
      contextAfter,
    };
  }

  if (DEPENDENT_TRAILING_WORDS.has(prevNorm)) {
    return {
      ...cut,
      safety: 'risky',
      safetyReason: `dependent_trailing_word: '${prevNorm}'`,
      contextBefore,
      contextAfter,
    };
  }

  if (prevEndsInPhrase) {
    return {
      ...cut,
      safety: 'soft',
      safetyReason: 'phrase_boundary_comma',
      contextBefore,
      contextAfter,
    };
  }

  const gapBefore = cut.start - prevWord.end_ms / 1000;
  if (gapBefore >= 1.0 && STARTS_WITH_CAPITAL.test(nextWord.word)) {
    return {
      ...cut,
      safety: 'safe',
      safetyReason: 'inferred_sentence_boundary',
      contextBefore,
      contextAfter,
    };
  }

  const cutDur = cut.end - cut.start;
  const midLongThresh = options.cutMidSentenceLongerThan ?? Infinity;
  if (cut.category === 'silence' && cutDur >= midLongThresh) {
    return {
      ...cut,
      safety: 'safe',
      safetyReason: `mid_sentence_long_pause_${cutDur.toFixed(2)}s`,
      contextBefore,
      contextAfter,
    };
  }

  return {
    ...cut,
    safety: 'risky',
    safetyReason: 'mid_sentence_no_boundary',
    contextBefore,
    contextAfter,
  };
}

// ── Silent-restart detection helpers ────────────────────────────────────

function levenshteinBounded(a, b, maxDist) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return Infinity;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      if (dp[i][j] < rowMin) rowMin = dp[i][j];
    }
    if (rowMin > maxDist) return Infinity;
  }
  return dp[a.length][b.length];
}

function findSentenceSpans(words, startAfter) {
  const spans = [];
  let curStart = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const wStart = w.start_ms / 1000;
    if (wStart < startAfter) continue;
    if (curStart === -1) curStart = i;
    const wEnd = w.end_ms / 1000;
    const next = words[i + 1];
    const breakOnPunct = /[.!?]$/.test(w.word);
    const breakOnGap = next ? (next.start_ms / 1000 - wEnd) >= 0.4 : true;
    if (breakOnPunct || breakOnGap) {
      spans.push({ startIdx: curStart, endIdx: i });
      curStart = -1;
    }
  }
  if (curStart !== -1) {
    spans.push({ startIdx: curStart, endIdx: words.length - 1 });
  }
  return spans;
}

function findSentenceStartRepeats(words, spans, minCutDur) {
  const HEAD_LEN = 6;
  const MIN_TOKEN_MATCHES = 3;
  const MAX_INTER_SENTENCE_GAP = 2.5;

  const cuts = [];
  for (let s = 0; s < spans.length - 1; s++) {
    const a = spans[s];
    const b = spans[s + 1];
    const aEnd = words[a.endIdx].end_ms / 1000;
    const bStart = words[b.startIdx].start_ms / 1000;
    const interGap = bStart - aEnd;
    if (interGap > MAX_INTER_SENTENCE_GAP) continue;

    const aHead = words.slice(a.startIdx, Math.min(a.startIdx + HEAD_LEN, a.endIdx + 1));
    const bHead = words.slice(b.startIdx, Math.min(b.startIdx + HEAD_LEN, b.endIdx + 1));
    if (aHead.length < MIN_TOKEN_MATCHES || bHead.length < MIN_TOKEN_MATCHES) continue;

    const compareLen = Math.min(aHead.length, bHead.length);
    let matches = 0;
    for (let k = 0; k < compareLen; k++) {
      const aTok = normalizeWord(aHead[k].word);
      const bTok = normalizeWord(bHead[k].word);
      if (!aTok || !bTok) continue;
      if (levenshteinBounded(aTok, bTok, 1) <= 1) matches++;
    }
    if (matches < MIN_TOKEN_MATCHES) continue;

    const cutStart = words[a.startIdx].start_ms / 1000;
    const cutEnd = words[a.endIdx].end_ms / 1000;
    if (cutEnd - cutStart < minCutDur) continue;
    cuts.push({
      start: cutStart,
      end: cutEnd,
      reason: `silent_restart: ${matches}/${compareLen} head-tokens repeat`,
      category: 'bad_take',
    });
  }
  return cuts;
}

function findSliding4gramRepeats(words, startAfter, minCutDur) {
  const N = 5;
  const WINDOW = 6.0;
  const MAX_GAP_BETWEEN_INSTANCES = 1.0;

  if (words.length < N * 2) return [];

  const cuts = [];
  const ngrams = new Map();
  for (let i = 0; i + N <= words.length; i++) {
    const startSec = words[i].start_ms / 1000;
    if (startSec < startAfter) continue;
    const ngram = words
      .slice(i, i + N)
      .map((w) => normalizeWord(w.word))
      .filter(Boolean);
    if (ngram.length < N) continue;
    const key = ngram.join(' ');
    if (!ngrams.has(key)) ngrams.set(key, []);
    ngrams.get(key).push(i);
  }

  const claimedIndices = new Set();
  for (const [, indices] of ngrams) {
    if (indices.length < 2) continue;
    for (let p = 0; p < indices.length - 1; p++) {
      const i1 = indices[p];
      const i2 = indices[p + 1];
      if (claimedIndices.has(i1) || claimedIndices.has(i2)) continue;
      const i1End = words[i1 + N - 1].end_ms / 1000;
      const i2Start = words[i2].start_ms / 1000;
      const i1Start = words[i1].start_ms / 1000;
      const windowDur = words[i2 + N - 1].end_ms / 1000 - i1Start;
      if (windowDur > WINDOW) continue;
      const gapBetween = i2Start - i1End;
      if (gapBetween > MAX_GAP_BETWEEN_INSTANCES) continue;
      const cutStart = i1Start;
      const cutEnd = i1End;
      if (cutEnd - cutStart < minCutDur) continue;
      cuts.push({
        start: cutStart,
        end: cutEnd,
        reason: `silent_restart: 4-gram repeat (${gapBetween.toFixed(2)}s apart)`,
        category: 'bad_take',
      });
      for (let k = 0; k < N; k++) {
        claimedIndices.add(i1 + k);
        claimedIndices.add(i2 + k);
      }
    }
  }
  return cuts;
}

function detectSilentRestarts(words, startAfter, minCutDur) {
  const spans = findSentenceSpans(words, startAfter);
  const sentenceCuts = findSentenceStartRepeats(words, spans, minCutDur);
  const slidingCuts = findSliding4gramRepeats(words, startAfter, minCutDur);
  const out = [...sentenceCuts];
  for (const sc of slidingCuts) {
    const overlaps = out.some(
      (c) => sc.start < c.end && sc.end > c.start,
    );
    if (!overlaps) out.push(sc);
  }
  return out;
}
