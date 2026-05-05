/**
 * test/slugify.test.js
 *
 * Pure-function tests for lib/clean_mode_pipeline.js:slugify.
 * Used by validateSourcePairing (PR #97) to compare the leading folder of
 * sourceMP4.path against the resolved client_name.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../lib/clean_mode_pipeline.js';

test('slugify: simple single word', () => {
  assert.equal(slugify('Justine'), 'justine');
  assert.equal(slugify('JUSTINE'), 'justine');
  assert.equal(slugify('justine'), 'justine');
});

test('slugify: pipe and ampersand collapse to single dashes', () => {
  // Real client_content_config rows
  assert.equal(slugify('Chelsea & Phil | EnableSNP'), 'chelsea-phil-enablesnp');
  assert.equal(slugify('Joe Sebestyen | SupportED Tutoring'), 'joe-sebestyen-supported-tutoring');
  assert.equal(slugify('Bradley Pounds | Appointment Daddy'), 'bradley-pounds-appointment-daddy');
  assert.equal(slugify('Chris Watters | Watters International'), 'chris-watters-watters-international');
});

test('slugify: collapses runs of whitespace/punctuation', () => {
  assert.equal(slugify('  Hello   World!! '), 'hello-world');
  assert.equal(slugify('Foo---Bar'), 'foo-bar');
  assert.equal(slugify('Foo   Bar'), 'foo-bar');
});

test('slugify: digits preserved, non-ascii dropped', () => {
  assert.equal(slugify('Day 5 Talking Heads'), 'day-5-talking-heads');
  assert.equal(slugify('Café & Co'), 'caf-co');                // accented stripped via [^a-z0-9]+
});

test('slugify: empty / nullish input returns empty string (no throw)', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
});

test('slugify: leading/trailing dashes stripped', () => {
  assert.equal(slugify('---hello---'), 'hello');
  assert.equal(slugify('!Hello!'), 'hello');
});

test('slugify: produces values that work with substring matching for inputValidation', () => {
  // path slug "justine-cyborg-va" should pass when expected slug is "justine"
  // because pathSlug.includes(expectedSlug) is true.
  const path = slugify('justine-cyborg-va');
  const expected = slugify('Justine');
  assert.equal(path, 'justine-cyborg-va');
  assert.equal(expected, 'justine');
  assert.ok(path.includes(expected));
});

test('slugify: deterministic — repeated calls return identical output', () => {
  const inputs = ['Justine', 'Chelsea & Phil | EnableSNP', '', '  Spaces  '];
  for (const i of inputs) {
    assert.equal(slugify(i), slugify(i));
  }
});
