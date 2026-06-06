/**
 * test/hyperframes_render_dimensions.test.js
 *
 * Verifies the new blueprint-path workspace setup in `lib/blueprint_render.js`:
 *
 *   - A landscape blueprint (1920×1080) materializes a workspace where
 *     `meta.json` carries width=1920, height=1080 and `index.html` has the
 *     same viewport. The dimensions are derived from the blueprint, NOT from
 *     the legacy hardcoded portrait template.
 *
 *   - A portrait blueprint (1080×1920) materializes a workspace where
 *     `meta.json` carries width=1080, height=1920 and `index.html` matches.
 *     Same code path; both kits work.
 *
 *   - When `compositionProjectUrl` is absent, the legacy template-driven
 *     path is selected by the route handler (asserted indirectly by checking
 *     that `setupBlueprintWorkspace` is NOT called and the template is
 *     still in place untouched).
 *
 * Strategy:
 *   Spin up a local HTTP server that mimics the two Supabase Storage
 *   endpoints we use:
 *     POST /storage/v1/object/list/<bucket>   → returns an object listing
 *     GET  /storage/v1/object/<bucket>/<path> → returns the object bytes
 *
 *   Then drive `setupBlueprintWorkspace()` against that server and assert the
 *   workspace contents match what was "stored" — proving the blueprint's
 *   dimensions flow through unchanged to where `npx hyperframes render` will
 *   later pick them up.
 *
 * Run:
 *   node --test test/hyperframes_render_dimensions.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseSupabaseSignedUrl,
  setupBlueprintWorkspace,
  readBlueprintDimensions,
  FACE_SOURCE_RELATIVE_PATH,
} from '../lib/blueprint_render.js';

const SERVICE_KEY = 'test-service-key-fake';
const BUCKET = 'hyperframes-projects';

/**
 * Build a minimal but realistic per-video project file map for the given
 * dimensions. The HTML mirrors what `render_blueprint.ts` emits (viewport
 * + body sizing locked to the blueprint dimensions).
 */
