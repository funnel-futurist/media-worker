# QC verification — precision cutting (PR-AK)

How to verify a clean-mode reel landed correctly after edit, using only
the Railway deploy log + Supabase row. No video scrubbing required to
sign off on the cut decisions.

## TL;DR — the three log signals that matter

For every job, the Railway log emits:

1. **Slate decision** — one line per slate detection
2. **Per-span silence audit** — one line per detected silence span
3. **Final cut summary** — one line showing source → cut duration

If all three look right, the reel's edit is correct *at the cut layer*.
Visual (b-roll, captions burned correctly, intro overlay) is a separate
inspection.

---

## 1. Slate decision

Grep the log for the jobId, look for the slate block:

```
[clean_mode_pipeline:<jobId>] slate (llm): end=12.16s text="Saturday, May 23. If not now, when? Selected option. Finding"
[slate_detect] meta-extender: 1.20s → 2.60s — extended past 1 meta marker(s): "Selected option."
```

**What to check:**

- `slate (llm): end=X.XXs` — Gemini's raw decision. The slate ends at
  the start of content. For Phil reels, this should be at least past
  "Selected option." / "Final version." On Justine/Chelsea reels with
  no slate this line is absent (no slate detected) — that's fine.

- `[slate_detect] meta-extender:` — appears ONLY when PR-AK extended
  Gemini's value. If present, confirms a "Selected option." or
  "Final version." that Gemini missed was caught deterministically.

- **`[slate_detect] hook-validator:`** — should NOT appear. PR-AJ
  disabled the validator. If it appears in a fresh log, the deploy is
  stale (still on PR-AH / pre-PR-AJ code).

**Red flag patterns:**

- `slate (llm): end=2.50s text="..."` on a Phil reel — too short, only
  caught the date. The extender should have kicked in. If `meta-extender`
  is absent, Gemini's transcript text didn't include the meta marker.
- No slate line at all on a Phil reel — Gemini classified `isSlate:false`.
  Usually means audio start is unusual (mid-breath, no clear date).

---

## 2. Per-span silence audit (PR-AK enriched)

Grep for `[silence-audit]`. Each line is one detected silence span with
the decision + transcript context:

```
[silence-audit] [12.340, 13.120] (0.780s) → CUT (sentence_boundary) | "the right plan." → "And so I"
[silence-audit] [45.100, 46.200] (1.100s) → PRESERVED (mid_sentence_no_boundary) | "we want to" → "help families"
[silence-audit] [78.000, 78.620] (0.620s) → DROPPED (subthreshold) | "and" → "we"
```

Format: `[start, end] (duration) → DECISION (reason) | "prev words" → "next words"`

**Decision values:**

| Decision | Meaning |
|---|---|
| `CUT` | Silence removed from final reel |
| `PRESERVED` | Silence kept in reel (classifier deemed it risky to cut) |
| `DROPPED` | Detected but no cut generated (subthreshold / cap evicted) |

**Reasons to know:**

