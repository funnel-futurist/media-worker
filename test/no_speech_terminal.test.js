/**
 * test/no_speech_terminal.test.js
 *
 * Locks the "no speech in source = terminal failure" behavior added so the
 * portal's hourly retry-failed-edits sweep can skip non-retryable jobs
 * instead of re-firing them ~every hour (burning Deepgram credit + Slack
 * noise). Context: a Chelsea & Phil / EnableSNP reel whose source had an
 * audio track but no recognizable speech failed at transcribe and got
 * re-fired hourly (2026-06-19).
 *
 * Two units under test:
 *   - isNoSpeechError(message)            (lib/clean_mode_pipeline.js)
 *   - buildReelFailedPayload({ terminal }) (lib/portal_webhook.js)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isNoSpeechError } from '../lib/clean_mode_pipeline.js';
import { buildReelFailedPayload } from '../lib/portal_webhook.js';

// ── isNoSpeechError ──────────────────────────────────────────────────

test('isNoSpeechError: true for the new human-readable message', () => {
  assert.equal(
    isNoSpeechError('No speech detected in source audio — verify the uploaded file. (Deepgram returned 0 words; ...)'),
    true,
  );
});

test('isNoSpeechError: true for the legacy "Deepgram returned 0 words" phrasing', () => {
  assert.equal(isNoSpeechError('Deepgram returned 0 words — cannot proceed. Sample: {...}'), true);
});

test('isNoSpeechError: false for other transcribe errors (retryable infra)', () => {
  assert.equal(isNoSpeechError('Deepgram 503 — service unavailable'), false);
  assert.equal(isNoSpeechError('Deepgram 429 — rate limited'), false);
});

test('isNoSpeechError: false for unrelated steps + empty/nullish input', () => {
  assert.equal(isNoSpeechError('ffmpeg compose failed'), false);
  assert.equal(isNoSpeechError(''), false);
  assert.equal(isNoSpeechError(undefined), false);
  assert.equal(isNoSpeechError(null), false);
});

// ── buildReelFailedPayload terminal flag ─────────────────────────────

test('buildReelFailedPayload: includes terminal:true only when passed true', () => {
  const p = buildReelFailedPayload({
    contentItemId: 'item-1',
    clientId: 'client-1',
    jobId: 'job-1',
    failedStep: 'transcribe',
    errorMessage: 'No speech detected in source audio — verify the uploaded file.',
    terminal: true,
  });
  assert.equal(p.terminal, true);
  assert.equal(p.outcome, 'failed');
  assert.equal(p.failedStep, 'transcribe');
});

test('buildReelFailedPayload: omits terminal for retryable failures (default + false)', () => {
  const base = {
    contentItemId: 'item-1', clientId: 'client-1', jobId: 'job-1',
    failedStep: 'compose', errorMessage: 'ffmpeg compose failed',
  };
  // not passed
  assert.equal('terminal' in buildReelFailedPayload(base), false);
  // explicitly false
  assert.equal('terminal' in buildReelFailedPayload({ ...base, terminal: false }), false);
  // any non-true value is treated as retryable
  assert.equal('terminal' in buildReelFailedPayload({ ...base, terminal: 'yes' }), false);
});
