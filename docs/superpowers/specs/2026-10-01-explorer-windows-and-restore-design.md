# Explorer Windows, Dim-Light Visions, Image Labels and Restore Fixes — Design

**Date:** 2026-10-01
**Status:** Approved. Delivered in one PR, released as a minor (`release:minor` → 1.3.0).

**Branch:** `feature/explorer-windows-and-restore` · **PR title:** `feat(map-screen): floating explorer windows, dim-light visions, image labels and restore fixes`

## Goal

Four pieces of work ship together:

1. After an Obsidian restart, the DM panel shows a background, layers or map the DM had already cleared, and a restored image that no longer exists breaks every screen silently.
2. Exploration Mode's AoE and vision controls overflow their 280px sidebar and produce a horizontal scrollbar.
3. Exploration Mode gets two floating, draggable, minimizable windows (AoEs and Vision), compact control cards, and rounded corners across the plugin.
4. The DM panel labels the background and the map with a human name, so the DM can tell which image is on screen.

## Root causes

### Cleared state comes back after a restart

The background and the map persist only through `lastBroadcastCache` (`settings.ts`), a copy of the server's `lastState` map. Three defects let stale state survive:

1. `Server.broadcast()` purges cached entries only on `clear` and `map-clear`. `hide-background-media` is stored next to `show-background-media`, so the `show` entry is never removed; `restoreState()` finds it, marks the background active, and `republishToServer()` pushes it again.
2. `DmControlPanel.saveState()` is the only writer of `lastBroadcastCache` and `lastImageLayers`, and only `onClose` and `broadcastImageLayers()` call it. Stop BG, Stop Map, Clear Player Screen, setting a background or a map, and AoE or vision edits never persist. Plugin `onunload` only stops the server.
3. `map-clear` purges every `map-*` entry, including `map-calibration`, which belongs to the TV and not to the map.

### A missing image breaks silently

`HydrusCache.sweep()` runs at plugin load, before views restore, and can delete a cached file. `ensureLocalCopy()` trusts the cache index without checking the file exists. Nothing on restore checks the image either: the DM previews render an `<img>` with no `onerror`, the server answers `404`, and the player and map screens show a broken image instead of the waiting screen.

### The Explore sidebar overflows

`.dm-explore-sidebar` is `width: 280px; overflow-y: auto`, which also computes `overflow-x: auto`. `.dm-map-aoe-row` is a non-wrapping flex row whose fixed-width children (label, shape select, number inputs, color, opacity range, rotation, buttons) add up to roughly 550–600px. The DM panel renders the same rows through `renderAoeSection()` / `renderVisionSection()` and overflows its own scroll container the same way.

## Design

### 1. Restore fixes

- `Server.broadcast()` treats `hide-background-media` as the inverse of `show-background-media`: it deletes the cached `show` entry and caches nothing. Replay then yields the true state for late-joining clients too.
- `map-clear` keeps `map-calibration`.
- The server emits a state-changed event whenever `lastState` changes. `DmControlPanel` subscribes and schedules the existing debounced `saveState()` (1s). Every state-changing action now persists without each call site remembering to save.
- Plugin `onunload` flushes a pending save before stopping the server.
- On restore, each restored background and map image is checked with `adapter.exists`:
  - Missing and Hydrus-sourced (URL under the Hydrus cache folder, hash known): re-download by hash through `HydrusCache`. `ensureLocalCopy()` also checks `adapter.exists` before trusting the index.
  - Still unavailable: drop that background or map from the cache, show a Notice naming the image (`Map "<label>" is no longer available`), and leave the screens on their waiting state.
- The DM background and map previews get an `onerror` placeholder ("Image unavailable") instead of a broken `<img>`.
- `player.ts` and `map.ts` handle image `error` by staying on, or returning to, the waiting screen.
- Layers already embed their `dataUrl`, so they never depend on the source file.

### 2. Floating windows in Exploration Mode

- New `FloatingWindow` component (`src/views/FloatingWindow.ts`): a header with a title and a minimize button (`–` / restore), a body with vertical scroll only, pointer-drag by the header, and a position clamped to the stage bounds on drag and on resize.
- Window position (as a fraction of the stage, so it survives a window resize) and the minimized flag persist per window id in settings (`exploreWindows`).
- Exploration Mode drops `.dm-explore-sidebar`. The stage takes the full modal width, and two windows, `AoEs` and `Vision`, float over it. They default to the top-right corner, side by side.
- A minimized window collapses to its header only. A Restore button in the header brings it back.

### 3. Compact control cards (DM panel and Explorer)

- One shared card renderer replaces `.dm-map-aoe-row` for both AoEs and visions, used by `renderAoeSection()` and `renderVisionSection()`. The DM panel and the Explorer stay identical.
- Collapsed card: one line, never wider than its container: color swatch, label (ellipsis), shape icon, size in ft, ✕.
- Expanded card (click the summary): the remaining fields on wrapping rows.
  - AoE fields: shape, size, width or thickness (line and ring), color, opacity, rotation.
  - Vision fields: label, color, shape, bright ft, dim ft, feather ft, follow view.
