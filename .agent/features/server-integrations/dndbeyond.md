# D&D Beyond Through the Server

> The server holds the D&D Beyond session cookie, refreshes the short-lived token from it, and runs the encounter poller. A controller asks it to track an encounter and receives the polled state over the control channel; the plugin still decides what the players see, so the server never computes a broadcast.

## Source files

- `server/src/integrations/ddb.rs` — cookie to token refresh, the named operations, the poll loop with its gap and circuit breaker, `ddb-state` pushes
- `src/integrations/remote.ts` — `RemoteGateway.ddb()`: the same surfaces over the routes below, plus the control-channel subscription
- `src/integrations/local.ts` — `LocalDdb`: today's `DdbClient` and `DdbEncounterPoller`
- `src/dndbeyond/client.ts`, `src/dndbeyond/poller.ts` — unchanged; the local gateway's implementation
- `src/views/DnDBeyondPanel.ts` — the caller, now through `plugin.gateway.ddb()`
- `src/dndbeyond/imageCache.ts` — embedded mode only; in remote mode avatars are assets

## Settings used

- `DM_SCREEN_DDB_COBALT` (or `DM_SCREEN_DDB_COBALT_FILE`) — server-side, see `overview.md` requirement 6
- `ddbInspirationPulse` — a preference, from the server in remote mode

## Requirements

1. The server shall expose, each requiring the control token: `GET /api/ddb/validate`, `GET /api/ddb/encounters`, `GET /api/ddb/encounters/<id>`, `POST /api/ddb/characters` (`{ids}`), `POST /api/ddb/monster-images` (`{ids}`), and `POST /api/ddb/track` (`{encounterId}` or `{encounterId: null}`).
2. The server shall exchange the session cookie for a short-lived token and refresh it when it expires or a call answers `401`, as the plugin's client does, and shall never return either value.
3. `<id>` and every id in a body shall be validated before any upstream call: an encounter id of at most 64 characters from `[A-Za-z0-9-]`, and at most 128 numeric ids.
4. `POST /api/ddb/monster-images` shall fetch each avatar, store it in the asset store and answer `{ [monsterId]: "/assets/<sha256>.<ext>" }`, so the device never fetches a D&D Beyond URL and the avatars become ordinary assets.
5. If D&D Beyond is not configured, then every route of requirement 1 shall answer `501`; an upstream failure shall answer `502` per `overview.md` requirement 16.

### Polling

6. `POST /api/ddb/track` with an encounter id shall start a single poll loop for it, replacing any loop already running; with `null` it shall stop the loop. Only an `active` controller may call it (`overview.md` requirement 18).
7. The loop shall keep the plugin's cadence — a randomised pause between polls and a circuit breaker that pauses after consecutive failures — so the server is no heavier on D&D Beyond than the plugin was.
8. After each successful poll the server shall send `ddb-state` to every control socket with the encounter and the characters it resolved, and shall remember the last one so a controller that connects mid-combat receives it immediately after `control-hello`.
9. After a failed poll the server shall send `ddb-state` with an `error` field naming the failure, so the panel can show that tracking is unhealthy.
10. The loop shall stop when the last control socket disconnects, so a forgotten encounter is not polled forever.
11. The plugin shall turn `ddb-state` into initiative broadcasts exactly as it turns a local poll result into them today — round-1 reveal, renames, conditions and exhaustion all stay on the DM side — and only while it holds the lease.
12. The panel shall start and stop tracking with one call, `track(encounterId, onState)` and `track(null, …)`, which the embedded gateway serves with its own poller and the remote one by asking the server to poll and forwarding what it pushes. `track(encounterId)` replaces whatever was being tracked, so switching encounters is one call and never a stop followed by a start.
12a. The remote gateway shall issue its track requests one at a time, each waiting for the previous one to answer. Tracking is a single slot on the server, so a stop that overtook the start made after it would leave the server tracking nothing and the encounter would arrive with no combatants.
12b. The server relays D&D Beyond's bodies as they came — the encounter wrapped in `data`, one character body per player id — so the remote gateway shall map a pushed state through the same parsing a local poll uses (`src/dndbeyond/parse.ts`: `unwrapData`, `parseEncounter`, `parseCharacter`), and shall map the encounter it fetches the same way. A raw body reaching the panel shows an encounter with no name, no round and no combatants. A state carrying an `error` is passed through as `{ encounter: null, characters: {}, error }`.
13. In remote mode a monster avatar shall arrive as the asset URL the server stored (`requirement 4`), and the panel shall turn it into a layer the same way it turns a locally cached avatar into one.

## Broadcast / IPC

| Message type | Direction | Payload | When |
|--------------|-----------|---------|------|
| `ddb-state` | server → controller | `{ encounter: DdbEncounter, characters: Record<string, DdbCharacterSummary>, error?: string }` | After each poll (requirements 8–9), and once to a controller that connects while a loop runs |

## Tests covering this

- `server/tests/ddb.rs` — against a stub D&D Beyond: the token refresh and its retry on `401`, id validation, avatars stored as assets, `501` unconfigured, `502` upstream, the loop's start, replace and stop, `ddb-state` after a poll and after a failure, the last state replayed to a new socket, the loop stopping with the last socket
- `src/__tests__/gateway-remote.test.ts` — the remote `DdbApi` routes and the `ddb-state` subscription; a track request is held until the one before it has answered (requirement 12a); a pushed state replayed from the real `encounter-kokoro.json` fixture arrives with its name, round and monsters, a poll error passes through, and a fetched encounter is parsed too (requirement 12b)
- `src/__tests__/ddb-panel-tracking-state.test.ts` — tracking state through `track`, the panel mapping a poll result, no broadcast without the lease, and switching encounters asking only for the new one (requirement 12)

## Non-goals

- The server computing what the players see. It polls and relays; the panel maps (requirement 11). The session therefore still needs a connected controller to drive the player screen.
- Writing to D&D Beyond. Every operation is a read.
- More than one tracked encounter at a time.