- `sentence_boundary` — clean cut between sentences, safe ✓
- `post_sentence_dead_air` — extra-long sentence-end pause, safe ✓
- `long_phrase_boundary_comma_X.Xs` — long post-comma pause, PR-AD reclassified as safe ✓
- `long_comma_then_continuation_X.Xs` — long pause before and/but/so, PR-AD reclassified as safe ✓
- `mid_sentence_no_boundary` — mid-sentence pause without comma/period anchor, **preserved by design** to avoid cutting into incomplete thoughts
- `dependent_trailing_word: 'X'` — pause after a weak-ending word (the, in, of, etc.), preserved
- `phrase_boundary_comma` — short post-comma pause, classified `soft`, only cut in `safe_and_soft` mode
- `subthreshold` — cut window collapsed after retain + preserve subtraction, never made it to classification
- `max_cut_fraction_cap` — cap evicted a safety-vetted cut (should not happen post-PR-AD's safe protection)

**Red flag patterns:**

- `→ PRESERVED (mid_sentence_no_boundary)` with `prev`/`next` showing a
  clearly-ended sentence (e.g., `prev="the plan."`). The classifier
  missed the punctuation — either Deepgram dropped it or the safety
  rule is too conservative for this case.
- `→ DROPPED (max_cut_fraction_cap)` — should be impossible for safe
  cuts post-PR-AD. If you see one, the cap protection didn't fire.
- `→ DROPPED (subthreshold)` on a 1.5s+ silence — the preserve budget
  ate the whole span. Usually means a post-sentence pause with a long
  preserve ceiling. Reasonable on natural emphasis, suspicious on
  3s+ spans.

---

## 3. Final cut summary

```
[clean_mode_pipeline:<jobId>] cutApply: 225.79s → 141.08s (removed 84.70s across 33 cuts)
```

Sanity checks:

- `removed` should be **<60%** of source. Above that means the cap is
  triggering or the safety classifier is being unusually aggressive.
- `N cuts` typical for a 3-4 min talking-head: 25-40 cuts.
- Above 50 cuts usually means many short pauses (rare on real Phil/Chelsea).

---

## 4. Fixture-driven regression cases (from Chelsea's 2026-05 QC)

These are the specific failures the precision-cut work was built around.
After any future change to slate / silence logic, the corresponding
audit lines should still look like this:

| Reel | Source pattern | Expected slate behavior |
|---|---|---|
| **Mon 18** Thinking_About_Planning | `Monday, May 18. Thinking about planning versus deciding to plan. [Final version.] [script…]` | Slate ends past "Final version." (~5s). Content opens at script. |
| **Sun 24** This_Is_Your_Invitation | `Sunday, May 24. [Title.] [Selected option.] [script…]` | Slate ends past "Selected option." (or "Final version."). |
| **Sat 23** If_Not_Now_When | `Saturday, May 23. If not now, when? Selected option. Finding…` | Slate ends past "Selected option." (~3s). "Finding…" is content opener. |
| **Tue 19** Why_We_Intentionally_Limit | `Tuesday, May 19. [Title.] [Selected option / Final version.] [script…]` | Slate ends past meta marker. Deepgram `keyterm: ["special needs"]` corrects the "specialist" mis-transcription. |
| **Thurs 21** What_Your_Future_Self | `Thursday, May 21. [Title.] [meta marker.] [script…]` | Same pattern. Deepgram `keyterm: ["wondered"]` corrects "wandered". |

If a future Phil reel falls outside this pattern (no clear date / no
explicit option marker), Gemini may classify `isSlate:false` — that's
not a bug. The extender only extends, never invents.

---

## 5. When to escalate vs tune

| Symptom | Action |
|---|---|
| Intro NOT cut (title or option marker visible in reel) | Check the meta-extender log line. If absent, the marker text isn't being detected — add a pattern to `META_MARKER_PATTERNS` in `slate_detect.js`. |
| Real content cut as slate | Gemini over-cut. Inspect the slate text Gemini returned. If the over-cut is reproducible across re-runs, tighten the prompt in `slate_detect.js`. |
| 1+ second pause preserved as `mid_sentence_no_boundary` | Check the `prev`/`next` context. If the prev word actually ended with `.`, Deepgram dropped the punctuation. Add the specific word/phrase to per-job Deepgram `keyterm` (PR-AF). |
| Caption error ("specialist" vs "special needs", etc.) | Surgical fix via `/api/content/[id]/repatch-captions` (PR-AF). No re-edit required if `pre_caption_video_url` is set. |
| Hook eaten ("If not now, when?" missing) | Confirmed false alarm on the Sat 23 case — that phrase is Phil's title readout, not content. The content version (different timestamp) is preserved separately and may need a Deepgram keyterm boost if mis-transcribed. |

---

## 6. Sanity check the deploy

Before relying on the audit log for any of the above, confirm the
worker is on the latest code. Each PR's signature in the log:

- **PR-AC** (silence audit): `[silence-audit]` block appears at all
- **PR-AD** (cap protection): rows with `long_phrase_boundary_comma_X.Xs` or `long_comma_then_continuation_X.Xs` reasons
- **PR-AF** (intermediate preservation): `repatchAssets` block in the response envelope; `pre_caption_video_url` in `cs.content_items` row
- **PR-AJ** (validator disabled): `[slate_detect] hook-validator:` does NOT appear
- **PR-AK** (extender + context): `[slate_detect] meta-extender:` may appear; every `[silence-audit]` row ends with `| "prev" → "next"`

Probe the worker route exists:

```
curl -X POST https://media-worker-production-9c2c.up.railway.app/repatch-captions
# → 401 (route exists, auth required) ✓
# → 404 (deploy is stale, missing PR-AF)
```
