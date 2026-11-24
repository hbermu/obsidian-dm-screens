# Server-Side Integrations

> In remote mode the upstream services — Hydrus, D&D Beyond and the webhook targets — are reached through the server instead of from the device. Their credentials live only in the server's environment and are never sent back over the API, so a controller needs nothing but the control token: a tablet, a phone, or someone else's laptop can run the table without holding a single secret. Embedded mode is unchanged and keeps using the per-device settings.

## Source files

- `src/integrations/gateway.ts` — `IntegrationGateway`: `hydrus()`, `ddb()`, `webhooks()`, `capabilities()`; the seam every caller uses
- `src/integrations/local.ts` — `LocalGateway`: builds `HydrusClient` and `DdbClient` from settings and posts webhooks directly, as the plugin does today
- `src/integrations/remote.ts` — `RemoteGateway`: the same surfaces over the server's `/api/` routes
- `src/integrations/prefs.ts` — `SessionPreferences`: the preference document, read from settings in embedded mode and from the server in remote mode
- `src/transport/transport.ts` — `publishMedia(url)`: makes a DM-side URL reachable by the server (unchanged in embedded mode), which is how a layer reaches a webhook
- `src/main.ts` — builds the gateway alongside the transport, exposes `plugin.gateway`
- `src/settings.ts` — the settings tab renders credentials only in embedded mode and binds the preferences to the active gateway
- `server/src/integrations/mod.rs` — shared outbound client, route allowlists, error mapping
- `server/src/integrations/hydrus.rs`, `ddb.rs`, `webhooks.rs` — one module per upstream (see the sibling specs)
- `server/src/config.rs` — secrets from the environment or a mounted file
- `server/src/prefs.rs` — the preference document and its `/api/prefs` routes

## Settings used

- `hydrusEnabled`, `hydrusApiUrl`, `hydrusApiKey`, `ddbEnabled`, `ddbCobaltSession`, `webhooks` — embedded mode only; in remote mode the server's own configuration replaces them and the fields are not shown
- `hydrusTagServices`, `hydrusIgnoredTagPatterns`, `hydrusDefaultSearchTags`, `hydrusDefaultLoop`, `hydrusDefaultMuted`, `mapDefaultPxPerSquare`, `mapFogTvOpacity`, `ddbInspirationPulse` — the preferences; the same values live in the server's preference document in remote mode
- `cacheBaseFolder`, `hydrusCacheTtlDays` — embedded mode only: in remote mode the server holds the files and its own retention applies

## Requirements

### The gateway

1. Every call to Hydrus, D&D Beyond or a webhook shall go through `plugin.gateway`, never through a client the caller builds itself, so the two modes differ in transport alone.
2. In embedded mode the gateway shall be a `LocalGateway` built from the settings above, behaving exactly as the plugin did before this feature.
3. In remote mode (including always on mobile, `../remote-server/overview.md` requirement 3) the gateway shall be a `RemoteGateway` that carries the control token and reaches the server's `/api/` routes.
4. `capabilities()` shall report what the active gateway can do: `hydrus` and `ddb` as booleans and `webhooks` as the list of target names. In embedded mode it shall be derived from the settings; in remote mode from the `integrations` block of `control-hello`.
5. While a capability is false, the UI that uses it shall be hidden or disabled rather than failing on use: no Hydrus bar without `hydrus`, no D&D Beyond tab without `ddb`, and no target list in the send modal without one. The UI shall read `capabilities()`, never the settings, so in remote mode a device whose own `data.json` still carries Hydrus credentials is offered nothing the server does not provide.

### Secrets

6. The server shall read each secret from an environment variable or, when the variable's name is suffixed `_FILE`, from the file it names, so a mounted secret can be rotated without editing the deployment. Setting both forms of one secret shall be a startup error.
7. The server shall never include a credential in any response, in `control-hello`, or in a log line. A controller shall learn only that an integration is configured and, for webhooks, the target names.
8. The plugin shall not write the server's credentials or preferences into `data.json`, so a synced vault never carries them.
9. Each upstream base URL configured on the server shall pass the outbound URL policy of `server/src/config.rs` at startup, and the server shall refuse to start when one does not.

