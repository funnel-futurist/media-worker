# Base: Microsoft Playwright image (Node 20 + Chromium + all deps pre-installed)
FROM mcr.microsoft.com/playwright:v1.50.0-noble

# Install ffmpeg (only extra dep needed)
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Don't re-download browsers — they're already in the image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
