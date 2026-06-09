/**
 * test/hook_brand_caps_and_title_fallback.test.js
 *
 * 2026-06-10: pin two related behaviors to fix Chelsea's feedback
 * on the EnableSNP Jun 8-14 batch:
 *
 *  1. Brand stylization (Tue Jun 9): the LLM hook prompt enforces
 *     "Title Case" so the brand "ENABLE" kept rendering as "Enable".
 *     Tests cover the post-validation uppercase normalization.
 *
 *  2. Hook entirely missing (Wed Jun 10, Fri Jun 12): the LLM
 *     generated hooks that failed validateHookText (probably
 *     end-punctuation or non-ascii). Tests cover the deterministic
 *     title-fallback that fires when both Pro AND Flash fail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBrandAllCaps,
  deriveHookFromTitle,
  generateHookText,
} from '../lib/hook_generate.js';

// ── applyBrandAllCaps (pure) ──────────────────────────────────────────────

test('applyBrandAllCaps: whole-word case-insensitive replace ("Enable" → "ENABLE")', () => {
  assert.equal(applyBrandAllCaps('Enable Foundational Planning Program', ['ENABLE']), 'ENABLE Foundational Planning Program');
  assert.equal(applyBrandAllCaps('enable starts with vision', ['ENABLE']), 'ENABLE starts with vision');
  assert.equal(applyBrandAllCaps('ENABLE has not changed', ['ENABLE']), 'ENABLE has not changed');
});

test('applyBrandAllCaps: word boundary protects adjacent letters (does NOT touch "enabled" or "Enables")', () => {
  assert.equal(applyBrandAllCaps('Why this is enabled now', ['ENABLE']), 'Why this is enabled now');
  assert.equal(applyBrandAllCaps('This Enables Everything', ['ENABLE']), 'This Enables Everything');
});

test('applyBrandAllCaps: punctuation around the term still matches', () => {
  assert.equal(applyBrandAllCaps('At Enable, we start with vision', ['ENABLE']), 'At ENABLE, we start with vision');
  assert.equal(applyBrandAllCaps('Enable.', ['ENABLE']), 'ENABLE.');
});

test('applyBrandAllCaps: multiple terms', () => {
  assert.equal(applyBrandAllCaps('At Enable we use SupportED daily', ['ENABLE', 'SUPPORTED']), 'At ENABLE we use SUPPORTED daily');
});

test('applyBrandAllCaps: empty / undefined / non-array → unchanged', () => {
  assert.equal(applyBrandAllCaps('hello world', undefined), 'hello world');
  assert.equal(applyBrandAllCaps('hello world', []), 'hello world');
  assert.equal(applyBrandAllCaps('hello world', null), 'hello world');
  assert.equal(applyBrandAllCaps('', ['ENABLE']), '');
});

test('applyBrandAllCaps: regex-meta characters in a term are escaped', () => {
  // Hypothetical brand term with a dot — should still match literally.
  assert.equal(applyBrandAllCaps('Hello A.B.C team', ['A.B.C']), 'Hello A.B.C team');
});

// ── deriveHookFromTitle (pure) ────────────────────────────────────────────

test('deriveHookFromTitle: extracts the meaningful tail of an EnableSNP title pattern', () => {
  // The exact title format the portal stores for these reels.
  assert.equal(
    deriveHookFromTitle('REEL | Reel - WEDNESDAY - Talking Heads - Comprehensive_Doesnt_Mean_Complicated'),
    'Comprehensive Doesnt Mean Complicated',
  );
  assert.equal(
    deriveHookFromTitle('REEL | Reel - FRIDAY - Talking Heads - The_Plan_Cant_Live_Only_in_One_Parents_Head'),
    'The Plan Cant Live Only In One Parents',  // 8-word cap drops "Head"
  );
});

test('deriveHookFromTitle: enforces the introMaxWords cap', () => {
  const long = 'REEL | Reel - One_Two_Three_Four_Five_Six_Seven_Eight_Nine_Ten';
  const out = deriveHookFromTitle(long);
  assert.ok(out !== null, 'should not return null');
  const wordCount = out.split(/\s+/).length;
  assert.ok(wordCount <= 8, `expected ≤8 words, got ${wordCount} ("${out}")`);
});

test('deriveHookFromTitle: returns null when title is empty / falsy', () => {
  assert.equal(deriveHookFromTitle(''), null);
  assert.equal(deriveHookFromTitle('   '), null);
  assert.equal(deriveHookFromTitle(undefined), null);
  assert.equal(deriveHookFromTitle(null), null);
});

test('deriveHookFromTitle: Title Cases the extracted text', () => {
  assert.equal(deriveHookFromTitle('REEL | Reel - Some_thing_lowercase_HERE'), 'Some Thing Lowercase Here');
});

// ── generateHookText end-to-end: brand normalization on LLM success ──────

test('generateHookText: brand normalization is applied to a successful Pro hook', async () => {
  // Stub Gemini to return a Title-Case hook with "Enable" in it.
  const fakeCallGemini = async () => ({
    ok: true,
    data: {
      candidates: [{
        content: { parts: [{ text: JSON.stringify({ hookText: 'Enable Starts With Vision' }) }] },
      }],
    },
  });
  const result = await generateHookText({
    transcriptText: 'we start with vision at enable',
    apiKey: 'test',
    callGemini: fakeCallGemini,
    brandTermsAllCaps: ['ENABLE'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.hookText, 'ENABLE Starts With Vision');
});

// ── generateHookText end-to-end: title fallback on LLM failure ───────────

test('generateHookText: when Pro + Flash both fail, falls back to deriveHookFromTitle (with brand normalization)', async () => {
  // Stub Gemini to fail validation on BOTH Pro and Flash. The model
  // returns a hook ending in a question mark — invalid.
  const fakeCallGemini = async () => ({
    ok: true,
    data: {
      candidates: [{
        content: { parts: [{ text: JSON.stringify({ hookText: 'Will This Work?' }) }] },
      }],
    },
  });
  const result = await generateHookText({
    transcriptText: 'long transcript here about enable',
    apiKey: 'test',
    callGemini: fakeCallGemini,
    brandTermsAllCaps: ['ENABLE'],
    titleForHookFallback: 'REEL | Reel - WEDNESDAY - Talking Heads - Enable_Comprehensive_Planning_Today',
  });
  assert.equal(result.ok, true, 'should succeed via title fallback');
  assert.equal(result.model, 'fallback_title');
  assert.equal(result.usedTitleFallback, true);
  // Brand normalization applied — "Enable" → "ENABLE" even in the fallback.
  assert.ok(result.hookText.startsWith('ENABLE '), `expected ENABLE-prefixed hook, got "${result.hookText}"`);
});

test('generateHookText: when LLM fails AND no titleForHookFallback provided → legacy skip-and-warn', async () => {
  const fakeCallGemini = async () => ({
    ok: true,
    data: {
      candidates: [{
        content: { parts: [{ text: JSON.stringify({ hookText: 'Will This Work?' }) }] },
      }],
    },
  });
  const result = await generateHookText({
    transcriptText: 'transcript',
    apiKey: 'test',
    callGemini: fakeCallGemini,
    // no titleForHookFallback
  });
  assert.equal(result.ok, false, 'should NOT auto-succeed without a fallback');
  assert.equal(result.reason, 'invalid_hook_text');
});

test('generateHookText: title-fallback derived hook is Title-Case so the overlay reads correctly', async () => {
  const fakeCallGemini = async () => ({
    ok: true,
    data: {
      candidates: [{
        content: { parts: [{ text: JSON.stringify({ hookText: 'Bad?' }) }] },
      }],
    },
  });
  const result = await generateHookText({
    transcriptText: 'transcript',
    apiKey: 'test',
    callGemini: fakeCallGemini,
    titleForHookFallback: 'REEL | Reel - SATURDAY - Calm_Reminder_About_June_30',
  });
  assert.equal(result.ok, true);
  assert.equal(result.hookText, 'Calm Reminder About June 30');
});
