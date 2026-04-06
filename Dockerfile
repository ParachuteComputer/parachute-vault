FROM oven/bun:1.2-alpine AS base
WORKDIR /app

# Install deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY core core
COPY src src
COPY bunfig.toml ./

# Data directory — mount a volume here for persistence
ENV PARACHUTE_HOME=/data
RUN mkdir -p /data

EXPOSE 1940

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost:1940/health || exit 1

CMD ["bun", "src/server.ts"]
