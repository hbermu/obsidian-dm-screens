# syntax=docker/dockerfile:1
# DM Screen remote server. Build from the repository root:
#   docker build -f server/Dockerfile -t dm-screen-server .

# The player and map screens, built from the same sources as the plugin.
FROM node:22-bookworm-slim AS screens
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.json manifest.json ./
COPY scripts ./scripts
COPY src ./src
RUN node scripts/export-screens.mjs /screens

# Toolchain for make server-test / server-lint (source bind-mounted).
FROM rust:1.100-slim-bookworm AS dev
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/* \
 && rustup component add clippy rustfmt

FROM rust:1.100-slim-bookworm AS build
WORKDIR /src/server
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
COPY --from=screens /screens ./assets
RUN cargo build --release --locked && cp target/release/dm-screen-server /dm-screen-server

# The conformance suite drives the binary from Node.
FROM node:22-bookworm-slim AS conformance
COPY --from=build /dm-screen-server /usr/local/bin/dm-screen-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /data dmscreen && mkdir -p /data && chown dmscreen /data
COPY --from=build /dm-screen-server /usr/local/bin/dm-screen-server
USER dmscreen
ENV DM_SCREEN_PORT=8080 DM_SCREEN_DATA_DIR=/data
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["dm-screen-server", "healthcheck"]
ENTRYPOINT ["dm-screen-server"]
