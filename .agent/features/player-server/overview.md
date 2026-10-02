# Player Screen Server

> An in-Obsidian HTTP + WebSocket server that hosts the player screen (`/`) and the map screen (`/map`, see `../map-screen/overview.md`). Any browser on the local network can connect to it to see the DM-pushed scene; the DM controls the server lifecycle and the broadcasts.

## Source files

- `src/server.ts` — `PlayerScreenServer` class, HTTP handler, WebSocket connection accounting, `ReplayCache` (late-joiner cache), `readVaultBytes` helper
- `src/main.ts` — wires `startServer` / `stopServer` / `toggleServer`, applies `maxClients`, forwards client-info callbacks to the DM panel
- `src/views/DmControlPanel.ts` — renders the server status row, Start/Stop button, and connected-client badges; the player LAN URL + Copy row lives at the top of the Player Screen section (mirroring the Map Screen section's URL row)
- `src/player/player.ts` — client side of the WebSocket connection, handles reconnect, reads the access token from `?k=` or the `dmScreenKey` cookie
- `src/auth.ts` — `generateAccessToken()`, `tokenMatches()` (length-independent compare), `buildJoinUrl()`
- `src/views/MapScreenPanel.ts` — the map join link, built with the same `buildJoinUrl`
- `docs/THREAT-MODEL.md` — trust boundary, what the token covers, and why TLS is not shipped

## Settings used

- `serverPort` — TCP port the HTTP listener binds to (default `3000`)
- `autoStartServer` — start the server automatically on plugin load
- `maxClients` — maximum number of simultaneous WebSocket clients (default `10`)
- `accessToken` — 32-char hex token required by every route except `/health`; minted on first load, regenerated from the settings tab
- `lastBroadcastCache` — persisted late-joiner cache, loaded into the plugin's `ReplayCache` on plugin load and kept in sync with it whether or not the server is running (`websocket-protocol.md` requirements 2b–2d)
- `waitingTitle` — big text rendered on the waiting screen (default `"Player Screen"`)
- `waitingSubtitle` — smaller text below the title (default `"Waiting for DM to push content..."`)
- `ddbInspirationPulse` — drives the `inspiration-style` broadcast that toggles the `dm-inspired-pulse` body class on every connected player (default `true`)

## Requirements

1. The server shall bind to `0.0.0.0` on `settings.serverPort` when started.
2. The server shall serve `GET /` and `GET /index.html` with the inline HTML built in `buildPlayerHtml()`.
3. The server shall serve `GET /player.js` with the bundled player script.
4. The server shall serve `GET /player.css` with the inline CSS.
4b. The server shall serve `GET /map` (inline HTML from `buildMapHtml()`), `GET /map.js` (bundled map script), and `GET /map.css` (inline map CSS).
5. The server shall serve `GET /health` with JSON `{ status: "ok", clients: <count> }`.
6. The server shall serve `GET /vault/<path>` via the vault-routing rules defined in `vault-routing.md`.
7. The server shall return HTTP 404 for any other path.
8. When a WebSocket client connects, the server shall reject it with close code `1013` and reason `"Max clients reached"` if `clientCount >= maxClients`.
9. When a WebSocket client connects within the limit, the server shall tag it with its channel (`map` when the upgrade path starts with `/map`, else `player`), add it to its client set, and replay every cached broadcast message of that channel.
10. When a WebSocket client disconnects, the server shall remove it from the client set, its channel tag, and `clientInfoMap`, and invoke `onClientCountChanged`.
11. When a WebSocket client sends a `client-info` message, the server shall store its payload plus the connection's channel in `clientInfoMap` and invoke `onClientInfo`.
12. When the DM calls `broadcast(message)`, the server shall serialise the message and send it to every client of the message's channel (`map-` prefixed types → map clients, all others → player clients) whose `readyState` is `1` (OPEN).
13. When the DM calls `broadcast({type: "clear"})`, the server shall purge the `player`-channel entries from the late-joiner cache before sending; `broadcast({type: "map-clear"})` shall purge the `map-*` entries symmetrically.
14. When the DM calls `broadcast(message)` with any type other than `clear`/`map-clear`, the server shall store the serialised message in the late-joiner cache, keyed by `message.type`, overwriting any previous entry of that type.
15. When the server stops, the server shall close every active WebSocket connection, clear its client set, close the HTTP listener, and destroy any lingering HTTP connections (via `httpServer.closeAllConnections()`) so idle keep-alive sockets do not hold the port bound on older runtimes.
16. If `autoStartServer` is true, then on plugin load the server shall start.
17. If the workspace contains an open DM Control Panel, when the connected-client count changes the server shall trigger that panel to re-render (debounced) so it can reflect the new count and resolutions. This background re-render shall be deferred while an `INPUT`/`TEXTAREA` inside the panel is focused, and flushed when that field loses focus, so a client connecting mid-typing does not discard the DM's in-progress entry (e.g. the manual add-combatant form).
18. The server shall expose a `clientCount` accessor and a `getConnectedClients()` accessor returning the array of `ClientInfo` payloads.
19. `buildPlayerHtml()` shall inline the current `waitingTitle` and `waitingSubtitle` into the `#waiting-screen` markup, HTML-escaping the values. Empty values shall cause the corresponding `<h1>` or `<p>` to be omitted entirely.
20. After `startServer()` succeeds, the plugin shall call `broadcastWaitingScreen()` to seed the late-joiner cache with the current waiting-screen text.
21. When either `waitingTitle` or `waitingSubtitle` changes in settings, the plugin shall broadcast `waiting-screen` immediately so already-connected clients update without a reload.
22. After `startServer()` succeeds, the plugin shall also call `broadcastInspirationStyle()` to seed the late-joiner cache with the current `ddbInspirationPulse` value (see `../combat-tracker/overview.md` Heroic Inspiration requirements). When `ddbInspirationPulse` changes in settings, the plugin shall broadcast `inspiration-style` immediately so already-connected clients update without a reload.
23. When the player-side WebSocket transitions to OPEN, the player shall set `window.__wsConnected` to `true`; when it transitions to CLOSE, the player shall set `window.__wsConnected` to `false`. (Drives the connection-ready gate used by the visual test harness so screenshots never fire before the first broadcast can arrive.)
24. `settings.accessToken` shall hold a 32-character lowercase hex token. `loadSettings()` shall mint one with `generateAccessToken()` and persist it whenever the stored value is empty, so an upgraded vault gets a token without user action. The default in `DEFAULT_SETTINGS` shall be the empty string — a module-level generate would hand every vault the token of whichever process imported `settings.ts` first.
25. For every HTTP route other than `/health`, the server shall require an access token matching `settings.accessToken`, supplied either as the `k` query parameter or as the `dmScreenKey` cookie, and shall respond `401 Unauthorized` when it is absent or wrong. `/health` shall stay open: it carries only a status string and a client count, and the DM panel polls it, so it must keep answering after a token regenerate.
26. When serving `/` or `/map`, the server shall set `dmScreenKey` as a cookie (`Path=/`, `SameSite=Strict`, `Max-Age=86400`) so a reload or a navigation that drops the query parameter still authenticates, and so `/vault/` subresource requests from the page carry the token automatically.
27. Token comparison shall be length-independent (`tokenMatches` in `src/auth.ts`), so response timing does not reveal a matching prefix. An empty or non-string stored token shall match nothing, so a missing or malformed token fails closed; `tokenMatches` shall never throw, because it runs inside the HTTP handler where a throw answers `ERR_EMPTY_RESPONSE` instead of `401`.
28. The DM panel and Map Screen panel shall render join links built by `buildJoinUrl(host, port, token, path)`: the anchor `href` and the Copy button shall carry the token, while the visible link text shall remain the bare `http://host:port` URL so a screenshot of the panel does not leak it.
29. The settings tab shall expose the access token read-only with a `Regenerate` button that mints a new token, saves it, calls `server.disconnectAllClients()`, and notifies the DM that each screen needs the new link.
30. `disconnectAllClients()` shall close every connected socket with code `1008`, clear the client/channel/info maps, and fire `onClientCountChanged`.
31. The server's threat model — what the token protects, the resource caps, and the deliberate decision to ship plaintext HTTP rather than TLS on a LAN — is documented in `docs/THREAT-MODEL.md`. That decision shall be revisited only together with that document.

## Broadcast / IPC

The server is the transport for every DM → player and player → DM message. The exhaustive message table is in `websocket-protocol.md`. HTTP routes are listed above (requirements 2–7).

## Tests covering this

- `src/__tests__/server.test.ts` — basic start / stop / port binding
- `src/__tests__/server-bootstrap.integration.test.ts` — real `PlayerScreenServer` + real `ws` client connection
- `src/__tests__/server-broadcast.test.ts` — `broadcast()` filters by `readyState`, populates late-joiner cache
- `src/__tests__/server-max-clients.test.ts` — `maxClients` enforced with close code `1013`
- `src/__tests__/server-vault-path.test.ts` — `/vault/` path-traversal guard (see `vault-routing.md`)
- `src/__tests__/server-combat-scale.test.ts` — `combat-scale` broadcast end-to-end
- `src/__tests__/auth.test.ts` — token shape and uniqueness, length-independent compare (prefix, extension, empty secret and candidate), join-URL construction and percent-encoding
- `src/__tests__/server-auth.integration.test.ts` — real `ws` handshakes: no token and wrong token close `1008`, right token opens, cookie-supplied token opens, cross-origin `Origin` closes `1008`, matching `Origin` opens, `/map?k=` still routes to the map channel, a 40-message burst closes `1008`, `disconnectAllClients()` drops every socket
- `src/__tests__/server-vault-allowlist.integration.test.ts` — `401` before the allowlist and before any disk read, `401` on a wrong token, `401` on the player page, `/health` open, and the `dmScreenKey` cookie set on `/`
- `src/__tests__/main.test.ts` — `loadSettings` mints and persists a token when none is stored and keeps an existing one
- `src/__tests__/smoke.test.ts` — module loads, exports present
- `src/__tests__/server-stop-keepalive.integration.test.ts` — `stop()` destroys idle keep-alive sockets so the port rebinds immediately (req 15)
- `src/__tests__/dm-control-render-guard.test.ts` — a background re-render is deferred while a panel input is focused and flushed on blur (req 17)
- `src/__tests__/bundle-smoke.integration.test.ts` — production `main.js` builds and contains the server class
- `test/visual/*.spec.ts` — Playwright visual regression suite. Boots a real `PlayerScreenServer` against the production player bundle (via `scripts/build-player.mjs` + a CJS-bundled `server-entry.ts` built in `test/visual/harness/build-host.mjs`) and asserts pixel-stable screenshots of waiting screen, background image, image-layers-sync, fog overlays (full / circle / rect / freehand), and the initiative tracker. Baselines must be generated inside the official Microsoft Playwright container so local and CI render identically.
- `test/e2e/specs/smoke.e2e.ts` — real Obsidian: plugin loads and enables, both commands registered, ribbon icon present, DM Control Panel opens with its sections
- `test/e2e/specs/server.e2e.ts` — real Obsidian: Start Server button serves the player/map endpoints over real HTTP, channel-scoped late-joiner replay over real sockets, port change takes effect after restart, settings persist across a plugin disable/enable cycle

## Non-goals

- TLS / HTTPS termination. The server is plain HTTP; it is intended for trusted LAN only.
- Authentication or per-client identity. Any browser that can reach the port can connect.
- Persisting non-broadcast state (e.g. per-client preferences). The only persisted state is the late-joiner cache.
- Replaying `clear` messages to late joiners.
- Serving files outside the vault root or following `..` path segments — see `vault-routing.md`.
