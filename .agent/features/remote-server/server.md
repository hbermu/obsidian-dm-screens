# Standalone Server

> The remote server: a Rust binary shipped as a container image, versioned with the plugin. It serves the same player and map screens as the embedded server, keeps the replay cache and the map-data store on disk, stores media by content hash, and accepts one controller over the control channel. Its viewer-facing behaviour is the embedded server's contract, verified by a conformance suite that runs against both.

## Source files

- `server/Cargo.toml`, `server/src/main.rs` — startup, the `listening on <addr>` line, graceful shutdown with a final state flush, the `healthcheck` subcommand
- `server/src/config.rs` — `Config::from_lookup` (environment variables, requirement 1–2), `check_outbound_url` (the plugin's URL policy)
- `server/src/lib.rs` — `open` (load state, allowlist the restored cache), `router` (every route, the `/api/` control-token layer, path-only request logs), `collect_garbage`, `spawn_background`
- `server/src/auth.rs` — `role_for` (digest comparison, view vs control), `request_token` (`k`, then cookie), `api_token` (`Bearer` first)
- `server/src/protocol.rs` — `PROTOCOL_VERSION`, the embedded screens, `player_page` (waiting-text slots), `message_channel`
- `server/src/viewers.rs` — player and map pages and WebSocket channels, `/health`, `origin_ok`, limits, `client-info`, `drain` (waits for the client's close reply after a server-initiated close)
- `server/src/state.rs` — `AppState`, `Session` (cache, allowlist, viewers, controllers, lease holder, map data), `relay`
- `server/src/persist.rs` — atomic state files, corrupt-file quarantine, the one-second coalescing writer
- `server/src/replay.rs` — `ReplayCache` with the same rules as `src/server.ts`, persisted to disk
- `server/src/allowlist.rs` — the display allowlist over `/assets/` URLs
- `server/src/mapdata.rs` — the map-data store
- `server/src/control.rs` — the control channel (see `control-channel.md`)
- `server/src/assets.rs`, `server/src/derivatives.rs`, `server/src/hydrus.rs` — media (see `assets.md`)
- `src/screenPages.ts`, `scripts/export-screens.mjs` — the page shells and bundles shared with the embedded server, written to `server/assets/` and embedded with `include_str!`
- `server/Dockerfile` — multi-stage build: the exported screens, the Rust binary, a runtime image with `ffmpeg`; also the `dev` (toolchain) and `conformance` targets
- `server/docker-compose.yml` — the deployment example (requirement 20)
- `test/conformance/` — the black-box suite and its two drivers (`embedded.ts`, `remote.ts`)
- `docker-compose.yml` — the `server` (toolchain) and `conformance-remote` services behind `make server-test`, `make server-lint` and `CONFORMANCE_TARGET=remote make test-conformance`
- `.github/workflows/release.yml` — the `image` and `image-manifest` jobs: native amd64 and arm64 builds pushed by digest, then one tagged manifest
- `.github/workflows/ci.yml` — the `server` job and the two-target `conformance` matrix

## Settings used

- none (the server reads environment variables, requirement 1)

## Requirements

### Configuration

1. The server shall read its configuration from environment variables: `DM_SCREEN_VIEW_TOKEN` and `DM_SCREEN_CONTROL_TOKEN` (required), `DM_SCREEN_PORT` (default `8080`), `DM_SCREEN_DATA_DIR` (default `/data`), `DM_SCREEN_MAX_CLIENTS` (default `10`), `DM_SCREEN_MAX_ASSET_MB` (default `1024`), `DM_SCREEN_ASSET_RETENTION_DAYS` (default `90`), `DM_SCREEN_DERIVATIVE_CACHE_MB` (default `2048`), `DM_SCREEN_HYDRUS_URL` and `DM_SCREEN_HYDRUS_KEY` (optional, both or neither), `DM_SCREEN_FFMPEG` and `DM_SCREEN_FFPROBE` (default `ffmpeg`, `ffprobe`); the log level follows `RUST_LOG` (default `info`).
2. If either token is missing, shorter than 32 characters, or the two tokens are equal, or only one of the two Hydrus variables is set, then the server shall exit with a non-zero status and a message naming the variable, without printing any value.
3. The server shall never write a token, the Hydrus key, or a `k` query value to its logs; request logs shall show the path with the query string removed.

### Viewer surface (shared with the embedded server)

4. The server shall serve `/`, `/index.html`, `/player.js`, `/player.css`, `/map`, `/map.js`, `/map.css` with the same bodies the embedded server builds, embedded at build time from the same sources and the same commit. The player page's waiting title and subtitle shall come from the cached `waiting-screen` message, or the embedded defaults (`Player Screen`, `Waiting for DM to push content...`) when none is cached, HTML-escaped and omitted when empty as in `../player-server/overview.md` requirement 19.
5. The server shall serve `GET /health` with `{ status: "ok", clients: <viewer count>, protocol: <PROTOCOL_VERSION>, version: <server version> }` without authentication. The embedded server's `/health` shall carry the same four fields.
6. For every viewer route other than `/health`, the server shall require the view token or the control token as `k` or as the `dmScreenKey` cookie, answer `401` otherwise, and set the cookie on `/` and `/map`, per `../player-server/overview.md` requirements 25–27.
7. The player and map WebSocket channels shall follow `../player-server/websocket-protocol.md` requirements 1b, 2, 3, 10–14 and 18–19 with the view token or the control token, and shall enforce `DM_SCREEN_MAX_CLIENTS` with close code `1013`.
8. The `Origin` check shall compare the `Origin` host with the `Host` header the server receives, so a reverse proxy in front of it shall preserve `Host`.
9. A relayed message shall go through the same cache rules as the embedded server: per-type overwrite, `clear`/`map-clear` channel-scoped purges (`map-calibration` survives `map-clear`), `hide-background-media` deleting `show-background-media`, sync-before-geometry insertion order, and the 2 MiB largest-first eviction.
10. The server shall not serve `/vault/`; it shall answer `404` for it like any unknown path.

### Persistence

11. The server shall persist the replay cache to `<data dir>/state/replay.json`, writing at most once per second and on shutdown, and shall load it on startup so screens connecting after a restart reconstruct the scene.
12. Every write of a state file shall go to a temporary file in the same directory followed by a rename, so a crash never leaves a truncated file.
13. If a state file cannot be parsed on startup, then the server shall rename it to `<name>.corrupt-<unix time>`, log a warning, and start with an empty state.

### Map data

14. The server shall keep a map-data document with five collections: `configs` (map URL key → stored map state), `profiles` (screen key → calibration profile), `fog` (map URL key → asset URL or `null`), `walls` (map URL key → wall list), `sources` (asset name → the scene source reference it was published from), persisted to `<data dir>/state/mapdata.json` under requirements 11–12.
15. `GET /api/mapdata` shall return the whole document.
16. `PUT /api/mapdata/<collection>/<url-encoded key>` with a JSON body shall set that entry, and `DELETE` on the same path shall remove it; an unknown collection shall answer `404`, a body over 1 MiB `413`, invalid JSON `400`.
17. Every `/api/` route shall require the control token (as `k` or as a `Bearer` authorization header) and answer `401` otherwise; the view token shall not open any `/api/` route.

### Image and release

18. The container shall run as a non-root user, expose `DM_SCREEN_PORT`, declare `<data dir>` as a volume, and define a health check that runs `dm-screen-server healthcheck`, which requests `/health` on the local port and exits 0 only on a `200`.
19. The image shall be built for `linux/amd64` and `linux/arm64` and published as `ghcr.io/<repository owner>/dm-screen-server:<version>` by the release workflow for every stable release and prerelease, with the same version string as the plugin release; stable releases shall also move the `latest` tag.
20. The repository shall ship `server/docker-compose.yml`, an example of the server alone, with the tokens supplied as variables and a named volume for the data directory.
20b. When started with `DM_SCREEN_PORT=0`, the server shall bind an ephemeral port and print `dm-screen-server <version> listening on <address>` to standard output, which the conformance driver reads.

### Conformance

21. `make test-conformance` shall run the suite in `test/conformance/` against the embedded server (a real `PlayerScreenServer` driven in-process) and against the server container (driven through the control channel), and both runs shall pass in CI.
22. The suite shall cover: routes and content types, `/health` shape, token and cookie handling, `Origin`, client limit, channel routing, every cache rule of requirement 9, late-joiner replay order, frame and rate limits, and the display allowlist. Cases that only one server implements (`/vault/` traversal on the embedded server; `Range`, the `map-fog` allowlist entry and the control channel on the remote one) shall be marked as such and skipped on the other. Derivatives are left to each server's own tests, because the embedded encoder needs Electron's WebCodecs.

## Tests covering this

- `server/src/*.rs` (`#[cfg(test)]` modules) — configuration and URL policy, token roles, replay-cache rules and UTF-16 budget, allowlist slots, atomic and corrupt state files, derivative width and video box, byte ranges, the asset store and retention sweep (`make server-test`)
- `server/tests/assets.rs`, `server/tests/hydrus.rs`, `server/tests/derivatives.rs` — see `assets.md`
- `test/conformance/*.conformance.ts` — the shared viewer contract against both servers (requirement 22)
- `test/e2e/specs/remote.e2e.ts` — real Obsidian against the container (see `overview.md`)

## Non-goals

- TLS termination. The server speaks plain HTTP behind a reverse proxy that terminates TLS.
- Running game logic. The server never computes a broadcast; it relays what the controller sends.
- Multiple sessions or tenants on one server. One server is one table.
- Serving vault files. Media reaches the server only through `/api/` uploads or its own Hydrus fetch.
