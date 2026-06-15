# Axona bridge — container image.
#
# node-datachannel ships a prebuilt native binary for linux-x64 (glibc), so a
# Debian (bookworm) base needs no compiler toolchain. git is required only at
# build time because @axona/protocol is pinned to a GitHub tag in package.json.
#
# Build:  docker build -t axona-bridge .
# Run:    see docker-compose.yml (fronts this with Caddy TLS + a coturn relay)

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Persist the identity keypair + discovered-bridge list across restarts:
# mount a volume at /data (see docker-compose.yml).
ENV BRIDGE_IDENTITY_PATH=/data/identity.json
ENV BRIDGE_BOOK_PATH=/data/bridges.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY package.json ./
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "src/server.js"]
