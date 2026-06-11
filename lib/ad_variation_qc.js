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
1. FRAMING — is the speaker's face FULLY in frame? Penalize heavily if the head is cut off at the top (hairline/forehead), chin, or sides, or if the speaker is awkwardly off-center.
2. CAPTIONS — are the burned-in subtitles readable AND not covering the speaker's face/mouth?
3. BANNER — if a banner is present across the top, is it readable and NOT overlapping the speaker's face?
4. SEAMS — does it play smoothly, with no jarring jump-cut or audio pop where segments join?
5. DELIVERY — is the speaker's energy/expression engaging for a paid ad (context-aware: a calm, sincere tone can be right for a serious topic — judge fit, not just loudness)?
6. OVERALL polish — does it look client-ready?

Return STRICT JSON ONLY, no markdown, no prose:
{
  "verdict": "green" | "yellow" | "red",   // green = ship it; yellow = usable, not peak; red = real problem (e.g. face cut off)
  "quality": <integer 0-100>,              // framing/captions/banner/seams/polish
  "energy": <integer 0-100>,               // delivery energy / engagement
  "why": "<one or two sentences, specific>",
  "action": "<keep it / redo / confirm — short recommendation>"
}`;

/**
 * Run Gemini QC on a rendered variation video.
 * @param {string} videoPath - local path to the finished mp4
 * @returns {Promise<{verdict:string, quality:number, energy:number|null, why:string, action:string}|null>}
 */
export async function qcAdVariation(videoPath) {
  if (!process.env.GOOGLE_AI_API_KEY) {
    console.warn('[ad_variation_qc] GOOGLE_AI_API_KEY not set — skipping QC');
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
  const verdict = VERDICTS.includes(parsed?.verdict) ? parsed.verdict : verdictFromScore(quality);
  const why = typeof parsed?.why === 'string' ? parsed.why.slice(0, 600) : '';
  const action = typeof parsed?.action === 'string' ? parsed.action.slice(0, 300) : '';

  return { verdict, quality, energy, why, action };
}
