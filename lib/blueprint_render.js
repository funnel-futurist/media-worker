/**
 * lib/blueprint_render.js
 *
 * Helpers for the blueprint-driven Hyperframes render path.
 *
 * Background:
 *   `routes/hyperframes.js` historically only knew the legacy "copy the static
 *   `hyperframes-template/` portrait pilot directory + swap in a fresh
 *   `videoUrl` + Gemini scene-rewrite" pipeline. That template is hardcoded
 *   1080×1920 portrait, so any landscape blueprint dispatched from
 *   creative-engine was silently rendered at portrait dimensions with
 *   distorted/wrong scene compositions.
 *
 *   Long-form landscape edits work differently: creative-engine's
 *   `compose_pending` cron materializes a per-video CompositionBlueprint into
 *   `hyperframes-projects/<adIngestionId>/...` on Supabase Storage. That
 *   project's `index.html` is emitted by `lib/hyperframes/render_blueprint.ts`
 *   with the correct viewport, body sizing, and meta.json dimensions for the
 *   blueprint's kit (1920×1080 for `ff-pilot-landscape`, 1080×1920 for
 *   portrait kits). The renderer just needs to download that project and run
 *   the `hyperframes` CLI against it — no scene rewriting, no template copy.
 *
 *   This module isolates the download+setup logic so the route handler stays
 *   small and the path can be tested without spinning up the full render.
 *
 * Scope discipline:
 *   - Touches: workspace setup from a compositionProjectUrl + sourceUrl pair
 *   - Does NOT touch: Gemini prompt, pattern catalog, upload flow, transcription,
 *     retry logic, or the legacy template-driven path
 *
 * The face source path matches what `render_blueprint.ts:150` emits:
 *   const faceSrc = 'assets/source.mp4';
 */

import { mkdirSync, createWriteStream, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const PROJECT_BUCKET_DEFAULT = 'hyperframes-projects';
export const FACE_SOURCE_RELATIVE_PATH = 'assets/source.mp4';

/**
 * Parse a Supabase Storage signed URL of the form
 *   https://<project>.supabase.co/storage/v1/object/sign/<bucket>/<path>?token=...
 * into { supabaseBase, bucket, path, prefix }. Returns null when the URL
 * doesn't match.
 *
 * `prefix` is the path with the final segment removed — the project root
 * folder (e.g. for `<id>/index.html` it returns `<id>`). Empty string when
 * the URL points directly at a bucket-root object.
 *
 * Exported for tests.
 */
export function parseSupabaseSignedUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const m = parsed.pathname.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const bucket = decodeURIComponent(m[1]);
  const path = decodeURIComponent(m[2]);
  const lastSlash = path.lastIndexOf('/');
  const prefix = lastSlash === -1 ? '' : path.slice(0, lastSlash);
  return {
    supabaseBase: `${parsed.protocol}//${parsed.host}`,
    bucket,
    path,
    prefix,
  };
}

/**
 * List every object under `<prefix>` in `<bucket>` using Supabase Storage's
 * POST /storage/v1/object/list/<bucket> endpoint with the service-role key.
 * Recurses one level into subfolders (hyperframes projects have
 * `compositions/*.html` and `assets/*` subfolders, max one level deep per
 * the layout emitted by `compose_pending` → `uploadProjectFiles`).
 *
 * Returns an array of `{ name, relativePath }` where `relativePath` is the
 * path RELATIVE TO `prefix` (so the workspace mirrors the project root).
 *
 * Exported for tests.
 */
