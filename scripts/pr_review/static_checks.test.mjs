/**
 * Unit tests for the deterministic static-check floor.
 * Run: node --test scripts/pr_review/static_checks.test.mjs
 * Zero deps (node:test + node:assert).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStaticChecks } from './static_checks.mjs';

const verdictOf = (r, name) => r.checks.find((c) => c.name === name)?.verdict;
const plus = (lines) => lines.map((l) => `+${l}`).join('\n');

// Fake secrets are assembled from fragments so this TEST FILE itself contains no contiguous,
// matchable secret literal — otherwise it would trip the repo's pre-commit hook and the very
// floor it tests. The assembled value at runtime is a realistic key shape.
const frag = (...p) => p.join('');
const FAKE_ANTHROPIC = frag('sk-', 'ant-', 'api03-', 'A'.repeat(40));   // assembles to an Anthropic-style key
const FAKE_XOXB = frag('xoxb', '-1234567890-abcdefghijklmnop');         // assembles to a Slack-bot-style token
const PG = frag('postgresql:', '//');                                  // assembles to a Postgres URL prefix

test('clean code PR → PASS, no block', () => {
  const r = runStaticChecks({
    diff: plus(['export const x = 1;', 'function add(a, b) { return a + b; }']),
    files: ['src/util/math.ts'], additions: 2, deletions: 0,
  });
  assert.equal(r.overall, 'PASS');
  assert.equal(r.hasBlock, false);
});

test('real API key in an added line → BLOCK', () => {
  const r = runStaticChecks({
    diff: plus([`const key = "${FAKE_ANTHROPIC}";`]),
    files: ['src/config.ts'], additions: 1, deletions: 0,
  });
  assert.equal(verdictOf(r, 'Secrets Scan'), 'BLOCK');
  assert.equal(r.hasBlock, true);
});

test('FALSE POSITIVE — secret prefix mentioned in a code comment → not a block', () => {
  const r = runStaticChecks({
    diff: plus([`// tokens look like ${FAKE_XOXB}`, 'const ok = true;']),
    files: ['src/notes.ts'], additions: 2, deletions: 0,
  });
  assert.equal(verdictOf(r, 'Secrets Scan'), 'PASS');
});

test('FALSE POSITIVE — process.env reference → not a block', () => {
  const r = runStaticChecks({
    diff: plus([`const db = process.env.DATABASE_URL; // ${PG}...`]),
    files: ['src/db.ts'], additions: 1, deletions: 0,
  });
  assert.equal(verdictOf(r, 'Secrets Scan'), 'PASS');
});

test('FALSE POSITIVE — placeholder in .env.example → not a block', () => {
  const r = runStaticChecks({
    diff: plus(['ANTHROPIC_API_KEY=your-key-here', `DATABASE_URL=${PG}example`]),
    files: ['.env.example'], additions: 2, deletions: 0,
  });
  assert.equal(verdictOf(r, 'Secrets Scan'), 'PASS');
});

test('committing a real .env file → BLOCK', () => {
  const r = runStaticChecks({
    diff: plus(['SOME=value']), files: ['.env'], additions: 1, deletions: 0,
  });
  assert.equal(verdictOf(r, 'Secrets Scan'), 'BLOCK');
});

test('deleted secret line (removal) → not a block (deletions are good)', () => {
  const r = runStaticChecks({
    diff: `-const key = "${FAKE_ANTHROPIC}";`,
    files: ['src/config.ts'], additions: 0, deletions: 1,
  });
  assert.equal(verdictOf(r, 'Secrets Scan'), 'PASS');
});

test('spaces in filename → BLOCK; uppercase filename → FLAG', () => {
  const block = runStaticChecks({ diff: '', files: ['06_Clients/my file.md'], additions: 1, deletions: 0 });
  assert.equal(verdictOf(block, 'Taxonomy'), 'BLOCK');
  const flag = runStaticChecks({ diff: '', files: ['11_Operations/MyDoc.md'], additions: 1, deletions: 0 });
  assert.equal(verdictOf(flag, 'Taxonomy'), 'FLAG');
});

test('allowed uppercase names (CLAUDE.md, SKILL.md, .github/) → PASS', () => {
  const r = runStaticChecks({
    diff: '', files: ['CLAUDE.md', '.claude/skills/x/SKILL.md', '.github/workflows/pr-review.yml'],
    additions: 1, deletions: 0,
  });
  assert.equal(verdictOf(r, 'Taxonomy'), 'PASS');
});

test('destructive migration (DROP TABLE) → BLOCK', () => {
  const r = runStaticChecks({
    diff: 'diff --git a/13_Database_Schemas/x.sql b/13_Database_Schemas/x.sql\n' + plus(['DROP TABLE core.clients;']),
    files: ['13_Database_Schemas/x.sql'], additions: 1, deletions: 0,
  });
  assert.equal(verdictOf(r, 'Migration Guard'), 'BLOCK');
  assert.equal(r.hasBlock, true);
});

test('DISABLE RLS migration → BLOCK', () => {
  const r = runStaticChecks({
    diff: 'diff --git a/migrations/001.sql b/migrations/001.sql\n' + plus(['ALTER TABLE cs.x DISABLE ROW LEVEL SECURITY;']),
    files: ['migrations/001.sql'], additions: 1, deletions: 0,
  });
  assert.equal(verdictOf(r, 'Migration Guard'), 'BLOCK');
});

test('additive migration (CREATE TABLE + ENABLE RLS) → PASS, not blocked', () => {
  const r = runStaticChecks({
    diff: 'diff --git a/13_Database_Schemas/002.sql b/13_Database_Schemas/002.sql\n' +
      plus(['CREATE TABLE analytics.pr_review_learnings (id bigserial);', 'ALTER TABLE analytics.pr_review_learnings ENABLE ROW LEVEL SECURITY;']),
    files: ['13_Database_Schemas/002.sql'], additions: 2, deletions: 0,
  });
  assert.equal(verdictOf(r, 'Migration Guard'), 'PASS');
  assert.equal(r.hasBlock, false);
});

test('CSS class "truncate" in a .tsx file does NOT trip the migration guard', () => {
  // No .sql file present → migration guard does not even run.
  const r = runStaticChecks({
    diff: 'diff --git a/src/x.tsx b/src/x.tsx\n' + plus(['<div className="truncate text-sm">hi</div>']),
    files: ['src/x.tsx'], additions: 1, deletions: 0,
  });
  assert.equal(r.checks.find((c) => c.name === 'Migration Guard'), undefined);
  assert.equal(r.hasBlock, false);
});

test('multiple client slugs referenced → FLAG (not block)', () => {
  const r = runStaticChecks({
    diff: plus(['notes about supported and erin_porter together']),
    files: ['00_Inbox/notes.md'], additions: 1, deletions: 0,
  });
  assert.equal(verdictOf(r, 'Client Isolation'), 'FLAG');
  assert.equal(r.hasBlock, false);
});

test('dangling symlink under .claude → Symlink Integrity BLOCK', () => {
  const r = runStaticChecks({
    diff: '', files: ['.claude/skills/higgsfield-soul-id'], additions: 0, deletions: 0,
    danglingSymlinks: ['.claude/skills/higgsfield-soul-id'],
  });
  assert.equal(verdictOf(r, 'Symlink Integrity'), 'BLOCK');
  assert.equal(r.hasBlock, true);
});

test('dangling symlink OUTSIDE .claude → FLAG, not blocked', () => {
  const r = runStaticChecks({
    diff: '', files: ['14_Content/swipe_files/x.md'], additions: 0, deletions: 0,
    danglingSymlinks: ['14_Content/swipe_files/x.md'],
  });
  assert.equal(verdictOf(r, 'Symlink Integrity'), 'FLAG');
  assert.equal(r.hasBlock, false);
});

test('no dangling symlinks → no Symlink Integrity check, not blocked', () => {
  const r = runStaticChecks({
    diff: plus(['ok']), files: ['x.md'], additions: 1, deletions: 0, danglingSymlinks: [],
  });
  assert.equal(r.checks.find((c) => c.name === 'Symlink Integrity'), undefined);
  assert.equal(r.hasBlock, false);
});

test('placeholder text → FLAG; large diff → Scope FLAG', () => {
  const r = runStaticChecks({
    diff: plus(['title: [INSERT] here', 'TODO: fix']),
    files: ['x.md'], additions: 600, deletions: 0,
  });
  assert.equal(verdictOf(r, 'Content Quality'), 'FLAG');
  assert.equal(verdictOf(r, 'Scope'), 'FLAG');
  assert.equal(r.hasBlock, false); // FLAGs never block
});
