/**
 * test/ad_variation_qc.test.js
 *
 * Unit tests for verdictFromScore (pure) + source-snapshot of the QC contract
 * (the Gemini call itself can't run in CI). Mirrors the no-network test style.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verdictFromScore } from '../lib/ad_variation_qc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '../lib/ad_variation_qc.js'), 'utf8');

test('verdictFromScore: 90+ green, 70-89 yellow, <70 red', () => {
  assert.equal(verdictFromScore(95), 'green');
  assert.equal(verdictFromScore(90), 'green');
  assert.equal(verdictFromScore(89), 'yellow');
  assert.equal(verdictFromScore(70), 'yellow');
  assert.equal(verdictFromScore(69), 'red');
  assert.equal(verdictFromScore(0), 'red');
  assert.equal(verdictFromScore(NaN), 'yellow'); // safe fallback
});

test('QC prompt checks framing / captions / banner / seams / delivery', () => {
  assert.match(src, /FRAMING/);
  assert.match(src, /cut off at the top/i);
  assert.match(src, /CAPTIONS/);
  assert.match(src, /BANNER/);
  assert.match(src, /SEAMS/);
  assert.match(src, /DELIVERY/);
});

test('QC returns the reel-QC shape: verdict + quality + energy + why + action', () => {
  assert.match(src, /"verdict"/);
  assert.match(src, /"quality"/);
  assert.match(src, /"energy"/);
  assert.match(src, /"why"/);
  assert.match(src, /"action"/);
});

test('QC is advisory + non-fatal (returns null on any failure, no throw)', () => {
  assert.match(src, /return null/);
  assert.match(src, /non-fatal/i);
  assert.match(src, /ADVISORY ONLY/i);
});
