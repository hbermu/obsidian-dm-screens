# Remote Assets

> How media reaches a remote server and the screens. Every image, video and fog mask is stored once under its SHA-256 and referenced as `/assets/<sha256>.<ext>`. The plugin first asks whether the server already has a file (by a cheap vault fingerprint, or by the Hydrus hash, which is the file's SHA-256), uploads in chunks only when it does not, and lets the server fetch Hydrus files itself when it is configured to. Screens get the same per-width derivatives as from the embedded server, plus byte ranges so video plays on every browser.

## Source files

- `server/src/assets.rs` — content-addressed store, fingerprint index, chunked uploads, retention sweep, `/assets/` serving with `Range`; the encoders run as `ffmpeg`/`ffprobe` subprocesses (`DM_SCREEN_FFMPEG`, `DM_SCREEN_FFPROBE` override their paths)
- `server/src/derivatives.rs` — WebP and MP4 derivatives, the on-disk derivative cache
- `server/src/hydrus.rs` — server-side Hydrus download with hash verification
- `server/src/allowlist.rs` — the display allowlist over `/assets/` URLs
- `src/transport/assetUpload.ts` — the plugin side: fingerprint, lookup, upload, Hydrus request, URL rewriting
- `src/player/safeUrl.ts` — accepts `/assets/<64 hex>.<ext>` URLs
- `src/hydrus/hashFromPath.ts` — recognises a Hydrus cache path so its hash can be used directly

## Settings used

- `remoteServerUrl`, `remoteControlToken` — target and credential of every `/api/` call
- `cacheBaseFolder` — locates Hydrus cache paths for requirement 15

## Requirements

### Store

1. The server shall store each asset at `<data dir>/assets/<first two hex>/<sha256>` with its extension and size recorded in `<data dir>/state/assets.json`, alongside the fingerprint index (requirement 6) and each asset's last-used time.
2. Accepted extensions shall be `png`, `jpg`, `jpeg`, `webp`, `gif`, `mp4`, `webm`, with the same `Content-Type` map as `../player-server/vault-routing.md` requirement 10; anything else shall be refused with `415`.
3. `GET /api/assets/<sha256>` shall answer `200 {sha256, ext, size}` when the asset exists and `404` otherwise, and shall mark the asset used.
4. Once a day, and on startup, the server shall delete every asset whose last-used time is older than `DM_SCREEN_ASSET_RETENTION_DAYS` and that no entry of the replay cache or the map-data store references.
5. An asset shall be marked used whenever a relay or a map-data write references it, a lookup or a Hydrus request returns it, or a screen fetches it.

### Lookup and upload

6. `POST /api/assets/lookup` with `{path, size, mtime}` shall answer `200 {sha256, ext}` when that exact fingerprint was recorded by an earlier upload whose asset still exists, and `404` otherwise.
7. `POST /api/uploads` with `{size, ext, fingerprint?}` shall answer `201 {id, chunkSize}` with `chunkSize` = 8 MiB; a `size` above `DM_SCREEN_MAX_ASSET_MB` shall answer `413`.
8. `PUT /api/uploads/<id>?offset=<n>` shall append the body when `n` equals the bytes received so far and the body is at most `chunkSize`, answering `200 {received}`; any other offset shall answer `409 {received}` so the client can resume.
9. `POST /api/uploads/<id>/complete` shall verify the received size equals the declared size, compute the SHA-256, move the file into the store (or discard it when the asset already exists), record the fingerprint if one was given, and answer `200 {sha256, ext}`; a size mismatch shall answer `422` and discard the upload.
10. An upload with no chunk for one hour shall be discarded, and at most four uploads shall be in progress at once (`429` beyond that).

### Hydrus fetch

11. If `DM_SCREEN_HYDRUS_URL` and `DM_SCREEN_HYDRUS_KEY` are set, then `POST /api/assets/hydrus` with `{hash}` shall return the existing asset when `hash` is already stored, and otherwise download the file from the Hydrus Client API with the key, verify that its SHA-256 equals `hash`, store it with the extension derived from the response `Content-Type`, and answer `200 {sha256, ext}`.
12. If Hydrus is not configured, then that route shall answer `501`; a Hydrus error or a hash mismatch shall answer `502` and store nothing.
13. The Hydrus URL shall obey the same rule as `src/net/urlPolicy.ts`: `http` or `https` only, no embedded credentials, plaintext only to a loopback, RFC1918 or single-label `.local` host; the server shall refuse to start otherwise.

### Plugin side

14. To publish a `/vault/<path>` URL the plugin shall send its fingerprint (`path`, and `size` and `mtime` from `vault.adapter.stat`) to the lookup route, and only on `404` read the file and upload it in `chunkSize` pieces, resuming from `received` on a `409`.
15. If the vault path is a Hydrus cache path (`hydrusHashFromVaultPath`), then the plugin shall first ask `GET /api/assets/<hash>`, then, when the server reports `hydrus: true` in `control-hello`, `POST /api/assets/hydrus`, and fall back to requirement 14 only when both miss and the file exists locally.
16. When the Hydrus explorer or a note's `hydrus://` reference sets a background, layer or map while connected to a server with `hydrus: true`, the plugin shall request the file through requirement 15 and shall not download it into the vault; the DM-side preview loads it per `overview.md` requirement 24.
17. To publish a `data:` URL the plugin shall decode it and upload the bytes with the extension from its MIME type, without a fingerprint.
18. The plugin shall remember, per session, which source URLs it has published and their asset URLs, so an unchanged source is not looked up twice.

### Serving

19. `GET /assets/<sha256>.<ext>` shall require a view or control token as in `server.md` requirement 6; with the view token, an asset not on the display allowlist shall answer `404` before any disk read.
20. The display allowlist shall be maintained from relayed messages exactly as `../player-server/vault-routing.md` requirements 3–4 maintain the embedded one, over `/assets/` URLs instead of `/vault/` ones, and shall additionally admit the URL in `map-fog.payload.dataUrl`.
21. The server shall honour single `Range` requests on `/assets/` with `206` and `Content-Range`, and advertise `Accept-Ranges: bytes`.
22. A `?w=` request shall follow `../player-server/vault-routing.md` requirements 15–17 — width rounded up to 256 and capped at 16384; still images as WebP at quality 0.9; videos re-encoded with `ffmpeg` to H.264 MP4 inside the `videoTargetSize` box with audio dropped; the original when it already fits or the encode fails — with access checks before any work.
23. Derivatives shall be cached on disk under `<data dir>/derivatives/` with least-recently-used eviction above `DM_SCREEN_DERIVATIVE_CACHE_MB`, and concurrent requests for one derivative shall share one encode.

## Tests covering this

- `server/tests/assets.rs` — upload by hash with fingerprint lookup hit and miss, resume after a wrong offset, size mismatch, extension, size and concurrency limits, view token kept off the API and unlisted assets, retention sweep sparing a referenced asset
- `server/tests/hydrus.rs` — fetch against a stub Hydrus: success, hash mismatch, upstream error, unconfigured (the URL policy at startup is a unit test in `server/src/config.rs`)
- `server/tests/derivatives.rs` — with the real `ffmpeg`: a WebP at the rounded width, the original when it fits, a video fitted inside 1080p and served by range, no derivative for a GIF
- `src/__tests__/asset-upload.test.ts` — the plugin side (requirements 14–18)
- `src/__tests__/safe-url.test.ts` — `/assets/` acceptance and rejection of malformed hashes and extensions
- `test/conformance/assets.conformance.ts` — the display allowlist against both servers, `Range` and the `map-fog` entry against the remote one

## Non-goals

- Deduplication across differently encoded copies of the same picture. Identity is the exact byte content.
- Uploading from a screen. Only the controller writes media.
- Streaming uploads from disk on mobile. Obsidian's adapter reads a whole file, so very large videos should be prepared from a desktop or fetched by the server from Hydrus.
