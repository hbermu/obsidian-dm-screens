# Scenes

> Saved, named snapshots that load in one action. A **player scene** captures the player screen (background and image layers with their fog); a **map scene** captures the map screen (the map with its grid, view, fog, walls, AoEs and visions). Each scene is a Markdown note holding a `dm-scene` code block, so it lives in the vault, syncs with it, and can be linked or embedded in a session note, where it renders as a card with a Load button. Scenes work the same in embedded and remote mode and with the server stopped.

## Source files

- `src/scenes/format.ts` — `PlayerScene`, `MapScene`, `parseScene`, `serializeScene`, `SCENE_FORMAT_VERSION`, source references (`vault:<path>`, `hydrus:<sha256>`)
- `src/scenes/capture.ts` — builds a scene from the panel's current state and writes the note and its fog files
- `src/scenes/load.ts` — applies a scene through the DM panel, reporting missing sources
- `src/scenes/codeBlock.ts` — the `dm-scene` code block processor rendering the scene card
- `src/views/SaveSceneModal.ts` — the name prompt with overwrite confirmation
- `src/views/SceneSuggestModal.ts` — fuzzy picker over the scenes of one kind
- `src/views/DmControlPanel.ts`, `src/views/MapScreenPanel.ts` — Save scene and Load scene buttons
- `src/main.ts` — code block registration and the four commands
- `src/types.ts` — `ImageLayer.source`, the layer's origin, needed to save a layer by reference

## Settings used

- `scenesFolder` — vault folder for scene notes (default `DM Screen/Scenes`)

## Requirements

### Format

1. A scene shall be a Markdown note containing exactly one fenced code block with the language `dm-scene`, whose body is YAML read with `parseYaml` and written with `stringifyYaml`.
2. Every scene shall carry `version` (`SCENE_FORMAT_VERSION`, currently `1`), `kind` (`player` or `map`) and `name`.
3. A media source shall be written as `vault:<vault path>` for a vault file or `hydrus:<sha256>` for a Hydrus file (including one cached in the vault), never as a `/vault/` or `/assets/` URL, so one scene loads in either server mode and on any device.
4. A player scene shall hold `background` (`null`, or `{source, mediaType, loop, muted}`) and `layers`, each `{source, label, x, y, width, height, zIndex, rotation, visible, bordered, fog}`, where `fog` is `null` or a path relative to the scene's fog folder.
5. A map scene shall hold `map` (`{source, mediaType}`), `view` (`mode`, `panX`, `panY`, `rotation`), `grid` (`pxPerSquare`, `gridOffsetX`, `gridOffsetY`, `showGrid`, `gridColor`, `gridOpacity`), `fog` (`null` or a relative path), `walls`, `aoes` and `visions` in the shapes of their `map-walls`, `map-aoe-sync` and `map-vision` payloads.
6. Fog masks shall be stored as PNG files in a folder named `<note basename>.fog` next to the note: `map.png` for a map scene and `<layer id>.png` for each fogged layer.
7. If a code block has an unknown `version`, an unknown `kind`, or a missing required field, then `parseScene` shall return an error naming the problem and nothing shall be applied.

### Saving

8. The Player Screen and Map Screen section headers shall each carry a `Save scene` button (`.dm-scene-save-btn`), enabled when that screen has content (a background or at least one layer; an active map).
9. When pressed, the button shall open `SaveSceneModal`; on confirm the plugin shall write `<scenesFolder>/<name>.md` with a level-one heading of the name followed by the `dm-scene` block, creating the folder if needed, and write the fog files.
10. If the note already exists, then the modal shall ask for confirmation before overwriting it, and an overwrite shall delete fog files the new scene no longer uses.
11. A layer whose `source` is unknown (added before layers recorded their origin) shall be skipped with a Notice naming its label.
12. A file name shall have the characters `\ / : * ? " < > |` replaced by `-`.

### Loading

13. The `dm-scene` code block processor shall render a `.dm-scene-card` showing the name, the kind, and a summary (`N layers`, or the map label and `N walls`), with a `Load` button; a block that fails `parseScene` shall render the error instead.
14. The Player Screen and Map Screen sections shall each carry a `Load scene` button (`.dm-scene-load-btn`) opening `SceneSuggestModal` over the scenes of that kind found in `scenesFolder` and its subfolders.
15. When a scene is loaded, the plugin shall open the DM panel if it is closed and apply the scene through the same panel methods the DM's own actions use, so broadcasts, persistence and server-mode behaviour follow every other spec unchanged.
16. Loading a player scene shall clear the background and every layer, then set the background and add the layers with their geometry, visibility, border and fog.
17. Loading a map scene shall apply the map as Add Map does, then set the view, grid, fog, walls, AoEs and visions from the scene, persisting them as the map's current state (`mapConfigs` and sidecars in embedded mode, the map-data store in remote mode).
18. A `hydrus:` source shall resolve to the vault cache when the file is there, otherwise to the existing Hydrus download path, or, in remote mode with server-side Hydrus, to the server fetch (`../remote-server/assets.md` requirement 15).
19. If a source cannot be resolved, then that item shall be skipped, the rest shall load, and one Notice shall list every skipped item; a map scene whose map is missing shall load nothing and say so.
20. While the remote role is `readonly` or disconnected, every Save scene and Load button shall be disabled.

### Commands

21. The plugin shall register the commands `Save player screen as scene`, `Save map as scene`, `Load player scene` and `Load map scene`, behaving like the matching buttons.

## Tests covering this

- `src/__tests__/scene-format.test.ts` — parse and serialise round trip for both kinds, source references, version and kind errors, missing fields
- `src/__tests__/scene-capture.test.ts` — capture from panel state, fog file layout, overwrite cleanup, skipped layers without a source, file-name sanitising
- `src/__tests__/scene-load.test.ts` — player and map load order, persistence of map state, missing sources reported in one Notice, missing map, read-only gating
- `src/__tests__/scene-codeblock.test.ts` — card rendering, summary, error rendering, Load button
- `test/e2e/specs/scenes.e2e.ts` — real Obsidian: save a player scene and a map scene, clear, load from the card and from the picker, assert the broadcasts on the wire

## Non-goals

- Combat state in scenes. Initiative stays with the combat tracker and its sources.
- Thumbnails of scenes.
- Merging a scene into the current screen. Loading replaces what that screen shows.
- Scenes stored on the remote server. Scenes are vault notes.
