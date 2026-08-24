# syntax=docker/dockerfile:1.7
#
# Parachute Vault container image.
#
# Two-stage shape mirroring parachute-hub's Dockerfile (hub#258/#261):
#   Stage 1 (`builder`) — install dependencies against the lockfile so the
#     install layer caches across source-only changes.
#   Stage 2 (`runtime`) — slim runtime layer with deps + source, run as the
#     non-root `bun` user under `tini` for proper SIGTERM forwarding.
#
# Bun reads `src/cli.ts` directly — no separate transpile step. The
# entrypoint runs `parachute-vault serve`, which imports `src/server.ts`
# and foregrounds the Bun.serve loop. Container hosts (Docker, Render,
# Fly, Railway) own process lifecycle; this image stays out of pidfile
# / launchd / systemd land.
#
# Operator-facing env vars:
#   PORT                  — bind port (Render injects this; default 1940)
#   PARACHUTE_HOME        — config root (mount the persistent disk here;
#                           default /parachute → vault state at /parachute/vault)
#   VAULT_BIND            — bind host (container default 0.0.0.0 so the
#                           platform's HTTP forwarder can reach us)
#   VAULT_AUTH_TOKEN      — optional server-wide bearer token. When set,
#                           any `Authorization: Bearer <token>` matching
#                           the env value authenticates as full/admin
#                           against any vault. The "single shared operator
#                           token" path for sibling services on Render.
#                           When unset, vault falls back to its existing
#                           per-vault tokens + hub JWT validation paths.
#   SCRIBE_URL            — opt-in scribe endpoint for transcription worker.

ARG BUN_VERSION=1.4
FROM oven/bun:${BUN_VERSION}-alpine AS builder

WORKDIR /app

# Copy manifests first so Docker layer-caches the install step across
# source-only changes.
COPY package.json bun.lock ./

# Install with the lockfile pinned. `--frozen-lockfile` matches CI; we
# only need runtime deps in the image.
RUN bun install --frozen-lockfile --production --ignore-scripts

# Copy the runtime source. The `.dockerignore` already prunes test files,
# node_modules, etc.
COPY core core
COPY src src
COPY bunfig.toml tsconfig.json ./

# ---- Runtime stage --------------------------------------------------------

FROM oven/bun:${BUN_VERSION}-alpine AS runtime

WORKDIR /app

# tini reaps zombies + forwards signals so `docker stop` / Render redeploys
# shut vault down cleanly via the SIGTERM drain path in server.ts instead
# of getting SIGKILLed after the grace period. wget for HEALTHCHECK.
RUN apk add --no-cache tini wget

# Bring over installed deps + source from the builder stage.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/core ./core
COPY --from=builder /app/src ./src
COPY --from=builder /app/bunfig.toml ./bunfig.toml
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/package.json ./package.json

# Vault state root. The container's persistent disk mounts here — every
# vault DB, config.yaml, .env, and attachment lives under
# `$PARACHUTE_HOME/vault/`. Override at run time with
# `-e PARACHUTE_HOME=/somewhere/else` if the host wants a different
# mount point.
ENV PARACHUTE_HOME=/parachute \
    PORT=1940 \
    VAULT_BIND=0.0.0.0 \
    NODE_ENV=production

# Pre-create the persistent-disk mount point and hand it to the non-root
# `bun` user (uid 1000). Docker creates a VOLUME mount with root:root
# permissions inheriting the image layer's owner; without this chown the
# first `mkdirSync` from server boot fails with EACCES. Render's disks
# come up pre-owned per Render's docs but anonymous-volume `docker run`
# and bind-mount paths both need this seed directory.
RUN mkdir -p /parachute && chown -R bun:bun /parachute

# Render mounts the persistent disk at $PARACHUTE_HOME; declare the volume
# so a `docker run` without a bind mount still gets an anonymous volume
# rather than writing under the image layer.
VOLUME ["/parachute"]

EXPOSE 1940

# /health is unauthenticated and cheap — safe to poll. Use the same PORT
# the server bound to; default 1940 matches the EXPOSE above.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://localhost:${PORT:-1940}/health" || exit 1

# Run as the non-root `bun` user that the base image already provides.
USER bun

ENTRYPOINT ["/sbin/tini", "--"]
# `parachute-vault serve` is the container-shape entrypoint: foregrounded
# Bun.serve loop, SIGTERM-drained shutdown, .env loaded from
# $PARACHUTE_HOME/vault/.env. Equivalent to `bun src/server.ts` since
# `cmdServe` just imports server.ts, but routing through cli.ts keeps the
# image's entrypoint aligned with the CLI surface users already know.
CMD ["bun", "src/cli.ts", "serve"]
