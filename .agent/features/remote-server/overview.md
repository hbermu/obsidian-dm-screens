# Remote Server Mode

> An optional second way to run DM Screen. Instead of hosting the player-screen server inside Obsidian (embedded mode, the default and unchanged), the plugin connects as the single controller of a standalone DM Screen server running elsewhere — a container on a home server — and the player and map screens connect to that server. This lets a device that cannot listen for connections (Obsidian on an iPad or an Android tablet) run the session, and lets a desktop run it without opening a port. The plugin stays the brain: it computes every broadcast exactly as in embedded mode; the remote server only relays, caches and serves media.

## Source files

- `src/transport/transport.ts` — `SceneTransport` interface: `broadcast(message)`, `publishAsset(ref)`, map-data reads and writes; every DM-side emitter and persister goes through it
- `src/transport/embedded.ts` — `EmbeddedTransport`: today's behaviour (in-process `PlayerScreenServer`, `ReplayCache`, settings and vault sidecars)
- `src/transport/remote.ts` — `RemoteTransport`: the control WebSocket client, role tracking, reconnect, the ordered relay queue
- `src/transport/assetUpload.ts` — fingerprint lookup, chunked upload, Hydrus fetch request, URL rewriting of outgoing messages
- `src/transport/remoteMapData.ts` — the server-backed store for map configs, calibration profiles, fog and walls
- `src/protocol.ts` — `PROTOCOL_VERSION` and the control-channel message types shared with the conformance suite
- `src/main.ts` — selects the transport from `serverMode`, loads the embedded server only on desktop, wires connect/disconnect
- `src/views/DmControlPanel.ts`, `src/views/MapScreenPanel.ts` — server row (Connect/Disconnect, role, holder), read-only banner and disabled controls
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
3. While running on Obsidian mobile, the plugin shall not load the embedded server or `ws`, shall force `serverMode` to `remote`, and shall hide the mode selector. The embedded server shall be obtained through a runtime `require` guarded by `Platform.isDesktopApp`, never a static import, because the Node `http` module does not exist on mobile.
4. `manifest.json` shall declare `isDesktopOnly: false`.

### Connecting

5. `remoteServerUrl` shall pass `assertOutboundUrl(url, "remote-server")` before any request or socket is opened: `https` always allowed, plaintext `http` only for a loopback, RFC1918 or single-label `.local` host.
6. On first use the plugin shall mint a random device id (lowercase hex, 32 characters) and store it with `app.saveLocalStorage("dm-screen-device-id", id)`; the device name sent to the server shall be `iPad`/`iPhone` on iOS, `Android` on Android, and `Desktop` otherwise.
7. In remote mode, the server row of the DM panel shall replace Start/Stop with Connect/Disconnect, and when `autoStartServer` is true the plugin shall connect on load.
8. When connecting, the plugin shall open `wss://` (or `ws://` for an `http` URL) `/control?k=<remoteControlToken>&device=<id>&name=<name>&protocol=<PROTOCOL_VERSION>` and handle the handshake per `control-channel.md`.
9. If the server closes the handshake for a protocol mismatch, then the plugin shall show a Notice naming both protocol versions and telling the DM to update the plugin or the server, and shall not retry until the DM presses Connect again.
10. If the server closes the handshake for a wrong token, then the plugin shall show a Notice `Remote server rejected the control token` and shall not retry automatically.
11. When the control socket drops for any other reason, the plugin shall reconnect with exponential backoff from 1 s to 30 s; while disconnected the panel shall show a `Reconnecting…` banner and shall behave as read-only (requirement 15).
12. The player and map join links in remote mode shall be built from `remoteServerUrl`, the path, and the view token received in `control-hello`, following `../player-server/overview.md` requirement 28 (the visible text omits the token).

### Roles

13. When `control-hello` assigns the role `active`, the plugin shall replace the contents of its `ReplayCache` with the server's cache, restore the DM panel from it exactly as on panel open, and re-send the live-only seeds (`waiting-screen`, `inspiration-style`, `map-calibration`) as it does on an embedded server start.
14. When `control-hello` or `control-role` assigns the role `readonly`, the plugin shall load the server's cache the same way, then stop sending relays.
15. While the role is `readonly` or the socket is disconnected, `transport.canEdit()` shall return false, and the DM panel and the Exploration Mode modal shall add the class `dm-readonly` to their root, disable every control that would broadcast or persist, and show a banner `Read-only — <holder name> has control` with a `Take control` button (`.dm-take-control-btn`); while disconnected the banner shall read `Reconnecting…` without the button.
16. When the DM presses `Take control`, the plugin shall open `TakeControlModal` naming the current holder; on confirm it shall send `control-claim`.
17. While the role is `readonly`, when a `mirror` message arrives, the plugin shall apply it to its `ReplayCache` and re-restore the panel (debounced 100 ms), so the read-only device follows the session live.
18. While the role is `active`, only the D&D Beyond poller of the active device shall run; a device that becomes `readonly` shall stop its poller, and a device that becomes `active` shall start it if `ddbEnabled` and an encounter is tracked.

