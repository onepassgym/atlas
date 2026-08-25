# ── Stage 1: Build Dashboard SPA ─────────────────────────────────────
FROM node:20-slim AS build-stage
WORKDIR /build

# Install dashboard dependencies
COPY dashboard/package*.json ./dashboard/
RUN cd dashboard && npm install

# Copy dashboard source and build
COPY dashboard/ ./dashboard/
RUN cd dashboard && npm run build

# ── Stage 2: Final Runtime Image ────────────────────────────────────
FROM node:20-slim
WORKDIR /app

# Install Chromium + Playwright system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libdbus-1-3 libxcb1 libxkbcommon0 \
    libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    libatspi2.0-0 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Playwright config for system Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install root dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy backend source
COPY . .

# Copy built dashboard from Stage 1
COPY --from=build-stage /build/dashboard/dist ./dashboard/dist

# Create runtime directories
RUN mkdir -p media/photos media/thumbnails logs

EXPOSE 4060

CMD ["node", "src/server.js"]
