/**
 * test/recompose_broll.test.js
 *
 * Pure-function tests for routes/recompose-broll.js:applyReplacementsToPlan
 * — the operator-input → insertions-plan transform that runs before any
 * I/O. End-to-end recompose (compose + overlay + burn + bgm) is exercised
 * by the deploy-time E2E since it requires real video assets.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReplacementsToPlan } from '../routes/recompose-broll.js';

function ins(startSec, endSec, asset_id) {
  return {
    startSec,
    endSec,
    asset_id,
    downloadUrl: `https://example.com/${asset_id}.mp4`,
    provenance: 'pixabay',
    visual_concept: 'placeholder',
  };
}

test('PR-AP: empty replacements → plan unchanged, applied/skipped empty', () => {
  const plan = [ins(5, 10, 'a'), ins(20, 25, 'b')];
  const r = applyReplacementsToPlan(plan, []);
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.plan.length, 2);
  assert.equal(r.plan[0].asset_id, 'a');
});

test('PR-AP: replacement matches exact startSec → asset swapped, others preserved', () => {
  const plan = [ins(5, 10, 'a'), ins(20, 25, 'b')];
  const r = applyReplacementsToPlan(plan, [
    { atSec: 20, newAsset: { downloadUrl: 'https://new.example/x.mp4', assetId: 'new-x', provenance: 'manual' } },
  ]);
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].oldAssetId, 'b');
  assert.equal(r.applied[0].newAssetId, 'new-x');
  assert.equal(r.plan[0].asset_id, 'a', 'unrelated insertion untouched');
  assert.equal(r.plan[1].asset_id, 'new-x');
  assert.equal(r.plan[1].downloadUrl, 'https://new.example/x.mp4');
  assert.equal(r.plan[1].provenance, 'manual');
});

test('PR-AP: replacement matches within tolerance window (1.5s default)', () => {
  const plan = [ins(5, 10, 'a'), ins(20, 25, 'b')];
  const r = applyReplacementsToPlan(plan, [
    { atSec: 21.0, newAsset: { downloadUrl: 'https://x', assetId: 'x' } },
  ]);
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].oldAssetId, 'b');
  assert.equal(r.applied[0].deltaSec, 1);
});

test('PR-AP: replacement outside tolerance → skipped with reason', () => {
  const plan = [ins(5, 10, 'a'), ins(20, 25, 'b')];
  const r = applyReplacementsToPlan(plan, [
    { atSec: 50, newAsset: { downloadUrl: 'https://x', assetId: 'x' } },
  ]);
  assert.equal(r.applied.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /no insertion within/);
});

test('PR-AP: replacement matches CLOSEST insertion when multiple in tolerance', () => {
  const plan = [ins(5, 10, 'a'), ins(7, 12, 'b'), ins(20, 25, 'c')];
  // atSec=6 is closer to 5 (delta 1) than to 7 (delta 1) — tie broken by
  // first encountered (insertion 'a').
  const r = applyReplacementsToPlan(plan, [
    { atSec: 6.4, newAsset: { downloadUrl: 'https://x', assetId: 'x' } },
  ]);
  assert.equal(r.applied.length, 1);
  // Closest by absolute delta — atSec=6.4 → 'b' at 7.0 (delta 0.6) wins over 'a' at 5.0 (delta 1.4).
  assert.equal(r.applied[0].oldAssetId, 'b');
});

test('PR-AP: missing atSec → skipped', () => {
  const plan = [ins(5, 10, 'a')];
  const r = applyReplacementsToPlan(plan, [
    { newAsset: { downloadUrl: 'https://x', assetId: 'x' } },
  ]);
  assert.equal(r.applied.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /atSec missing/);
});

test('PR-AP: missing newAsset.downloadUrl → skipped', () => {
  const plan = [ins(5, 10, 'a')];
  const r = applyReplacementsToPlan(plan, [
    { atSec: 5, newAsset: { assetId: 'x' } },
  ]);
  assert.equal(r.applied.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /downloadUrl missing/);
});

test('PR-AP: multiple replacements apply independently', () => {
  const plan = [ins(5, 10, 'a'), ins(20, 25, 'b'), ins(40, 45, 'c')];
  const r = applyReplacementsToPlan(plan, [
    { atSec: 5, newAsset: { downloadUrl: 'https://x', assetId: 'x' } },
    { atSec: 40, newAsset: { downloadUrl: 'https://z', assetId: 'z' } },
  ]);
  assert.equal(r.applied.length, 2);
  assert.equal(r.plan[0].asset_id, 'x');
  assert.equal(r.plan[1].asset_id, 'b', 'middle insertion untouched');
  assert.equal(r.plan[2].asset_id, 'z');
});

test('PR-AP: custom toleranceSec is honored', () => {
  const plan = [ins(5, 10, 'a')];
  // Default tolerance 1.5 → atSec=10 (delta 5) would fail.
  // Custom tolerance 10 → matches.
  const tight = applyReplacementsToPlan(plan, [
    { atSec: 10, newAsset: { downloadUrl: 'https://x', assetId: 'x' } },
  ], 1.5);
  assert.equal(tight.applied.length, 0);
  const loose = applyReplacementsToPlan(plan, [
    { atSec: 10, newAsset: { downloadUrl: 'https://x', assetId: 'x' } },
  ], 10);
  assert.equal(loose.applied.length, 1);
});

test('PR-AP: input plan is not mutated', () => {
  const original = [ins(5, 10, 'a'), ins(20, 25, 'b')];
  const snapshot = JSON.parse(JSON.stringify(original));
  applyReplacementsToPlan(original, [
    { atSec: 20, newAsset: { downloadUrl: 'https://x', assetId: 'x' } },
  ]);
  assert.deepEqual(original, snapshot, 'caller\'s array must not be mutated');
});

test('PR-AP: default provenance is "manual" when not specified', () => {
  const plan = [ins(5, 10, 'a')];
  const r = applyReplacementsToPlan(plan, [
    { atSec: 5, newAsset: { downloadUrl: 'https://x', assetId: 'x' } },
  ]);
  assert.equal(r.plan[0].provenance, 'manual');
});
