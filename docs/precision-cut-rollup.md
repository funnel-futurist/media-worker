# Precision cutting upgrade — final rollup

This is the complete record of the precision-cutting work shipped in
response to Chelsea's 2026-05 QC batch. Read alongside the operator
playbook ([qc-precision-cut-verification.md](./qc-precision-cut-verification.md))
and the before/after evidence ([precision-cut-before-after.md](./precision-cut-before-after.md)).

## Shipped PRs

| PR | Title | What |
|---|---|---|
| [#148](https://github.com/funnel-futurist/media-worker/pull/148) | PR-AC | Per-span silence audit log + tighter post-sentence preserve budget |
| [#149](https://github.com/funnel-futurist/media-worker/pull/149) | PR-AD | Protect safe cuts from 40% cap + reclassify long post-comma pauses as safe + distinguish `subthreshold` vs `max_cut_fraction_cap` |
| [#162](https://github.com/funnel-futurist/media-worker/pull/162) | PR-AF (worker) | Preserve `brolled.mp4` + `.ass` to Storage; new `POST /repatch-captions` route; Deepgram `keyterm` boost support |
| [#168](https://github.com/funnel-futurist/media-worker/pull/168) | hotfix | `keywords` → `keyterm` for Nova-3 |
| [#172](https://github.com/funnel-futurist/media-worker/pull/172) | PR-AJ | Disable hook-validator — trust Gemini slate end |
| [#173](https://github.com/funnel-futurist/media-worker/pull/173) | **PR-AK** | Meta-extender guard + transcript context per audit row |
| [#175](https://github.com/funnel-futurist/media-worker/pull/175) | PR-AK follow-up | `[slate-audit]` + `[bad-take-audit]` log lines with context |
| [ff-portal #269](https://github.com/funnel-futurist/ff-client-portal/pull/269) | PR-AF (portal) | DB migration + `/api/content/[id]/repatch-captions` endpoint |

## Files changed (lib + tests)

```
lib/clean_mode_pipeline.js          orchestrator wiring for audit, slate, intermediates
lib/slate_detect.js                 + extendSlateForLateMetaMarkers + META_MARKER_PATTERNS
lib/silence_audit.js                + contextAround helper, prev/next on every row
lib/repatch_captions.js             new — applyAssReplacements + runRepatchCaptions
lib/deepgram_transcribe.js          + buildDeepgramQuery with keyterm support
lib/portal_webhook.js               buildReelEditedPayload accepts intermediate URLs
lib/cut_detection.js                + protectSafeCutsFromCap + longCommaPauseAsSafeThreshSec
routes/clean-mode-compose.js        callback forwarding + new option validation
routes/repatch-captions.js          new route

test/slate_detect.test.js           30 cases (was 23) — extender + back-compat
test/silence_audit.test.js          18 cases (was 13) — context + format
test/repatch_captions.test.js       14 cases — text replacement + escaping
test/deepgram_transcribe.test.js    19 cases — keyterm builder
test/cut_detection.test.js          78 cases — PR-AC/AD tunings + cap protection
```

## Regression test coverage of Chelsea's failures

| QC failure | Test that locks it in |
|---|---|
| Mon 18 1:49 pause | `test/cut_detection.test.js` — `PR-AC: 0.78s post-sentence pause → CUT`, `PR-AD: long phrase_boundary_comma (3s) → safe` |
| Sun 24 1:13 pause | Same fixtures as Mon 18 — same classifier path |
| Sat 23 hook bundling | `test/slate_detect.test.js` — `PR-AJ: detectSlate trusts Gemini` + `PR-AK extender: extends past "Selected option."` |
| Tue 19 `specialist` | `test/deepgram_transcribe.test.js` — `buildDeepgramQuery: multi-word term + :5` |
| Thurs 21 `wandered` | Same |
| Thurs 21 1:23 blip | `test/silence_audit.test.js` — PR-AK context row format (lets operator distinguish blip from emphasis) |
| Wed 20 source mismatch | N/A — not a pipeline bug, content team escalation |

## Audit signal summary (post-PR-AK)

Every cut decision the pipeline makes emits one greppable log line in
one of three families:

```
[slate-audit] [start, end] (dur) → CUT (slate_intro) | "<prev>" → "<next>"
[silence-audit] [start, end] (dur) → CUT|PRESERVED|DROPPED (reason) | "<prev>" → "<next>"
[bad-take-audit] [start, end] (dur) → CUT (bad_take: <reason>) | "<prev>" → "<next>"
```

Plus the summary lines:

```
[clean_mode_pipeline:<jobId>] silence audit summary: detected=N cut=N preserved=N dropped=N detectedSec=X cutSec=X survivingSec=X
[clean_mode_pipeline:<jobId>] cutApply: <sourceSec>s → <cutSec>s (removed Xs across N cuts)
```

## Railway verification (PR-AK active)

- Health endpoint returns 200
- `/repatch-captions` route returns 401 (auth required, route present)
- First successful job emits `[slate-audit]`, `[silence-audit] ... | "..." → "..."`, and (when Phil's transcript triggers it) `[slate_detect] meta-extender:` lines
- `cs.content_items.pre_caption_video_url` populated on every new edit

## Final QC instructions for the operator

1. Re-fire a reel (or fire a fresh one) — auto-trigger from upload or manual `/run-edit`
2. After ~10 min, query the row for `edit_file_url`
3. Open Railway Deploy Logs, search the jobId
4. Verify:
   - `slate (llm): end=X.XXs` exists (or `isSlate:false` if no clear date)
   - `meta-extender` line if Gemini's text contained a marker AFTER its end
   - Every `[silence-audit]` row has `| "<prev>" → "<next>"`
   - `cutApply: ... (removed Xs across N cuts)` shows reasonable Z (10-40% of source on talking-head reels)
5. Watch the reel at any timestamps the audit flagged as `PRESERVED` or `DROPPED` with `dur ≥ 1.5s` — those are the high-risk decisions
6. Ship if the audit + spot-check both pass. Surgical repatch via `/api/content/[id]/repatch-captions` if only captions are wrong.

## Out of scope (intentionally deferred)

- **Mid-sentence pause classifier tuning** — `PRESERVED (mid_sentence_no_boundary)` rows ≥1.5s might still be dead air. Requires a real-world feedback cycle to tune without over-cutting incomplete thoughts. The new audit context format makes this decidable when the time comes.
- **Per-job Deepgram keyterm UI** — already wired through `editing_defaults` JSONB, just no portal UI surface yet.
- **B-roll content alignment** — separate problem; clip-content matching is a Gemini Pro decision, not a slate/silence concern.
- **Wed 20 source mismatch** — not a pipeline bug; upload-side concern.
