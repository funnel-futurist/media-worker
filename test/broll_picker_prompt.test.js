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

test('buildPrompts: PR-F — user prompt tells Gemini to USE BOTH sources for a healthy mix', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  assert.match(userPrompt, /USE BOTH/i);
  assert.match(userPrompt, /healthy mix/i);
});

test('buildPrompts: PR-F — user prompt frames the choice as "what fits the moment best", not "fallback"', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  // Wording from Shannon's PR-F directive — locked so a future rewrite can't soften.
  assert.match(userPrompt, /best fits|best fit/i);
  // Prefer-client clause is now CONDITIONAL on "relevance is similar", not absolute.
  assert.match(userPrompt, /prefer client only when relevance is/i);
  // Stock is OK to pick when it explains the moment more directly.
  assert.match(userPrompt, /pick stock when it (explains|fills|fits)/i);
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
  assert.match(userPrompt, /\[6\.0s, 8\.0s\]/);
  assert.match(userPrompt, /aim for ~7\.0s/);
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

test('PR-N: coverage framed as FLOOR with no upper cap, exceed when script supports more', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.55,
  });
  assert.match(userPrompt, /COVERAGE FLOOR/);
  assert.match(userPrompt, /AT LEAST/);
  assert.match(userPrompt, /NO upper cap/i);
  assert.match(userPrompt, /exceed the floor/i);
  // Stop-at-floor language for low-opportunity scripts.
  assert.match(userPrompt, /stop at the floor/i);
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

test('buildPrompts: PR-K — when overrides omitted, defaults (6/7/8) appear', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  assert.match(userPrompt, /\[6\.0s, 8\.0s\]/);
  assert.match(userPrompt, /aim for ~7\.0s/);
  assert.match(userPrompt, /sub-6\.0s flashes/);
});

// ── PR #130: clientPreference modes ─────────────────────────────────

test("buildPrompts: clientPreference='balanced' (default) uses the AI-blend USE BOTH rule", () => {
  const { userPrompt: defaultPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  const { userPrompt: explicitBalanced } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
    clientPreference: 'balanced',
  });
  // Default and explicit-balanced produce the same prompt.
  assert.equal(defaultPrompt, explicitBalanced);
  // Both contain the "USE BOTH" wording.
  assert.match(defaultPrompt, /USE BOTH/);
  assert.match(defaultPrompt, /healthy mix/i);
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
  // PR-K: duration range is now [6.0s, 8.0s] (was [2.5s, 5.0s] pre-PR-K).
  assert.match(userPrompt, /\[6\.0s, 8\.0s\]/);
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
  assert.match(userPrompt, /USE BOTH/);
  assert.doesNotMatch(userPrompt, /MINIMAL-CLIENT MODE/);
});
