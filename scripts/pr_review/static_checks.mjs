#!/usr/bin/env node
/**
 * Deterministic PR static checks — the HARD FLOOR of the converged PR auto-reviewer.
 *
 * Ported from github_pr_autoreviewer_v2.js (runStaticChecks) — the same battle-tested
 * patterns, now dependency-free (Node built-ins only) so it runs on a bare GitHub-hosted
 * runner with zero `npm install`. No LLM, no network, no DB.
 *
 * Layering (see SPEC_converged_pr_autoreviewer_2026_06_08.md):
 *   - This file = the deterministic regex/path floor. It is the SINGLE source of truth
 *     for secret/taxonomy/migration patterns. The pr_review skill does NOT re-implement
 *     these — it does judgment on top. That kills the two-brains drift.
 *   - DB-aware checks (column existence, dynamic client list) live in the skill (ai_review
 *     job), which has psql + DATABASE_CONNECTION_URL. Not here — keeps this dep-free.
 *
 * Verdicts per check: PASS | FLAG (annotate, never blocks) | BLOCK (fails the required check).
 * Only a true BLOCK fails CI. Fail asymmetry: a bug here must not block a human (callers
 * treat a thrown error as non-blocking), but auto-merge fails CLOSED downstream.
 *
 * CLI:  node static_checks.mjs <diff_file> <meta_json_file> [--out static_verdict.json]
 *   meta_json = { "files": ["a/b.ts", ...], "additions": N, "deletions": M, "repo": "ai-os" }
 *   Prints a Markdown summary to stdout. Writes the verdict JSON to --out (default ./static_verdict.json).
 *   Exit 0 = no BLOCK. Exit 1 = at least one BLOCK (required check fails).
 */

import { readFileSync, writeFileSync } from 'node:fs';

// ─── Secret patterns (single source of truth — ported verbatim) ──────────────
// IMPORTANT: built from fragments on purpose. A secret-scanner whose source contains
// contiguous, matchable secret literals would flag ITSELF (and trip the repo's pre-commit
// hook + this very floor on its own PR). Splitting each literal across a `+` keeps the
// runtime regex identical while leaving no matchable substring in the committed file.
const SECRET_FRAGMENTS = [
  'sk-ant' + '-',
  'sk-[a-zA-Z0-9]{20,}',
  'xoxb' + '-',
  'xoxp' + '-',
  'AKIA[A-Z0-9]{16}',
  'ghp_[a-zA-Z0-9]{36}',
  'postgresql:' + '\\/\\/',
  'mongodb' + '\\+srv:\\/\\/',
  '-----BEGIN (RSA |EC )?PRIVATE' + '[ ]KEY',
];
export const SECRET_PATTERN = new RegExp('(' + SECRET_FRAGMENTS.join('|') + ')', 'i');

// Filenames in upper-case that are legitimately allowed (not taxonomy violations).
const UPPER_EXCLUDE =
  /CLAUDE\.md|README\.md|SKILL\.md|SPEC\.md|GETTING_STARTED\.md|MEMORY\.md|QUICKSTART|PROTOCOL\.md|LICENSE|CODEOWNERS|Dockerfile|Makefile|\.github\//;

// Heuristic client list — FLAG only. The skill does the authoritative DB-backed
// (SELECT slug FROM core.clients WHERE status='active') cross-client check.
const CLIENT_NAMES = [
  'enable_special_needs', 'bradley_pounds', 'erin_porter', 'dr_joe', 'brian_humphrey',
  'kirby_dublin', 'supported', 'guided_autism', 'carla_bate', 'chris_watters',
];

// Which apps depend on which schema — blast-radius annotation for migrations.
const SCHEMA_APP_MAP = {
  core: ['ALL APPS — identity layer'],
  marketing: ['creative-engine (R/W)', 'cmo-app (READ)', 'quiz-hub (WRITE)', 'ea-slack-bot (R/W)'],
  cs: ['ff-client-portal (R/W)', 'ops-dashboard (READ)'],
  sales: ['sales-copilot (R/W)', 'outreach-os (R/W)'],
  team_ops: ['sales-copilot (R/W)', 'outreach-os (R/W)', 'ops-dashboard (READ)'],
  analytics: ['quiz-hub (WRITE)', 'ops-dashboard (READ)', 'ea-slack-bot (R/W)'],
  finance: ['finance-api (R/W)', 'ops-dashboard (READ)'],
  ea: ['ea-slack-bot (R/W)'],
  client_data: ['ea-slack-bot (R/W) — PII VAULT'],
  monitoring: ['creative-engine (WRITE)'],
  affiliate: ['ops-dashboard (READ)'],
  system: ['INTERNAL — no RLS'],
};

