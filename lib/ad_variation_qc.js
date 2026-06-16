/**
 * lib/ad_variation_qc.js — Gemini QC for a rendered ad variation.
 *
 * Sends the finished 1080x1350 ad to Gemini and grades it in the same shape as
 * the reel QC: a Verdict (green/yellow/red) + Why + Action + Quality/100 +
 * Energy/100. Checks framing (face not cut), captions (readable, not over the
 * face), banner (not over the speaker), clean seams, delivery energy, polish.
 *
 * ADVISORY ONLY — a verdict for the operator; never blocks/discards a variation.
 * Non-fatal: any failure returns null so a QC hiccup never breaks the render.
 */

import { analyzeVideo } from './gemini.js';

const VERDICTS = ['green', 'yellow', 'red'];

/** Fallback verdict from the quality score (matches pipeline grading) if the
 *  model didn't return one: 90+ green, 70-89 yellow, <70 red. */
export function verdictFromScore(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'yellow';
  if (score >= 90) return 'green';
  if (score >= 70) return 'yellow';
  return 'red';
}

const QC_PROMPT = `You are a strict QC reviewer for a vertical 1080x1350 paid talking-head video ad. Review this finished ad and grade it for CLIENT-READINESS.

Check, in order of importance:
1. FRAMING — is the speaker's face FULLY in frame? Penalize heavily if the head is cut off at the top (hairline/forehead), chin, or sides, or if off-center. (issue: "wrong_crop")
2. BLACK BARS — are there black letterbox/pillarbox bars instead of the video filling the frame? (issue: "black_bars")
3. CAPTIONS — are burned-in subtitles present, readable, and NOT covering the face/mouth? None at all → "missing_subtitles"; present but unreadable/over the face → "caption_issue".
4. BANNER — is a banner present across the top, readable, not over the face? Clearly absent → "banner_missing".
5. CTA — does it end on a clear call-to-action / next step? Weak or missing → "cta_weak".
6. SEAMS / RENDER — smooth playback, no jarring jump-cut, freeze, or audio pop at joins? Glitches → "render_issue".
7. DELIVERY — is the speaker's energy/expression engaging (context-aware: a calm tone can fit a serious topic — judge fit, not loudness)?

Also write a TITLE: a punchy 4-6 word label for THIS specific ad.
CRITICAL — IGNORE the banner/caption text overlaid on the video. That banner is IDENTICAL on every variation, so it can NEVER be the title (if you use it, every ad gets the same title, which is wrong). Do NOT read the on-screen text.
Instead, base the title on what the speaker actually SAYS out loud — primarily the spoken hook in the first ~5 seconds, plus the angle of the spoken body (the argument they make). Capture what makes THIS ad's pitch distinct from the others.
Title Case, no surrounding quotes, no trailing period. Good examples: Straight-A's, But A 3 · The $40K Tuition Math · Summer Head-Start · Champions In The Off-Season · Two Students, Same Class · The College Board Loophole. NEVER output the banner line (e.g. "5s Are Made In Summer") or generic labels like "Talking Head Ad", "AP Ad", "Variation".

Return STRICT JSON ONLY, no markdown, no prose:
{
  "title": "<4-6 word punchy angle label, see rules above>",
  "verdict": "green" | "yellow" | "red",   // green = ship it (no issues); yellow = usable, not peak; red = real problem
  "quality": <integer 0-100>,              // framing/captions/banner/seams/polish
  "energy": <integer 0-100>,               // delivery energy / engagement
  "issues": ["<code>", ...],               // ONLY from: missing_subtitles, wrong_crop, banner_missing, black_bars, cta_weak, caption_issue, render_issue. [] if none.
  "why": "<one or two sentences, specific>",
  "action": "<keep it / redo / confirm — short recommendation>"
}`;

// Issue codes the operator sees as "why it's not ready".
export const QC_ISSUE_CODES = [
  'missing_subtitles', 'wrong_crop', 'banner_missing', 'black_bars',
  'cta_weak', 'section_mismatch', 'render_issue', 'caption_issue',
];

/**
 * Run Gemini QC on a rendered variation video.
 * @param {string} videoPath - local path to the finished mp4
 * @returns {Promise<{title:string, verdict:string, quality:number, energy:number|null, issues:string[], why:string, action:string}|null>}
 */
export async function qcAdVariation(videoPath) {
  if (!process.env.GOOGLE_AI_API_KEY && !process.env.GEMINI_API_KEY) {
    console.warn('[ad_variation_qc] no Gemini key (GOOGLE_AI_API_KEY / GEMINI_API_KEY) — skipping QC');
    return null;
  }
  let text;
  try {
    text = await analyzeVideo(videoPath, QC_PROMPT);
  } catch (err) {
    console.warn(`[ad_variation_qc] Gemini analyze failed (non-fatal): ${err?.message ?? err}`);
    return null;
  }

  let parsed;
  try {
    const cleaned = String(text).replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : cleaned);
  } catch (err) {
    console.warn(`[ad_variation_qc] could not parse QC JSON (non-fatal): ${err?.message ?? err}`);
    return null;
  }

  const clampInt = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  };
  const quality = clampInt(parsed?.quality);
  if (quality === null) return null; // quality is the minimum we need
  const energy = clampInt(parsed?.energy);
  let verdict = VERDICTS.includes(parsed?.verdict) ? parsed.verdict : verdictFromScore(quality);
  const why = typeof parsed?.why === 'string' ? parsed.why.slice(0, 600) : '';
  const action = typeof parsed?.action === 'string' ? parsed.action.slice(0, 300) : '';
  // Punchy angle label for the variation card (replaces "Variation N").
  // Strip wrapping quotes / trailing period the model sometimes adds.
  const title = typeof parsed?.title === 'string'
    ? parsed.title.trim().replace(/^["'“‘]+|["'”’.]+$/g, '').trim().slice(0, 60)
    : '';
  const issues = Array.isArray(parsed?.issues)
    ? [...new Set(parsed.issues.filter((c) => QC_ISSUE_CODES.includes(c)))]
    : [];
  // Any flagged issue keeps it out of "green" → it stays in Deliverables for
  // the operator instead of auto-promoting to Review.
  if (issues.length > 0 && verdict === 'green') verdict = 'yellow';

  return { title, verdict, quality, energy, issues, why, action };
}
