# Reference container for a MiakAPI 4 coordinator.
#
# Build context is the repository root so the example can self-reference the
# `miakapi` package it ships with, before the SDK is installed from a registry.
#
#   docker build -f examples/deploy/Dockerfile -t miakapp-coordinator .
FROM oven/bun:1.2.23-alpine AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json tsconfig.build.json ./
RUN bun install --frozen-lockfile
COPY src ./src
RUN bun run build

FROM oven/bun:1.2.23-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY examples ./examples
USER bun
EXPOSE 8080
CMD ["bun", "examples/synthetic-coordinator-service.ts"]
