# Screenshots

Visual assets used by the project [README](../../README.md).

Conventions:

- PNG for stills, GIF for short demos; kebab-case filenames.
- Crop to the relevant UI region — full-window screenshots only when the surrounding context matters.
- 16:9 for hero / wide shots; native aspect for cropped UI shots.
- Keep stills under ~500 KB (the hero is the exception, being full-bleed artwork); downscale to roughly 1600 px wide max and quantize to a 256-colour palette.
- Keep GIFs under ~3 MB and ~15 s; when a demo involves a screen the players see, show it beside or inset into the DM's view so cause and effect are both visible.
- Never capture secrets: webhook URLs (they carry bot tokens), the D&D Beyond cookie, the Hydrus API key, or a join link's access token.

## Current assets

Stills:

- `player-screen-hero.png` — player screen mid-session (hero).
- `dm-control-panel.png` — the DM Control Panel, full height.
- `fog-of-war.png` — per-layer fog on the DM preview (player screen), with the fog drawing tools.
- `hydrus-explorer.png` — the Hydrus explorer modal.
- `hydrus-preview.png` — a Hydrus tile's full-resolution preview with its tags and action buttons.
- `dndbeyond-encounter.png` — D&D Beyond encounter sync: the COMBAT section beside the tracker on the player screen.
- `map-calibration.png` — the calibration modal beside the TV's test pattern.
- `map-fog-editor.png` — the Fog modal over a map, showing the Fog / Walls tabs and a partially revealed mask.
- `map-vision.png` — vision rows and markers on the panel beside the line-of-sight reveal on the TV.
- `map-explore-mode.png` — the near-fullscreen Exploration modal with door markers, AoEs and the Combat / AoEs / Vision windows.
- `webhook-send.png` — the Send image modal for a webhook target.

GIFs:

- `live-push.gif` — the DM pushes a background and an image layer; the player screen follows.
- `walls-import.gif` — importing a Foundry module zip on the Walls tab.
- `aoe.gif` — searching spell AoEs, placing a Fireball and aiming Burning Hands, with the TV inset.
- `explore.gif` — Exploration Mode: opening doors, revealing rooms, switching to physical scale and dragging the players' view, with the TV inset.
