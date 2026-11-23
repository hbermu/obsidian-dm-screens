# Control Channel

> The WebSocket the controlling plugin uses to drive a remote server: the handshake, the single-controller lease with take-over, the relay of player- and map-channel broadcasts, the mirror stream for a read-only device, and the screen list that feeds the DM panel's badges.

## Source files

- `server/src/control.rs` — handshake checks, `hello`, the lease transitions, relay handling, `send_roles`
- `server/src/state.rs` — `Session.holder` (the lease), `Session::is_active`, `AppState::relay` (processing and mirror fan-out), `Session::send_screens`
- `server/src/protocol.rs` — `PROTOCOL_VERSION`
- `src/protocol.ts` — the same message types on the plugin side
- `src/transport/remote.ts` — the plugin's client of this channel

## Settings used

- none (the plugin side reads the settings listed in `overview.md`)

## Requirements

### Handshake

1. The server shall accept control connections on `WS /control` only, with query parameters `k` (control token), `device`, `name` and `protocol`.
2. If `k` is absent or does not match the control token (length-independent comparison), then the server shall close the socket with code `1008` before any other processing. The view token shall not open a control socket.
3. If `device` does not match `^[0-9a-f]{32}$`, or `name` is absent or longer than 64 characters, then the server shall close the socket with code `1008`.
4. If `protocol` is not exactly the server's `PROTOCOL_VERSION`, then the server shall close the socket with code `4001` and reason `protocol-mismatch:<server PROTOCOL_VERSION>`.
5. If four control sockets are already open, then the server shall close the new one with code `1013`.
5b. After any close the server initiates, it shall keep reading until the client answers the close (two seconds at most), so the client observes the close code instead of a reset connection.
6. The server shall accept a control handshake from any `Origin`. The `Origin` rule of `../player-server/websocket-protocol.md` requirement 11 exists because viewers authenticate with an ambient cookie a foreign page could reuse; the control token travels only explicitly in the query, and the controller is Obsidian (`app://`, `capacitor://`), never a page on the server's origin.

### Lease

7. The server shall hold at most one lease holder, identified by device id and name. The lease shall survive the holder's disconnection and shall not be persisted across a server restart.
8. When a handshake succeeds and there is no holder, or the holder's device id equals `device`, the server shall make that device the holder and give the socket the role `active`; otherwise the socket shall get the role `readonly`.
9. Immediately after a successful handshake, the server shall send `control-hello` (see the table) carrying the protocol, the server version, the view token, the role, the holder, whether Hydrus fetch is configured, the full replay cache of both channels, and the current screen list.
10. When a socket sends `control-claim`, the server shall make its device the holder, send `control-role {role: "active"}` to every socket of that device, and send `control-role {role: "readonly"}` with the new holder to every other control socket.
11. If more than one socket of the holder's device is open, then every one of them shall be `active`.

### Relay

12. When an `active` socket sends `relay {message}`, the server shall process `message` exactly as `PlayerScreenServer.broadcast` does — channel routing, replay-cache rules including the 2 MiB budget, display-allowlist update, fan-out to `readyState` OPEN viewers of the channel — per `server.md` requirement 9.
13. After processing a relay, the server shall send `mirror {message}` to every `readonly` control socket.
14. When a `readonly` socket sends `relay`, the server shall drop the message and answer `control-error {code: "not-active"}`.
15. If `message` lacks a string `type` or an object `payload`, then the server shall answer `control-error {code: "bad-message"}` and change nothing.
16. The server shall close a control socket that sends a frame over 1 MiB with code `1009`, and close a control socket that sends more than 200 messages within one window, counted like `../player-server/websocket-protocol.md` requirement 13, with code `1008`. Media never travels on this channel (`assets.md`).

### Screens

17. When a viewer connects, disconnects, or sends `client-info`, the server shall send `screens {clients}` to every control socket, where `clients` lists each viewer's `{width, height, devicePixelRatio, channel}`.

## Broadcast / IPC

| Message type | Direction | Payload | When |
|--------------|-----------|---------|------|
| `control-hello` | server → controller | `{ protocol: number, version: string, viewToken: string, role: "active" \| "readonly", holder: { deviceId, name } \| null, hydrus: boolean, cache: Record<string, string>, clients: ClientInfo[] }` — `cache` maps message type to the serialised cached message | Right after a successful handshake |
| `control-role` | server → controller | `{ role: "active" \| "readonly", holder: { deviceId, name } }` | The lease changes hands |
| `control-claim` | controller → server | `{}` | The DM confirms Take control |
| `relay` | controller → server | `{ message: { type, payload } }` — a player- or map-channel message with media URLs already rewritten to `/assets/` | Every DM-side broadcast while active |
| `mirror` | server → controller | `{ message: { type, payload } }` | After every processed relay, to read-only sockets |
| `screens` | server → controller | `{ clients: ClientInfo[] }` | A viewer connects, disconnects or reports `client-info` |
| `control-error` | server → controller | `{ code: "not-active" \| "bad-message" }` | A relay is refused |

## Tests covering this

- `test/conformance/control.conformance.ts` — over real sockets against the server binary: handshake rejections (token, view token, device id, name, protocol `4001` with its reason, fifth socket `1013`, Origin), the hello contents, lease assignment, same-device reclaim after reconnect, claim hand-over, multi-socket holder, relay to viewers and mirror, read-only refusal, bad messages, cache hand-off, rate limit, oversized frame `1009`, screens push, the map-data API, persistence across a restart

## Non-goals

- Voluntary release of the lease. Another device takes it over with confirmation; a lease never expires on its own.
- Partial leases (for example a second device controlling only AoEs or visions).
- Acknowledgements for relays. Like broadcasts, relays are fire-and-forget; `control-error` is the only answer.
