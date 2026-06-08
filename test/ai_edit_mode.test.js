/**
 * test/ai_edit_mode.test.js
 *
 * Pure-function tests for resolveAiEditMode — the preset that bundles
 * "subtitles_hook_only" / "hook_subtitles_broll" into the underlying
 * pipeline flags (skipBroll + introHookEnabled), with explicit-flag-wins
 * precedence so existing callers passing the granular flags directly are
 * unaffected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAiEditMode,
  isValidAiEditMode,
  AI_EDIT_MODES,
  DEFAULT_AI_EDIT_MODE,
} from '../lib/ai_edit_mode.js';

// ── enum surface ───────────────────────────────────────────────────────

test('AI_EDIT_MODES exposes exactly the two modes', () => {
  assert.deepEqual([...AI_EDIT_MODES], ['subtitles_hook_only', 'hook_subtitles_broll']);
});

test("DEFAULT_AI_EDIT_MODE is 'hook_subtitles_broll' — preserves current production behavior when callers omit the field", () => {
  assert.equal(DEFAULT_AI_EDIT_MODE, 'hook_subtitles_broll');
});

test('isValidAiEditMode: only the two strings pass; everything else is invalid', () => {
  assert.equal(isValidAiEditMode('subtitles_hook_only'), true);
  assert.equal(isValidAiEditMode('hook_subtitles_broll'), true);
  assert.equal(isValidAiEditMode('clean_talking_head'), false);
  assert.equal(isValidAiEditMode(''), false);
  assert.equal(isValidAiEditMode(undefined), false);
  assert.equal(isValidAiEditMode(null), false);
  assert.equal(isValidAiEditMode(42), false);
});

// ── preset → flag mapping ──────────────────────────────────────────────

test("preset 'subtitles_hook_only' → {skipBroll:true, introHookEnabled:true, source:'preset'}", () => {
  const r = resolveAiEditMode({ aiEditMode: 'subtitles_hook_only' });
  assert.deepEqual(r, {
    aiEditMode: 'subtitles_hook_only',
    skipBroll: true,
    introHookEnabled: true,
    source: 'preset',
  });
});

test("preset 'hook_subtitles_broll' → {skipBroll:false, introHookEnabled:true, source:'preset'}", () => {
  const r = resolveAiEditMode({ aiEditMode: 'hook_subtitles_broll' });
  assert.deepEqual(r, {
    aiEditMode: 'hook_subtitles_broll',
    skipBroll: false,
    introHookEnabled: true,
    source: 'preset',
  });
});

// ── default behavior (caller omits aiEditMode) ─────────────────────────

test('aiEditMode omitted → falls back to default hook_subtitles_broll (current behavior preserved)', () => {
  const r = resolveAiEditMode({});
  assert.equal(r.aiEditMode, 'hook_subtitles_broll');
  assert.equal(r.skipBroll, false);
  assert.equal(r.introHookEnabled, true);
});

test('aiEditMode omitted + no explicit() at all → still safe default', () => {
  const r = resolveAiEditMode();
  assert.equal(r.aiEditMode, 'hook_subtitles_broll');
  assert.equal(r.skipBroll, false);
  assert.equal(r.introHookEnabled, true);
});

test('invalid aiEditMode value (would normally be caught at the route) → falls back to default', () => {
  const r = resolveAiEditMode({ aiEditMode: 'subtitles_only' });
  assert.equal(r.aiEditMode, 'hook_subtitles_broll');
});

// ── explicit-flag-wins precedence (backward compatibility) ─────────────

test("explicit skipBroll:false beats preset 'subtitles_hook_only' (caller knows best)", () => {
  const r = resolveAiEditMode({
    aiEditMode: 'subtitles_hook_only',
    explicit: { skipBroll: false },
  });
  assert.equal(r.skipBroll, false, 'explicit skipBroll:false should override the preset');
  assert.equal(r.introHookEnabled, true, 'introHook is still the preset default');
  assert.equal(r.source, 'mixed', 'one explicit + one preset → mixed');
});

test("explicit skipBroll:true beats preset 'hook_subtitles_broll'", () => {
  const r = resolveAiEditMode({
    aiEditMode: 'hook_subtitles_broll',
    explicit: { skipBroll: true },
  });
  assert.equal(r.skipBroll, true);
});

test('explicit introHookEnabled:false beats both presets (operator turns hook off)', () => {
  const r1 = resolveAiEditMode({
    aiEditMode: 'subtitles_hook_only',
    explicit: { introHookEnabled: false },
  });
  assert.equal(r1.introHookEnabled, false);

  const r2 = resolveAiEditMode({
    aiEditMode: 'hook_subtitles_broll',
    explicit: { introHookEnabled: false },
  });
  assert.equal(r2.introHookEnabled, false);
});

test("both explicit flags set → source:'explicit'", () => {
  const r = resolveAiEditMode({
    aiEditMode: 'hook_subtitles_broll',
    explicit: { skipBroll: true, introHookEnabled: false },
  });
  assert.equal(r.source, 'explicit');
  assert.equal(r.skipBroll, true);
  assert.equal(r.introHookEnabled, false);
});

test("no explicit flags set → source:'preset'", () => {
  const r = resolveAiEditMode({ aiEditMode: 'subtitles_hook_only' });
  assert.equal(r.source, 'preset');
});

test('non-boolean explicit values (null, undefined, string) are NOT honored — only `boolean` counts', () => {
  // The buildPipelineOpts coercion may produce undefined for unset fields;
  // the resolver must treat those as "not explicit" and use the preset.
  const r = resolveAiEditMode({
    aiEditMode: 'subtitles_hook_only',
    explicit: { skipBroll: undefined, introHookEnabled: null },
  });
  assert.equal(r.skipBroll, true, 'undefined → preset wins');
  assert.equal(r.introHookEnabled, true, 'null → preset wins');
  assert.equal(r.source, 'preset');
});