- Only one card is expanded at a time per list. The expanded id survives a panel re-render.

### 4. Rounded corners

- `styles.css` defines `--dm-radius: 8px` and `--dm-radius-lg: 12px` on `.dm-control-panel`, the plugin modals, and the explore modal.
- Every hard-coded `border-radius` in `styles.css` uses them, except `50%` (dots and handles) and the small swatch radius.
- `player.css` and `map.css` (the player-facing screens) are unchanged.

### 5. Dim-light visions

- `MapVision` gains `dimFt` (default `0`), `label?` and `color?`. `sizeFt` keeps its name and means the bright radius, so saved visions load unchanged with `dimFt = 0`.
- Bright area: fully revealed, as today.
- Dim ring (`sizeFt` → `sizeFt + dimFt`): revealed but darkened by a translucent dark overlay on the map screen.
- Line of sight from walls clips both zones. Feather softens the outer edge of the outermost zone.
- "Bake into fog" reveals both zones.
- `map-vision` payloads carry `dimFt`. `label` and `color` are DM-only and are stripped before broadcast.
- New generated catalog `src/map/lightSources.ts` (`LIGHT_SOURCES: { name, brightFt, dimFt }[]`):
  - Generated from the 5etools item and spell data in `dnd-library/5etools-data`: every entry whose text gives bright light in an N-foot radius plus dim light for an additional M feet, including the wording variants that a naive pattern misses (Torch, Daylight, Continual Flame).
  - Sorted and deduplicated by name.
  - Hand-added in the same order: `Darkvision 60 ft` and `Darkvision 120 ft` (bright 0, dim 60/120).
  - Committed; never generated at runtime.
- Add Vision gains a `Lights…` entry that opens a fuzzy picker (same pattern as `Spells…`). Picking a source creates a circle vision with that bright and dim radius and the source's name as its label.
- Every vision's bright and dim radius stays editable in its card.
- Vision label and color: the label defaults to the preset name; the color tints the vision's dot and ring on DM-side markers only.
- Group mode: a 🔗 toggle in the Vision window header (and the DM panel vision header) persists in map state. While on, dragging any vision moves every vision by the same delta, keeping their formation. Visions with `followsView` are excluded.

### 6. Image labels (DM panel only)

- Label resolution, in order:
  1. Hydrus image: the first `name:` tag with the namespace stripped.
  2. Hydrus image without a `name:` tag: the first 8 hex chars of the hash, with the full hash in the tooltip.
  3. Non-Hydrus image loaded from a note: the note's basename.
  4. Otherwise: the image's file name.
- Hydrus `name:` tags come from the known tags in the cache index (already fetched), so labelling never needs a network call.
- The background and map labels are stored DM-side in settings (`lastSourceLabels: { background?, map? }`) and never travel in the WebSocket protocol.
- Rendering: a chip at the top-left of the DM background preview, the DM map preview, and in the Explore bar title.

## Testing

- **Unit:**
  - server cache purge (`hide-background-media`, `map-clear` keeps calibration)
  - the state-changed event triggers a save
  - `onunload` flush
  - restore with a missing image: Hydrus re-download succeeds, re-download fails → dropped plus Notice
  - `ensureLocalCopy` checks existence
  - label resolution (all four branches)
  - `FloatingWindow` drag clamp, minimize and persisted position
  - card collapse/expand and no fixed widths
  - `MapVision` migration (`dimFt` default)
  - dim-ring render
  - group drag
  - `LIGHT_SOURCES` shape, sorting and the hand-added entries
- **e2e (real Obsidian):**
  - Stop BG, Stop Map and Clear Player Screen, then reload the plugin: nothing comes back
  - Explore windows minimize, restore and drag
  - group mode moves all visions
  - the Lights… picker adds a labelled vision
- **Visual:**
  - the dim ring on the map screen
  - the Explore modal with both windows
  - the DM preview label chip

## Specs and docs

Each behaviour change lands with its EARS spec change in the same commit:

- `map-screen/fog-of-war.md` (Exploration Mode, visions, dim light, group mode)
- `map-screen/aoe-overlays.md` (cards)
- `map-screen/overview.md` (restore, label)
- `background-media/overview.md`
- `image-layers/persistence.md`
- `player-server/websocket-protocol.md` (cache purge, `dimFt`)
- `hydrus-integration/cache.md`
- `hydrus-integration/note-references.md`
- `dm-preview/overview.md`

`AGENTS.md` is updated if a new subsystem file needs listing. The root repo's `obsidian-dm-screen` skill is touched only if a process changes, after loading `ai-docs`.

## Out of scope

- Labels on the player-facing screens.
- Tokens, per-character vision linked to a statblock, and light sources that animate.
- Auto-bake of the explored trail.
