# Hydrus Through the Server

> The server holds the Hydrus Client API URL and key and exposes the handful of operations the plugin actually needs: verify, services, search, metadata, tag suggestions, thumbnails, ranged file reads, and the file fetch that already existed. In remote mode the device never talks to Hydrus and never downloads a Hydrus file into its vault, which is what makes the library usable from a tablet.

## Source files

- `server/src/integrations/hydrus.rs` — the named operations, the key attached per request, thumbnail caching
- `src/integrations/remote.ts` — `RemoteGateway.hydrus()`: the same method names as `HydrusClient`, over the routes below
- `src/integrations/local.ts` — `LocalGateway.hydrus()`: a `HydrusClient` against the configured URL
- `src/hydrus/client.ts` — unchanged; the local gateway's implementation
- `src/views/HydrusExplorerModal.ts`, `src/views/HydrusTagSuggester.ts`, `src/hydrus/noteRefs.ts`, `src/hydrus/foundryModules.ts`, `src/hydrus/recoverImage.ts` — callers, now through `plugin.gateway.hydrus()`
- `src/hydrus/cache.ts` — embedded mode only; remote mode has no local Hydrus cache

## Settings used

- `DM_SCREEN_HYDRUS_URL`, `DM_SCREEN_HYDRUS_KEY` (or `DM_SCREEN_HYDRUS_KEY_FILE`) — server-side, see `overview.md` requirement 6
- `hydrusTagServices`, `hydrusIgnoredTagPatterns`, `hydrusDefaultSearchTags`, `hydrusDefaultLoop`, `hydrusDefaultMuted` — preferences, from the server in remote mode

## Requirements

1. The server shall expose exactly these operations, each requiring the control token: `GET /api/hydrus/verify`, `GET /api/hydrus/services`, `POST /api/hydrus/search` (`{tags, limit}`), `POST /api/hydrus/metadata` (`{hashes}`), `GET /api/hydrus/tags?search=&service=`, `GET /api/hydrus/thumbnail/<hash>`, `GET /api/hydrus/file/<hash>` (honouring `Range`), and the existing `POST /api/assets/hydrus` (`{hash}`) which stores the file and answers with its asset.
2. Each shall call the matching Hydrus Client API route with the key in `Hydrus-Client-API-Access-Key`, and shall pass through the upstream's JSON body for the read operations, which carry no credential.
3. `<hash>` shall be 64 lowercase hex characters; anything else shall answer `400` without a request upstream.
4. `POST /api/hydrus/search` shall accept at most 64 tags, each at most 256 characters, and an optional positive `limit`; `POST /api/hydrus/metadata` at most 1024 hashes, which covers a full explorer page.
4b. Hydrus takes the hash list in the query string, so the server shall ask it for metadata in batches of at most 64 hashes and join the answers into one `metadata` array. A page of hashes in a single query is tens of kilobytes, past what an HTTP server accepts in a request line.
5. If Hydrus is not configured, then every route of requirement 1 shall answer `501`.
6. An upstream error shall answer `502` and log the operation and the upstream status, never the body or the URL (`overview.md` requirement 16).
7. `GET /api/hydrus/thumbnail/<hash>` shall answer the thumbnail bytes with their content type and `Cache-Control: private, max-age=3600`, and shall keep them in a bounded in-memory cache so a grid of tiles costs one upstream request per file.
8. `GET /api/hydrus/file/<hash>` shall forward a single `Range` header and return `206` with `Content-Range` when the upstream does, so the Foundry module reader keeps reading a few entries out of a large archive.

### Plugin side

9. The gateway's Hydrus surface shall offer the read methods `HydrusClient` offers — `verifyAccess`, `getServices`, `searchFiles`, `searchTags`, `getFileMetadata`, `getFileBytes`, `getThumbnailBytes`, `getFileRange` — plus `publish(hash)` and `markUsed(hash)`, so every caller is unchanged beyond where it gets the client.
9b. `publish(hash)` shall make the file reachable by the screens and answer its URL, its media type and its known tags: the vault cache and a `/vault/` URL in embedded mode, the server's asset store and an `/assets/` URL in remote mode. Every caller that used to copy a file into the vault shall use it. In remote mode it shall also record `hydrus:<hash>` as that asset's scene source (`../remote-server/overview.md` requirement 28), because an `/assets/` URL the server fetched by hash carries nothing that says where it came from, and a scene saved from such a map would otherwise be refused for having no map.
10. In remote mode, applying a Hydrus file as a background, a layer or a map shall publish it with `POST /api/assets/hydrus` and use the returned asset URL, and shall not download it into the vault or the plugin cache.
11. In remote mode, the explorer shall render a tile's thumbnail from `GET /api/hydrus/thumbnail/<hash>` and its full preview from `GET /api/hydrus/file/<hash>`. It shall not offer the local-cache source or the per-tile cache actions (download, re-download, delete the local copy), because there is no vault cache to list or evict.
12. In remote mode, a note's `hydrus://` reference shall resolve through the gateway: available when the metadata call finds it, and applied per requirement 10 without a local copy.
13. In remote mode, the media's natural dimensions shall be measured from the URL the device can load (the asset URL), since there is no local file to measure.
14. In remote mode, `recoverVaultImage` shall not run: an `/assets/` URL is the server's to keep, and the server's retention is what governs it.

## Tests covering this

- `server/tests/hydrus.rs` — each operation against the stub Hydrus: the key attached, hash validation, a full page of hashes answered in batches whose queries stay small, the search and metadata limits, `501` unconfigured, `502` on an upstream error with nothing of the body in the response, thumbnail caching, a forwarded `Range`
- `src/__tests__/gateway-remote.test.ts` — the remote `HydrusApi` maps each method to its route and shape, and `publish` records `hydrus:<hash>` as the published asset's scene source (requirement 9b)
- `src/__tests__/hydrus-explorer-search.test.ts` — the explorer searching through the gateway
- `test/e2e/specs/remote.e2e.ts` — real Obsidian: the Hydrus bar appears from the server's capability

## Non-goals

- Writing to Hydrus (tags, ratings, imports). Every operation is a read.
- A local Hydrus cache in remote mode. The server's asset store is the cache.
- Hiding the library from a controller. Anyone with the control token can search it (`../../docs/THREAT-MODEL.md`).
