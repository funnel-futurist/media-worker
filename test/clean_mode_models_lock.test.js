/**
 * test/clean_mode_models_lock.test.js
 *
 * Source-snapshot lock-in: every Gemini-using lib on the clean-mode pipeline
 * must use a Pro model (default: `gemini-3.1-pro-preview`). Any future drift
 * to a Flash variant fails this test and the PR can't merge.
 *
 * Per Shannon's directive 2026-05-08 ("Gemini Pro only — do not switch
 * anything to Flash"), this rule applies to all clean-mode AI decision
 * steps:
 *   - lib/broll_picker.js          (b-roll picker)
 *   - lib/stock_keyword_gen.js     (stock keyword generation, PR-A)
 *   - lib/slate_detect.js          (slate detection)
 *   - lib/bad_take_detect.js       (bad-take detection)
 *   - lib/bgm_select.js            (BGM mood/genre, PR-B — added when that
 *                                   file lands; this test will fail loudly
 *                                   until PR-B updates this file too)
 *   - lib/audio_qc.js              (optional BGM perceptual QC, PR-B)
 *
 * Rule-of-thumb pattern: (a) the source contains the literal model id
 * `gemini-3.1-pro-preview`, AND (b) the source does NOT contain ANY of
 * `gemini-*-flash` / `gemini-*-flash-*`. Both halves matter — only the
 * "no Flash" half catches the case where someone introduces a new model
 * constant pointing at Flash.
 *
 * What this test does NOT cover (intentional):
 *   - lib/gemini.js / lib/scene_rewriter.js — used by routes/hyperframes.js
 *     (motion-graphics path, NOT clean-mode). Not subject to this rule.
 *   - lib/broll_picker.js DEFAULT_MODEL constant only — `broll_picker_config.test.js`
 *     already enforces `pro` is in the model id and `flash` is not. We don't
 *     re-cover that one here; this file is the catch-all for the rest.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(__dirname, '..', 'lib');

/**
 * The canonical list of clean-mode AI files that must use Pro.
 * Each entry is a path relative to lib/ + a `requireExists` flag (true if
 * the file MUST exist; false if it's added by a future PR and we should
 * skip the assertion until then).
 */
const CLEAN_MODE_AI_FILES = [
  { rel: 'broll_picker.js',       requireExists: true  },
  { rel: 'stock_keyword_gen.js',  requireExists: true  },
  { rel: 'slate_detect.js',       requireExists: true  },
  { rel: 'bad_take_detect.js',    requireExists: true  },
  // PR-B will add these. Gate the assertion on existence so this test passes
  // before PR-B and fails loudly when PR-B lands without using Pro.
  { rel: 'bgm_select.js',         requireExists: false },
  { rel: 'audio_qc.js',           requireExists: false },
];

const PRO_MODEL_ID = 'gemini-3.1-pro-preview';
// Match `gemini-2.0-flash`, `gemini-2.0-flash-exp`, `gemini-2.5-flash`,
// `gemini-1.5-flash-002`, future `gemini-3-flash`, etc.
const FLASH_MODEL_RE = /gemini-[\w.]+-flash(-[\w.]+)?/g;

for (const { rel, requireExists } of CLEAN_MODE_AI_FILES) {
  const absPath = join(LIB_DIR, rel);
  const fileExists = existsSync(absPath);

  if (!fileExists) {
    if (requireExists) {
      test(`clean-mode AI: ${rel} must exist`, () => {
        assert.fail(`expected ${rel} to exist at ${absPath}`);
      });
    }
    // Otherwise (PR-B placeholders not landed yet): skip silently.
    continue;
  }

  const source = readFileSync(absPath, 'utf8');

  test(`clean-mode AI: ${rel} uses gemini-3.1-pro-preview`, () => {
    assert.match(
      source,
      new RegExp(PRO_MODEL_ID.replace(/[.]/g, '\\.')),
      `${rel} must reference '${PRO_MODEL_ID}' as the Gemini model — clean-mode AI decisions are Pro-only per Shannon's 2026-05-08 directive`,
    );
  });

  test(`clean-mode AI: ${rel} does NOT reference any gemini-*-flash model`, () => {
    // Strip JS comments before scanning so historical comments referring to
    // Flash (e.g., "bumped from gemini-2.5-flash...") don't trip the regex.
    // We only want to catch live model references.
    const stripped = stripJsComments(source);
    const matches = stripped.match(FLASH_MODEL_RE) || [];
    assert.equal(
      matches.length,
      0,
      `${rel} must NOT reference any gemini-*-flash model in code; ` +
      `found: ${JSON.stringify(matches)} — clean-mode AI is Pro-only`,
    );
  });
}

/**
 * Cheap JS comment stripper for source-snapshot scanning. Not bulletproof
 * (won't handle string literals containing `//` or `/*`) but adequate for
 * scanning our own lib code where model ids appear either as constants or
 * in JSDoc explanations.
 */
function stripJsComments(src) {
  // Block comments first (multi-line), then line comments. Rough but fine
  // for our purposes — we don't have model ids inside string literals
  // disguised as code.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
