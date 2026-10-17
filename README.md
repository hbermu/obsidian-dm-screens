# DM Screen

> Player screen and battle screen for in-person D&D 5e sessions, powered by Obsidian.

![Player screen mid-session](docs/screenshots/player-screen-hero.png)

DM Screen turns Obsidian into a local control center for tabletop play: it serves a live player screen to any browser on your network — TV, tablet, second monitor — and pushes what your party should see while you keep your notes on the DM side.

Built for in-person 5e games where the DM wants a clean visual layer for the players (maps, portraits, video backgrounds, an initiative tracker) without leaving Obsidian.

![The DM pushes a background and an image layer from the active note; the player screen follows live](docs/screenshots/live-push.gif)

*Left: the DM Control Panel inside Obsidian. Right: the player screen on the TV. Images are added hidden and revealed with the eye toggle when the party should see them.*

<p align="center"><img src="docs/screenshots/dm-control-panel.png" alt="DM Control Panel" width="360"></p>

## Features

- **Player screen on any device** — HTTP + WebSocket server. Open the URL on a TV, tablet, or second monitor; auto-reconnect handles bumps.
- **Image layers with per-layer fog of war** — stack maps and portraits, fog each layer independently, reveal as combat unfolds.
- **Background image or video** — full-screen scene from the active note, the Hydrus library, or a video loop.
- **Initiative tracker** — manual, synced from the Initiative Tracker plugin, or live from a D&D Beyond encounter.
- **Statblock display** — inline 5e statblocks via Fantasy Statblocks.
- **Multi-screen aware** — multiple connected players with per-client resolution detection.
- **Token-gated screens** — every screen joins with a link that carries an access token, so a neighbour on the same Wi-Fi cannot open your player screen or read vault files. Regenerate it from settings to kick every connected device.
- **Map screen for TV tables** — a dedicated `/map` endpoint renders one battlemap (image or animated video) at true 1-inch-per-square physical scale for miniatures on a horizontal TV: per-screen calibration with a ruler test pattern, DM-side panning, fit/physical toggle, and an optional grid overlay for gridless maps.
- **Battlemap fog of war** — paint a persistent fog mask over any map with brush / rectangle / grid-cell / whole-room tools; it is saved per map (note images and Hydrus files alike) and re-applied whenever you push the same map again.
- **Dynamic vision & line of sight** — drop feathered vision shapes measured in feet, define walls and doors, and the fog carves out exactly what a token can see; opening a door lets sight spill through.
- **Import walls automatically** — load line-of-sight and doors from a UVTT file (`.dd2vtt` / `.uvtt`) or a Foundry VTT module `.zip` (Czepeku and friends), so you skip drawing walls by hand.
- **Spell AoE overlays** — drop circle / square / cone / line / ring templates (or search the 5e spell catalog) at true grid scale, drag to place, rotate to aim.
- **Exploration Mode** — a near-fullscreen table-play surface: click doors to open/close them and rooms to reveal/hide their fog, drag the players' viewport, and bind a vision to follow the view for a moving "torchlight" as the party explores.
- **Send layer to webhook** — right-click an image layer to POST it to Telegram, Discord, or any `multipart/form-data` endpoint with an editable caption.

![Fog of war on the DM preview](docs/screenshots/fog-of-war.png)

