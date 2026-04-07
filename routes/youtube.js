import { Router } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { unlinkSync, existsSync, readFileSync, createReadStream, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);

export const youtubeRouter = Router();

const COOKIES_PATH = '/tmp/youtube-cookies.txt';

/**
 * Write YOUTUBE_COOKIES env var to a temp file and return the --cookies flag.
 * Returns empty string if env var not set.
 */
function getYtDlpCookiesArg() {
  const cookiesEnv = process.env.YOUTUBE_COOKIES;
  if (!cookiesEnv) return '';
  writeFileSync(COOKIES_PATH, cookiesEnv, 'utf8');
  return `--cookies "${COOKIES_PATH}"`;
}

function getSupabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_KEY not set');
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
  return url;
}

/**
 * Upload a local file to Supabase Storage.
 * Returns the public URL.
 */
async function uploadToSupabaseStorage(filePath, storagePath) {
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_KEY not set');

  const fileBuffer = readFileSync(filePath);
  const fileSize = statSync(filePath).size;

  const res = await fetch(
    `${getSupabaseUrl()}/storage/v1/object/video-modules/${storagePath}`,
    {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'video/mp4',
        'Content-Length': String(fileSize),
        'x-upsert': 'true',
      },
      body: fileBuffer,
    }
  );

  if (!res.ok) throw new Error(`Supabase Storage upload failed: ${await res.text()}`);

  return `${getSupabaseUrl()}/storage/v1/object/public/video-modules/${storagePath}`;
}

async function supabasePatch(table, id, data) {
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: getSupabaseHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} failed: ${await res.text()}`);
}

async function supabaseInsert(table, data) {
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...getSupabaseHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase POST ${table} failed: ${await res.text()}`);
  return res.json();
}

/**
 * Convert MM:SS or HH:MM:SS timestamp string to total seconds.
 */