export async function listProjectObjects({ supabaseBase, bucket, prefix, serviceKey, fetchImpl = fetch }) {
  async function listOne(p) {
    const res = await fetchImpl(`${supabaseBase}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefix: p, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`listProjectObjects: ${res.status} for prefix=${p} — ${body.slice(0, 200)}`);
    }
    return (await res.json()) ?? [];
  }

  const out = [];
  const seenFolders = new Set();
  const topLevel = await listOne(prefix);
  for (const entry of topLevel) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id === null) {
      // Folder — recurse one level. The seenFolders guard is belt-and-suspenders
      // in case a future bucket layout repeats folder names.
      if (seenFolders.has(fullPath)) continue;
      seenFolders.add(fullPath);
      const sub = await listOne(fullPath);
      for (const child of sub) {
        if (child.id === null) continue; // skip nested folders — none expected at this depth
        out.push({
          name: child.name,
          relativePath: `${entry.name}/${child.name}`,
          fullPath: `${fullPath}/${child.name}`,
        });
      }
    } else {
      out.push({ name: entry.name, relativePath: entry.name, fullPath });
    }
  }
  return out;
}

/**
 * Stream an object from Supabase Storage to a local file path, using the
 * service-role key (so private buckets work). Creates parent directories.
 *
 * Exported for tests.
 */
export async function downloadObjectToFile({ supabaseBase, bucket, objectPath, serviceKey, destPath, fetchImpl = fetch }) {
  const url = `${supabaseBase}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`downloadObjectToFile: ${res.status} for ${objectPath} — ${body.slice(0, 200)}`);
  }
  mkdirSync(dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
}

/**
 * Stream an arbitrary URL (e.g. a signed source MP4) to a local file path.
 * Used for the face-video download; the source bucket is separate from the
 * project bucket so we go through fetch directly rather than the storage API.
 */
export async function downloadUrlToFile({ url, destPath, fetchImpl = fetch }) {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`downloadUrlToFile: ${res.status} for ${url.slice(0, 80)}…`);
  }
  mkdirSync(dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
}

/**
 * Materialize a Hyperframes per-video project (created by creative-engine's
 * compose_pending) into a local workspace, ready for `npx hyperframes render`.
 *
 * Steps:
 *   1. Parse `compositionProjectUrl` to derive { bucket, prefix }.
 *   2. List + download every file under that prefix into `<workspace>`,
 *      preserving relative paths.
 *   3. Download the slate-trimmed face-source MP4 (from `sourceUrl`) into
 *      `<workspace>/assets/source.mp4` — that's the path
 *      `render_blueprint.ts` emits for the face video.
 *   4. Return the project dimensions read from the blueprint's `meta`. The
 *      dimensions are NOT applied to anything here — `hyperframes render`
 *      reads them from the project's `meta.json` and `index.html` viewport.
 *      The return value is for caller-side logging + tests.
 *
 * Throws on any download failure so the route's outer catch block reverts the
 * row status and surfaces a useful error.
 */
export async function setupBlueprintWorkspace({
  workspace,
  compositionProjectUrl,
  sourceUrl,
  blueprintJson,
  serviceKey,
  fetchImpl = fetch,
}) {
  const parsed = parseSupabaseSignedUrl(compositionProjectUrl);
  if (!parsed) {
    throw new Error(`setupBlueprintWorkspace: compositionProjectUrl is not a Supabase signed URL`);
  }
  const { supabaseBase, bucket, prefix } = parsed;
  // We expect the prefix to live under hyperframes-projects; warn (don't fail)
  // if a future buck-rename means we see something else. Logged for visibility.
  if (bucket !== PROJECT_BUCKET_DEFAULT) {
    console.warn(`[blueprint_render] unexpected bucket="${bucket}" (expected "${PROJECT_BUCKET_DEFAULT}")`);
  }

  if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });

  // 1+2: download project files
  const objects = await listProjectObjects({ supabaseBase, bucket, prefix, serviceKey, fetchImpl });
  if (objects.length === 0) {
    throw new Error(`setupBlueprintWorkspace: project at "${prefix}" is empty — nothing to render`);
  }
  let downloadedCount = 0;
  for (const obj of objects) {
    const destPath = join(workspace, obj.relativePath);
    await downloadObjectToFile({
      supabaseBase,
      bucket,
      objectPath: obj.fullPath,
      serviceKey,
      destPath,
      fetchImpl,
    });
    downloadedCount++;
  }

  // 3: download source mp4 to the path the blueprint's HTML expects
  if (sourceUrl) {
    await downloadUrlToFile({
      url: sourceUrl,
      destPath: join(workspace, FACE_SOURCE_RELATIVE_PATH),
      fetchImpl,
    });
  }

  // 4: read dimensions from the blueprint (defensive — defaults to null tuple
  // when the caller didn't pass blueprintJson, e.g. older creative-engine).
  // `npx hyperframes render` reads dimensions from `meta.json` itself; this
  // return value is only used by the caller for logging + tests.
  const dimensions = readBlueprintDimensions(blueprintJson);

  return { downloadedCount, dimensions };
}

/**
 * Return `{ width, height }` from `blueprintJson.meta` when both are positive
 * finite numbers; otherwise `null`. Exported for tests.
 */
export function readBlueprintDimensions(blueprintJson) {
  const w = blueprintJson?.meta?.width;
  const h = blueprintJson?.meta?.height;
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { width: w, height: h };
  }
  return null;
}
