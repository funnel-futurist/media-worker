import { Router } from 'express';
import { execSync, spawn } from 'child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, cpSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { rewriteScenesWithScript } from '../lib/scene_rewriter.js';

export const hyperframesRouter = Router();

const TEMPLATE_DIR = resolve(process.cwd(), 'hyperframes-template');
const WORKSPACE_BASE = '/tmp';

/**
 * Headers for Supabase REST + Storage calls using the service role key.
 */
function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_KEY/SUPABASE_SERVICE_ROLE_KEY not set');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'marketing',
    'Content-Profile': 'marketing',
  };
}

function getSupabaseUrl() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL not set');
  return url.replace(/\/$/, '');
}

async function supabaseUpdate(table, id, data) {
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: supabaseHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} failed: ${await res.text()}`);
}

async function supabaseInsert(table, data) {
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/${table}`, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase POST ${table} failed: ${await res.text()}`);
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed ${res.status} for ${url.slice(0, 80)}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
}

/**
 * Upload a file to Supabase Storage.
 * Path inside `video-modules` bucket.
 */
async function uploadToSupabaseStorage(filePath, storagePath) {
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = getSupabaseUrl();

  const buffer = readFileSync(filePath);
  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/video-modules/${storagePath}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'video/mp4',
        'x-upsert': 'true',
      },
      body: buffer,
    }
  );
  if (!res.ok) throw new Error(`Supabase Storage upload failed: ${await res.text()}`);
  return `${supabaseUrl}/storage/v1/object/public/video-modules/${storagePath}`;
}

/**
 * Spawn a child process and stream its stdout/stderr to our logger.
 * Resolves on exit code 0, rejects otherwise.
 */
function runCommand(cmd, args, cwd, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    proc.stdout.on('data', (d) => {
      const line = d.toString();
      chunks.push(line);
      process.stdout.write(`[hf:${label}] ${line}`);
    });
    proc.stderr.on('data', (d) => {
      const line = d.toString();
      chunks.push(line);
      process.stderr.write(`[hf:${label}] ${line}`);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      const output = chunks.join('');
      if (code === 0) return resolve(output);
      // Keep the last 1500 chars of combined stdout/stderr so we can surface
      // the real failure reason in the ad_ingestion error event.
      const tail = output.slice(-1500).replace(/\s+$/, '');
      const err = new Error(`${label} exited with code ${code}\n--- last output ---\n${tail}`);
      err.stage = label;
      err.tail = tail;
      reject(err);
    });
  });
}

/**
 * POST /hyperframes-render-async
 *
 * Body:
 * {
 *   adIngestionId: string,
 *   clientId: string,
 *   clientSlug: string,
 *   videoUrl: string,
 *   musicUrl?: string | null,
 *   brollUrls: string[],
 *   script: string,
 *   brandTokens: { accent: string, warn: string }
 * }
 *
 * Returns immediately with { accepted: true, adIngestionId }. Render runs
 * in background; on completion this endpoint directly updates the Supabase
 * ad_ingestion row to status='rendered' + file_url, and logs a
 * hyperframes_render_complete event.
 */
hyperframesRouter.post('/hyperframes-render-async', async (req, res) => {
  const {
    adIngestionId,
    clientId,
    clientSlug,
    videoUrl,
    musicUrl,
    brollUrls = [],
    script = '',
    brandTokens = { accent: '#37bdf8', warn: '#f09025' },
  } = req.body || {};

  if (!adIngestionId || !clientId || !clientSlug || !videoUrl) {
    return res.status(400).json({ error: 'adIngestionId, clientId, clientSlug, videoUrl are required' });
  }

  // Fire-and-forget: return immediately so Vercel cron doesn't block.
  res.json({ accepted: true, adIngestionId });

  // Background processing
  runHyperframesJob({
    adIngestionId,
    clientId,
    clientSlug,
    videoUrl,
    musicUrl,
    brollUrls,
    script,
    brandTokens,
  }).catch((err) => {
    console.error(`[hf] background job failed for ${adIngestionId}:`, err.message);
  });
});

async function runHyperframesJob({
  adIngestionId,
  clientId,
  clientSlug,
  videoUrl,
  musicUrl,
  brollUrls,
  script,
  brandTokens,
}) {
  const workspace = join(WORKSPACE_BASE, `hf-${adIngestionId}-${randomUUID()}`);
  console.log(`[hf] starting render for ${adIngestionId} in ${workspace}`);

  try {
    if (!existsSync(TEMPLATE_DIR)) {
      throw new Error(`Hyperframes template not found at ${TEMPLATE_DIR}`);
    }

    // 1. Copy template
    cpSync(TEMPLATE_DIR, workspace, { recursive: true });
    mkdirSync(join(workspace, 'assets', 'visuals'), { recursive: true });
    mkdirSync(join(workspace, 'renders'), { recursive: true });

    // 2. Download raw video
    const rawPath = join(workspace, 'assets', 'raw-edit.mp4');
    console.log(`[hf] downloading raw video...`);
    await downloadFile(videoUrl, rawPath);

    // 3. Download music (optional)
    if (musicUrl) {
      try {
        await downloadFile(musicUrl, join(workspace, 'assets', 'music.mp3'));
        console.log(`[hf] music downloaded`);
      } catch (err) {
        console.warn(`[hf] music download failed, continuing without music: ${err.message}`);
      }
    } else {
      console.log(`[hf] no music URL provided — speaker-only render`);
    }

    // 4. Download b-roll assets (up to 3)
    for (let i = 0; i < Math.min(brollUrls.length, 3); i++) {
      try {
        await downloadFile(brollUrls[i], join(workspace, 'assets', 'visuals', `broll-${i + 1}.png`));
      } catch (err) {
        console.warn(`[hf] b-roll ${i + 1} download failed: ${err.message}`);
      }
    }

    // 5. Write script.txt
    writeFileSync(join(workspace, 'assets', 'script.txt'), script || '', 'utf8');

    // 6. Override brand tokens
    const brandTokensCss = `
