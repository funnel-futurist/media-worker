# Base: Microsoft Playwright image (Node 20 + Chromium + all deps pre-installed)
FROM mcr.microsoft.com/playwright:v1.50.0-noble

# Install ffmpeg + yt-dlp (standalone binary — no Python needed)
RUN apt-get update && apt-get install -y ffmpeg wget && \
    wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Don't re-download browsers — they're already in the image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
