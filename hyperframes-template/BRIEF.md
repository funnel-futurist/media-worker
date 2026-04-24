# FF Pilot — Short-Form Vertical Test

## What this is

Test project to validate the Hyperframes pipeline with real Funnel Futurist content
before committing to it over Remotion for all short-form jobs.

## Status

Scaffold: DONE (copied from may-shorts-19).
Blocking: Need a source video from Phoenix + FFmpeg installed.

## To run this pilot

### 1. Install FFmpeg (one-time, ~2 min)
```bash
brew install ffmpeg
```

### 2. Drop in your video
Record or pick any existing talking-head clip. Export as MP4.
```bash
cp ~/path/to/your-clip.mp4 assets/raw.mp4
```

### 3. Transcribe
```bash
cd /Users/phoenixbohannon/Documents/GitHub/hyperframes-student-kit/video-projects/ff-pilot
npx hyperframes transcribe assets/raw.mp4 --model small.en --json
# → writes assets/raw.json with word-level timestamps
```

### 4. Measure duration (needed for composition data-duration)
```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 assets/raw.mp4
```

### 5. Tell Claude Code to build the composition
Open Claude Code from the hyperframes-student-kit root directory, then:
```
/short-form-video
```
Point it at this project, paste in your script/transcript, and it will:
- Replace the AIS SEGMENTS in compositions/captions.html with your transcript
- Rewrite scene text and timing to match your script
- Run lint → preview → draft render → visual verification

### 6. Verify
```bash
npx hyperframes lint
npx hyperframes preview      # Studio at localhost:3002 — scrub and check live
npx hyperframes render --quality draft --output renders/pilot-draft.mp4
ffmpeg -ss 3 -i renders/pilot-draft.mp4 -frames:v 1 renders/frame-3s.png
```

## Brand tokens

Edit `assets/brand-tokens.css` → swap `--ff-accent` with your actual hex color.
AIS vars are aliased to FF vars so the inherited compositions still work out of the box.

## What this replaces

If the pilot passes (draft renders clean, captions sync, face mode smooth):
- Hyperframes becomes the default for all short-form jobs (talking_head_overlay, reel)
- Shannon's 3 Remotion components (StatReveal, BRollInsert, EndCardCTA) pivot to
  Hyperframes composition blocks instead
- ref_executor_decision.md gets updated from "under re-evaluation" → "production default"

If it fails or takes >4 hrs to get a clean render:
- Remotion stays as the near-term default
- Shannon proceeds with the original React component spec
