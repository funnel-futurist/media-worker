#!/usr/bin/env python3
"""
Detect the largest face in an image and output its center coordinates as JSON.
Used by youtube.js to find the optimal crop position for portrait conversion.
"""
import cv2
import sys
import json

def detect_face(image_path):
    img = cv2.imread(image_path)
    if img is None:
        print(json.dumps({"cx": None, "cy": None, "speaker_side": "left"}))
        return

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(60, 60))

    if len(faces) == 0:
        print(json.dumps({"cx": None, "cy": None, "speaker_side": "left"}))
        return

    # Pick the largest face
    largest = max(faces, key=lambda f: f[2] * f[3])
    x, y, w, h = largest
    cx = int(x + w / 2)
    cy = int(y + h / 2)
    img_w = img.shape[1]
    speaker_side = "left" if cx < img_w / 2 else "right"
    print(json.dumps({"cx": cx, "cy": cy, "w": int(w), "h": int(h), "speaker_side": speaker_side}))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"cx": None, "cy": None}))
    else:
        detect_face(sys.argv[1])
