/**
 * test/broll_picker_prompt.test.js
 *
 * Pure-function snapshot tests on broll_picker `buildPrompts`.
 *
 * History:
 *   PR-D (2026-05-09): locked the "STRONGLY prefer client over Pixabay"
 *     wording so a refactor couldn't accidentally let stock take over.
 *   PR-F (2026-05-09): flipped to AI-blend semantics. The picker should
 *     USE BOTH sources when both are available and pick the asset that
 *     best fits each spoken moment, preferring client only when relevance
 *     is genuinely similar. Locks the new wording so a future refactor
 *     can't regress to a one-sided rule.
 *
 * Pattern matches test/clean_mode_models_lock.test.js — read the prompt,
 * assert the wording is/isn't present. No Gemini calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompts } from '../lib/broll_picker.js';

const TRANSCRIPT = [
  { startSec: 0, endSec: 3, text: 'Families wait too long to plan.' },
];
const LIBRARY = [
  { asset_id: 'c1', provenance: 'client', when_to_use: 'desk paperwork' },
  { asset_id: 'p1', provenance: 'pixabay', when_to_use: 'documents' },
];

test('buildPrompts: user prompt names provenance="client" and provenance="pixabay" so Gemini sees both labels', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  assert.match(userPrompt, /provenance="client"/);
  assert.match(userPrompt, /provenance="pixabay"/);
});

test('buildPrompts: Tier 1 — balanced clause is CLIENT-FIRST (supersedes PR-F "USE BOTH" co-equal blend)', () => {
  // 2026-05-27: Chelsea/Phil EnableSNP feedback. Pixabay is too generic to
  // drive client-facing reels' visual identity, so the default balanced mode
  // is now client-first with stock as SUPPORT/fallback — superseding PR-F's
  // co-equal "USE BOTH / healthy mix" wording. Lock the new stance.
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  assert.match(userPrompt, /CLIENT-FIRST/);
  assert.match(userPrompt, /Stock is a fallback, not a co-equal default/i);
  assert.match(userPrompt, /primary source/i);
  // The PR-F co-equal wording is intentionally GONE.
  assert.doesNotMatch(userPrompt, /USE BOTH/i);
  assert.doesNotMatch(userPrompt, /healthy mix/i);
});

test('buildPrompts: Tier 1 — STOCK QUALITY GATE forbids abstract scenery and requires concrete/human stock', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  assert.match(userPrompt, /STOCK QUALITY GATE/);
  assert.match(userPrompt, /concrete, human, and context-relevant/i);
  assert.match(userPrompt, /NEVER use abstract scenery/i);
});

test('buildPrompts: Tier 1 — REJECT rubric explicitly rejects abstract scenery unless the speaker describes nature', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  assert.match(userPrompt, /abstract scenery\/landscape/i);
  assert.match(userPrompt, /UNLESS the speaker is literally describing nature/i);
});

test('buildPrompts: PR-F — old "STRONGLY prefer / NEVER take over" wording is GONE', () => {
  // Regression guard: the PR-D wording produced too-client-heavy results
  // (Phil rerun was 7 client / 0 stock when both sources were available).
  // PR-F replaces it with AI-blend language; assert the old absolute rule
  // is no longer present.
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  assert.doesNotMatch(userPrompt, /STRONGLY prefer client/i);
  assert.doesNotMatch(userPrompt, /should NEVER take over the edit/i);
  assert.doesNotMatch(userPrompt, /SUPPLEMENTAL fallback/i);
});

test('buildPrompts: still includes the library JSON so Gemini sees provenance per row', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  // Library JSON dump must be present so the mix rule has data to act on.
  assert.match(userPrompt, /"asset_id": "c1"/);
  assert.match(userPrompt, /"provenance": "client"/);
  assert.match(userPrompt, /"provenance": "pixabay"/);
});

test('buildPrompts: PR-AN — OPENER ZONE clause forbids insertions before brollMinStartSec', () => {
  // Phoenix QC 2026-05-22: b-roll openers are objectively wrong for a
  // talking-head reel. Picker must see an explicit no-go zone at the
  // start of the timeline so it doesn't even propose one. The hard
  // floor still runs in normalizeInsertions; this is the upstream nudge.
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  // Default brollMinStartSec = 5.0s.
  assert.match(userPrompt, /OPENER ZONE/);
  assert.match(userPrompt, /below 5\.0s/);
  assert.match(userPrompt, /first 5\.0 seconds MUST show the speaker/);
});

test('buildPrompts: PR-AN — custom brollMinStartSec is substituted into the OPENER ZONE clause', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
    brollMinStartSec: 7.0,
  });
  assert.match(userPrompt, /below 7\.0s/);
  assert.match(userPrompt, /first 7\.0 seconds MUST show the speaker/);
  // The 5.0 default should not appear when explicitly overridden.
  assert.doesNotMatch(userPrompt, /below 5\.0s/);
});

test('buildPrompts: PR-G — explicit asset_id-fidelity instruction is present', () => {
  // Phil PR-F rerun (2026-05-09) failed at brollDownload because Gemini
  // truncated long client UUIDs. The prompt must explicitly tell the picker
  // to copy the full asset_id verbatim. Lock the wording so a future rewrite
  // can't silently re-introduce the regression.
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  // "exact" / "verbatim" / "do not truncate/abbreviate/shorten/invent" anchors
  assert.match(userPrompt, /exact|verbatim/i);
  assert.match(userPrompt, /do not (truncate|shorten|abbreviate)/i);
  assert.match(userPrompt, /do not (invent|make up|fabricate)/i);
  // The id-fidelity rule should specifically reference asset_id.
  assert.match(userPrompt, /full asset_id/i);
});

test('buildPrompts: coverage floor + variety + duration constraints stay intact (regression guard)', () => {
  // PR-F changed the source-selection rule; existing rules must not have regressed.
  // PR-K (2026-05-12) bumped insertion duration from [2.5s, 5.0s] → [6.0s, 8.0s]
  // with a ~7s target.
  // PR-N (2026-05-12) reframed density as a FLOOR (not target) and replaced
  // "Density target" wording with "Minimum b-roll coverage". Lock the new
  // anchors so a future rewrite can't silently revert.
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  assert.match(userPrompt, /Minimum b-roll coverage/);
  assert.match(userPrompt, /this is a FLOOR, not a target/);
  assert.match(userPrompt, /never reuse the same asset_id/);
  // PR-K defaults rolled from 6/7/8 → 4/5/5 (2026-05-19 follow-up; comment in
  // broll_picker.js lines 133-140). Anchor here updated 2026-05-22 alongside
  // PR-AN to bring CI green.
  assert.match(userPrompt, /\[4\.0s, 5\.0s\]/);
  assert.match(userPrompt, /aim for ~5\.0s/);
  assert.match(userPrompt, /Min 4s spacing/);
  // The pre-PR-K shorter range is GONE.
  assert.doesNotMatch(userPrompt, /\[2\.5s, 5\.0s\]/);
  // The pre-PR-N "Density target" wording is GONE.
  assert.doesNotMatch(userPrompt, /Density target/);
});

// ── PR-N: opportunity-driven b-roll selection ────────────────────────

test('buildPrompts: PR-N — B-ROLL-WORTHY criteria list present (illustrate / metaphor / emotion / static stretch)', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.55,
  });
  assert.match(userPrompt, /B-ROLL-WORTHY/);
  // The four worthy-moment criteria — anchors so the policy doesn't drift.
  assert.match(userPrompt, /Illustrate something the speaker references/i);
  assert.match(userPrompt, /abstract concept concrete via metaphor/i);
  assert.match(userPrompt, /emotional beat/i);
  assert.match(userPrompt, /long talking-head stretch/i);
});

test('PR-N: BETTER ON SPEAKER FACE criteria list present (expression / direct address / intimate / connective)', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.55,
  });
  assert.match(userPrompt, /BETTER ON SPEAKER FACE/);
  assert.match(userPrompt, /speaker's expression IS the visual/i);
  assert.match(userPrompt, /direct address to the viewer/i);
  assert.match(userPrompt, /intimate and emotionally charged/i);
  assert.match(userPrompt, /short connective phrase/i);
});

test('Editor-brain: coverage framed as QUALITY FLOOR / soft hint, NOT a count target', () => {
  // Supersedes the PR-N "COVERAGE FLOOR with no upper cap" rule (Chelsea
  // 2026-06-01 editor-mindset rewrite). The old framing pressured Gemini to
  // hit coverage; the new framing prioritises quality and explicitly says
  // coverage is a consequence of strong matches, not a target.
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.55,
  });
  assert.match(userPrompt, /QUALITY FLOOR/);
  assert.match(userPrompt, /SOFT HINT|soft hint/);
  assert.match(userPrompt, /Coverage is a CONSEQUENCE of strong matches/);
  assert.match(userPrompt, /Do not pad/);
  // Old "COVERAGE FLOOR" header is gone (replaced by QUALITY FLOOR).
  assert.doesNotMatch(userPrompt, /^COVERAGE FLOOR$/m);
});

test('PR-N: ANTI-PADDING rule present (weak/generic/repetitive picks not allowed to hit floor)', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.55,
  });
  assert.match(userPrompt, /ANTI-PADDING/);
  assert.match(userPrompt, /weak, generic, or repetitive/i);
  assert.match(userPrompt, /Leaving the speaker on screen is ALWAYS better/i);
  // Variety-by-concept (not just by asset_id) — repetition isn't just about IDs.
  assert.match(userPrompt, /Repetitive picks/i);
});

test('PR-N: pre-PR-N restrictive language is GONE (abstract claims, transitions ban, density target)', () => {
  // These three phrases pre-PR-N actively suppressed exactly the kinds
  // of moments Shannon wants covered. Regression guard against silent
  // revert.
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.55,
  });
  assert.doesNotMatch(userPrompt, /Pick brolls only at moments where the visual genuinely explains/i);
  assert.doesNotMatch(userPrompt, /Do NOT insert during transitions, abstract claims, or pure talky moments/i);
  assert.doesNotMatch(userPrompt, /Density target: ~/);
});

test('PR-N: floor value scales with brollDensity (per-job override still substitutes)', () => {
  // Override should flow into the "Minimum b-roll coverage" line.
  const { userPrompt: low } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 100, brollDensity: 0.3,
  });
  const { userPrompt: high } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 100, brollDensity: 0.7,
  });
  assert.match(low, /Minimum b-roll coverage: ~30\.00s.*\(30% of total\)/);
  assert.match(high, /Minimum b-roll coverage: ~70\.00s.*\(70% of total\)/);
  // Both still say it's a floor.
  assert.match(low, /FLOOR, not a target/);
  assert.match(high, /FLOOR, not a target/);
});

// ── PR-K: per-job duration overrides ─────────────────────────────────

test('buildPrompts: PR-K — per-job brollMinDurationSec / target / max are substituted into the prompt', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
    brollMinDurationSec: 5.0,
    brollTargetDurationSec: 6.5,
    brollMaxDurationSec: 9.0,
  });
  assert.match(userPrompt, /\[5\.0s, 9\.0s\]/);
  assert.match(userPrompt, /aim for ~6\.5s/);
  assert.match(userPrompt, /sub-5\.0s flashes/);
});

test('buildPrompts: PR-K — when overrides omitted, defaults (4/5/5) appear', () => {
  // Defaults rolled 6/7/8 → 4/5/5 (broll_picker.js lines 133-140).
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  assert.match(userPrompt, /\[4\.0s, 5\.0s\]/);
  assert.match(userPrompt, /aim for ~5\.0s/);
  assert.match(userPrompt, /sub-4\.0s flashes/);
});

// ── PR #130: clientPreference modes ─────────────────────────────────

test("buildPrompts: clientPreference='balanced' (default) uses the CLIENT-FIRST rule", () => {
  // Tier 1 (2026-05-27): balanced is now client-first (stock = fallback),
  // superseding PR-F's co-equal "USE BOTH" wording.
  const { userPrompt: defaultPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  const { userPrompt: explicitBalanced } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
    clientPreference: 'balanced',
  });
  // Default and explicit-balanced produce the same prompt.
  assert.equal(defaultPrompt, explicitBalanced);
  // Both contain the client-first wording; the old co-equal rule is gone.
  assert.match(defaultPrompt, /CLIENT-FIRST/);
  assert.match(defaultPrompt, /Stock is a fallback, not a co-equal default/i);
  assert.doesNotMatch(defaultPrompt, /USE BOTH/);
  // Neither contains the minimal-mode language.
  assert.doesNotMatch(defaultPrompt, /MINIMAL-CLIENT MODE/);
  assert.doesNotMatch(defaultPrompt, /STRONGLY PREFER Pixabay stock/);
});

test("buildPrompts: clientPreference='minimal' injects strong stock-bias language", () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
    clientPreference: 'minimal',
  });
  // Stock-bias anchors that lock the wording so a future rewrite can't
  // silently weaken the rule.
  assert.match(userPrompt, /MINIMAL-CLIENT MODE/);
  assert.match(userPrompt, /STRONGLY PREFER Pixabay stock/);
  assert.match(userPrompt, /at most 1-2 client picks per video/);
  assert.match(userPrompt, /Default to STOCK for all other moments/);
  assert.match(userPrompt, /Do NOT over-pick client b-roll/);
  // The default "USE BOTH" wording is REPLACED, not appended.
  assert.doesNotMatch(userPrompt, /USE BOTH\./);
});

test("buildPrompts: clientPreference='minimal' keeps the ASSET ID FIDELITY rule intact (regression)", () => {
  // Mode switch must not drop the existing constraints — only swap the
  // source-mix clause.
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
    clientPreference: 'minimal',
  });
  assert.match(userPrompt, /ASSET ID FIDELITY/);
  assert.match(userPrompt, /full asset_id/i);
  assert.match(userPrompt, /Min 4s spacing/);
  // PR-K duration range now defaults to [4.0s, 5.0s] (rolled 6/7/8 → 4/5/5).
  assert.match(userPrompt, /\[4\.0s, 5\.0s\]/);
});

test("buildPrompts: unrecognized clientPreference falls back to 'balanced' (defensive)", () => {
  // Future-proofing — if someone passes a string that isn't an
  // accepted mode, we default to the safe 'balanced' rule rather than
  // emitting a half-built prompt. (Route validation rejects invalid
  // values upstream, so this is a belt-and-braces guard.)
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
    clientPreference: 'aggressive',
  });
  assert.match(userPrompt, /CLIENT-FIRST/);
  assert.doesNotMatch(userPrompt, /MINIMAL-CLIENT MODE/);
});

// ── PR-Q: match quality rubric, cut timing, visual variety, semantic relevance ──

test('Editor-brain: system prompt enforces editor-as-reviewer mindset (supersedes PR-Q semantic-relevance wording)', () => {
  const { systemPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.55,
  });
  // Editor framing — the model is told what role to take.
  assert.match(systemPrompt, /PROFESSIONAL VIDEO EDITOR/);
  assert.match(systemPrompt, /NOT a search-result matcher/);
  // Hard rule: weak picks → drop to talking head.
  assert.match(systemPrompt, /HARD RULE.*kind of related.*DO NOT USE IT/);
  assert.match(systemPrompt, /Fewer strong picks beat more weak picks/i);
});

test('PR-Q: system prompt output schema includes match_type and visual_concept fields', () => {
  const { systemPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.55,
  });
  assert.match(systemPrompt, /match_type/);
  assert.match(systemPrompt, /visual_concept/);
  assert.match(systemPrompt, /"direct" \| "metaphor" \| "emotional"/);
});

test('PR-Q: MATCH QUALITY RUBRIC present with all four tiers (DIRECT / METAPHOR / EMOTIONAL / REJECT)', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.55,
  });
  assert.match(userPrompt, /MATCH QUALITY RUBRIC/);
  assert.match(userPrompt, /DIRECT \(strongest\)/);
  assert.match(userPrompt, /METAPHOR \(strong\)/);
  assert.match(userPrompt, /EMOTIONAL \(acceptable only as last resort\)/);
  assert.match(userPrompt, /REJECT \(never pick\)/);
});

test('PR-Q: rubric has concrete good/bad examples so Gemini sees what to pick and what to reject', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.55,
  });
  // Good examples
  assert.match(userPrompt, /Good: Speaker says/);
  // Bad examples
  assert.match(userPrompt, /Bad: Speaker says/);
  // Specific reject pattern — generic stock handshake
  assert.match(userPrompt, /generic stock handshake/i);
  // Specific reject pattern — random nature footage
  assert.match(userPrompt, /random nature footage/i);
  // REJECT instruction — leave speaker on camera
  assert.match(userPrompt, /leave the speaker on camera/i);
});

test('PR-Q: CUT TIMING section present with sentence boundary and punchline rules', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.55,
  });
  assert.match(userPrompt, /CUT TIMING/);
  assert.match(userPrompt, /never mid-word/i);
  assert.match(userPrompt, /natural sentence boundary or pause/i);
  assert.match(userPrompt, /punchline.*or emotional climax/i);
});

test('PR-Q: VISUAL VARIETY section present with consecutive-concept and diversity rules', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.55,
  });
  assert.match(userPrompt, /VISUAL VARIETY/);
  assert.match(userPrompt, /visual_concept/);
  assert.match(userPrompt, /same or very similar visual_concept consecutively/i);
  assert.match(userPrompt, /when_to_use.*context.*emotion.*insight/i);
  assert.match(userPrompt, /Do not match on asset_title alone/i);
});

test('PR-Q: constraints include match_type and visual_concept enforcement', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.55,
  });
  // match_type constraint
  assert.match(userPrompt, /match_type must be "direct", "metaphor", or "emotional"/);
  assert.match(userPrompt, /If most of your picks are "emotional", you are over-picking/);
  // visual_concept constraint
  assert.match(userPrompt, /Consecutive insertions MUST have different visual_concepts/);
});

test('Editor-brain: anti-padding self-check is the 8-question EDITOR\'S TEST (supersedes prior single-question check)', () => {
  // Old PR-Q test asserted one self-check sentence on the user prompt; the
  // editor-mindset rewrite moved self-checks into a richer 8-question
  // checklist in the system prompt, and the user prompt explicitly points
  // back to it from the ANTI-PADDING section.
  const { systemPrompt, userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.55,
  });
  assert.match(systemPrompt, /EDITOR'S TEST/);
  assert.match(systemPrompt, /DIRECTLY support the exact spoken phrase/);
  assert.match(systemPrompt, /ACTUALLY visible in the clip/);
  // The user-prompt ANTI-PADDING block now references the editor's test.
  assert.match(userPrompt, /ANTI-PADDING/);
  assert.match(userPrompt, /EDITOR'S TEST/);
});

test('PR-Q: BETTER ON SPEAKER FACE includes momentum/punchline rule', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.55,
  });
  assert.match(userPrompt, /building to a punchline or key point.*cutting away breaks momentum/i);
});

test('Editor-brain: the old "TARGET 10 INSERTIONS" coverage pressure is GONE', () => {
  // Inversion of the prior PR-Q assertion (which locked the count target).
  // The editor-mindset rewrite removes count targets entirely — fewer
  // strong picks beat more weak picks. This guard prevents accidental
  // re-introduction of the count target via a future refactor.
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 120, brollDensity: 0.55,
  });
  assert.doesNotMatch(userPrompt, /TARGET AT LEAST 10 INSERTIONS/i);
  assert.doesNotMatch(userPrompt, /any video over 60 seconds/i);
  // Sanity: the new framing IS present.
  assert.match(userPrompt, /Coverage is a CONSEQUENCE of strong matches/);
});
