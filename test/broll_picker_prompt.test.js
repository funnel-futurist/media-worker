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

test('buildPrompts: density target + variety + duration constraints stay intact (regression guard)', () => {
  // PR-F changed the source-selection rule; existing rules must not have regressed.
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  assert.match(userPrompt, /Density target/);
  assert.match(userPrompt, /never reuse the same asset_id/);
  assert.match(userPrompt, /\[2\.5s, 5\.0s\]/);
  assert.match(userPrompt, /Min 4s spacing/);
});
