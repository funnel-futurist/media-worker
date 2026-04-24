# ff-pilot — Short-Form Video Reference Template

A production-ready 73.3-second talking-head short (1080×1920, 30fps) built on **Hyperframes** — HTML + GSAP + headless Chrome. This is the new pipeline standard for short-form video in creative-engine, replacing the old Remotion-based approach for pipeline work.

Remotion stays in place for the Video Lab portfolio/UI; Hyperframes is for the short-form production pipeline.

---

## What it is

A 7-scene structure (hook → baseline → minimum → tier-2 → contrast → close → CTA) with:

- **Three-lane layout** — top = hook/slam text, face = talking head (or Tier A screenshot during b-roll), bottom = captions
- **No face zooms** — subject framing is stable; emphasis comes from layout, timing, and caption choreography
- **Caption suppression** — captions disappear automatically when the hook text duplicates their content
- **Face-panel images** — dashboards/screenshots replace the face rectangle cleanly with a dark backdrop
- **Contextual notes** — accent-cyan parenthetical above each b-roll explaining why the screenshot matters

Full production workflow is in [`.claude/skills/short-form-video/PLAYBOOK.md`](../../.claude/skills/short-form-video/PLAYBOOK.md) (9 steps, end-to-end).

---

## Quick start

From repo root:

```bash
# Install deps (hyperframes + remotion + next)
npm install

# Drop raw footage at:
#   video-projects/ff-pilot/assets/raw-edit.mp4
# Drop music + b-roll visuals:
#   video-projects/ff-pilot/assets/music.mp3
#   video-projects/ff-pilot/assets/visuals/broll-1.png (etc)

# Run the full prep pipeline (silence cut → transcribe → caption align → audio QC)
cd video-projects/ff-pilot
node scripts/prep.js assets/raw-edit.mp4

# Lint the composition (will fail on a fresh checkout because raw footage,
# music, and visuals are intentionally gitignored — drop them above first)
npm run ff-pilot:lint

# Draft render (~5 min on M-series Mac)
npm run ff-pilot:render
# → video-projects/ff-pilot/renders/{timestamp}.mp4
```

---

## Directory layout

```
ff-pilot/
├── index.html              root composition (1080×1920, 73.3s)
├── hyperframes.json        registry config
├── meta.json               format spec
├── BRIEF.md                project notes
├── compositions/           21 scene HTMLs + 3 archived
├── assets/
│   ├── brand-tokens.css    theming (--ff-accent, --ff-warn, --ff-bg)
│   ├── script.txt          human-written script for caption correction
│   └── visuals/            client-drop zone for b-roll PNGs
├── styles/
│   └── typography.css      font tokens (Outfit, Space Grotesk, Roboto Mono, Montserrat)
├── scripts/
│   ├── silence_cut.js      ffmpeg silence detection + trim
│   ├── prep.js             one-command pipeline (steps 1–4)
│   ├── align_captions.js   Whisper correction + SEGMENTS inject
│   └── audio_qc.js         LUFS measurement + Gemini perceptual QC
└── renders/                generated MP4 output (gitignored)
```

Per-project binaries (`assets/raw-*.mp4`, `assets/music.mp3`, `assets/visuals/*.png`, `renders/`, `transcript.json`, `.thumbnails/`) are all in `.gitignore`. The template files are source-controlled; the output is not.

---

## Stack

| Layer | Tool | Role |
|---|---|---|
| Render engine | `hyperframes` (npm) | Headless Chrome composition → MP4 |
| Animation | GSAP 3.14.2 (CDN) | Timeline choreography |
| Audio prep | `ffmpeg` / `ffprobe` | Silence detection, LUFS measurement |
| Transcription | Whisper small.en (via `npx hyperframes transcribe`) | Word-level caption timing |
| Perceptual QC | Gemini 2.0 Flash (`@google/genai`) | Music/speech balance check |
| Typography | Google Fonts | Outfit · Space Grotesk · Roboto Mono · Montserrat |

Render cost per video: **<$0.01** (Gemini QC is the only paid call).

---

## Relationship to existing pipeline

This template **does not** replace or alter the current Submagic + Railway pipeline (`app/api/triggers/remotion_render/route.ts`). It exists alongside as a reference implementation.

A Phase 2 PR will wire Hyperframes into the cron trigger system with a client-level `render_engine` feature flag so Hyperframes can run parallel to the Submagic path for select clients. That work is intentionally NOT in this PR.

---

## Per-client workflow (Shannon)

When starting a new client short-form:

1. `cp -R video-projects/ff-pilot video-projects/{client-slug}`
2. Drop client's raw footage + music + b-roll screenshots into `{client-slug}/assets/`
3. Edit `{client-slug}/assets/brand-tokens.css` — update `--ff-accent` to the client's brand color
4. Edit `{client-slug}/assets/script.txt` with the client's actual script
5. Update the contextual notes in `{client-slug}/compositions/float-broll-*.html` to match the client's angle
6. Run `node scripts/prep.js assets/raw-edit.mp4` → render draft → review → iterate

See the PLAYBOOK for the full per-client checklist.
