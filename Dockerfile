# Jessbot in a container: Node 24, the built assets, and open-source Chromium for the agent's browser.
# Runs as a non-root user; everything it writes (database, files, the .env the setup page fills in) is in /data.
#   docker build -t jessbot .
#   docker compose up -d        (see compose.yaml; the setup code is in `docker compose logs jessbot`)

# ---- Build: install with dev dependencies, build the assets, then drop the dev dependencies ----------------------------
FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---- Run ----------------------------------------------------------------------------------------------------------------
FROM node:26-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3737 \
    JESSBOT_HOME=/data \
    JESSBOT_ENV_FILE=/data/.env \
    JESSBOT_TOOLS=/opt/jessbot-tools \
    PLAYWRIGHT_BROWSERS_PATH=/opt/jessbot-tools/ms-playwright \
    HOME=/tmp
WORKDIR /app
COPY --from=build /app /app
# Chromium's system libraries and fonts (Latin, Arabic and the rest of Noto, emoji), then the Chromium build that
# playwright-core expects, downloaded into the image (open source; never committed to the repository).
RUN apt-get update \
 && npx --yes playwright-core install-deps chromium \
 && apt-get install -y --no-install-recommends fonts-noto-core fonts-noto-color-emoji tini \
 && rm -rf /var/lib/apt/lists/* \
 && node scripts/browser-install.js --engine chromium \
 && rm -rf /data/* \
 && groupadd --system --gid 10001 jessbot \
 && useradd --system --uid 10001 --gid jessbot --home-dir /data --shell /usr/sbin/nologin jessbot \
 && mkdir -p /data && chown jessbot:jessbot /data
USER jessbot
VOLUME ["/data"]
EXPOSE 3737
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3737)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