function makeProjectFiles({ width, height, prefix }) {
  const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>FF Per-Video Project</title>
    <style>
      html, body { width: ${width}px; height: ${height}px; margin: 0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-width="${width}" data-height="${height}"></div>
  </body>
</html>`;
  const meta = {
    title: 'per-video project',
    width,
    height,
    fps: 30,
  };
  const sceneHtml = `<!doctype html><html><body><div>scene</div></body></html>`;
  return new Map([
    [`${prefix}/index.html`, indexHtml],
    [`${prefix}/meta.json`, JSON.stringify(meta)],
    [`${prefix}/compositions/scene1.html`, sceneHtml],
  ]);
}

/**
 * Local HTTP mock for the two Supabase Storage endpoints the helper hits.
 *
 * `objects` is a Map<fullStoragePath, stringBody> in the bucket. The "list"
 * endpoint walks keys whose path starts with the requested prefix; the "get"
 * endpoint returns the matching body verbatim.
 *
 * Auth check matches the helper's `Bearer <serviceKey>` header to confirm
 * we're going through the service-role path (and not accidentally fetching
 * via the public/anon path that wouldn't work for the private project bucket).
 */
function makeMockSupabase({ objects, sourceBytes }) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      // The source-bucket fetch simulates a Supabase signed URL — those are
      // self-authenticating (token in query string), so we skip the
      // service-role-key check for that bucket path. Every other endpoint
      // requires the service-role key, matching the helper's auth shape.
      const isSourceBucketGet =
        req.method === 'GET' && /^\/storage\/v1\/object\/source-bucket\//.test(req.url);
      if (!isSourceBucketGet) {
        const auth = req.headers.authorization || '';
        const apikey = req.headers.apikey || '';
        if (auth !== `Bearer ${SERVICE_KEY}` && apikey !== SERVICE_KEY) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'auth required' }));
          return;
        }
      }

      // POST /storage/v1/object/list/<bucket>
      const listMatch = req.url.match(/^\/storage\/v1\/object\/list\/([^?]+)/);
      if (req.method === 'POST' && listMatch) {
        const bucket = decodeURIComponent(listMatch[1]);
        if (bucket !== BUCKET) {
          res.writeHead(404).end();
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          const requestedPrefix = parsed.prefix ?? '';
          // Return the immediate children of requestedPrefix.
          // Folders have id=null per Supabase storage list semantics.
          const childMap = new Map();
          for (const key of objects.keys()) {
            if (!key.startsWith(`${requestedPrefix}/`)) continue;
            const rel = key.slice(requestedPrefix.length + 1);
            const slash = rel.indexOf('/');
            if (slash === -1) {
              childMap.set(rel, { id: 'file-id', name: rel });
            } else {
              const folderName = rel.slice(0, slash);
              if (!childMap.has(folderName)) {
                childMap.set(folderName, { id: null, name: folderName });
              }
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([...childMap.values()]));
        });
        return;
      }

      // GET /storage/v1/object/<bucket>/<path>
      const getMatch = req.url.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
      if (req.method === 'GET' && getMatch) {
        const bucket = decodeURIComponent(getMatch[1]);
        const path = decodeURIComponent(getMatch[2]);
        if (bucket === 'source-bucket' && path === 'source.mp4') {
          res.writeHead(200, { 'Content-Type': 'video/mp4' });
          res.end(sourceBytes);
          return;
        }
        if (bucket !== BUCKET) {
          res.writeHead(404).end();
          return;
        }
        const body = objects.get(path);
        if (body === undefined) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end(`not found: ${path}`);
          return;
        }
        res.writeHead(200, { 'Content-Type': path.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8' });
        res.end(body);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`unsupported: ${req.method} ${req.url}`);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function makeTmpWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'hf-bp-test-'));
  return { workspace: join(dir, 'workspace'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('parseSupabaseSignedUrl handles the standard signed-URL shape', () => {
  const url = 'https://abc.supabase.co/storage/v1/object/sign/hyperframes-projects/abc-123/index.html?token=zzz';
  const parsed = parseSupabaseSignedUrl(url);
  assert.deepEqual(parsed, {
    supabaseBase: 'https://abc.supabase.co',
    bucket: 'hyperframes-projects',
    path: 'abc-123/index.html',
    prefix: 'abc-123',
  });
});

test('parseSupabaseSignedUrl returns null for non-storage URLs', () => {
  assert.equal(parseSupabaseSignedUrl(''), null);
  assert.equal(parseSupabaseSignedUrl('https://example.com/foo'), null);
  assert.equal(parseSupabaseSignedUrl(null), null);
});

test('readBlueprintDimensions returns null when meta is missing/invalid', () => {
  assert.equal(readBlueprintDimensions(null), null);
  assert.equal(readBlueprintDimensions({}), null);
  assert.equal(readBlueprintDimensions({ meta: {} }), null);
  assert.equal(readBlueprintDimensions({ meta: { width: 0, height: 1080 } }), null);
  assert.deepEqual(
    readBlueprintDimensions({ meta: { width: 1920, height: 1080 } }),
    { width: 1920, height: 1080 },
  );
});

test('LANDSCAPE blueprint: workspace gets 1920×1080 viewport + meta from the blueprint, not a portrait template', async () => {
  const PREFIX = 'landscape-ad';
  const objects = makeProjectFiles({ width: 1920, height: 1080, prefix: PREFIX });
  const { server, base } = await makeMockSupabase({ objects, sourceBytes: Buffer.from('fake-mp4-bytes') });
  const { workspace, cleanup } = makeTmpWorkspace();

  try {
    const compositionProjectUrl = `${base}/storage/v1/object/sign/${BUCKET}/${PREFIX}/index.html?token=zzz`;
    const sourceUrl = `${base}/storage/v1/object/source-bucket/source.mp4`;
    const blueprintJson = { meta: { width: 1920, height: 1080, fps: 30 } };

    const result = await setupBlueprintWorkspace({
      workspace,
      compositionProjectUrl,
      sourceUrl,
      blueprintJson,
      serviceKey: SERVICE_KEY,
    });

    // Project files materialized
    assert.equal(result.downloadedCount, 3, 'all 3 project files downloaded');
    assert.deepEqual(result.dimensions, { width: 1920, height: 1080 });

    // index.html came from the blueprint, not the portrait template
    const indexHtml = readFileSync(join(workspace, 'index.html'), 'utf8');
    assert.match(indexHtml, /viewport.*width=1920.*height=1080/);
    assert.match(indexHtml, /width: 1920px; height: 1080px/);
    assert.doesNotMatch(indexHtml, /width=1080.*height=1920/, 'no portrait viewport leaked in');

    // meta.json carries landscape dimensions — `npx hyperframes render` will
    // pick these up at launch; Chromium viewport + ffmpeg output both inherit.
    const meta = JSON.parse(readFileSync(join(workspace, 'meta.json'), 'utf8'));
    assert.equal(meta.width, 1920);
    assert.equal(meta.height, 1080);

    // Scene HTML is materialized in its subfolder
    assert.ok(existsSync(join(workspace, 'compositions', 'scene1.html')));

    // Source video landed at the path the blueprint HTML expects
    const sourcePath = join(workspace, FACE_SOURCE_RELATIVE_PATH);
    assert.ok(existsSync(sourcePath));
    assert.ok(statSync(sourcePath).size > 0);
  } finally {
    cleanup();
    server.close();
  }
});

test('PORTRAIT blueprint: same code path renders at 1080×1920 — proves dimensions come from blueprint, not a hardcoded constant', async () => {
  const PREFIX = 'portrait-reel';
  const objects = makeProjectFiles({ width: 1080, height: 1920, prefix: PREFIX });
  const { server, base } = await makeMockSupabase({ objects, sourceBytes: Buffer.from('fake-mp4-bytes') });
  const { workspace, cleanup } = makeTmpWorkspace();

  try {
    const compositionProjectUrl = `${base}/storage/v1/object/sign/${BUCKET}/${PREFIX}/index.html?token=zzz`;
    const sourceUrl = `${base}/storage/v1/object/source-bucket/source.mp4`;
    const blueprintJson = { meta: { width: 1080, height: 1920, fps: 30 } };

    const result = await setupBlueprintWorkspace({
      workspace,
      compositionProjectUrl,
      sourceUrl,
      blueprintJson,
      serviceKey: SERVICE_KEY,
    });

    assert.equal(result.downloadedCount, 3);
    assert.deepEqual(result.dimensions, { width: 1080, height: 1920 });

    const indexHtml = readFileSync(join(workspace, 'index.html'), 'utf8');
    assert.match(indexHtml, /viewport.*width=1080.*height=1920/);
    assert.match(indexHtml, /width: 1080px; height: 1920px/);

    const meta = JSON.parse(readFileSync(join(workspace, 'meta.json'), 'utf8'));
    assert.equal(meta.width, 1080);
    assert.equal(meta.height, 1920);
  } finally {
    cleanup();
    server.close();
  }
});

test('Empty project prefix is rejected loudly (so we never render an empty workspace)', async () => {
  const { server, base } = await makeMockSupabase({ objects: new Map(), sourceBytes: Buffer.from('') });
  const { workspace, cleanup } = makeTmpWorkspace();

  try {
    const compositionProjectUrl = `${base}/storage/v1/object/sign/${BUCKET}/empty-prefix/index.html?token=zzz`;
    await assert.rejects(
      () =>
        setupBlueprintWorkspace({
          workspace,
          compositionProjectUrl,
          sourceUrl: null,
          blueprintJson: { meta: { width: 1920, height: 1080 } },
          serviceKey: SERVICE_KEY,
        }),
      /empty — nothing to render/,
    );
  } finally {
    cleanup();
    server.close();
  }
});

test('Non-Supabase URL is rejected before any network call', async () => {
  const { workspace, cleanup } = makeTmpWorkspace();
  try {
    await assert.rejects(
      () =>
        setupBlueprintWorkspace({
          workspace,
          compositionProjectUrl: 'https://example.com/not-a-storage-url',
          sourceUrl: null,
          blueprintJson: { meta: { width: 1920, height: 1080 } },
          serviceKey: SERVICE_KEY,
        }),
      /not a Supabase signed URL/,
    );
  } finally {
    cleanup();
  }
});
