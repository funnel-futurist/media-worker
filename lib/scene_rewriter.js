/**
 * scene_rewriter.js
 *
 * Takes Phoenix's ff-pilot composition HTMLs (baked in with his specific
 * pilot content: "BASELINE STACK", "GHL", "Slack", etc.) and rewrites the
 * visible text slots to match the CURRENT client's script.
 *
 * Preserves HTML structure, CSS, JavaScript, GSAP timelines, class names
 * and IDs. Only the text content inside elements with an `id` attribute
 * gets replaced. If Gemini fails or returns malformed data, the original
 * HTMLs are left untouched (safe fallback).
 *
 * This is Path A — text-only rewrite — which matches content but not
 * animation timing. Path B (Phoenix redesigning compositions to be
 * parameterized) is the proper long-term fix.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { load as cheerioLoad } from 'cheerio';
import { GoogleGenAI } from '@google/genai';

const MODEL = 'gemini-2.0-flash';

/**
 * Rewrite all composition HTMLs in `workspace/compositions/` to match the
 * client's script. Skips the `_archive` subfolder.
 *
 * @param {string} workspace  The per-render /tmp/hf-... directory
 * @param {string} script     Client's script (portal-supplied or transcript)
 * @param {object} clientContext Optional { clientName, clientSlug } for grounding
 */
export async function rewriteScenesWithScript(workspace, script, clientContext = {}) {
  if (!script || script.trim().length < 40) {
    console.warn('[scene_rewriter] script too short, skipping rewrite');
    return { skipped: true, reason: 'script too short' };
  }

  if (!process.env.GEMINI_API_KEY) {
    console.warn('[scene_rewriter] GEMINI_API_KEY not set, skipping rewrite');
    return { skipped: true, reason: 'no GEMINI_API_KEY' };
  }

  const compositionsDir = join(workspace, 'compositions');
  const files = readdirSync(compositionsDir).filter((f) => f.endsWith('.html'));

  // 1. Extract text slots from each composition
  const slotMap = {};
  const parsed = {};

  for (const file of files) {
    const html = readFileSync(join(compositionsDir, file), 'utf-8');
    const $ = cheerioLoad(html, { xml: false });
    parsed[file] = $;

    const slots = {};
    $('[id]').each((_, el) => {
      const id = $(el).attr('id');
      if (!id) return;
      // Only get the direct text nodes of this element (skip child element text)
      const text = $(el)
        .contents()
        .filter((_, node) => node.type === 'text')
        .map((_, node) => node.data.trim())
        .get()
        .filter((t) => t.length > 0)
        .join(' ');
      if (text.length > 0 && text.length < 200) {
        slots[id] = text;
      }
    });

    if (Object.keys(slots).length > 0) {
      slotMap[file] = slots;
    }
  }

  if (Object.keys(slotMap).length === 0) {
    console.warn('[scene_rewriter] no text slots found, skipping rewrite');
    return { skipped: true, reason: 'no slots' };
  }

  const totalSlots = Object.values(slotMap).reduce((acc, s) => acc + Object.keys(s).length, 0);
  console.log(`[scene_rewriter] extracted ${totalSlots} text slots across ${Object.keys(slotMap).length} scenes`);

  // 2. Ask Gemini to rewrite
  let newSlotMap;
  try {
    newSlotMap = await rewriteViaGemini(slotMap, script, clientContext);
  } catch (err) {
    console.error(`[scene_rewriter] Gemini rewrite failed: ${err.message}`);
    return { skipped: true, reason: 'gemini failed', error: err.message };
  }

  // 3. Apply changes to each composition HTML
  let filesWritten = 0;
  let slotsRewritten = 0;

  for (const [file, slots] of Object.entries(newSlotMap)) {
    const $ = parsed[file];
    if (!$) continue;
    let changed = false;

    for (const [slotId, newText] of Object.entries(slots)) {
      if (typeof newText !== 'string') continue;
      const el = $(`#${CSS.escape(slotId)}`);
      if (!el.length) continue;

      // Replace only the first direct text node to preserve child elements
      let replaced = false;
      el.contents().each((_, node) => {
        if (replaced) return;
        if (node.type === 'text' && node.data.trim().length > 0) {
          node.data = newText;
          replaced = true;
        }
      });

      // If element had no existing text node (rare), append one
      if (!replaced && newText.length > 0) {
        el.append(newText);
        replaced = true;
      }

      if (replaced) {
        slotsRewritten++;
        changed = true;
      }
    }

    if (changed) {
      writeFileSync(join(compositionsDir, file), $.html(), 'utf-8');
      filesWritten++;
    }
  }

  console.log(`[scene_rewriter] rewrote ${slotsRewritten} slots across ${filesWritten} files`);
  return { filesWritten, slotsRewritten };
}

async function rewriteViaGemini(slotMap, script, clientContext) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const clientContextBlock = clientContext.clientName
    ? `CLIENT: ${clientContext.clientName}${clientContext.clientSlug ? ` (${clientContext.clientSlug})` : ''}\n\n`
    : '';

  const prompt = `You are rewriting motion-graphic text overlays for a short-form vertical video.

${clientContextBlock}CLIENT SCRIPT (what the speaker actually says in the video — THIS is the source of truth for all content):
"""
${script.slice(0, 8000)}
"""

CURRENT TEXT SLOTS (each scene file has element IDs mapped to the current placeholder text — these come from Phoenix's pilot about his own tech stack and MUST be replaced):
${JSON.stringify(slotMap, null, 2)}

TASK:
Return a JSON object with the EXACT SAME structure as the CURRENT TEXT SLOTS. For every slot, provide new text that fits the CLIENT SCRIPT's actual content.

RULES:
1. Preserve each slot's semantic role. A tool name stays a tool/product/concept name. A headline stays a headline. A label stays a label. A slam word stays a slam word (short, punchy, all-caps).
2. Match the approximate LENGTH of the original. If original is 1-2 words, keep 1-3 words. If original is a full sentence, produce a similar-length sentence.
3. For list items that look like tools (e.g. "GHL", "Slack", "Google Sheets", "Notion", "Loom" — 5 tool slots) fill with the specific tools/platforms/products mentioned in the client's script. If the script mentions fewer items than there are slots, leave the extras as empty string "". If more items exist, pick the most impactful.
4. Never rewrite CSS variables, JavaScript identifiers, class names, or IDs. Only the visible text content.
5. Keep ALL-CAPS for slots that are currently ALL-CAPS. Keep Title Case for slots that are Title Case.
6. If a slot is clearly structural (e.g. step numbers like "01", "02") leave it exactly as-is.

Return ONLY the JSON object matching the input structure. Do not include commentary or markdown.`;

  const result = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.35,
      maxOutputTokens: 8192,
    },
  });

  const text =
    result?.candidates?.[0]?.content?.parts?.[0]?.text ??
    result?.response?.text?.() ??
    '{}';

  const cleaned = text.replace(/```(?:json)?\n|```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Gemini returned non-object');
  }

  return parsed;
}
