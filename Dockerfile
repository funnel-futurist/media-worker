# Base: Microsoft Playwright image (Node 20 + Chromium + all deps pre-installed)
FROM mcr.microsoft.com/playwright:v1.59.1-noble

# Use bash for RUN commands. Default /bin/sh on Ubuntu is dash, which doesn't
# support `set -o pipefail` — our whisper.cpp build step uses pipefail for
# fail-fast safety, so this SHELL directive is what makes that valid.
# (Without this, every GitHub auto-deploy since PR #72 silently failed at
#  `/bin/sh: set: Illegal option -o pipefail` — production was stuck on #71.)
SHELL ["/bin/bash", "-c"]

# Install system deps: ffmpeg (audio/video processing), yt-dlp (YouTube extraction),
# Python + OpenCV (face detection), and build tools for whisper.cpp (used by
# `npx hyperframes transcribe` via the Hyperframes short-form pipeline).
RUN apt-get update && apt-get install -y \
      ffmpeg wget git \
      python3 python3-pip \
      build-essential cmake && \
    pip3 install --break-system-packages opencv-python-headless yt-dlp && \
    rm -rf /var/lib/apt/lists/*

# Build whisper.cpp and expose the `whisper-cpp` binary on PATH.
# Hyperframes' `transcribe` command spawns `whisper-cpp`. Without this the
# short-form render pipeline fails at the prep step.
# The small.en model (~466MB) is baked in so we don't download on every render.
#
# Binary selection notes:
#   whisper.cpp produces BOTH `main` (deprecation shim that prints a warning
#   and exits 1) AND `whisper-cli` (the real current binary). An earlier
#   version of this Dockerfile used a single `find` with `-o` and `head -1`,
#   which picked whichever file the filesystem listed first — sometimes the
#   deprecation shim. The shim's `exit 1` then failed the verify step.
#   Prefer `whisper-cli` explicitly; fall back to the older names only if
#   `whisper-cli` is missing (for older whisper.cpp commits).
RUN set -euxo pipefail && \
    git clone --depth 1 https://github.com/ggml-org/whisper.cpp /opt/whisper.cpp && \
    cd /opt/whisper.cpp && \
    cmake -B build -DCMAKE_BUILD_TYPE=Release && \
    cmake --build build -j --config Release && \
    echo "=== Searching for whisper binary (prefer whisper-cli) ===" && \
    WHISPER_BIN="" && \
    for candidate in whisper-cli whisper main; do \
      WHISPER_BIN="$(find /opt/whisper.cpp/build/bin /opt/whisper.cpp -maxdepth 3 -type f -executable \
                       -name "$candidate" 2>/dev/null | head -1)"; \
      if [ -n "$WHISPER_BIN" ]; then \
        echo "Found $candidate at $WHISPER_BIN"; \
        break; \
      fi; \
    done && \
    if [ -z "$WHISPER_BIN" ]; then \
      echo "FATAL: no whisper binary (whisper-cli/whisper/main) found after cmake build" && \
      ls -laR /opt/whisper.cpp/build/bin 2>/dev/null || true && \
      exit 1; \
    fi && \
    echo "Using whisper binary: $WHISPER_BIN" && \
    cp "$WHISPER_BIN" /usr/local/bin/whisper-cpp && \
    chmod +x /usr/local/bin/whisper-cpp && \
    echo "=== Verifying whisper-cpp runs ===" && \
    whisper-cpp --help > /tmp/whisper-help.txt 2>&1 || (cat /tmp/whisper-help.txt && exit 1) && \
    echo "whisper-cpp verified ✓" && \
    echo "=== Downloading small.en model ===" && \
    bash ./models/download-ggml-model.sh small.en && \
    ls -la /opt/whisper.cpp/models/ggml-small.en.bin

# Let Hyperframes find the bundled model without re-downloading.
ENV WHISPER_MODEL_DIR=/opt/whisper.cpp/models

# Tell yt-dlp to use Node.js (already present via Playwright image) for JS challenge solving
ENV YT_DLP_JS_RUNTIMES=node

# Hyperframes Chromium tuning for Railway's constrained container.
# Root cause: on the previous render attempt Chromium's GPU subprocess crashed
# with `pthread_create: Resource temporarily unavailable (11)` — the container
# hit its thread limit when Chromium tried to spawn the GPU + network + renderer
# helper processes. Even with --workers 1 (a single capture worker), a *single*
# Chromium instance still spawns multiple helper processes per frame.
#
# These env vars are read by hyperframes' producer/browserManager.ts:
#   PRODUCER_DISABLE_GPU=true        → adds --disable-gpu; skips GPU subprocess
#                                      entirely (the one that was crashing).
#   PRODUCER_FORCE_SCREENSHOT=true   → uses screenshot capture mode instead of
#                                      HeadlessExperimental.beginFrame, which
#                                      avoids the compositor/GPU-heavy flags
#                                      (--run-all-compositor-stages-before-draw
#                                      etc.) that also spawn helpers.
#   PRODUCER_ENABLE_BROWSER_POOL=true → reuses one Chromium instance across all
#                                      frame captures in a render, instead of
#                                      launching a fresh browser per frame.
ENV PRODUCER_DISABLE_GPU=true
ENV PRODUCER_FORCE_SCREENSHOT=true
ENV PRODUCER_ENABLE_BROWSER_POOL=true

WORKDIR /app

# Don't re-download browsers — they're already in the image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
