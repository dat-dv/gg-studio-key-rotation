# syntax=docker/dockerfile:1

# Node 24 LTS: better-sqlite3 có sẵn binary prebuilt cho cả amd64 lẫn arm64,
# nên KHÔNG cần cài python/make/g++ (bước từng tốn ~6 phút trên server).
FROM node:24-bookworm-slim AS base
WORKDIR /app

# ---- dependency chạy production (chạy song song với stage build) ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

# ---- build TypeScript ----
FROM base AS build
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM base
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_PATH=/app/data/gg-studio.db
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME /app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
