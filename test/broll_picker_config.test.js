/**
 * test/broll_picker_config.test.js
 *
 * Lock-in tests for broll_picker tuning that's been an issue across multiple
 * runs. Source-snapshot style — same pattern as compose_filter.test.js — so
 * future drift triggers a CI failure instead of a quiet production regression.
 *
 * Specifically guards:
 *   - Per-attempt Gemini timeout stays at 120s (PR #113 — bumped from 60s
 *     after B9 attempts on 2026-05-08 hit two consecutive 60s timeouts).
 *   - Default broll picker model stays in the Pro tier (Shannon's directive:
 *     "Do not downgrade to Flash"). Catches accidental swaps to a Flash
 *     variant in the broll-pick path, which would silently reduce quality.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, '..', 'lib', 'broll_picker.js');
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

test('broll_picker: per-attempt timeout is 120s (PR #113)', () => {
  // The axios call in callGeminiWithRetry must use a 120000ms timeout.
  // Pre-PR #113 was 60_000, which was too tight for gemini-3.1-pro-preview's
  // tail latency on busy days (B9 hit two consecutive 60s timeouts).
  assert.match(
    SOURCE,
    /timeout:\s*120_000\b/,
    'expected `timeout: 120_000` in callGeminiWithRetry — Pro model needs the wider budget',
  );
  assert.doesNotMatch(
    SOURCE,
    /timeout:\s*60_000\b/,
    'pre-PR #113 60s timeout must NOT appear — was the cause of B9 broll-pick failures',
  );
});

test('broll_picker: DEFAULT_MODEL stays in the Pro tier (no silent downgrade to Flash)', () => {
  // Shannon's directive 2026-05-08: "Do not downgrade to Flash" for the broll
  // picker. Pro provides materially better picks than Flash for the structured
  // selection task; we accept the latency premium. This test guards against
  // accidental swaps.
  //
  // The constant is exported as DEFAULT_MODEL. Tests we expect:
  //   - matches /pro/i in the model id
  //   - does NOT match /flash/i
  const defaultModelMatch = SOURCE.match(/(?:export\s+)?const\s+DEFAULT_MODEL\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(defaultModelMatch, 'expected `DEFAULT_MODEL` constant declared in broll_picker.js');
  const modelId = defaultModelMatch[1];
  assert.match(modelId, /pro/i, `DEFAULT_MODEL "${modelId}" must be a Pro variant — Flash downgrade is forbidden`);
  assert.doesNotMatch(modelId, /flash/i, `DEFAULT_MODEL "${modelId}" must not contain "flash"`);
});