function tsToSeconds(ts) {
  const parts = ts.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

/**
 * Download a time-ranged clip from a YouTube video using yt-dlp.
 * Returns path to the downloaded mp4 file.
 */
async function downloadClip(youtubeUrl, startTs, endTs, outputPath) {
  const startSec = tsToSeconds(startTs);
  const endSec = tsToSeconds(endTs);
  const duration = endSec - startSec;

  if (duration <= 0) throw new Error(`Invalid time range: ${startTs} → ${endTs}`);

  const cookiesArg = getYtDlpCookiesArg();
  const cmd = [
    'yt-dlp',
    cookiesArg,
    '--extractor-args "youtube:player_client=ios"',
    `--download-sections "*${startTs}-${endTs}"`,
    '-f "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best"',
    '--merge-output-format mp4',
    '--no-playlist',
    `--output "${outputPath}"`,
    `"${youtubeUrl}"`,
  ].filter(Boolean).join(' ');

  console.log(`[youtube] downloading clip ${startTs}→${endTs} (${duration}s)`);
  await execAsync(cmd, { timeout: 300000 }); // 5 min max per clip
}

/**
 * Download transcript (auto-generated captions) from a YouTube video.
 * Returns the raw VTT text, or null if unavailable.
 */
async function downloadTranscript(youtubeUrl, tmpDir) {
  try {
    const cookiesArg = getYtDlpCookiesArg();
    await execAsync(
      `yt-dlp ${cookiesArg} --extractor-args "youtube:player_client=ios" --write-auto-subs --sub-langs en --sub-format vtt --skip-download --no-playlist -o "${tmpDir}/transcript" "${youtubeUrl}"`,
      { timeout: 60000 }
    );
    // yt-dlp writes transcript.en.vtt
    const vttPath = join(tmpDir, 'transcript.en.vtt');
    if (existsSync(vttPath)) return readFileSync(vttPath, 'utf8');
    return null;
  } catch {
    return null;
  }
}

/**
 * POST /youtube-extract-async
 *
 * Fire-and-forget: accepts immediately, processes in background.
 * Downloads clip segments from a YouTube video, uploads to Cloudinary,
 * creates ad_ingestion rows so the render pipeline picks them up.
 *
 * Body: {
 *   clipPlanId: string
 *   youtubeUrl: string
 *   videoTitle: string
 *   clientId: string
 *   clips: Array<{ title, startTimestamp, endTimestamp, suggestedCaption }>
 * }
 */
youtubeRouter.post('/youtube-extract-async', async (req, res) => {
  const { clipPlanId, youtubeUrl, videoTitle, clientId, clips } = req.body;
  if (!clipPlanId || !youtubeUrl || !clientId || !Array.isArray(clips)) {
    return res.status(400).json({ error: 'clipPlanId, youtubeUrl, clientId, clips required' });
  }

  res.json({ accepted: true, clipPlanId, clipCount: clips.length });

  setImmediate(async () => {
    const tmpDir = `/tmp/yt-${randomUUID()}`;
    await execAsync(`mkdir -p "${tmpDir}"`);

    try {
      console.log(`[youtube] starting extraction for plan ${clipPlanId} (${clips.length} clips)`);

      const extractedClips = [];

      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const clipPath = join(tmpDir, `clip_${i}.mp4`);

        try {
          await downloadClip(youtubeUrl, clip.startTimestamp, clip.endTimestamp, clipPath);

          if (!existsSync(clipPath)) {
            console.warn(`[youtube] clip ${i} file not found after download, skipping`);
            continue;
          }

          // Upload to Supabase Storage
          const date = new Date().toISOString().split('T')[0];
          const safeFilename = (clip.title ?? `clip_${i}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
          const storagePath = `youtube-clips/${clientId}/${date}/${randomUUID()}_${safeFilename}.mp4`;
          const clipUrl = await uploadToSupabaseStorage(clipPath, storagePath);
          console.log(`[youtube] clip ${i} uploaded: ${clipUrl}`);

          // Create ad_ingestion row — pipeline will add captions via Submagic
          const safeTitle = clip.title?.slice(0, 100) ?? `Clip ${i + 1}`;
          const filename = `${safeTitle}.mp4`;

          await supabaseInsert('ad_ingestion', {
            client_id: clientId,
            upload_source: 'youtube_clip',
            asset_type: 'reel_raw',
            format: 'video',
            file_url: clipUrl,
            original_filename: filename,
            status: 'classified',
            gemini_markup: {
              source: 'youtube',
              youtube_url: youtubeUrl,
              video_title: videoTitle,
              clip_title: clip.title,
              suggested_caption: clip.suggestedCaption ?? null,
              broll_cues: [],
              emotion_tags: [],
            },
          });

          extractedClips.push({ title: clip.title, url: clipUrl });
        } catch (clipErr) {
          console.error(`[youtube] clip ${i} failed:`, clipErr.message);
        }

        // Cleanup clip temp file
        if (existsSync(clipPath)) unlinkSync(clipPath);
      }

      // Mark plan as extracted
      await supabasePatch('youtube_clip_plans', clipPlanId, {
        extraction_status: extractedClips.length > 0 ? 'extracted' : 'failed',
      });

      console.log(`[youtube] done: ${extractedClips.length}/${clips.length} clips extracted for plan ${clipPlanId}`);
    } catch (err) {
      console.error(`[youtube] extraction failed for plan ${clipPlanId}:`, err.message);
      await supabasePatch('youtube_clip_plans', clipPlanId, {
        extraction_status: 'failed',
        last_error: err.message,
      }).catch(() => {});
    } finally {
      // Cleanup temp dir
      execAsync(`rm -rf "${tmpDir}"`).catch(() => {});
    }
  });
});

/**
 * POST /youtube-transcript
 *
 * Returns the VTT transcript for a YouTube video.
 * Used by Vercel to get transcript before calling Gemini for clip identification.
 */
youtubeRouter.post('/youtube-transcript', async (req, res, next) => {
  const { youtubeUrl } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: 'youtubeUrl required' });

  const tmpDir = `/tmp/transcript-${randomUUID()}`;
  try {
    await execAsync(`mkdir -p "${tmpDir}"`);
    const transcript = await downloadTranscript(youtubeUrl, tmpDir);
    res.json({ transcript, available: transcript !== null });
  } catch (err) {
    next(err);
  } finally {
    execAsync(`rm -rf "${tmpDir}"`).catch(() => {});
  }
});
