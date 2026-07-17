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

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]