:root {
  --ff-accent: ${brandTokens.accent};
  --ff-warn: ${brandTokens.warn};
  --ff-bg: #07121c;
  --ff-surface: #0d2031;
  --ff-surface-2: #1a2e3d;
  --ff-border: #252d33;
  --ff-text: #ffffff;
  --ff-text-dim: #96a2b6;
}
`;
    writeFileSync(join(workspace, 'assets', 'brand-tokens.css'), brandTokensCss.trim() + '\n', 'utf8');

    // 7a. Rewrite scene text slots with Gemini so motion graphics match the
    //     CURRENT client's script, not Phoenix's baked-in pilot content.
    //     Safe fallback: if rewrite fails, the original template renders unchanged.
    console.log(`[hf] rewriting scenes with Gemini...`);
    try {
      const result = await rewriteScenesWithScript(workspace, script, { clientSlug });
      console.log(`[hf] scene rewriter result:`, JSON.stringify(result));
    } catch (err) {
      console.warn(`[hf] scene rewriter threw (continuing with original template): ${err.message}`);
    }

    // 7b. Run prep pipeline (silence cut + transcribe + caption align + audio QC)
    console.log(`[hf] running prep.js...`);
    await runCommand('node', ['scripts/prep.js', 'assets/raw-edit.mp4'], workspace, 'prep');

    // 8. Run hyperframes render
    console.log(`[hf] running hyperframes render...`);
    await runCommand('npx', ['hyperframes', 'render', '--quality', 'draft'], workspace, 'render');

    // 9. Find the output MP4
    const rendersDir = join(workspace, 'renders');
    const renderFiles = readdirSync(rendersDir)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => ({ name: f, mtime: statSync(join(rendersDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);

    if (renderFiles.length === 0) {
      throw new Error('No MP4 produced in renders/ directory');
    }
    const outputPath = join(rendersDir, renderFiles[0].name);
    console.log(`[hf] render complete: ${renderFiles[0].name}`);

    // 10. Upload to Supabase Storage
    const datePrefix = new Date().toISOString().slice(0, 10);
    const storagePath = `hyperframes-output/${clientId}/${datePrefix}/${randomUUID()}.mp4`;
    const publicUrl = await uploadToSupabaseStorage(outputPath, storagePath);
    console.log(`[hf] uploaded to ${publicUrl}`);

    // 11. Update ad_ingestion
    await supabaseUpdate('ad_ingestion', adIngestionId, {
      status: 'rendered',
      file_url: publicUrl,
    });

    // 12. Log event
    await supabaseInsert('content_pipeline_events', {
      client_id: clientId,
      event_type: 'hyperframes_render_complete',
      source_module: 'media-worker/hyperframes',
      metadata: {
        ingestion_id: adIngestionId,
        client_slug: clientSlug,
        broll_count: brollUrls.length,
        had_music: !!musicUrl,
        output_path: storagePath,
      },
    });

    console.log(`[hf] ✓ complete for ${adIngestionId}`);
  } catch (err) {
    console.error(`[hf] ✗ render failed for ${adIngestionId}:`, err.message);

    // Revert to washed so the cron retries next tick
    await supabaseUpdate('ad_ingestion', adIngestionId, { status: 'washed' }).catch(() => {});
    await supabaseInsert('content_pipeline_events', {
      client_id: clientId,
      event_type: 'error',
      source_module: 'media-worker/hyperframes',
      metadata: {
        ingestion_id: adIngestionId,
        error: err.message.slice(0, 1800),
        stage: err.stage ?? null,
        tail: err.tail ? err.tail.slice(-1500) : null,
      },
    }).catch(() => {});
  } finally {
    // Clean up workspace
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch (_err) {
      /* ignore */
    }
  }
}
