FROM node:22-slim AS base
RUN corepack enable && apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
# pnpm patches (patchedDependencies in pnpm-workspace.yaml): the install reads them, so they come before it.
COPY patches/ patches/
RUN pnpm install --frozen-lockfile
COPY . .
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_ENGINE_URL
RUN pnpm db:generate && pnpm --filter web build
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "web", "start"]
