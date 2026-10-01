# Threat model — the player-screen server

DM Screen runs an HTTP + WebSocket server inside Obsidian and binds it to `0.0.0.0` so that phones, tablets and TVs on the same network can render what the DM pushes. That is the feature, not an accident. This document states what the server exposes, who can reach it, what the access token protects, and what it deliberately does not.

## What the server exposes

| Route | Content | Authenticated |
|---|---|---|
| `GET /`, `/index.html` | Player screen HTML (CSS and JS inlined at build time) | yes |
| `GET /player.js`, `/player.css` | Player bundle | yes |
| `GET /map` | Map screen HTML, rendered at physical 1-inch-per-square scale | yes |
| `GET /map.js`, `/map.css` | Map bundle | yes |
| `GET /vault/<path>` | A vault file, **only** while it is on the display allowlist | yes |
| `GET /health` | `{"status":"ok","clients":N}` | **no** |
| `WS /` | Player channel: every non-`map-` broadcast | yes |
| `WS /map` | Map channel: every `map-` broadcast | yes |

`/health` is intentionally open. It carries a status string and a connected-client count, nothing else, and the DM panel polls it — keeping it open means the panel still reports the truth immediately after the token is regenerated.

The `/vault/` route is not a file server. `VaultServeAllowlist` admits only paths the DM has actually pushed (the current background, the current map, and the data/fog URLs of the live image layers), rejects `..` and absolute paths before any disk access, and returns 404 for everything else. A vault file that has never been broadcast cannot be read through it, including `.obsidian/plugins/dm-screen/data.json`.

## Trust boundary

Anyone who can route packets to the Obsidian host's LAN address can reach the listener. In the intended deployment that is a home or game-table network: the DM's laptop, the players' phones, a TV. The boundary is the network, so every inbound byte — HTTP request, WebSocket frame, payload field — is untrusted input and is validated at the edge.

## What the access token protects

A 128-bit token, minted on first load and persisted in plugin settings, is required on every route except `/health`. It arrives as `?k=<token>` on the join link and is then parked in a `SameSite=Strict` cookie so a reload or a navigation that drops the query still authenticates. The DM panel's join links and Copy buttons already carry it; the visible link text does not, so a screenshot of the panel does not leak it.

It closes these:

- **Casual and automated LAN access.** Another device on the network cannot open the player screen, watch the DM's broadcasts, or enumerate which vault assets are currently on display.
- **Vault asset retrieval.** `/vault/` checks the token before the allowlist and before any disk read, so an unauthenticated request never touches the vault at all.
- **Cross-origin WebSocket hijacking.** WebSockets are exempt from CORS, so a page on any origin a player visits could otherwise open a socket to the server from inside their browser. The handshake is rejected when `Origin` is present and its host differs from the request `Host`. A handshake with no `Origin` (non-browser clients, including the e2e suite) is accepted only with a valid token.
- **Token brute-forcing by timing.** Comparison is length-independent, so response latency does not reveal a matching prefix.

Resource limits bound what an authenticated client can cost:

- WebSocket frames are capped at 64 KiB (`maxPayload`).
- A client sending more than 20 messages per second is closed with code `1008`.
- Concurrent clients are capped by the `maxClients` setting (default 10).
- A `/vault/` asset over 512 MiB is refused with `413` rather than buffered.

Regenerating the token in settings disconnects every connected screen with code `1008`; they rejoin with the new link.

## What it does not protect

**Traffic is plaintext HTTP.** Anyone able to passively capture packets on the LAN segment — an attacker already on the Wi-Fi, a compromised router — can read the token out of a request and then everything the DM pushes. The token is an access control, not a confidentiality guarantee.

**TLS was considered and rejected.** No certificate authority issues certificates for `192.168.1.x`, and a self-signed certificate replaces a one-tap join with a full-page browser security interstitial on every tablet and TV, every session, on devices whose trust stores are often not user-editable. That cost is paid every session to defend against an attacker who is already inside the network perimeter. The trade was made in favour of the feature working; if your network is not trusted, do not run the server on it.

**A malicious player device is in scope for the DM's own content only.** A client that holds the token sees what the DM broadcasts. There is no per-client authorisation — the player and map channels are broadcast channels by design.

## Untrusted-input rules the code follows

These exist because the boundary is the network, and they are enforced in the specs under `.agent/features/`:

- Payload URLs bound for a DOM sink in the player bundle pass `safePlayerUrl()` (`src/player/safeUrl.ts`), which admits only `/vault/...` paths and `data:image/...` / `data:video/...` with an allowlisted MIME family.
- Neither browser bundle builds DOM from markup strings; the statblock renderer and the map chrome construct nodes and text nodes instead.
- Outbound requests (webhooks, Hydrus, D&D Beyond images) pass `assertOutboundUrl()` (`src/net/urlPolicy.ts`): `http`/`https` only, no embedded credentials, and plaintext only to a loopback/RFC1918/`.local` host. Credentials are bound to their configured destination — the Hydrus API key is attached only when the request origin matches `hydrusApiUrl`.
- Debug logging passes URLs through `redactUrl()` and secrets through `redactSecret()`, and never logs a response body.

## Dependency advisories

The shipped plugin has two runtime dependencies, `fflate` and `ws`. `npm audit --omit=dev` reports **0 vulnerabilities**, so nothing advisory-flagged reaches a user's vault. Run `make deps-audit` to check both the runtime-only and the dev-inclusive picture.

One dev-only advisory is knowingly accepted because **no patched version exists**:

- **`extract-zip` (high, GHSA-jmr9-qjv8-65gv and GHSA-7pqw-9j4j-h8q3):** arbitrary file write through symlink entries in an extracted archive. It arrives as a transitive dependency of `@puppeteer/browsers`, which WebdriverIO uses to download and unpack Chrome/chromedriver for the e2e suite. Every advisory npm still reports chains back to this one package. The upstream has published no fix, and the reachable path is "extract an attacker-controlled zip" — here the only archives extracted are browser and Obsidian builds fetched from their official endpoints, on a developer machine or a CI runner, never in the published plugin. It is tracked rather than suppressed: re-check with `make deps-audit` when bumping `webdriverio` or `wdio-obsidian-service`.

Everything else flagged at the time of the security review was cleared by pinning patched versions through `overrides` in `package.json` (`js-yaml`, `ip-address`, `nanoid`, `deepmerge-ts`, `diff`, `serialize-javascript`, `moment`) and by bumping `vitest` / `@vitest/coverage-v8` to `^4.1.11`. `brace-expansion` is deliberately not overridden: each `minimatch` major needs its own `brace-expansion` major (`minimatch` 10 imports the `expand` export that only `brace-expansion` 5 provides), so a tree-wide pin breaks the e2e runner, and the copies the lockfile resolves per range are all patched.
