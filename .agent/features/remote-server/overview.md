# Remote Server Mode

> An optional second way to run DM Screen. Instead of hosting the player-screen server inside Obsidian (embedded mode, the default and unchanged), the plugin connects as the single controller of a standalone DM Screen server running elsewhere — a container on a home server — and the player and map screens connect to that server. This lets a device that cannot listen for connections (Obsidian on an iPad or an Android tablet) run the session, and lets a desktop run it without opening a port. What makes that device usable with a finger rather than a cursor is specified in `../map-screen/touch-input.md`. The plugin stays the brain: it computes every broadcast exactly as in embedded mode; the remote server only relays, caches and serves media.

## Source files

- `src/transport/transport.ts` — `SceneTransport` (`broadcast`, `sendLive`, `isLive`, `canEdit`, `mediaUrl`, `displayUrl`, `sourceOf`, `rememberSource`, `joinLink`) and `MapDataStore`; every DM-side emitter and persister goes through it
- `src/transport/embedded.ts` — `EmbeddedTransport`: the in-process `PlayerScreenServer`, the `ReplayCache`, settings and vault sidecars, LAN join links
- `src/transport/wire.ts` — `toWire` (a layer's `source` never leaves the DM side), `encodeVaultPath`
- `src/transport/remote.ts` — `RemoteTransport`: the control WebSocket client, `deviceId`/`deviceName`, role tracking, reconnect backoff, the ordered relay queue, `fetchDataUrl`, `claim`
- `src/transport/remoteApi.ts` — `callApi`: `/api/` and `/assets/` requests through `requestUrl` with a `Bearer` token
- `src/transport/assetUpload.ts` — `AssetPublisher`: fingerprint lookup, chunked upload, Hydrus by hash, the progress Notice, `rewrite` of outgoing messages
- `src/transport/remoteMapData.ts` — `RemoteMapData`: the server-backed store for map configs, calibration profiles, fog, walls and asset sources
- `src/protocol.ts` — `PROTOCOL_VERSION`, which must equal the constant of the same name in `server/src/protocol.rs`
- `src/main.ts` — `sessionIsLocal`, `sourceLabels`, `reloadLocalSession`, `effectiveServerMode`, `buildTransport`, `setServerMode`, `startSession`, `toggleServer`, the remote hooks (`onRemoteSession`, `onRemoteRole`, `onRemoteMirror`, `applyScreens`), `exploreModals`
- `src/views/DmControlPanel.ts` — `reloadFromLocal`, `renderRemoteServerSection` (Connect/Disconnect, status), `renderReadonlyBanner`, the inert `.dm-session` wrapper, `reloadFromSession`
- `src/views/MapScreenPanel.ts` — `resetForSession`; media published through `transport.mediaUrl` in `setVaultMap`
- `src/views/MapExploreModal.ts` — `applyEditable`
- `src/views/DnDBeyondPanel.ts` — polls broadcast only while `canEditSession()`
- `src/views/TakeControlModal.ts` — confirmation before claiming control from another device
- `src/settings.ts` — the server-mode settings group
- `server/` — the standalone server (see `server.md`)

## Settings used

- `serverMode` — `"embedded"` (default) or `"remote"`
- `remoteServerUrl` — base URL of the remote server, normally an `https` origin on an internal domain
- `remoteControlToken` — the server's control token
- `autoStartServer` — in remote mode, connect automatically on plugin load
- `mapConfigs`, `mapScreenProfiles` — used only in embedded mode; in remote mode their server-side counterparts are used instead (requirement 19)

The device identity is deliberately **not** a setting: `data.json` may be synced between devices, which would give two devices the same identity. It lives in device-local storage (requirement 6).

## Requirements

### Modes

1. The plugin shall support two server modes selected by `serverMode`: `embedded`, which shall behave exactly as specified by `../player-server/overview.md` and every other feature spec, and `remote`.
2. Every DM-side emitter and persister (`DmControlPanel`, `MapScreenPanel`, `MapFogModal`, `MapCalibrationModal`, `HydrusExplorerModal`, `DnDBeyondPanel`, the scene loader) shall send broadcasts, publish media and read or write map data only through the active `SceneTransport`, so the two modes differ in transport alone and not in how state is computed.
3. While running on Obsidian mobile (`Platform.isDesktopApp` false), the plugin shall run in remote mode whatever `serverMode` holds (`effectiveServerMode`, computed and never written back, because `data.json` may sync to a desktop that keeps its own choice), shall hide the mode selector, and shall never start the embedded server. `src/server.ts` shall import Node's `http` as types only and `require` it, like `ws`, when the server starts, so loading the plugin on mobile never touches either module. No other module may touch Node while the bundle loads either: fflate is imported from its `fflate/browser` build (its Node build calls `module.createRequire` at load), and mediabunny is required on first use inside the embedded server's video encoder.
4. `manifest.json` shall declare `isDesktopOnly: false`.

### Session ownership

4b. While the mode is remote, the server owns the session, so the plugin shall not write session state into `data.json`: `lastBroadcastCache`, `lastImageLayers` and `lastSourceLabels` shall keep whatever the last embedded session left there. The remote session's source labels live in memory for as long as the mode lasts.
4c. While the mode is remote, the DM panel shall not restore from `data.json` on open; `control-hello` is what rebuilds it (requirement 13), and the stored session belongs to the other mode.
4d. When the DM switches back to embedded, the plugin shall reload the local session — the `ReplayCache` from `lastBroadcastCache` and every open panel from `data.json` — so nothing of the server's scene lingers, whose `/assets/` URLs the embedded server cannot serve.
4e. Switching modes shall delete nothing: the credentials, map configs, calibration profiles, fog and walls sidecars, the Hydrus cache and the local preferences all survive a round trip, so returning to embedded mode resumes where it left off.

### Connecting

5. `remoteServerUrl` shall pass `assertOutboundUrl(url, "remote-server")` before any request or socket is opened: `https` always allowed, plaintext `http` only for a loopback, RFC1918 or single-label `.local` host.
6. On first use the plugin shall mint a random device id (lowercase hex, 32 characters) and store it with `app.saveLocalStorage("dm-screen-device-id", id)`; the device name sent to the server shall be `iPad`/`iPhone` on iOS, `Android` on Android, and `Desktop` otherwise.
7. In remote mode, the server row of the DM panel shall replace Start/Stop with Connect/Disconnect, and when `autoStartServer` is true the plugin shall connect on load.
8. When connecting, the plugin shall open `wss://` (or `ws://` for an `http` URL) `/control?k=<remoteControlToken>&device=<id>&name=<name>&protocol=<PROTOCOL_VERSION>` and handle the handshake per `control-channel.md`.
9. If the server closes the handshake for a protocol mismatch, then the plugin shall show a Notice naming both protocol versions and telling the DM to update the plugin or the server, and shall not retry until the DM presses Connect again.
10. If the server closes the handshake for a wrong token, then the plugin shall show a Notice `Remote server rejected the control token` and shall not retry automatically.
11. When the control socket drops for any other reason, the plugin shall reconnect with exponential backoff from 1 s to 30 s; while disconnected the panel shall show a `Reconnecting…` banner and shall behave as read-only (requirement 15).
12. The player and map join links in remote mode shall be built from `remoteServerUrl`, the path, and the view token received in `control-hello`, following `../player-server/overview.md` requirement 28 (the visible text omits the token); the panels take both modes' links from `transport.joinLink`.

### Roles

13. When `control-hello` assigns the role `active`, the plugin shall replace the contents of its `ReplayCache` with the server's cache (`ReplayCache.replace`), rebuild every open DM panel from it (`reloadFromSession`), and re-send the live-only seeds (`waiting-screen`, `inspiration-style`, `map-calibration`) as it does on an embedded server start. `reloadFromSession` shall take the layers from the cached `image-layers-sync` merged with the cached `image-layers-geometry`, fetch each layer image and fog mask back as a data URL (`fetchDataUrl`) and restore each layer's `source` from the server's `sources` collection, keep the background's and the map's `/assets/` URLs, and fetch the map fog mask back as a data URL — so the editing tools and webhooks work on the same data as in embedded mode.
14. When `control-hello` or `control-role` assigns the role `readonly`, the plugin shall load the server's cache the same way, then stop sending relays.
15. While the role is `readonly` or the socket is not connected, `transport.canEdit()` shall return false; the DM panel shall add the class `dm-readonly` to its root, make everything below the server section inert (the `.dm-session` wrapper: no input, no focus), and show a `.dm-readonly-banner` reading `Read-only — <holder name> has control` with a `Take control` button (`.dm-take-control-btn`), `Reconnecting…` while it retries, or `Disconnected — press Connect to control the session` when it does not; an open Exploration Mode modal shall make its content inert and carry `dm-explore-readonly` (`applyEditable`, re-run on every status change).
16. When the DM presses `Take control`, the plugin shall open `TakeControlModal` naming the current holder; on confirm it shall send `control-claim`.
17. While the role is `readonly`, when a `mirror` message arrives, the plugin shall apply it to its `ReplayCache` and re-restore the panel (debounced 100 ms), so the read-only device follows the session live.
18. While `canEditSession()` is false, the D&D Beyond panel shall not turn poll results into broadcasts, so only the device holding the lease feeds the screens.

### Broadcasting and media

18b. In remote mode, every path that turns a vault file into a background or map URL (note picker, a note's `hydrus://` reference, the Hydrus explorer, scene loading) shall publish it first through `transport.mediaUrl` and use the returned `/assets/<sha256>.<ext>` URL as the panel's identity for that medium, so every device names a medium the same way; a failed publish shall show a Notice and leave the current medium in place.
19. While the role is `active`, `plugin.broadcast(message)` shall record the message in the local `ReplayCache` as given (with layer sources, so the DM side keeps them) and enqueue a copy for the server, rewritten by requirement 20; while it is not, the message shall be neither recorded nor relayed.
20. Before a queued message is relayed, every media URL field it carries — `show-background-media.payload.url`, `map-show.payload.url`, `image-layers-sync.payload.layers[].dataUrl`, `image-layers-sync.payload.layers[].fogDataUrl`, `map-fog.payload.dataUrl` — shall be rewritten to an `/assets/<sha256>.<ext>` URL by publishing it per `assets.md` (vault file, Hydrus file, or `data:` URL); an empty or `null` value shall pass through unchanged.
21. The relay queue shall be FIFO across message types, shall hold a message until all of its media are published, and shall drop a queued message when a newer message of the same `type` is enqueued before it is sent; an `image-layers-geometry` shall never be relayed before the `image-layers-sync` enqueued ahead of it.
22. If publishing a medium fails, then the plugin shall show a Notice naming the file (never a URL or token), drop that message, and keep relaying later messages.
23. When an upload is larger than 8 MiB, the plugin shall show a persistent Notice with the file name and percentage, updated per chunk and hidden on completion or failure.
24. DM-side previews of an `/assets/` URL shall load `<remoteServerUrl>/assets/<sha256>.<ext>?k=<remoteControlToken>` (`transport.displayUrl`); a `/vault/` URL keeps resolving through the vault adapter.

### Map data

25. In remote mode, map configs (`mapConfigs` equivalent), calibration profiles (`mapScreenProfiles` equivalent), fog masks and walls shall be read from and written to the server's map-data store (`server.md` requirements 14–17) instead of `data.json` and the `.dm-screen/fog`/`.dm-screen/walls` sidecars, keyed by the map's `/assets/` URL (requirement 18b), which is the same on every device.
26. The plugin shall load the whole map-data document once per `control-hello` and write each change with one `PUT` (or `DELETE` for a removal), so a change made on one device is what the next device to take control sees.
27. A fog mask committed in remote mode shall be published as a PNG asset and stored in the map-data store as that asset URL; the `map-fog` broadcast carries the same URL.
28. Whenever the plugin publishes a vault file, relays a layer that has a `source`, or has the server fetch a file from Hydrus by hash, it shall record the asset name → scene source pair in the server's `sources` collection (only when it changes), through `transport.rememberSource` — a no-op in embedded mode, where every URL is a vault path that states its own source. `transport.sourceOf` shall resolve an `/assets/` URL through that collection, so a device that took the session over can still save scenes by reference. A Hydrus file the server fetched is the case nothing else can cover: the asset store holds the bytes under their sha256 and knows nothing of where they came from, so without the recorded `hydrus:<hash>` a scene saved from it would have no map and the save would be refused.

## Broadcast / IPC

The control-channel messages are specified in `control-channel.md`. Player- and map-channel messages are unchanged (`../player-server/websocket-protocol.md`); in remote mode they travel inside `relay` envelopes from the plugin to the server.

## Tests covering this

- `src/__tests__/transport-embedded.test.ts` — the embedded transport: broadcast, live-only sends, cache while stopped, map data in settings and sidecars, `/vault/` media URLs and previews, sources (and `rememberSource` as a no-op), LAN join links, `source` stripped before the server and the cache
- `src/__tests__/transport-remote.test.ts` — the control URL and stable device id, the URL policy, the active and read-only hellos, join links, previews, `control-role` and claim, mirror and screens hand-off, protocol-mismatch and bad-token Notices, reconnect backoff
- `src/__tests__/transport-relay-queue.test.ts` — local record with original URLs, sync-before-geometry, same-type supersession, failure isolation with a Notice
- `src/__tests__/asset-upload.test.ts` — fingerprint reuse, chunked upload with fingerprint and memo, 409 resume, Hydrus by hash and server fetch, a missing file named, the progress Notice, data URL dedupe by hash, unsupported types, message rewriting and source recording
- `src/__tests__/remote-map-data.test.ts` — load once per hello, PUT/DELETE per change with encoded keys, fog as an asset, sources written on change, one warning on a refused write
- `src/__tests__/ddb-panel-tracking-state.test.ts` — a read-only device does not broadcast polls (requirement 18)
- `src/__tests__/bundle-smoke.integration.test.ts` — the built `main.js` loads in a sandbox whose `require` yields only `obsidian`, with no `process` or `Buffer`, as on Obsidian mobile (requirement 3; runs after `make build`)
- `src/__tests__/session-ownership.test.ts` — a round trip between modes: the stored session untouched while remote, the two modes' labels kept apart, persistence resuming on return, and the server's scene dropped from memory (requirements 4b–4e)
- `src/__tests__/mobile-load.test.ts` — with `http` and `ws` unloadable and `Platform.isDesktopApp` false, the modules load, the plugin runs remote without rewriting `serverMode`, never starts the embedded server, and names an iPad (requirements 3, 6)
- `test/e2e/specs/remote.e2e.ts` — real Obsidian against the server container (`make test-e2e-remote`): the map published and served by hash, a layer relayed as an asset without its source, read-only on another device's claim and Take control back, the panel rebuilt from the session after a reconnect

## Non-goals

- More than one active controller. Exactly one device controls the session; others are read-only.
- Running the session with the remote server down. There is no fallback; on a desktop the DM switches back to embedded mode.
- Migrating map data between modes. Embedded and remote keep separate stores.
- Credentials in `data.json` in remote mode. The server's environment holds the Hydrus key, the D&D Beyond cookie and the webhook targets, and the plugin reaches those services through it (`../server-integrations/overview.md`); embedded mode keeps its per-device settings.
- Exposing the remote server to the public internet. It is meant for an internal network behind a TLS reverse proxy (`docs/THREAT-MODEL.md`).
