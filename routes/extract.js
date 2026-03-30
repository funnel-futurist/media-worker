import { Router } from 'express';
import { mkdirSync, rmSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { analyzeVideo } from '../lib/gemini.js';
import { uploadVideoToDrive, uploadAnalysisToDrive } from '../lib/drive.js';

const execAsync = promisify(exec);

export const extractRouter = Router();

/**
 * POST /extract
 *
 * Download a Bunny.net HLS video via ffmpeg, analyze with Gemini,
 * upload video + analysis to Google Drive, return the analysis.
 *
 * Body: {
 *   guid: string,              — Bunny video GUID
 *   module_name: string,       — e.g., "M3V6 How to Research Your Market"
 *   course_code: string,       — e.g., "EMAIL101"
 *   coach: string,             — e.g., "Isaac Lara"
 *   course_name: string,       — e.g., "Email to CRO Pro"
 *   drive_folder_id: string,   — Drive folder ID for this course
 *   output_filename: string,   — e.g., "video_10" (no extension)
 *   prompt?: string,           — Custom analysis prompt (optional)
 *   skip_drive_video?: bool,   — Skip video upload to Drive (analysis only)
 * }
 *
 * Returns: {
 *   success: bool,
 *   analysis: string,          — Gemini analysis markdown
 *   video_size_mb: number,
 *   drive_video: { id, action },
 *   drive_analysis: { id, action },
 *   duration_seconds: number,
 * }
 */
extractRouter.post('/extract', async (req, res, next) => {
  const tmpDir = join('/tmp', `extract-${randomUUID()}`);
  const startTime = Date.now();

  try {
    const {
      guid,
      module_name,
      course_code,
      coach,
      course_name,
      drive_folder_id,
      output_filename,
      prompt: customPrompt,
      skip_drive_video = false,
    } = req.body;

    if (!guid || !module_name || !course_code || !drive_folder_id || !output_filename) {
      return res.status(400).json({
        error: 'Required: guid, module_name, course_code, drive_folder_id, output_filename',
      });
    }

    mkdirSync(tmpDir, { recursive: true });

    // ── Step 1: Download via ffmpeg ──────────────────────────────────
    const hlsUrl = `https://vz-0df954d7-e19.b-cdn.net/${guid}/playlist.m3u8`;
    const videoPath = join(tmpDir, `${output_filename}.mp4`);

    console.log(`[Extract] Downloading ${module_name} (${guid})...`);
    await execAsync(
      `ffmpeg -headers "Referer: https://iframe.mediadelivery.net/" -i "${hlsUrl}" -c copy -y "${videoPath}"`,
      { timeout: 600_000 } // 10 min max for download
    );

    const videoSize = statSync(videoPath).size;
    const sizeMB = (videoSize / (1024 * 1024)).toFixed(1);
    console.log(`[Extract] Downloaded: ${sizeMB}MB`);

    // ── Step 2: Gemini analysis ─────────────────────────────────────
    const analysisPrompt = customPrompt || buildDefaultPrompt(course_code, course_name, module_name, coach);
    const analysis = await analyzeVideo(videoPath, analysisPrompt);
    console.log(`[Extract] Analysis complete: ${analysis.length} chars`);

    // ── Step 3: Upload to Google Drive ──────────────────────────────
    let driveVideo = { action: 'skipped' };
    if (!skip_drive_video) {
      driveVideo = await uploadVideoToDrive(videoPath, drive_folder_id);
    }

    const driveAnalysis = await uploadAnalysisToDrive(
      analysis,
      `${output_filename}.md`,
      drive_folder_id
    );

    // ── Cleanup ─────────────────────────────────────────────────────
    rmSync(tmpDir, { recursive: true, force: true });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Extract] Complete: ${module_name} in ${duration}s`);

    res.json({
      success: true,
      analysis,
      video_size_mb: parseFloat(sizeMB),
      drive_video: driveVideo,
      drive_analysis: driveAnalysis,
      duration_seconds: parseFloat(duration),
    });

  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    next(err);
  }
});

/**
 * POST /extract/batch
 *
 * Process multiple videos sequentially. Same params as /extract but as an array.
 * Returns results for each video (success or error).
 *
 * Body: { videos: [{ guid, module_name, ... }, ...], ...sharedParams }
 * sharedParams: course_code, coach, course_name, drive_folder_id — applied to all
 */
extractRouter.post('/extract/batch', async (req, res, next) => {
  try {
    const { videos, course_code, coach, course_name, drive_folder_id, skip_drive_video } = req.body;

    if (!videos?.length) {
      return res.status(400).json({ error: 'videos array is required' });
    }

    const results = [];
    for (const video of videos) {
      const startTime = Date.now();
      const tmpDir = join('/tmp', `extract-${randomUUID()}`);

      try {
        mkdirSync(tmpDir, { recursive: true });

        const guid = video.guid;
        const moduleName = video.module_name;
        const outputFilename = video.output_filename;

        const hlsUrl = `https://vz-0df954d7-e19.b-cdn.net/${guid}/playlist.m3u8`;
        const videoPath = join(tmpDir, `${outputFilename}.mp4`);

        console.log(`[Batch] Downloading ${moduleName}...`);
        await execAsync(
          `ffmpeg -headers "Referer: https://iframe.mediadelivery.net/" -i "${hlsUrl}" -c copy -y "${videoPath}"`,
          { timeout: 600_000 }
        );

        const sizeMB = (statSync(videoPath).size / (1024 * 1024)).toFixed(1);
        const prompt = video.prompt || buildDefaultPrompt(course_code, course_name, moduleName, coach);
        const analysis = await analyzeVideo(videoPath, prompt);

        let driveVideo = { action: 'skipped' };
        if (!skip_drive_video) {
          driveVideo = await uploadVideoToDrive(videoPath, drive_folder_id);
        }
        const driveAnalysis = await uploadAnalysisToDrive(analysis, `${outputFilename}.md`, drive_folder_id);

        rmSync(tmpDir, { recursive: true, force: true });

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Batch] Done: ${moduleName} (${duration}s)`);

        results.push({
          module_name: moduleName,
          success: true,
          video_size_mb: parseFloat(sizeMB),
          analysis_length: analysis.length,
          drive_video: driveVideo,
          drive_analysis: driveAnalysis,
          duration_seconds: parseFloat(duration),
        });

      } catch (err) {
        rmSync(tmpDir, { recursive: true, force: true });
        console.error(`[Batch] Failed: ${video.module_name} — ${err.message}`);
        results.push({
          module_name: video.module_name,
          success: false,
          error: err.message,
        });
      }
    }

    res.json({
      total: videos.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    });

  } catch (err) {
    next(err);
  }
});

function buildDefaultPrompt(courseCode, courseName, moduleName, coach) {
  return `You are an IP extraction specialist working for a direct response marketing agency. Your job is to extract EVERY piece of intellectual property from this training video with extreme thoroughness. Do NOT summarize — extract and preserve the original thinking.

**Source:** ${courseCode} — ${courseName}
**Module:** ${moduleName}
**Coach:** ${coach}

Extract using this exact structure. Every section must have substantive content — if a section is empty, explain why.

---

## 1. EXECUTIVE SUMMARY (150-300 words)
What is this module actually teaching? What's the core thesis? What does the coach want the student to DO differently after watching? Be specific — not "improve email marketing" but the exact mechanism or mindset shift being taught.

## 2. KEY FRAMEWORKS & MODELS
For EACH framework, model, or mental model presented:
- **Name:** (use the coach's exact name, or create a descriptive one if unnamed)
- **How it works:** Step-by-step mechanics (not a summary — the actual steps)
- **Visual/diagram:** Describe any visual model shown (flowchart, matrix, pyramid, etc.)
- **Novelty Rating:** [NET_NEW] never seen this before | [VARIANT] twist on known concept | [COMMON] standard industry knowledge
- **Applicability Rating:** [HIGH] immediately usable | [MEDIUM] needs adaptation | [LOW] niche/theoretical
- **Similar to:** Name any overlapping frameworks from CFA (Curiosity-Fascination-Agitation), Copy Logic, Awareness Levels, or standard direct response frameworks

## 3. TACTICAL TAKEAWAYS
Specific, actionable items. Tag each:
- [BENCHMARK] — specific numbers, metrics, or performance standards mentioned
- [EXPERIMENT] — something to test or try
- [TEMPLATE] — a fill-in-the-blank structure, formula, or script pattern
- [DASHBOARD] — a metric to track or KPI to monitor
- [SOP] — a repeatable process or workflow

## 4. SWIPE-WORTHY EXAMPLES
Every specific example, case study, or demonstration shown:
- What was the before/after?
- What specific numbers or results were shared?
- What made it work (the coach's explanation of WHY)?
- Could we adapt this for our clients? [YES_DIRECT | YES_MODIFIED | NO_NICHE]

## 5. SCRIPTS, TEMPLATES & FORMULAS
Extract word-for-word any:
- Email subject line formulas
- Copy templates or fill-in-the-blank structures
- Headline patterns
- Call-to-action frameworks
- Sequence structures (what goes in email 1, 2, 3...)
Preserve the EXACT wording. These are the most valuable extracted assets.

## 6. TERMINOLOGY & DEFINITIONS
Every coined term, acronym, or concept name the coach uses. Include their exact definition.

## 7. NOTABLE QUOTES (verbatim)
Direct quotes that capture the coach's core philosophy or could be used as proof/authority. Include timestamp if visible.

## 8. CROSS-CHANNEL CONNECTIONS
How does this content connect to:
- Paid ads (Meta, Google, YouTube)?
- Landing pages / funnels?
- Sales calls / DM outreach?
- Content marketing (organic social, YouTube, podcast)?
- Offer design / pricing?
Tag: [ECOSYSTEM] for connections the coach explicitly makes, [IMPLIED] for connections we can infer.

## 9. PHYSICS CHECK — Overlap with Core Frameworks
Map against these agency frameworks:
- **CFA (Curiosity → Fascination → Agitation → Resolution):** Does this complement, extend, or contradict?
- **Copy Logic Chain:** Does the argument structure align?
- **Clean Claims:** Are the claims defensible?
- **Levels of Awareness (Schwartz):** What awareness level is assumed?
- **Verdict:** [COMPLEMENTARY] strengthens our physics | [EXTENDS] adds new dimension | [CONTRADICTS] conflicts — flag for review | [REDUNDANT] we already have this covered

## 10. CONDENSED TRANSCRIPT (800-1200 words)
A faithful condensation preserving the coach's teaching flow, key phrases, and argument structure. Not a summary — a compression. Someone reading this should get 80% of the value of watching the video.

---

Be exhaustive. A 30-minute video should produce 2000-4000 words of extraction. If your output is under 1500 words, you missed content. Go back and extract more.`;
}