### Preferences

10. The server shall keep a preference document with the keys of the Settings-used preference list, persisted like the map-data store (`../remote-server/server.md` requirements 11–12), and shall send it in `control-hello`.
11. `GET /api/prefs` shall return the document and `PUT /api/prefs/<key>` shall set one key, both requiring the control token; an unknown key shall answer `404` and a value of the wrong shape `400`.
12. When the DM changes a preference in remote mode, the plugin shall write it through requirement 11 and apply it immediately, without a restart of the server.
13. When a preference changes, the server shall send `prefs` to every control socket, so a second device sees the change.
14. A preference the server has never been given shall take the same default as the plugin's own setting, so a fresh server behaves like a fresh vault.
14b. The key list in `src/integrations/prefs.ts` and the one in `server/src/prefs.rs` shall hold the same keys, because a key only one side knows is a silent `404` that loses the preference.

### Proxy rules

15. Each `/api/` integration route shall be an explicitly named operation, never a pass-through of an arbitrary upstream path, so the control token cannot be turned into free rein over Hydrus or a D&D Beyond account.
16. An upstream failure shall be reported as a status plus the operation name; the upstream's own body shall not be forwarded, because it can echo the request, and the request carried the credential.
17. Every integration route shall require the control token (`../remote-server/server.md` requirement 17); the view token shall open none of them.
18. While the controller is read-only (`../remote-server/overview.md` requirement 15), the plugin shall not call a route that changes anything upstream — sending a webhook, or tracking an encounter.

### Settings tab

19. While the active gateway is remote, the settings tab shall not render the Hydrus URL and key, the D&D Beyond cookie or the webhook list; in their place it shall state which integrations the server provides and name its webhook targets.
20. While the active gateway is remote, the preference fields shall read and write the server's document (requirement 11); while it is local they shall read and write `data.json` as today.

## Broadcast / IPC

| Message type | Direction | Payload | When |
|--------------|-----------|---------|------|
| `control-hello` | server → controller | gains `integrations: { hydrus: boolean, ddb: boolean, webhooks: string[] }` and `prefs: Record<string, unknown>`; the `hydrus` boolean of `../remote-server/control-channel.md` is replaced by the one inside `integrations` | On connect |
| `prefs` | server → controller | `{ prefs: Record<string, unknown> }` | A preference is written (requirement 13) |
| `ddb-state` | server → controller | see `dndbeyond.md` | The server's poller has a new encounter state |

## Tests covering this

- `src/__tests__/gateway-local.test.ts` — the local gateway reproduces today's calls and reports capabilities from the settings
- `src/__tests__/gateway-remote.test.ts` — the remote gateway's routes, the control token on every call, capabilities from `control-hello`, read-only gating of the mutating routes
- `src/__tests__/session-prefs.test.ts` — preferences read and written in both modes, defaults for an absent key, a `prefs` message applied live
- `src/__tests__/cross-language-parity.test.ts` — the plugin's key list and the server's `KNOWN` table hold the same keys, and the two `PROTOCOL_VERSION` constants agree (requirement 14b)
- `server/tests/config_secrets.rs` — a secret from the environment and from a `_FILE` path, both forms set is an error, no secret in any response or log
- `server/tests/prefs.rs` — the document round trip, unknown key, bad shape, the push to every control socket
- `test/conformance/integrations.conformance.ts` — remote-only: the capability block, `/api/prefs`, and that the view token opens no integration route
- `test/e2e/specs/remote.e2e.ts` — real Obsidian in remote mode: with Hydrus credentials set on the device and none on the server, the Hydrus bar stays hidden and `capabilities()` reports none; the settings tab offers no credential field and keeps only the control token

## Non-goals

- Integrations in embedded mode changing at all. The local gateway is today's behaviour, and the per-device settings stay where they are.
- Editing the server's credentials from the plugin. They are deployment configuration; the plugin only learns whether they exist.
- A generic upstream proxy. Every operation is named and allowlisted (requirement 15).
- Per-controller permissions. Any holder of the control token gets every configured integration.
