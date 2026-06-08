#!/usr/bin/env python3
"""
python/face_detect_offset.py

Sample N evenly-spaced frames from a video, run OpenCV Haar cascade face
detection on each frame, and emit the MEDIAN face-center X and Y positions as
fractions of the source frame width/height on stdout.

Output: two space-separated floats on stdout, e.g. "0.42 0.66"  →  "<x> <y>"
        - x: 0.5 = horizontally centered; <0.5 left-of-center; >0.5 right
        - y: 0.5 = vertically centered;   <0.5 upper;          >0.5 lower
        - "0.5 0.5" = no faces detected / any fallback → center crop both axes

Used by lib/face_detect.js (PR #114) to compute the horizontal `crop=` offset
for the production fill-crop reframe in composeFaceAndBrolls. Replaces the
naive center-crop that pushed Phil's face to the right edge of the 9:16
output on B10 (m2-e2e-018-enablesnp, 2026-05-08) because his landscape
source recording isn't perfectly centered.

Falls back to 0.5 (center crop) on:
  - Cannot open video / zero frames
  - No faces detected in any sample frame
  - Cascade XML missing (shouldn't happen — opencv-python-headless ships it)

Diagnostic info goes to stderr so the Node wrapper can include it in the
pipeline log without affecting the float value parsed from stdout.

Why median (not mean): a hand passing in front of the camera or a brief
false-positive on a busy painting in the background can produce one
outlier face center. Median ignores outliers up to ~50% of samples.
"""

import sys
import argparse

try:
    import cv2
except ImportError:
    # If opencv isn't available, fall back to center. Don't crash.
    print('0.5 0.5')
    sys.stderr.write('face_detect: opencv-python-headless not installed — falling back to center crop\n')
    sys.exit(0)


def main():
    parser = argparse.ArgumentParser(description='Estimate median face-center x as a fraction of frame width.')
    parser.add_argument('video_path', help='Path to the video file (mp4, mov, etc.)')
    parser.add_argument('--samples', type=int, default=8, help='Number of frames to sample (default 8)')
    parser.add_argument('--min-face-px', type=int, default=80,
                        help='Min face size in pixels for detection (default 80) — filters tiny false positives')
    args = parser.parse_args()

    cap = cv2.VideoCapture(args.video_path)
    if not cap.isOpened():
        print('0.5 0.5')
        sys.stderr.write(f'face_detect: failed to open {args.video_path}\n')
        sys.exit(0)

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    if total_frames < 1 or width < 1:
        print('0.5 0.5')
        cap.release()
        sys.stderr.write(f'face_detect: {args.video_path} has invalid frame count/width ({total_frames}/{width})\n')
        sys.exit(0)

    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    face_cascade = cv2.CascadeClassifier(cascade_path)
    if face_cascade.empty():
        print('0.5 0.5')
        cap.release()
        sys.stderr.write(f'face_detect: failed to load Haar cascade from {cascade_path}\n')
        sys.exit(0)

    # Sample N evenly-spaced frames. Use (i + 0.5) / N so the first/last samples
    # don't land on the actual first/last frames (which often contain partial
    # rendered content like a fade-in).
    sample_indices = [
        int(total_frames * (i + 0.5) / args.samples)
        for i in range(args.samples)
    ]

    face_centers_x = []
    face_centers_y = []
    samples_attempted = 0
    samples_successful = 0
    for idx in sample_indices:
        samples_attempted += 1
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if not ret:
            continue
        samples_successful += 1
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = face_cascade.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(args.min_face_px, args.min_face_px),
        )
        # Take the LARGEST face per frame (talking-head reels are typically
        # one speaker; if there's a face on a TV in the background it's much
        # smaller). Falls back to all faces if multiple are similar size.
        if len(faces) > 0:
            faces_sorted = sorted(faces, key=lambda f: f[2] * f[3], reverse=True)
            x, y, w, h = faces_sorted[0]
            face_centers_x.append((x + w / 2.0) / width)
            face_centers_y.append((y + h / 2.0) / height)

    cap.release()

    if not face_centers_x:
        print('0.5 0.5')
        sys.stderr.write(
            f'face_detect: no faces in any of {samples_successful}/{samples_attempted} sampled frames '
            f'({width}x{height}) — falling back to center crop\n'
        )
        sys.exit(0)

    sorted_centers = sorted(face_centers_x)
    median = sorted_centers[len(sorted_centers) // 2]
    sorted_centers_y = sorted(face_centers_y)
    median_y = sorted_centers_y[len(sorted_centers_y) // 2]

    sys.stderr.write(
        f'face_detect: {len(face_centers_x)}/{samples_successful} samples had faces '
        f'(x: min={min(face_centers_x):.3f} median={median:.3f} max={max(face_centers_x):.3f}; '
        f'y median={median_y:.3f}) on {width}x{height} source\n'
    )
    print(f'{median:.4f} {median_y:.4f}')


if __name__ == '__main__':
    main()