// Only ADDED, non-comment, non-env-reference, non-placeholder lines can be real secrets.
function extractRealAddedLines(diff) {
  return diff.split('\n').filter((line) => {
    if (!line.startsWith('+')) return false;          // additions only — deletions are good
    if (line.startsWith('+++')) return false;          // diff header
    if (/your-|example|placeholder|changeme|xxx/i.test(line)) return false; // placeholders
    const stripped = line.replace(/^\+\s*/, '');
    if (/^\s*(\/\/|\/\*|\*|#)/.test(stripped)) return false;                  // comments
    if (/process\.env\.|os\.environ|env\[|getenv/i.test(line)) return false;  // env reads, not literals
    return true;
  }).join('\n');
}

// Pull only SQL-file additions out of the diff (avoids CSS ".truncate" matching SQL TRUNCATE).
function extractSqlAddedLines(diff) {
  return diff.split(/^diff --git /m)
    .filter((section) => /\.sql\b/.test(section.split('\n')[0] || ''))
    .flatMap((section) => section.split('\n'))
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n');
}

/**
 * Run all deterministic checks.
 * @returns {{checks: Array, hasBlock: boolean, blockers: string[], overall: string}}
 */
export function runStaticChecks({ diff = '', files = [], additions = 0, deletions = 0, danglingSymlinks = [] }) {
  const checks = [];

  // CHECK 1 — Secrets
  const envFiles = files
    .filter((f) => /^\.env|\.pem$|\.key$|credentials\.json$/.test(f))
    .filter((f) => !/\.env\.(example|sample|template)$/.test(f));
  const hasSecrets = SECRET_PATTERN.test(extractRealAddedLines(diff));
  const exampleFiles = files.filter((f) => /\.env\.(example|sample|template)$/.test(f));
  const hasRealEmail = exampleFiles.length > 0 && /[a-zA-Z0-9._%+-]+@(?!example\.com)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(
    diff.split('\n').filter((l) => l.startsWith('+') && /@/.test(l) && !/your-|example|placeholder/i.test(l)).join('\n')
  );
  checks.push({
    name: 'Secrets Scan',
    verdict: hasSecrets || envFiles.length ? 'BLOCK' : hasRealEmail ? 'FLAG' : 'PASS',
    notes: hasSecrets ? 'Potential secret in ADDED lines — REVOKE AND ROTATE, remove from history'
      : envFiles.length ? `Sensitive file(s) committed: ${envFiles.join(', ')}`
      : hasRealEmail ? 'Real email in .env.example — use a placeholder'
      : 'Clean',
  });

  // CHECK 2 — Taxonomy (spaces = BLOCK, uppercase = FLAG)
  const spaceFiles = files.filter((f) => f.includes(' '));
  const upperFiles = files.filter((f) => !UPPER_EXCLUDE.test(f) && /[A-Z]/.test(f.split('/').pop() || ''));
  checks.push({
    name: 'Taxonomy',
    verdict: spaceFiles.length ? 'BLOCK' : upperFiles.length ? 'FLAG' : 'PASS',
    notes: spaceFiles.length ? `Spaces in filename(s): ${spaceFiles.join(', ')}`
      : upperFiles.length ? `Uppercase filename(s): ${upperFiles.slice(0, 3).join(', ')}`
      : 'snake_case compliant',
  });

  // CHECK 3 — Folder placement (client-shaped files outside 06_Clients/)
  const clientOutside = files.filter((f) =>
    /client|avatar|market_analysis|offer_opt/i.test(f) && !/(06_Clients|01_Foundations|_template|00_Inbox)/.test(f));
  checks.push({
    name: 'Folder Placement',
    verdict: clientOutside.length ? 'FLAG' : 'PASS',
    notes: clientOutside.length ? `Possible client data outside 06_Clients/: ${clientOutside.slice(0, 3).join(', ')}` : 'Correct directories',
  });

  // CHECK 4 — Client isolation (heuristic FLAG; skill does DB-backed authoritative check)
  const mentioned = CLIENT_NAMES.filter((c) => diff.toLowerCase().includes(c));
  checks.push({
    name: 'Client Isolation',
    verdict: mentioned.length > 1 ? 'FLAG' : 'PASS',
    notes: mentioned.length > 1 ? `Multiple client slugs referenced: ${mentioned.join(', ')} (skill verifies vs core.clients)` : 'No cross-client refs',
  });

  // CHECK 5 — Placeholders
  const placeholders = (diff.match(/\[INSERT\]|\[TODO\]|\[PLACEHOLDER\]|XXX|FIXME/gi) || []).length;
  checks.push({
    name: 'Content Quality',
    verdict: placeholders > 0 ? 'FLAG' : 'PASS',
    notes: placeholders > 0 ? `${placeholders} placeholder(s) found` : 'No placeholders',
  });

  // CHECK 6 — Scope
  checks.push({
    name: 'Scope',
    verdict: additions > 500 ? 'FLAG' : 'PASS',
    notes: `${files.length} files, +${additions}/-${deletions}${additions > 500 ? ' — consider splitting' : ''}`,
  });

  // CHECK 7 — Destructive / security-config
  const securityFiles = files.filter((f) => /\.claude\/settings|\.gitignore/.test(f));
  checks.push({
    name: 'Destructive Changes',
    verdict: securityFiles.length || deletions > 100 ? 'FLAG' : 'PASS',
    notes: securityFiles.length ? `Security config modified: ${securityFiles.join(', ')}`
      : deletions > 100 ? `${deletions} lines deleted — verify intentional` : 'Clean',
  });

  // CHECK 8 — Migration guard (only when .sql migration/schema files are present)
  const dbFiles = files.filter((f) => /migrations?\/.*\.sql$/i.test(f) || /13_Database_Schemas\/.*\.sql$/i.test(f));
  if (dbFiles.length > 0) {
    const sql = extractSqlAddedLines(diff);
    const destructive = [
      [/DROP\s+TABLE/i, 'DROP TABLE'], [/DROP\s+COLUMN/i, 'DROP COLUMN'], [/DROP\s+SCHEMA/i, 'DROP SCHEMA'],
      [/TRUNCATE/i, 'TRUNCATE'], [/DELETE\s+FROM/i, 'DELETE FROM'],
    ].filter(([re]) => re.test(sql)).map(([, label]) => label);
    const disablesRLS = /DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql);
    const grantsPublic = /GRANT.*TO\s+(public|anon)/i.test(sql);
    const altersType = /ALTER\s+.*\s+TYPE/i.test(sql);
    const addsRLS = /ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql) || /CREATE\s+POLICY/i.test(sql);
    const schemas = [...new Set(
      (sql.match(/(?:ALTER|CREATE|DROP|INSERT INTO|UPDATE|DELETE FROM)\s+(?:TABLE\s+)?(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(\w+)\./gi) || [])
        .map((m) => m.match(/(\w+)\./)?.[1]).filter(Boolean)
    )];
    const apps = [...new Set(schemas.flatMap((s) => SCHEMA_APP_MAP[s] || [`unknown schema: ${s}`]))];

    let verdict = 'PASS', notes;
    if (destructive.length) { verdict = 'BLOCK'; notes = `DESTRUCTIVE MIGRATION: ${destructive.join(', ')}. Requires manual review + backup before applying.`; }
    else if (disablesRLS || grantsPublic) { verdict = 'BLOCK'; notes = `SECURITY-DEGRADING MIGRATION: ${[disablesRLS && 'DISABLES RLS', grantsPublic && 'GRANTS PUBLIC/ANON'].filter(Boolean).join(', ')}.`; }
    else if (altersType) { verdict = 'FLAG'; notes = `Column type change (ALTER TYPE) — may break readers. Schemas: ${schemas.join(', ') || 'see diff'}`; }
    else if (addsRLS) { verdict = 'PASS'; notes = `Security hardening (adds RLS/policies). Schemas: ${schemas.join(', ') || 'see diff'}`; }
    else { verdict = schemas.length > 2 ? 'FLAG' : 'PASS'; notes = `Migration touches: ${dbFiles.join(', ')}. Schemas: ${schemas.join(', ') || 'see diff'}`; }
    if (apps.length) notes += `\n    → Apps using these schemas: ${apps.join(', ')}`;
    checks.push({ name: 'Migration Guard', verdict, notes });
  }

  // CHECK 9 — Symlink integrity (repeatable guardrail).
  // A tracked symlink whose target is NOT tracked in git works on the author's machine but DANGLES
  // on every fresh clone (teammates, CI runners, client AIOS) — and silently breaks tooling that
  // walks the tree on a clean checkout (this is what took down the reviewer the first time).
  // The git-aware list is gathered by symlink_audit.mjs and passed in; the decision is here.
  if (danglingSymlinks.length > 0) {
    // BLOCK under .claude/ (breaks Claude tooling: the action's "restore .claude" step dies on these).
    // FLAG elsewhere — still broken on clones, but a content/IP cleanup, not worth blocking every PR.
    const critical = danglingSymlinks.filter((p) => p.startsWith('.claude/'));
    checks.push({
      name: 'Symlink Integrity',
      verdict: critical.length ? 'BLOCK' : 'FLAG',
      notes: critical.length
        ? `Tracked symlink(s) under .claude/ with untracked targets — dangle on every fresh clone AND break Claude tooling: ${critical.join(', ')}. Untrack + .gitignore, or commit a real file.`
        : `Tracked symlink(s) with untracked targets — dangle on fresh clones, please clean up: ${danglingSymlinks.join(', ')}`,
    });
  }

  const blockers = checks.filter((c) => c.verdict === 'BLOCK').map((c) => c.name);
  const hasBlock = blockers.length > 0;
  const hasFlag = checks.some((c) => c.verdict === 'FLAG');
  const overall = hasBlock ? 'BLOCK' : hasFlag ? 'FLAG' : 'PASS';
  return { checks, hasBlock, blockers, overall };
}

export function toMarkdown({ checks, overall, blockers }) {
  const icon = (v) => (v === 'PASS' ? '✅' : v === 'FLAG' ? '⚠️' : '🚫');
  let md = '### Static checks (deterministic floor)\n\n| # | Check | Verdict | Notes |\n|---|---|---|---|\n';
  checks.forEach((c, i) => { md += `| ${i + 1} | ${c.name} | ${icon(c.verdict)} ${c.verdict} | ${String(c.notes).replace(/\n/g, '<br>')} |\n`; });
  md += `\n**Floor verdict: ${overall}**`;
  if (blockers.length) md += ` — blocked by: ${blockers.join(', ')}. This is a required check; an admin can bypass if it is a confirmed false positive.`;
  return md;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
function isMain() {
  return process.argv[1] && process.argv[1].endsWith('static_checks.mjs');
}

if (isMain()) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : 'static_verdict.json';
  const positional = args.filter((a, i) => !a.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1));
  const [diffFile, metaFile] = positional;
  if (!diffFile || !metaFile) {
    console.error('Usage: static_checks.mjs <diff_file> <meta_json_file> [--out static_verdict.json]');
    process.exit(2);
  }
  try {
    const diff = readFileSync(diffFile, 'utf-8');
    const meta = JSON.parse(readFileSync(metaFile, 'utf-8'));
    const result = runStaticChecks({
      diff,
      files: meta.files || [],
      additions: meta.additions || 0,
      deletions: meta.deletions || 0,
      danglingSymlinks: meta.dangling_symlinks || [],
    });
    const md = toMarkdown(result);
    console.log(md);
    writeFileSync(out, JSON.stringify({ ...result, repo: meta.repo || null }, null, 2));
    // Mirror to the GitHub Actions job summary when available.
    if (process.env.GITHUB_STEP_SUMMARY) {
      try { writeFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n', { flag: 'a' }); } catch {}
    }
    process.exit(result.hasBlock ? 1 : 0);
  } catch (e) {
    // Fail OPEN: a bug in the floor must never block a human. Emit a non-blocking notice.
    console.error(`static_checks error (failing open, non-blocking): ${e.message}`);
    try { writeFileSync(out, JSON.stringify({ checks: [], hasBlock: false, blockers: [], overall: 'ERROR', error: e.message }, null, 2)); } catch {}
    process.exit(0);
  }
}
