import { Router } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { unlinkSync, existsSync, readFileSync, createReadStream, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const execAsync = promisify(exec);

export const youtubeRouter = Router();

const OAUTH_TOKEN_PATH = '/tmp/yt-dlp-oauth2.json';

/**
 * Write YOUTUBE_OAUTH_TOKEN env var to the yt-dlp oauth2 token file.
 * Returns the --username/--password flags for oauth2 plugin if token exists.
 * Falls back to cookies if YOUTUBE_COOKIES is set.
 * Returns empty string if neither is configured.
 */
function getYtDlpAuthArg() {
  const oauthToken = process.env.YOUTUBE_OAUTH_TOKEN;
  if (oauthToken) {
    writeFileSync(OAUTH_TOKEN_PATH, oauthToken, 'utf8');
    return `--username oauth2 --password "" --plugin-dirs /usr/local/lib/python3.*/dist-packages`;
  }
  const cookiesEnv = process.env.YOUTUBE_COOKIES;
  if (cookiesEnv) {
    const cookiesPath = '/tmp/youtube-cookies.txt';
    writeFileSync(cookiesPath, cookiesEnv, 'utf8');
    return `--cookies "${cookiesPath}"`;
  }
  return '';
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

  const cookiesArg = getYtDlpAuthArg();
  const cmd = [
    'yt-dlp',
    cookiesArg,
    '--js-runtimes node',
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
 * Detect the speaker's face in a video frame.
 * Returns { cx, speakerSide } — speakerSide is 'left' or 'right'.
 */
async function detectFace(videoPath) {
  const framePath = videoPath.replace('.mp4', '_frame.jpg');
  try {
    await execAsync(`ffmpeg -ss 1 -i "${videoPath}" -frames:v 1 -y "${framePath}"`, { timeout: 15000 });
    const scriptPath = new URL('../lib/detect_face.py', import.meta.url).pathname;
    const { stdout } = await execAsync(`python3 "${scriptPath}" "${framePath}"`, { timeout: 15000 });
    const result = JSON.parse(stdout.trim());
    if (result.cx != null) {
      console.log(`[youtube] face detected at x=${result.cx}, side=${result.speaker_side}`);
      return { cx: result.cx, speakerSide: result.speaker_side };
    }
    console.log('[youtube] no face detected, defaulting to left=speaker');
    return { cx: null, speakerSide: 'left' };
  } catch (err) {
    console.warn('[youtube] face detection failed:', err.message);
    return { cx: null, speakerSide: 'left' };
  } finally {
    if (existsSync(framePath)) unlinkSync(framePath);
  }
}

/**
 * Convert a landscape YouTube clip to portrait (1080x1920).
 * Uses face detection to center the crop on the speaker.
 * Overwrites the file in place.
 */
async function convertToPortraitSplit(inputPath) {
  const outputPath = inputPath.replace('.mp4', '_portrait.mp4');
  try {
    // Detect input dimensions
    const { stdout } = await execAsync(
      `ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${inputPath}"`
    );
    const [w, h] = stdout.trim().split(',').map(Number);
    console.log(`[youtube] input dimensions: ${w}x${h}`);

    // If already portrait or near-square, just scale to 1080x1920
    if (h >= w) {
      await execAsync(
        `ffmpeg -i "${inputPath}" ` +
        `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" ` +
        `-c:v libx264 -preset fast -crf 23 -c:a aac -movflags +faststart -y "${outputPath}"`,
        { timeout: 120000 }
      );
    } else {
      // Detect which side the speaker is on
      const { speakerSide } = await detectFace(inputPath);

      // Split left/right halves — speaker goes bottom, content/guest goes top
      // Layout: [top = guest/content] [bottom = speaker face]
      const speakerCrop = speakerSide === 'left'
        ? `crop=iw/2:ih:0:0` // left half = speaker
        : `crop=iw/2:ih:iw/2:0`; // right half = speaker
      const contentCrop = speakerSide === 'left'
        ? `crop=iw/2:ih:iw/2:0` // right half = content
        : `crop=iw/2:ih:0:0`; // left half = content

      console.log(`[youtube] speaker on ${speakerSide} → speaker=bottom, content=top`);
      await execAsync(
        `ffmpeg -i "${inputPath}" ` +
        `-filter_complex "[0:v]${contentCrop},scale=1080:960[top];[0:v]${speakerCrop},scale=1080:960[bottom];[top][bottom]vstack[out]" ` +
        `-map "[out]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a aac -movflags +faststart -y "${outputPath}"`,
        { timeout: 120000 }
      );
    }

    unlinkSync(inputPath);
    await execAsync(`mv "${outputPath}" "${inputPath}"`);
    console.log(`[youtube] converted to portrait (${w}x${h} → 1080x1920): ${inputPath}`);
  } catch (err) {
    if (existsSync(outputPath)) unlinkSync(outputPath);
    throw err;
  }
}

/**
 * Download transcript (auto-generated captions) from a YouTube video.
 * Returns the raw VTT text, or null if unavailable.
 */
async function downloadTranscript(youtubeUrl, tmpDir) {
  try {
    const cookiesArg = getYtDlpAuthArg();
    await execAsync(
      `yt-dlp ${cookiesArg} --js-runtimes node --write-auto-subs --sub-langs en --sub-format vtt --skip-download --no-playlist -o "${tmpDir}/transcript" "${youtubeUrl}"`,
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

          // Convert landscape to portrait split-screen (host bottom, guest top)
          await convertToPortraitSplit(clipPath);

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
            uploaded_by: clientId,
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
        extraction_status: extractedClips.length > 0 ? 'extracted' : 'dispatch_failed',
      });

      console.log(`[youtube] done: ${extractedClips.length}/${clips.length} clips extracted for plan ${clipPlanId}`);
    } catch (err) {
      console.error(`[youtube] extraction failed for plan ${clipPlanId}:`, err.message);
      await supabasePatch('youtube_clip_plans', clipPlanId, {
        extraction_status: 'dispatch_failed',
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
