# 1080x1350 Banner Ad Layout Spec

**Format:** 1080 x 1350 (4:5 portrait)
**Use:** Workhorse paid ad format for Facebook/Instagram feed

---

## Zone Map

```
0px   ┌─────────────────────────────────┐
      │                                 │
      │         BANNER ZONE             │
      │    (brand + headline text)      │
      │                                 │
200px ├─────────────────────────────────┤
      │                                 │
      │                                 │
      │                                 │
      │       CONTENT ZONE              │
      │   (face video + b-roll)         │
      │                                 │
      │                                 │
      │                                 │
      │                                 │
      │                                 │
      │                                 │
1050px├ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┤
      │     CAPTION SAFE ZONE           │
      │   (subtitles render here)       │
      │                                 │
1350px└─────────────────────────────────┘
```

---

## 1. Banner Zone

- **Height:** 200px (top of frame)
- **Coordinates:** y=0 to y=200
- **Purpose:** Brand name, headline/hook text, audience callout
- **Background:** Solid brand color or gradient (per-client brand kit)
- **Text:** 1-2 lines, bold, high contrast
- **Rule:** HARD RESERVED. Nothing else renders here. No video, no b-roll, no captions, no motion graphics unless explicitly designed as part of the banner.

## 2. Content Zone (Face Video + B-roll)

- **Height:** 850px
- **Coordinates:** y=200 to y=1050
- **Effective resolution:** 1080 x 850
- **Purpose:** Talking-head video and b-roll insertions
- **Face video:** Source video scaled and cropped to fill 1080x850, face centered using face_detect.py
- **B-roll:** Stock or client b-roll scaled to fill 1080x850. Same crop/fill logic as face video.
- **Rule:** All visual content lives here. Face crop must keep head and shoulders visible within this region.

## 3. Caption Safe Zone

- **Height:** 300px (bottom of content zone)
- **Coordinates:** y=1050 to y=1350
- **Purpose:** Subtitle text renders here
- **Rule:** Captions must NOT go above y=1050. This prevents captions from covering the speaker's face in the content zone.
- **Fallback:** If the content zone extends lower (no banner), captions still stay in the bottom 300px.
- **ASS subtitle config:** MarginV calculated so text baseline sits at ~y=1200 (center of caption zone)

## 4. B-roll Safe Zone

- **Same as Content Zone:** y=200 to y=1050
- **Rule:** B-roll fills the content zone only. Never bleeds into the banner zone.
- **Scaling:** `scale=1080:850:force_original_aspect_ratio=increase,crop=1080:850`

## 5. Motion Graphics Safe Zone

- **Same as Content Zone:** y=200 to y=1050
- **Exception:** Motion graphics that are part of the banner design (animated banner text, accent bars) can render in the banner zone.
- **Rule:** Default motion graphics (lower thirds, bullet builds, etc.) stay within the content zone.

## 6. Talking-Head Framing Rules

- Source video (typically 9:16 or 4:3) gets:
  1. Face detection (detect_face.py returns speaker X offset)
  2. Scale to fill 1080x850 (content zone dimensions)
  3. Crop centered on face horizontally
  4. Placed at y=200 (below banner)
- Speaker's head should be in the upper third of the content zone (~y=200 to y=480)
- Speaker's shoulders should be visible
- If source is already 4:5, crop vertically: keep center 850px after removing top/bottom equally, then offset down by 200px for banner

## 7. B-roll Framing Rules

- B-roll clips scaled to fill 1080x850 (content zone)
- Placed at y=200 (below banner)
- Use `force_original_aspect_ratio=increase,crop=1080:850` to fill without letterboxing
- 16:9 source: will be cropped top/bottom to fill 850px height
- 1:1 source: will be cropped left/right to fill 1080px width
- 9:16 source: will be cropped significantly — may lose too much. Flag as warning if source is taller than 16:9.

## 8. Banner Text Configuration

### v1 (Manual — ship first)
```json
{
  "bannerEnabled": true,
  "bannerConfig": {
    "text": "Parents of AP Students",
    "subtext": "SupportED Tutoring",
    "bgColor": "#1a1a2e",
    "textColor": "#ffffff",
    "font": "Montserrat-Bold",
    "fontSize": 48,
    "subtextFontSize": 24,
    "height": 200
  }
}
```

Passed as part of the `options` object in the clean-mode-compose (or future ad-compose) request body.

### v2 (AI-selected — later)
- Gemini reads the transcript + client F6 docs
- Selects the best banner text from a pre-approved list per client
- Falls back to manual if no match
- Banner text saved to `marketing.ad_compositions.banner_text`

### v3 (AI-generated — future)
- Gemini generates banner text from transcript + offer context
- Human-in-the-loop approval before render
- Variations tracked: banner swap = full new ad

## 9. Summary Table

| Zone | Y Start | Y End | Height | What renders here |
|------|---------|-------|--------|-------------------|
| Banner | 0 | 200 | 200px | Brand name, headline, audience callout |
| Content | 200 | 1050 | 850px | Face video, b-roll, motion graphics |
| Caption | 1050 | 1350 | 300px | Subtitle text only |

## 10. Implementation Notes

### ffmpeg approach for Phase 2:
1. Render face video at 1080x850 (not 1080x1350)
2. Render b-roll clips at 1080x850
3. Create banner image (1080x200) from config
4. Stack: banner on top, video/broll below, using ffmpeg `vstack` or `overlay`
5. Burn subtitles with ASS MarginV set for the caption zone (bottom 300px)

### Alternative approach:
1. Render full 1080x1350 video (face fills entire frame)
2. Overlay opaque banner on top 200px (covers whatever was there)
3. Adjust subtitle MarginV to keep captions in bottom 300px

The first approach is cleaner (no wasted pixels rendered then covered). The second is simpler to implement as a post-processing step on existing pipeline output.

### Recommendation: Start with approach 2 (overlay) for speed, migrate to approach 1 (native) when the ad-compose route is built.
