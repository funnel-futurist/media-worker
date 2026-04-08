# Base: Microsoft Playwright image (Node 20 + Chromium + all deps pre-installed)
FROM mcr.microsoft.com/playwright:v1.50.0-noble

# Install ffmpeg, yt-dlp, Python + OpenCV for face detection + yt-dlp oauth2 plugin
RUN apt-get update && apt-get install -y ffmpeg wget python3 python3-pip && \
    pip3 install --break-system-packages opencv-python-headless yt-dlp yt-dlp-youtube-oauth2 && \
    rm -rf /var/lib/apt/lists/*

# Tell yt-dlp to use Node.js (already present via Playwright image) for JS challenge solving
ENV YT_DLP_JS_RUNTIMES=node

WORKDIR /app

# Don't re-download browsers — they're already in the image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