*Player-screen fog of war is drawn per image layer with reveal / fog circle, rectangle, and freehand tools. The map screen has its own, richer fog system — see [Battlemap fog of war, walls, and vision](#battlemap-fog-of-war-walls-and-vision).*

## Quickstart

1. Install and enable the plugin (see [Installation](#installation)).
2. Open the **DM Control Panel** from the ribbon icon or the Command Palette ("Open DM Control Panel").
3. Click **Start Server**. The panel shows a LAN URL — use its **Copy** button and open the link on the device your players will look at. The link carries an access token, so type it from the Copy button rather than from memory; the device remembers it afterwards, so a reload just works.
4. Use **Add Image** to push images from the active note, **Add BG** to set a background, or **Media from Hydrus** to browse your Hydrus library.
5. In the COMBAT section, pick a source (Manual, Initiative Tracker plugin, or D&D Beyond) and start the encounter.

## Map screen (TV tables)

A second endpoint dedicated to battlemaps for in-person play with miniatures on a horizontal TV. It is fully independent from the player screen: clearing one never touches the other, and both can run at the same time on different devices.

**Setup**

1. With the server running, open the `/map` link on the table TV — the MAP SCREEN section in the DM panel has it, with a **Copy** button so you get the access token with it. Use the on-screen button to go fullscreen.
2. The TV appears as a resolution badge in the panel. Click it and enter the screen's physical **diagonal in inches**; toggle the **test pattern** (a 6-inch ruler and a 1-inch square rendered on the TV) and fine-tune until a real ruler agrees. The calibration is stored per resolution and reused forever.

   ![Calibration modal and the test pattern on the TV](docs/screenshots/map-calibration.png)
3. Click **Add Map** — same sources as the background: images embedded in the active note and `hydrus://` references (images or videos, so animated maps just work). The Hydrus explorer also has a **Set as map** action.

**At the table**

- **Scale toggle** — *fit screen* shows the whole map (exploration); *physical 1″* renders every grid square as exactly one real inch, so miniatures sit true to RAW scale.
- **Pan** — in physical mode most maps overflow the TV; drag the green rectangle on the panel's preview (or click anywhere in it) to choose the visible window.
- **Rotate** — 90° steps. In fit mode a portrait map turned sideways uses the whole landscape TV.
- **Grid overlay** — for gridless map variants: a lattice drawn over the map, aligned to its cells. `px/square` is how many map pixels one square spans (Czepeku full-resolution exports are 140; the default for new maps is configurable in settings). `offset X/Y` shift the lattice's phase in map pixels for maps whose grid doesn't start at the image corner. Line color and opacity are adjustable.
- Everything — scale mode, pan, rotation, grid — is remembered **per map** and restored when you push the same map again.

If the TV isn't calibrated yet, physical mode falls back to 96 px/inch and both the TV and the panel show a warning until you calibrate.

### Battlemap fog of war, walls, and vision

![Map fog editor](docs/screenshots/map-fog-editor.png)

*The Fog editor: reveal / cover with brush, rectangle, grid-cell, and whole-room tools, plus a Walls tab for line of sight.*

While a map is active, the MAP SCREEN section gains a **Fog** button (it reads `Fog ●` once a map has fog). It opens a dedicated editor with two tabs:

- **Fog tab** — a single mask over the map: black hides, transparent reveals. Paint with a sized **brush**, a **rectangle** marquee, a snapped **grid cell** or **grid rectangle**, or the **Room** tool (one click floods a whole walled room). Reveal and Cover are the two modes; **Reveal All** / **Cover All** reset the whole map. The mask is saved as a sidecar next to nothing you have to manage — it lives in `.dm-screen/fog/`, keyed to the map, and comes back whenever you show that map again (note images and Hydrus-cached files alike). TV opacity of the fog layer is adjustable in settings.
- **Walls tab** — draw line-of-sight **walls** and **doors** (chained clicks or a rectangle drag), toggle a door open/closed, or erase. Walls power dynamic vision and the Room flood.

![Dynamic vision on the panel and the TV](docs/screenshots/map-vision.png)

*A torch (bright + dim ring) and a darkvision on the panel's preview; on the TV, walls cut the line of sight and only what the lights reach is revealed.*

**Dynamic vision** lives in its own panel section: add a **Circle** or **Square** vision (range in feet, with a soft feather), drag it onto a token, and the fog carves out exactly what it can see. Each vision has a **bright** radius plus an optional **dim** ring that stays half-shrouded, and **Lights…** pre-fills both from the 5e catalog (torch 20/+20 ft, lantern, *light*, *daylight*, darkvision 60/120 ft …). Give a vision a name and a marker colour to tell the party's torches apart, and flip the 🔗 group toggle to drag them all together as the party moves. Where walls block the line of sight the reveal stops at the wall; an **open door** lets vision spill through while a closed one blocks it. **Bake into fog** burns the current vision permanently into the mask (for "we've explored this" areas) and clears the live layer.

**Importing walls** — drawing walls by hand is optional. On the Walls tab:

![Importing a Foundry module zip fills in every wall and door](docs/screenshots/walls-import.gif)

- **Import UVTT** — load a `.dd2vtt` / `.uvtt` / `.df2vtt` export (Dungeondraft and most VTT map packs). Walls, objects, and portals become walls and doors, and the map's grid size is set automatically.
- **Import Foundry** — load a Foundry VTT module `.zip` (the format Czepeku and other creators ship). The scene's walls and doors are extracted and scaled to your map. Both old (NeDB) and new (LevelDB) Foundry module layouts are supported. When a module holds several rooms or variants, the scene matching your map's shape is picked for you, and a picker asks when more than one could fit.
- **Straight from Hydrus** — set a Hydrus image as the map and, if your library holds a Foundry module zip tagged `type:foundry module` with the same `name:` tag, the plugin offers to import its walls. It reads only the module's few-MB scene data out of the zip, never the hundreds of MB of artwork around it.

### Spell AoE overlays

![Searching Fireball and Burning Hands, placing them and aiming the cone](docs/screenshots/aoe.gif)

*Templates render at true grid scale (1 square = 5 ft) on both the DM's view and the TV (bottom-left inset). Shown here from Exploration Mode's AoEs window; the panel section works the same way.*

The **AoE Overlays** section drops spell templates onto the map: **Circle**, **Square**, **Cone**, **Line**, and **Ring** presets, or a **Spells…** search over the 5e catalog that pre-fills the shape, size, and color for a chosen spell. Set size (and width, for lines and rings), color, opacity, and rotation per template; drag the anchor dot on the preview to place it and the diamond handle to aim it. AoEs are ephemeral combat state — they clear when you stop the map.

### Exploration Mode

![Exploration Mode: opening doors, revealing rooms and moving the players' view](docs/screenshots/explore.gif)

*Opening the hall door lets the torchlight spill in, a click reveals each room, and in physical scale the green rectangle is what the table TV (bottom-left inset) shows.*

The **Explore** button, next to the Map Screen title (so it works even with the section collapsed), opens a near-fullscreen surface built for running the session, not editing it:

- **Click a door** to open or close it — green means open, grey means closed. The players' TV recomputes line of sight instantly.
- **Click a room** to reveal or hide its fog in one gesture; a green hover highlight shows which room you're about to toggle. Doors always bound a room here, so an open door lights up without merging rooms.
- **Move the players' view** — in physical mode, drag the viewport rectangle to pan what the table sees. A **lock** button freezes it so you can't nudge it by accident; hold **Shift** to momentarily click straight through to doors and rooms without moving anything.
- **Bind a vision to the view** — flip the ⦿ toggle on a vision and it stays where you put it relative to the players' viewport: pan the view and the lit circle/square moves by the same amount, a moving pool of light that makes exploration feel alive.
- **Scale** and **Grid** toggles in the top bar switch the TV between *fit screen* and *physical 1″* and show or hide the grid, which is drawn over the map here too.
- Floating **AoEs**, **Vision** and **Combat** windows carry the full controls, so you can add, tweak, and place templates or run initiative (local, Initiative Tracker or D&D Beyond) without leaving the modal; drag them by the header out of the way or minimize them, and they remember where you left them.

![Exploration Mode with the Combat, AoEs and Vision windows](docs/screenshots/map-explore-mode.png)

Everything here reuses the same fog, walls, and vision the editor produced — Exploration Mode is where you *drive* them at the table.

## Installation

### BRAT (recommended)

DM Screen is not yet listed in the Obsidian Community Plugins gallery. The easiest install path is [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install BRAT from Community Plugins.
2. Add this repository: `hbermu/obsidian-dm-screens`.
3. BRAT keeps you on the latest release automatically.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/hbermu/obsidian-dm-screens/releases) and drop them into `.obsidian/plugins/dm-screen/`.

## Integrations

### Hydrus Network

![Hydrus explorer modal](docs/screenshots/hydrus-explorer.png)

Browse a self-hosted [Hydrus](https://hydrusnetwork.github.io/hydrus/) media library by tags and push files to the player screen.

- Click **Media from Hydrus** in the DM Control Panel to open the explorer.
- Left-click a tile to open a full-resolution preview with action buttons (add as image layer, set as background, set as map, copy tags, copy reference).

  ![Hydrus preview with its tags and actions](docs/screenshots/hydrus-preview.png)

- Right-click a tile — or use its ⋮ button — for the same actions as a context menu, plus cache management (download / delete local copy).
- Videos can be used as a background or map, not as an image layer.
- Downloaded media is cached locally; the cache folder, retention, and tag filters are all configurable in settings.
- No Hydrus yet? [hydrus/README.md](hydrus/README.md) runs it with Docker Compose, API key included, and has a script that tags your maps from their folder layout (including the tags the Foundry wall import looks for).

### D&D Beyond

![D&D Beyond encounter sync](docs/screenshots/dndbeyond-encounter.png)

Sync live encounters from your [D&D Beyond](https://www.dndbeyond.com) account so the player screen reflects the real-time state of combat.

To set it up:

1. Enable D&D Beyond integration in settings.
2. Log in to [dndbeyond.com](https://www.dndbeyond.com) in your browser and copy your `CobaltSession` cookie (DevTools → Application → Cookies → dndbeyond.com).
3. Paste it into the settings field and click **Test connection**.
4. In the DM Control Panel's COMBAT section, switch to the **D&D Beyond** tab and pick an encounter. Initiative, HP, and monster avatars start streaming to the player screen automatically.

### Webhook share (Telegram, Discord, …)

Right-click any image layer in the DM Control Panel → **Send to image webhook…** → pick a target, edit the caption (defaults to the layer's label), hit Send. Anything that accepts a `multipart/form-data` upload works:

<p align="center"><img src="docs/screenshots/webhook-send.png" alt="Send image to a webhook target" width="480"></p>


- **[Telegram](https://core.telegram.org/bots/api#sendphoto) bot** — `sendPhoto` against a chat your bot is in, with the caption riding along.
- **[Discord](https://discord.com/developers/docs/resources/webhook#execute-webhook) webhook** — drops the image into a channel; the caption becomes the message body.
- **Generic** — anything else; you spell out the image field name, caption field name, and any extra static form fields (tokens, IDs, etc.).

To set it up:

1. Open **Settings → DM Screen → Webhooks**.
2. Click **Load template ▾** and pick **Telegram bot**, **Discord webhook**, or **Generic multipart** to drop in starter values.
3. Replace the placeholders in the URL (`<TOKEN>`, `<CHAT_ID>`, `<ID>`) with the real credentials from your bot or channel. URL fields render in plain text so you can copy them out to an external editor when fiddling with long bot URLs.
4. Right-click an image layer → **Send to image webhook…**, confirm, send.

Fog of war is never composited onto the outbound image — what the layer originally is, is what gets sent.

## Configuration

Open **Settings → DM Screen**. The tab is split into five sections — Server, Hydrus Library, D&D Beyond, Webhooks, and Advanced — each with inline descriptions for every option. Most defaults are fine for a first run; you only need to revisit settings when you plug in Hydrus, D&D Beyond, or a webhook target.

## Compatible plugins

DM Screen integrates with two community plugins when they are installed and enabled:

- [Initiative Tracker](https://github.com/javalent/initiative-tracker) — auto-syncs combatants, HP, statuses, and rounds.
- [Fantasy Statblocks](https://github.com/javalent/fantasy-statblocks) — inline 5e statblock display in the DM combat panel.

## Network usage & privacy

DM Screen is a **desktop-only** plugin that starts a local HTTP + WebSocket server on your machine:

- **Player screen server** — listens on a configurable port (default `3000`) on all network interfaces (`0.0.0.0`) so any device in the room can reach it. Every route except `/health` requires the plugin's access token, which the join links in the DM panel already carry, so another device on the network cannot watch your screen or pull vault files. Traffic is plaintext HTTP: the token is an access control, not encryption, and the server is meant for a network you trust. See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) for the full picture, including why TLS is not shipped.
- **Hydrus Network** (optional) — connects to your self-hosted Hydrus Client API (`http://localhost:45869` by default) to search and download images. No data leaves your LAN.
- **D&D Beyond** (optional) — polls the D&D Beyond encounter API to sync combatants and HP. Requires a session cookie you provide; no credentials are stored beyond what you paste into settings.
- **Webhooks** (optional) — POSTs image layers to endpoints you configure (Telegram, Discord, custom). Only triggered explicitly by the user via the "Send to webhook" action.

The plugin does not collect telemetry, phone home, or transmit any data to third parties without explicit user action. All cached files (Hydrus images, D&D Beyond avatars) are stored locally inside your vault.

## Support & contributing

- Found a bug or want to request a feature? [Open an issue](https://github.com/hbermu/obsidian-dm-screens/issues).
- Contributing? Start with [AGENTS.md](AGENTS.md) for build, test, branch, and release conventions.

## Credits & attribution

The battlemap in the map-screen screenshots and GIFs (*Adventurers' Guildhall*, walls imported from its Foundry module) and the scene art in the Hydrus screenshots are by **[Czepeku](https://www.czepeku.com/)**. They make beautiful maps, a lot of them, and if you run games in person or online their packs are worth every penny.

- 🌐 Website & shop: [czepeku.com](https://www.czepeku.com/)
- ❤️ Patreon: [patreon.com/czepeku](https://www.patreon.com/czepeku)

The map is only here to show off the plugin. It isn't bundled with DM Screen, and all rights to it stay with Czepeku. The plugin ships no map assets of its own.

## License

[MIT](LICENSE)