### Broadcasting and media

19. While the role is `active`, `plugin.broadcast(message)` shall record the message in the local `ReplayCache` with its original URLs (so DM-side previews keep resolving locally) and enqueue a copy for the server, rewritten by requirement 20.
20. Before a queued message is relayed, every media URL field it carries — `show-background-media.payload.url`, `map-show.payload.url`, `image-layers-sync.payload.layers[].dataUrl`, `image-layers-sync.payload.layers[].fogDataUrl`, `map-fog.payload.dataUrl` — shall be rewritten to an `/assets/<sha256>.<ext>` URL by publishing it per `assets.md` (vault file, Hydrus file, or `data:` URL); an empty or `null` value shall pass through unchanged.
21. The relay queue shall be FIFO across message types, shall hold a message until all of its media are published, and shall drop a queued message when a newer message of the same `type` is enqueued before it is sent; an `image-layers-geometry` shall never be relayed before the `image-layers-sync` enqueued ahead of it.
22. If publishing a medium fails, then the plugin shall show a Notice naming the file (never a URL or token), drop that message, and keep relaying later messages.
23. When an upload is larger than 8 MiB, the plugin shall show a persistent Notice with the file name and percentage, updated per chunk and hidden on completion or failure.
24. DM-side previews of an `/assets/` URL (an item fetched by the server from Hydrus and never stored on this device) shall load `<remoteServerUrl>/assets/<sha256>.<ext>?k=<remoteControlToken>`.

### Map data

25. In remote mode, map configs (`mapConfigs` equivalent), calibration profiles (`mapScreenProfiles` equivalent), fog masks and walls shall be read from and written to the server's map-data store (`server.md` requirements 20–23) instead of `data.json` and the `.dm-screen/fog`/`.dm-screen/walls` sidecars, keyed by the same map URL keys as embedded mode.
26. The plugin shall load the whole map-data document once per `control-hello` and write each change with one `PUT` (or `DELETE` for a removal), so a change made on one device is what the next device to take control sees.
27. A fog mask committed in remote mode shall be published as a PNG asset and stored in the map-data store as that asset URL; the `map-fog` broadcast carries the same URL.

## Broadcast / IPC

The control-channel messages are specified in `control-channel.md`. Player- and map-channel messages are unchanged (`../player-server/websocket-protocol.md`); in remote mode they travel inside `relay` envelopes from the plugin to the server.

## Tests covering this

- `src/__tests__/transport-embedded.test.ts` — the embedded transport is behaviour-identical to the pre-transport code paths (broadcast, cache, map data, sidecars)
- `src/__tests__/transport-remote.test.ts` — handshake handling, role transitions, read-only gating, mirror application, reconnect backoff, protocol-mismatch and bad-token Notices
- `src/__tests__/transport-relay-queue.test.ts` — FIFO order, same-type supersession, sync-before-geometry, failure isolation
- `src/__tests__/asset-upload.test.ts` — URL rewriting per field, fingerprint lookup hit/miss, chunked upload, Hydrus fetch path, progress Notice threshold
- `src/__tests__/remote-map-data.test.ts` — load once per hello, PUT/DELETE per change, fog as asset URL
- `src/__tests__/mobile-load.test.ts` — with `Platform.isDesktopApp` false the plugin loads without requiring `http` or `ws` and forces remote mode
- `test/e2e/specs/remote.e2e.ts` — real Obsidian against the real remote server container: connect, broadcast a background and a map, a second controller reads only, take control, reconnect

## Non-goals

- More than one active controller. Exactly one device controls the session; others are read-only.
- Running the session with the remote server down. There is no fallback; on a desktop the DM switches back to embedded mode.
- Migrating map data between modes. Embedded and remote keep separate stores.
- Syncing credentials (Hydrus key, D&D Beyond cookie, webhooks) between devices through the server. They stay per device.
- Exposing the remote server to the public internet. It is meant for an internal network behind a TLS reverse proxy (`docs/THREAT-MODEL.md`).
