#!/usr/bin/env node
/**
 * Symlink integrity audit — finds git-tracked symlinks whose target is NOT tracked in git.
 *
 * Why this exists (a repeatable guardrail, see lesson_pr_autoreviewer_handover):
 * A committed symlink that points at a gitignored / untracked target works on the machine that
 * created it and DANGLES on every fresh clone — teammates, CI runners, and any client's AIOS.
 * It silently breaks tooling that walks the tree on a clean checkout (e.g. claude-code-action's
 * "restore .claude from origin/main" step). One such symlink took down the PR reviewer until found.
 *
 * This is the GATHERER (git-aware, env-specific). The deterministic decision lives in
 * static_checks.mjs Check 9 ("Symlink Integrity"), which BLOCKs when this list is non-empty.
 * Keeping gather (here) and decide (there) separate keeps the floor's logic pure + unit-testable.
 *
 * Usage:  node symlink_audit.mjs            # prints JSON array of offending paths to stdout
 * Exit 0 always (gatherer never blocks; the floor decides). Errors fail OPEN (prints []).
 */

import { execSync } from 'node:child_process';
import { resolve, dirname, relative, join } from 'node:path';

function gitTrackedSymlinksWithUntrackedTargets() {
  const root = execSync('git rev-parse --show-toplevel').toString().trim();
  const out = [];
  const entries = execSync('git ls-files -s', { maxBuffer: 64 * 1024 * 1024 }).toString().trim().split('\n');
  for (const line of entries) {
    // format: <mode> <objecthash> <stage>\t<path>
    const m = line.match(/^(\d+)\s+\S+\s+\d+\t(.+)$/);
    if (!m || m[1] !== '120000') continue;        // 120000 = symlink
    const file = m[2];
    const target = execSync(`git cat-file -p ":${file.replace(/"/g, '\\"')}"`).toString().trim();
    // Non-portable if: absolute target (only resolves on the author's box), OR points outside the
    // repo, OR the in-repo target isn't tracked (gitignored/missing => dangles on a clean clone).
    const isAbsolute = target.startsWith('/');
    const abs = resolve(dirname(join(root, file)), target);
    const rel = relative(root, abs);
    const outsideRepo = rel.startsWith('..');
    let tracked = false;
    if (!isAbsolute && !outsideRepo) {
      try { execSync(`git ls-files --error-unmatch -- "${rel.replace(/"/g, '\\"')}"`, { stdio: 'ignore' }); tracked = true; }
      catch { tracked = false; }
    }
    if (isAbsolute || outsideRepo || !tracked) out.push(file);
  }
  return out;
}

try {
  console.log(JSON.stringify(gitTrackedSymlinksWithUntrackedTargets()));
} catch (e) {
  // Fail open — a bug in the auditor must not block a human.
  process.stderr.write(`symlink_audit error (failing open): ${e.message}\n`);
  console.log('[]');
}
