/**
 * test/broll_picker_quality_floor.test.js
 *
 * Editor-brain picker — verifies that:
 *   (a) the prompt encodes the per-dimension scoring rubric + quality floor
 *   (b) the post-Gemini filter (`filterByQualityFloor`) drops picks whose
 *       composite_score is below the floor, keeps strong ones, and is
 *       backward-compatible with score-less picks.
 *
 * Pure functions — no Gemini calls.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompts, filterByQualityFloor } from "../lib/broll_picker.js";

// ── Prompt encoding ─────────────────────────────────────────────────────────

const MIN_ARGS = {
  transcript: [{ startSec: 0, endSec: 3, text: "Families plan early." }],
  library: [{ asset_id: "p1", provenance: "pixabay", when_to_use: "documents" }],
  totalDuration: 60,
  brollDensity: 0.55,
};

test("system prompt names the 7 editor dimensions", () => {
  const { systemPrompt } = buildPrompts(MIN_ARGS);
  for (const dim of [
    "phrase_match",
    "visual_specificity",
    "editorial_fit",
    "brand_tone_fit",
    "seasonality_fit",
    "distraction_risk",
    "repetition_risk",
  ]) {
    assert.match(systemPrompt, new RegExp(dim), `dimension ${dim} missing from prompt`);
  }
});

test("system prompt requires composite_score + names the floor", () => {
  const { systemPrompt } = buildPrompts({ ...MIN_ARGS, brollQualityFloor: 7.0 });
  assert.match(systemPrompt, /composite_score/);
  // Floor is rendered as "7.0" in the QUALITY FLOOR sentence.
  assert.match(systemPrompt, /7\.0/);
});

test("system prompt drops the old 'TARGET 10 INSERTIONS' coverage pressure", () => {
  const { userPrompt } = buildPrompts(MIN_ARGS);
  assert.doesNotMatch(userPrompt, /TARGET AT LEAST 10 INSERTIONS/i,
    "coverage pressure should be removed — picker must not chase a count");
});

test("user prompt frames coverage as a soft hint, not a floor", () => {
  const { userPrompt } = buildPrompts(MIN_ARGS);
  assert.match(userPrompt, /QUALITY FLOOR/);
  assert.match(userPrompt, /SOFT HINT|soft hint/);
});

test("system prompt includes the 8-question editor's test", () => {
  const { systemPrompt } = buildPrompts(MIN_ARGS);
  assert.match(systemPrompt, /EDITOR'S TEST/);
  // Sample phrases from Shannon's spec that must appear verbatim or close.
  assert.match(systemPrompt, /DIRECTLY support the exact spoken phrase/);
  assert.match(systemPrompt, /ACTUALLY visible in the clip/);
  assert.match(systemPrompt, /HARD RULE/);
});

// ── filterByQualityFloor: behavior ──────────────────────────────────────────

test("filter drops picks with composite_score below the floor", () => {
  const picks = [
    { asset_id: "a", composite_score: 8.5, reason: "strong cabinet match" },
    { asset_id: "b", composite_score: 5.2, reason: "loose keyword match" },
    { asset_id: "c", composite_score: 6.0, reason: "borderline — at floor" },
    { asset_id: "d", composite_score: 3.1, reason: "generic filler" },
  ];
  const { kept, rejected } = filterByQualityFloor(picks, 6.0);
  assert.deepStrictEqual(kept.map((p) => p.asset_id), ["a", "c"]);
  assert.deepStrictEqual(rejected.map((p) => p.asset_id), ["b", "d"]);
  // Rejection reason includes both numbers for operator clarity.
  assert.match(rejected[0].rejection_reason, /5\.2.*6\.0/);
  assert.match(rejected[1].rejection_reason, /3\.1.*6\.0/);
});

test("filter keeps picks without a composite_score (backward compat)", () => {
  const picks = [
    { asset_id: "old", reason: "no score field — older prompt variant" },
    { asset_id: "new-weak", composite_score: 2.0 },
  ];
  const { kept, rejected } = filterByQualityFloor(picks, 6.0);
  assert.deepStrictEqual(kept.map((p) => p.asset_id), ["old"]);
  assert.deepStrictEqual(rejected.map((p) => p.asset_id), ["new-weak"]);
});

test("filter keeps picks with non-numeric composite_score (treats as missing)", () => {
  const picks = [
    { asset_id: "bad-type-a", composite_score: "high" },
    { asset_id: "bad-type-b", composite_score: null },
    { asset_id: "good", composite_score: 7.0 },
  ];
  const { kept } = filterByQualityFloor(picks, 6.0);
  // All three kept — the two non-numeric ones treated as "unsigned" (kept),
  // and 7.0 is above floor.
  assert.deepStrictEqual(kept.map((p) => p.asset_id), ["bad-type-a", "bad-type-b", "good"]);
});

test("filter with floor=0 keeps everything (sanity)", () => {
  const picks = [
    { asset_id: "a", composite_score: 0.5 },
    { asset_id: "b", composite_score: 9.9 },
  ];
  const { kept, rejected } = filterByQualityFloor(picks, 0);
  assert.equal(kept.length, 2);
  assert.equal(rejected.length, 0);
});

test("filter with floor=10 drops everything below perfect (sanity)", () => {
  const picks = [
    { asset_id: "a", composite_score: 9.9 },
    { asset_id: "b", composite_score: 10 },
  ];
  const { kept } = filterByQualityFloor(picks, 10);
  // Only the exact-10 pick survives.
  assert.deepStrictEqual(kept.map((p) => p.asset_id), ["b"]);
});

// ── End-to-end: simulating the cabinets-vs-electrical regression ────────────
// Reproduces the exact failure mode Chelsea flagged: a candidate matched the
// word "electrical" but the spoken moment was "cabinets". Editor scoring
// should produce a low composite (esp. phrase_match + visual_specificity).
// The filter then drops it to talking-head.

test("rejects keyword-only match that doesn't fit the spoken word", () => {
  // Simulated Gemini output AFTER the new prompt — model gave the
  // electrical-on-cabinets pick a low phrase_match/specificity but high
  // distraction_risk, producing a composite below the floor.
  const fakeGeminiPick = {
    asset_id: "pexels-video-28886877",
    startSec: 4.88,
    endSec: 9.88,
    matchedPhrase: "the cabinets do not come before the electrical",
    visual_concept: "electrician at panel",
    match_type: "direct",
    reason: "Pexels tagged with 'electrical' — but speaker is referencing CABINETS at this moment",
    scores: {
      phrase_match: 2,        // visual shows electrical, spoken word is "cabinets"
      visual_specificity: 3,  // electrician visible, but wrong subject
      editorial_fit: 2,       // an editor would NOT choose this here
      brand_tone_fit: 5,      // construction-adjacent, neutral
      seasonality_fit: 8,     // no seasonal issue
      distraction_risk: 7,    // viewer asks "why electrical when speaker said cabinets?"
      repetition_risk: 0,     // fresh asset
    },
    composite_score: 2.6,     // (2+3+2+5+8) - (7+0) = 13 → /5 = 2.6
  };
  // A strong cabinet pick that should survive.
  const fakeStrongPick = {
    asset_id: "pexels-video-7226912",
    startSec: 5,
    endSec: 10,
    matchedPhrase: "renovated a kitchen, you know the cabinets",
    visual_concept: "man opening cabinet",
    match_type: "direct",
    reason: "Cabinet door interaction visible — directly matches 'cabinets' reference",
    scores: {
      phrase_match: 10,
      visual_specificity: 9,
      editorial_fit: 9,
      brand_tone_fit: 8,
      seasonality_fit: 8,
      distraction_risk: 1,
      repetition_risk: 0,
    },
    composite_score: 8.6,    // (10+9+9+8+8) - (1+0) = 43 → /5 = 8.6
  };

  const { kept, rejected } = filterByQualityFloor(
    [fakeGeminiPick, fakeStrongPick],
    6.0,
  );

  assert.equal(kept.length, 1, "only the strong cabinet pick should survive");
  assert.equal(kept[0].asset_id, "pexels-video-7226912");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].asset_id, "pexels-video-28886877");
  assert.match(rejected[0].rejection_reason, /2\.6.*6\.0/);
});
