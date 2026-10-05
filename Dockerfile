# syntax = docker/dockerfile:1

# Node runs src/server/index.ts directly (native TypeScript type-stripping,
# no build step, no dist/ — matching the "no bundler" stack decision in
# PROCESS.md). The image serves HTTP on 0.0.0.0:$PORT (fly.toml sets PORT)
# and publishes README.md at /readme/ via the server itself.

FROM node:24-alpine
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile

COPY src ./src
COPY client ./client
COPY README.md ./README.md

ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server/index.ts"]
