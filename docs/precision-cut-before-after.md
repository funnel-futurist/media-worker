# Precision cutting: before / after evidence

Side-by-side comparison of audit signals across the PRs that landed
between Chelsea's 2026-05 QC and PR-AK. Each row is one of the actual
failures from her Slack note.

## Mon 18 — `Thinking_About_Planning_vs_Deciding_to_Plan` (`93a5ecc7`)

**Issue:** 1:49 pause not removed.

| Stage | Slate end | Pause at 1:49 result |
|---|---|---|
| **Before PR-AC** | n/a (no audit) | Preserved silently — no diagnostic |
| **PR-AC** (audit) | 14.13s | Visible in audit as `PRESERVED (phrase_boundary_comma)` 4.089s |
| **PR-AD** (cap + comma) | 14.13s | Flipped to `CUT (long_phrase_boundary_comma_4.09s)` ✓ |
| **PR-AH** (validator) | **2.50s** (shortened) | Pause cut; but title `Thinking about planning...` leaks into reel ❌ |
| **PR-AJ** (validator off) | 14.13s | Pause cut; but Gemini's 14.13s sometimes missed `Final version.` |
| **PR-AK** (extender + context) | 14.13s, extended to cover `Final version.` if present | Pause cut, title cut, marker cut. Audit row: `→ CUT (long_phrase_boundary_comma_4.09s) \| "...the right plan." → "And so..."` |

## Sat 23 — `If_Not_Now_When_Selected_Option` (`4dad7b0b`)

**Issue:** Phil's hook missing; Chelsea heard "It not now, that's the whole thing" instead of "If not now, when? That's it. That's the whole question."

| Stage | Slate end | "If not now, when?" outcome |
|---|---|---|
| **Before PR-AH** | 12.16s | Cut as part of slate (correct — it's a title readout) |
| **PR-AH** | 2.0s (shortened) | Preserved as content ❌ — leaks the title readout |
| **PR-AJ** | 12.16s | Cut as slate ✓; but `Final version.` after meta might leak if Gemini missed it |
| **PR-AK** | 12.16s; extender appends if late marker found | Title readout cut, option marker cut, `Final version.` cut. The CONTENT instance of "If not now, when? That's it." is a separate later phrase — preserved or repatched depending on Deepgram fidelity |

Note: Chelsea's "It not now" was a Deepgram mis-transcription of the
LATER content instance (not the slate readout). Fix path is per-job
`deepgramKeywords: ["If not now when", "that's the whole question"]`
via `editing_defaults`, or surgical caption repatch (PR-AF).

## Tue 19 — `Why_We_Intentionally_Limit_New_Families_Each_Month` (`f1a67c03`)

**Issues:** "specialist" should be "special needs" (×2); green flashes at 2:00, 2:03.

| Stage | Outcome |
|---|---|
| **Before PR-AF** | "specialist" → no fix path without full re-edit; green flashes baked in |
| **PR-AF** (keyterm + intermediates) | Deepgram `keyterm: ["special needs"]` catches the phrase on next edit; green flashes typically fix on re-encode (PR #157/#158) |
| **PR-AK** | Slate edit unchanged here (same date+marker pattern). Audit now shows transcript context: any preserved silence with prev/next words reveals whether it's emphasis or dead air. |

## Thurs 21 — `What_Your_Future_Self_Would_Choose` (`ed3ee6c3`)

**Issues:** "wandered" should be "wondered"; 1:23 audio blip + pause.

| Stage | Outcome |
|---|---|
| **PR-AC** (audit) | 1:23 audio blip visible in audit if it spans ≥0.6s; otherwise silenceDetect missed it |
| **PR-AD** (long-comma cuts) | Long post-comma pause around 1:23 → CUT |
| **PR-AF** | Deepgram `keyterm: ["wondered"]` corrects the caption |
| **PR-AK** | Audit row shows context: `\| "...something" → "we built..."` makes it clear what bracketed the pause |

## Sun 24 — `This_Is_Your_Invitation_to_Move_Forward` (`9615c003`)

**Issue:** 1:13 pause not removed.

Same pattern as Mon 18 — `PR-AD` reclassified long post-comma pauses
as safe so this pause now cuts; `PR-AK` extender ensures any
`Selected option.` / `Final version.` after the date also goes with
the slate.

---

## What the new audit format reveals

Pre-PR-AK row:

```
[silence-audit] [12.340, 13.120] (0.780s) → CUT (post_sentence_dead_air)
```

Post-PR-AK row:

```
[silence-audit] [12.340, 13.120] (0.780s) → CUT (post_sentence_dead_air) | "...the right plan." → "And so I"
```

The trailing context lets an operator scan 30+ audit rows and
immediately spot any decision that doesn't match the surrounding
transcript — e.g., a `PRESERVED (mid_sentence_no_boundary)` row whose
`prev` clearly ends a sentence (`"...the plan."`) means Deepgram
dropped the punctuation and the classifier ran on the wrong
boundary signal.

---

## Slate signature

Pre-PR-AK:

```
[clean_mode_pipeline:abc...] slate (llm): end=1.20s text="Saturday, May 23."
```

(Slate ends at the date. "Selected option." leaks into the reel.)

Post-PR-AK:

```
[clean_mode_pipeline:abc...] slate (llm): end=1.20s text="Saturday, May 23."
[slate_detect] meta-extender: 1.20s → 2.60s — extended past 1 meta marker(s): "Selected option."
```

(Extender catches the under-cut. Final slate cut is `[0, 2.60s]`,
"Selected option." removed.)
