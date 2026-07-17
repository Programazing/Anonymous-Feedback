# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/feedback.sqlite

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data \
    && chown -R node:node /app

# /app/data holds the SQLite database file (feedback.sqlite) plus its WAL
# and SHM sidecar files. It MUST be persisted across container restarts and
# rebuilds — mount a named Docker volume (see docker-compose.yml) or a host
# bind mount owned by uid 1000 (the "node" user). The application will fail
# fast with a clear error if the directory is missing or not writable.
# See README.md ("Backup and restore") for online backup procedure.
VOLUME ["/app/data"]

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]