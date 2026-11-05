FROM node:22-slim AS base
RUN corepack enable && apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/engine/package.json apps/engine/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm db:generate && pnpm --filter @strowger/engine build
# Chromium for the Free Caller Registry form (provision/fcr.ts).
RUN pnpm --filter @strowger/engine exec playwright install --with-deps chromium
ENV NODE_ENV=production
CMD ["sh", "-c", "pnpm db:deploy && node apps/engine/dist/index.js"]
