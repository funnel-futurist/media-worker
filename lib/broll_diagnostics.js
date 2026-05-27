/**
 * lib/broll_diagnostics.js
 *
 * Pure formatting of the b-roll insertion plan into an operator-readable
 * diagnostic — one entry per insertion joining the Gemini editorial rationale
 * (reason / matchedPhrase / match_type / visual_concept) with the resolved
 * asset (id / title / url / provenance) and its placement (startSec–endSec).
 *
 * Why this exists: the picker already returns the rationale and
 * `downloadBrollAssets` already resolves the URL + title, but nothing logged
 * the JOINED view. So when a client says "the b-roll at 0:57 is wrong" there
 * was no way to map that timestamp to an asset_id without rewatching and
 * guessing. These log lines make every future feedback item directly
 * actionable (and give us the exact asset_id to blacklist).
 *
 * Pure + I/O-free so it's unit-testable; the orchestrator does the
 * console.log + response attachment.
 */

/**
 * @typedef {Object} InsertionLike
 * @property {number} [startSec]
 * @property {number} [endSec]
 * @property {string} [asset_id]
 * @property {string} [assetTitle]
 * @property {string} [url]
 * @property {string} [provenance]   'client' | 'pixabay'
 * @property {string} [match_type]   'direct' | 'metaphor' | 'emotional'
 * @property {string} [visual_concept]
 * @property {string} [reason]
 * @property {string} [matchedPhrase]
 */

const fmtSec = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '?');
// Single-line a free-text field and clamp it so one runaway `reason` can't
// blow out the Railway log. Collapses newlines so each insertion stays on
// exactly one log line.
const oneLine = (s, max = 160) => {
  if (typeof s !== 'string' || s.length === 0) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * Build structured diagnostic rows + formatted log lines for an insertions
 * array. Order is preserved (callers pass the final normalized plan, so the
 * order matches what's actually in the video).
 *
 * @param {InsertionLike[]} insertions
 * @returns {{ rows: Array<object>, lines: string[] }}
 */
export function formatInsertionDiagnostics(insertions) {
  const safe = Array.isArray(insertions) ? insertions : [];
  const rows = safe.map((ins, i) => ({
    idx: i + 1,
    startSec: typeof ins?.startSec === 'number' ? Number(ins.startSec.toFixed(3)) : null,
    endSec: typeof ins?.endSec === 'number' ? Number(ins.endSec.toFixed(3)) : null,
    source: ins?.provenance === 'pixabay' ? 'stock' : 'client',
    assetId: ins?.asset_id ?? null,
    assetTitle: ins?.assetTitle ?? null,
    url: ins?.url ?? null,
    matchType: ins?.match_type ?? null,
    visualConcept: ins?.visual_concept ?? null,
    reason: ins?.reason ?? null,
    matchedPhrase: ins?.matchedPhrase ?? null,
  }));

  const lines = rows.map((r) => {
    const parts = [
      `#${r.idx}`,
      `t=${fmtSec(r.startSec)}–${fmtSec(r.endSec)}`,
      `src=${r.source}`,
      `id=${r.assetId ?? '?'}`,
      `"${oneLine(r.assetTitle, 60) || '(no title)'}"`,
      `match=${r.matchType ?? '?'}`,
      `concept="${oneLine(r.visualConcept, 40)}"`,
      `url=${r.url ?? '?'}`,
      `reason="${oneLine(r.reason)}"`,
      `phrase="${oneLine(r.matchedPhrase, 80)}"`,
    ];
    return parts.join(' ');
  });

  return { rows, lines };
}
