/**
 * test/broll_picker_prompt.test.js
 *
 * Pure-function snapshot tests on broll_picker `buildPrompts`. Locks down the
 * PR-D "prefer client over Pixabay" constraint so a future prompt rewrite
 * can't silently let stock take over the edit again.
 *
 * Pattern matches test/clean_mode_models_lock.test.js — read the source,
 * assert the wording is present. No Gemini calls.
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

test('buildPrompts: user prompt explicitly tells Gemini to PREFER client over pixabay', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  // The exact word "prefer" (case-insensitive) anchored on client > pixabay.
  assert.match(userPrompt, /STRONGLY prefer client/i);
  // And the inverse: pixabay is supplemental / fallback / fill.
  assert.match(userPrompt, /Pixabay is a SUPPLEMENTAL fallback/i);
});

test('buildPrompts: user prompt forbids Pixabay from taking over when client assets exist', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  // Wording from Shannon's PR-D directive — locked so a refactor can't soften it.
  assert.match(userPrompt, /should NEVER take over the edit/i);
  assert.match(userPrompt, /ALWAYS pick the client asset/i);
});

test('buildPrompts: still includes the library JSON so Gemini sees provenance per row', () => {
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  // Library JSON dump must be present so the prefer-client rule has data to act on.
  assert.match(userPrompt, /"asset_id": "c1"/);
  assert.match(userPrompt, /"provenance": "client"/);
  assert.match(userPrompt, /"provenance": "pixabay"/);
});

test('buildPrompts: density target + variety + duration constraints stay intact (regression guard)', () => {
  // PR-D added a constraint; existing rules must not have regressed.
  const { userPrompt } = buildPrompts({
    transcript: TRANSCRIPT, library: LIBRARY, totalDuration: 60, brollDensity: 0.4,
  });
  assert.match(userPrompt, /Density target/);
  assert.match(userPrompt, /never reuse the same asset_id/);
  assert.match(userPrompt, /\[2\.5s, 5\.0s\]/);
  assert.match(userPrompt, /Min 4s spacing/);
});
