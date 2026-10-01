# Explorer Windows, Dim-Light Visions, Image Labels and Restore Fixes — Implementation Plan

> **For agentic workers:** one subagent per phase, run sequentially. The coordinator reviews each phase before the next starts. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-10-01-explorer-windows-and-restore-design.md` on branch `feature/explorer-windows-and-restore`, as one PR released as 1.3.0 (`release:minor`).

**Architecture:** Fix restore at its source: the server replay cache, plus a save on every state change. Add DM-side image labels. Replace the AoE and vision rows with one shared compact card renderer. Move Exploration Mode controls into a reusable `FloatingWindow`. Extend `MapVision` with a dim ring, a generated light-source catalog and group drag.

**Tech Stack:** TypeScript Obsidian plugin, esbuild, vitest + happy-dom, Playwright visual, wdio-obsidian-service e2e, all run through `make`/Docker.

**User Verification:** NO. The user asked for coordinator review between phases, not a human sign-off per task.

---

## Rules for every phase (read before starting)

- **Before editing**, read `AGENTS.md`, `.agent/conventions.md` (EARS format), and the matching `.agent/features/<feature>/*.md`. Then read only the `src/` files the phase touches.
- **No Node toolchain on the host.** Never run `npm`, `npx`, `node`, `tsc`, `vitest` or `esbuild` directly; a hook blocks any command containing `npm` or `esbuild`. Use `make typecheck`, `make test`, `make test-coverage`, `make build`, `make test-visual`, `make test-visual-update` and `make test-e2e` (set `OBSIDIAN_VERSIONS="earliest/earliest latest/latest"` for both legs).
- **Locally on arm64, the `map-fog-video` visual tests crash with SIGILL.** This is a known local-only issue; CI passes. Ignore exactly those tests and report it.
- **Every behaviour change ships with its EARS spec change in the same commit.** Number new requirements following the file's existing scheme (e.g. `52b`, or the next free integer). AI docs are English and self-contained, with no external URLs.
- **Commits:**
  - Conventional Commits; one or more commits per phase.
  - Identity: `contact@hbermu.com` (already set locally; verify with `git config user.email`).
  - End every message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Never use `--no-verify`, `--amend` on pushed commits, or force-push.
  - **Do not push.** The coordinator pushes.
- **Do not create native tasks** (TaskCreate): a hook blocks `git commit` while any task is open.
- **Phase gate:** `make typecheck && make test-coverage && make build` must be green before the final commit of the phase, and the coverage gate must not drop. Run the e2e and visual specs listed in the phase.
- **Report at the end:**
  - commits (hash + subject)
  - files touched
  - test commands and their results
  - any deviation from this plan, and why

---

## Phase 1: Restore fixes

**Goal:** a cleared background, layers or map stays cleared after an Obsidian restart, and a restored image that is missing gets re-downloaded from Hydrus or dropped with a Notice. Nothing renders broken.

**Files:**
- Modify:
  - `src/server.ts`: `broadcast()` around `:308-320`; replay at `:301`
  - `src/views/DmControlPanel.ts`: `restoreState` `:189`, `republishToServer` `:228`, `saveState` `:245`, Stop BG `:568`, Clear Player Screen `:999`, background preview `:596-631`
  - `src/views/MapScreenPanel.ts`: `restoreFromCache` `:82-137`, Stop Map `:359`, map preview img `:885-899`
  - `src/main.ts`: `onunload` `:104`
  - `src/hydrus/noteRefs.ts`: `ensureLocalCopy` `:64-68`
  - `src/hydrus/cache.ts`
  - `src/player/player.ts`: `showBackgroundMedia` `:352-385`
  - `src/map/map.ts`: `showMap` `:294-332`
- Specs:
  - `.agent/features/player-server/websocket-protocol.md`
  - `.agent/features/image-layers/persistence.md`
  - `.agent/features/background-media/overview.md`
  - `.agent/features/map-screen/overview.md`
  - `.agent/features/hydrus-integration/cache.md`
  - `.agent/features/hydrus-integration/note-references.md`
- Tests:
  - `src/__tests__/server-broadcast.test.ts`
  - `src/__tests__/server-map-channel.test.ts`
  - a new `src/__tests__/restore-state.test.ts`
  - `src/__tests__/note-refs.test.ts`
  - e2e: a new `test/e2e/specs/restore.e2e.ts`, or extend `layer-controls.e2e.ts`, which already does save/restore via a leaf detach

**Acceptance criteria:**
- [ ] **`hide-background-media`:** `broadcast()` deletes the cached `show-background-media` entry and caches nothing for the hide. After show → hide, the replay sends no background message.
- [ ] **`map-clear`:** still purges every `map-*` entry except `map-calibration`.
- [ ] **State-changed event:** the server exposes a subscription such as `onStateChange(cb): () => void`, and fires it after any `lastState` mutation, including clears and replay-cache eviction.
  - `DmControlPanel` subscribes when it opens and unsubscribes on close. The callback calls the existing debounced save (`scheduleSaveState`, 1 s).
  - Stop BG, Stop Map, Clear Player Screen, setting a background or map, and AoE/vision/fog/wall edits all persist without per-call-site saves.
- [ ] **Clear Player Screen:** persists the empty `lastImageLayers` too.
- [ ] **`onunload`:** flushes any pending debounced save (synchronously calling `saveState()` on the open panel) before `stopServer()`.
- [ ] **`ensureLocalCopy`:**
  - Returns the indexed path only if `adapter.exists(vaultPath)`.
  - Otherwise drops the index entry and re-downloads when Hydrus is enabled and reachable.
- [ ] **Restore check:** `restoreState` / `restoreFromCache` check each restored background and map `/vault/<path>` with `adapter.exists` before marking it active.
  - **Hydrus cache path** (`<cacheBaseFolder>/hydrus/<hash>.<ext>`): re-download it via the Hydrus cache/client by hash, then restore.
  - **Still missing:** delete the cached entries (background: `show-background-media`; map: all `map-*` except calibration), clear `activeBackgroundUrl` / `activeMap`, and show `new Notice("Background \"<name>\" is no longer available")` or `"Map ..."` respectively. `<name>` is the file name for now; Phase 2 swaps in the label. Then persist.
  - **Async:** restore may become async. Make sure `republishToServer()` only republishes what survived; await the check before republishing.
- [ ] **DM previews:** the background and map `<img>` get an `error` handler that replaces them with a `.dm-image-unavailable` placeholder reading "Image unavailable", styled in `styles.css`.
- [ ] **Player screen:** `player.ts` handles `error` on the background image/video by hiding it and showing the waiting screen.
- [ ] **Map screen:** `map.ts` handles `error` on the map image/video by returning to the waiting screen. Use `console.warn`, since the browser bundles can't reach the Debug setting.
- [ ] **Unit tests cover every bullet above:**
  - cache purge
  - calibration kept
  - state-change event fires
  - restore with a missing Hydrus file → re-download called
  - restore with re-download failing → dropped + Notice. Stub `Notice` in `test/stubs/obsidian.ts` if needed and assert on it.
  - `ensureLocalCopy` existence check
- [ ] **e2e:**
  - **Background:** set a background, Stop BG, reload the plugin, and the panel shows no active background (button reads the "set" state, not "Stop BG").
  - **Map:** Add Map, Stop Map, reload, and no map. Reload via `app.plugins.disablePlugin('dm-screen')` + `enablePlugin`, or the leaf-detach pattern from `layer-controls.e2e.ts`.
  - **Missing image:** delete the image file, reload, and a Notice appears; the map stays cleared.

**Verify:** `make typecheck && make test-coverage && make build && OBSIDIAN_VERSIONS="earliest/earliest latest/latest" make test-e2e` → all green.

**Commit:** `fix(persistence): keep cleared state cleared across restarts and recover missing images` (code + specs + tests together; split into 2–3 commits if natural, each with its spec).

---

## Phase 2: Image labels (DM panel only)

**Goal:** the DM background preview, the DM map preview and the Explore bar show a human label for the image.

**Files:**
- Create: `src/sourceLabel.ts`. It exports a pure `resolveSourceLabel(input: { url: string; hydrusHash?: string; knownTags?: string[]; noteBasename?: string }): { label: string; title: string }`.
- Modify:
  - `src/settings.ts`: add `lastSourceLabels: { background?: SourceLabel; map?: SourceLabel }`, default `{}`, where `SourceLabel = { label: string; title: string }`
  - `src/views/DmControlPanel.ts`: background setters at `:1934-1947` (note refs) and `:2131-2142`; preview `.dm-preview-bg` at `:614`
  - `src/views/HydrusExplorerModal.ts`: background `:455-466`. Reuse or extend `layerLabelFromTags` at `:809-817` so there is ONE name-tag parser.
  - `src/views/MapScreenPanel.ts`: map setters at `:372-379`; preview `.dm-map-preview` at `:696`
  - `src/views/MapExploreModal.ts`: bar
  - `styles.css`: `.dm-source-label` chip
  - The Phase 1 Notices: use the label.
- Specs:
  - `.agent/features/background-media/overview.md`
  - `.agent/features/map-screen/overview.md`
  - `.agent/features/dm-preview/overview.md`
  - `.agent/features/hydrus-integration/explorer.md`
  - `.agent/features/hydrus-integration/note-references.md`
- Tests:
  - a new `src/__tests__/source-label.test.ts`
  - `src/__tests__/hydrus-layer-label.test.ts`, if the parser is shared
  - `src/__tests__/dm-preview-bg.test.ts`

**Acceptance criteria:**
- [ ] **Resolution order:**
  1. The first `name:` tag with the namespace stripped. `title` = the full hash for Hydrus images.
  2. A Hydrus image without a `name:` tag: the first 8 hex chars of the hash.
  3. A non-Hydrus image loaded from a note: the note basename (`app.workspace.getActiveFile()?.basename` at load time, or the source note of the reference).
  4. Otherwise: the file name without its folder (keep the extension).
- [ ] **Where tags come from:** Hydrus tags are read from the cache index `knownTags`, so no network call is made for labelling. A Hydrus image is identified by its URL under the cache folder, `hydrus/<64hex>.<ext>`.
- [ ] **Storage:** the label is saved in `lastSourceLabels` when a background or map is set, and cleared when it is stopped or cleared. It is never added to any WebSocket payload; assert this in a test on the broadcast payload.
- [ ] **Restore:** after a restart the label comes from settings; when it is missing, it is recomputed from the URL.
- [ ] **Chip:**
  - Absolutely positioned at the top-left inside the background preview and the map preview, with the full value in `title` (hash or full name).
  - Text is ellipsised and never widens the preview.
  - The Explore bar shows the label as its title text.
- [ ] **Unit tests:** cover the four resolution branches plus the "not in payload" assertion.

**Verify:** `make typecheck && make test-coverage && make build`, plus `make test-e2e` for `background.e2e.ts`, `map.e2e.ts` and `explore.e2e.ts` (add one assertion that the chip exists with the fixture note's basename).

**Commit:** `feat(dm-preview): label the background and map previews with their Hydrus name or source note`.

---

## Phase 3: Rounded corners + compact control cards

**Goal:** one shared compact card renderer for AoEs and visions that never overflows horizontally, in both the DM panel and Exploration Mode; and consistent rounded corners across the plugin UI.

**Files:**
- Create: `src/views/controlCard.ts`. It exports `renderControlCard(parent: HTMLElement, opts: { id: string; color: string; label: string; summary: string; icon: string; expanded: boolean; onToggle(): void; onRemove(): void; renderDetails(body: HTMLElement): void }): HTMLElement`.
- Modify:
  - `src/views/MapScreenPanel.ts`: `renderAoeSection` `:1101-1218` and `renderVisionSection` `:1338-1445`. Keep their public signatures so `MapExploreModal` keeps calling them. Track `expandedAoeId` / `expandedVisionId` on the panel instance, so the state survives a re-render. Only one card is expanded per list.
  - `styles.css`:
    - Drop the fixed-width non-wrapping `.dm-map-aoe-row` rules (`:1999-2028`).
    - Add `.dm-control-card*` rules: `min-width: 0`, `flex-wrap: wrap` on detail rows, inputs that are `width: 100%` / flexible inside the details grid, and `overflow-x: hidden` on the explore container.
    - Add `--dm-radius: 8px` and `--dm-radius-lg: 12px` on `.dm-control-panel`, `.modal.dm-*` / `.dm-explore-modal` (and any `.dm-*-modal` roots), and replace every hard-coded `border-radius` in `styles.css` except `50%` and swatch radii ≤ 3px.
    - Do not touch `player.css` / `map.css`.
- Specs:
  - `.agent/features/map-screen/aoe-overlays.md` (row layout requirement)
  - `.agent/features/map-screen/fog-of-war.md` (vision rows)
  - `.agent/features/dm-preview/overview.md` or the closest general UI spec for the radius variables. If no spec owns plugin styling, add a short requirement to `map-screen/overview.md`.
- Tests:
  - `src/__tests__/map-screen-panel-aoe.test.ts`
  - a vision test, if one exists
  - a new `src/__tests__/control-card.test.ts`
  - e2e: update selectors in `aoe-vision.e2e.ts`, `aoe-shapes.e2e.ts` and `explore.e2e.ts`. They must expand a card before touching its inputs; add a helper in `test/e2e/helpers/obsidian.ts`.

**Acceptance criteria:**
- [ ] **Collapsed card:** a single line with swatch, label (ellipsis), shape icon, size summary (e.g. `20 ft`, `30×5 ft`) and ✕. Clicking anywhere on the summary except ✕ toggles it.
- [ ] **AoE details:**
  - shape select; size; width/thickness for line and ring only; color; opacity; rotation (hidden for circle)
  - same input semantics and min/step values as today
- [ ] **Vision details (this phase):**
  - shape, range (`sizeFt`), feather, follow-view toggle
  - same semantics as today; Phase 5 adds more fields
- [ ] **Unchanged behaviour:**
  - All existing AoE/vision behaviour stays exactly as it is: broadcast, persistence, the Spells… picker, Clear All, Bake into fog.
  - Drag dots and rotation handles on the preview are unaffected.
- [ ] **Width check:** in a 260 px wide container, no card element has `scrollWidth > clientWidth`. Unit-test with the happy-dom layout if feasible; otherwise assert via the CSS rules and in e2e with `executeObsidian`, measuring `.dm-explore-modal` card containers.
- [ ] **Radius:**
  - `styles.css` has no `border-radius: <n>px` literal other than inside the variable definitions and the allowed exceptions.
  - Verify with `grep -nE "border-radius:\s*[0-9]+px" styles.css`.
- [ ] **Visuals:** baselines are refreshed only inside the container (`make test-visual-update`), and only for screenshots that include the DM UI. Player/map screen baselines must not change.

**Verify:** `make typecheck && make test-coverage && make build && make test-visual && OBSIDIAN_VERSIONS="earliest/earliest latest/latest" make test-e2e`.

**Commit:** `feat(map-screen): compact collapsible AoE and vision cards and shared rounded corners`.

---

## Phase 4: Floating windows in Exploration Mode

**Goal:** Exploration Mode drops its fixed sidebar. AoEs and Vision live in two draggable, minimizable floating windows over a full-width stage.

**Files:**
- Create: `src/views/FloatingWindow.ts`, exporting `class FloatingWindow`:
  - `constructor(host: HTMLElement, opts: { id: string; title: string; initial: WindowState; onChange(state: WindowState): void })`
  - `body: HTMLElement`
  - `setTitleExtra(el: HTMLElement)`, for header buttons such as Phase 5's 🔗
  - `clamp()`
  - `destroy()`
  - `WindowState = { x: number; y: number; minimized: boolean }`. `x`/`y` are fractions (0–1) of the host size, for the window's top-left.
- Modify:
  - `src/views/MapExploreModal.ts`: layout `:82-137`, `:261-287`
  - `src/settings.ts`: `exploreWindows: Record<string, WindowState>`, default `{}`
  - `styles.css`: remove the `.dm-explore-sidebar` rules (`:2109-2114`); add `.dm-floating-window*`
- Specs: `.agent/features/map-screen/fog-of-war.md` (Exploration Mode, reqs 42–52a), `.agent/features/map-screen/overview.md` (req 9).
- Tests: a new `src/__tests__/floating-window.test.ts`, `src/__tests__/map-explore-modal.test.ts`, `test/e2e/specs/explore.e2e.ts`, and a new visual for the Explore modal if the visual harness can render it (skip with a note if it can't).

**Acceptance criteria:**
- [ ] **Window structure:**
  - Header: title, then a spacer, then extra buttons, then a minimize/restore button (`–` / `▢`, with `aria-label` "Minimize" / "Restore").
  - Body: `overflow-y: auto; overflow-x: hidden`, `max-height` limited to the host height minus the header and margins.
- [ ] **Dragging:**
  - Pointer-drag on the header (not on its buttons) moves the window, using pointer capture.
  - The position is clamped so the whole header stays inside the host. The host is resized with a `ResizeObserver`, which re-clamps.
  - `onChange` fires on drag end and on minimize toggle; the modal persists it to `settings.exploreWindows[id]` via `saveSettings`.
- [ ] **Defaults:** with nothing saved, the `aoes` and `vision` windows sit at the top-right, side by side, with a 12 px margin and no overlap. Their width is fixed at 260 px; the Phase 3 cards fit.
- [ ] **Minimized:** only the header shows.
- [ ] **Interaction with the map:**
  - Drag dots and markers under a window are still reachable when it is moved or minimized.
  - The window's own pointer events do not reach the stage (`stopPropagation` on pointerdown).
- [ ] **Unchanged:**
  - The stage occupies the full modal width.
  - The bar (Reveal All, Cover All, lock, Exit, plus the Phase 2 label) is unchanged.
  - AoE and vision sections render into the windows' bodies through the existing `renderAoeSection` / `renderVisionSection`.
- [ ] **Unit tests:**
  - clamp math
  - default placement
  - state round-trip
  - minimize hides the body
  - drag via synthetic pointer events
  - `onChange` payload
- [ ] **e2e:**
  - Open Explore; both windows exist.
  - Minimize the AoE window: the body is hidden. Restore it.
  - Drag the Vision window header by (-200, +100): its rect moved.
  - Close and reopen Explore: the moved position is kept.

**Verify:** `make typecheck && make test-coverage && make build && OBSIDIAN_VERSIONS="earliest/earliest latest/latest" make test-e2e` (the explore specs at least), plus `make test-visual`.

**Commit:** `feat(map-screen): floating minimizable AoE and Vision windows in Exploration Mode`.

---

## Phase 5: Dim-light visions

**Goal:** a vision has a bright radius and a configurable dim ring. Players see the dim ring revealed but darkened, with line of sight applied to both zones.

**Files:**
- Modify:
  - `src/map/types.ts`: `MapVision` gets `dimFt: number`, `label?: string`, `color?: string`
  - `src/map/vision.ts`, including `eraseVisionWithWalls` `:42`
  - `src/map/los.ts`, if needed
  - the map-screen fog/vision renderer in `src/map/map.ts`, plus whatever renders the vision mask
  - the DM-side preview renderer
  - `src/views/MapScreenPanel.ts`: the vision card details, the `map-vision` broadcast and the stored map state
  - the Bake into fog path
  - `map.css`, for a dim overlay if one is needed. Keep the player-facing chrome unchanged.
- Specs: `.agent/features/map-screen/fog-of-war.md` (visions), `.agent/features/player-server/websocket-protocol.md` (`map-vision` payload `dimFt`).
- Tests: the existing vision and LOS tests (`grep -l vision src/__tests__`), and a visual `test/visual/map-vision.spec.ts` with a new dim-ring baseline. Refresh the baseline inside the container.

**Acceptance criteria:**
- [ ] **Migration:** stored or cached visions without `dimFt` load with `dimFt = 0`, so behaviour is identical to today. Add a normaliser at every read point: cache restore, `mapConfigs`, incoming edits.
- [ ] **Two zones:**
  - The bright zone is `sizeFt`; the dim zone runs out to `sizeFt + dimFt` (circle radius / square half-extent).
  - The map screen reveals both, and draws the dim zone under a dark translucent overlay (default `rgba(0,0,0,0.5)`; a constant in code).
  - Feather applies to the outer edge of the outermost zone.
  - LOS (walls / closed doors) clips both zones.
  - `sizeFt = 0` with `dimFt > 0` must work (darkvision-only).
- [ ] **Bake into fog:** reveals the union of both zones.
- [ ] **Payload:**
  - The `map-vision` payload includes `dimFt`.
  - `label` and `color` are stripped before broadcast and replay caching. Test: the broadcast payload has no `label`/`color` keys.
- [ ] **Vision card details:** label (text), color, shape, bright ft, dim ft (min 0, step 5), feather, follow view. The collapsed summary shows `20/+20 ft` when `dimFt > 0`.
- [ ] **DM-side markers:**
  - The vision dot and ring use `color` (default: the current color).
  - The label is the dot's `title`.
- [ ] **Unit tests:**
  - the normaliser
  - the dim-zone geometry
  - LOS clipping of the dim zone
  - the strip-before-broadcast
  - bake covers both zones
- [ ] **Visual:** a new baseline with one vision of 20/+20 ft shows the dim ring; the other map-vision baselines are unchanged.

**Verify:** `make typecheck && make test-coverage && make build && make test-visual && OBSIDIAN_VERSIONS="earliest/earliest latest/latest" make test-e2e`.

**Commit:** `feat(map-screen): dim-light ring for visions with line of sight`.

---

## Phase 6: Light catalog, Lights… picker, labelled visions and group mode

**Goal:** 5e light sources one click away; group drag.

**Files:**
- Create:
  - `scripts/gen-light-sources.py`. It is plain Python 3 and stdlib only, reading `<dnd-library>/5etools-data/data/items.json`, `items-base.json` and `spells/spells-*.json`; the default root is `../../dnd-library`, overridable with `--root`. It writes `src/map/lightSources.ts`.
  - `src/map/lightSources.ts` (generated, committed).
  - `src/views/LightSourceModal.ts`, a `FuzzySuggestModal` mirroring `SpellAoeModal`.
- Modify:
  - `src/views/MapScreenPanel.ts`: the Add Vision menu, the group toggle, and the drag handlers for vision dots in both the DM preview and Explore (see `MapExploreModal.ts`)
  - `src/views/MapExploreModal.ts`: the 🔗 toggle in the Vision window header via `FloatingWindow.setTitleExtra`
  - `src/map/types.ts` / stored map state: `visionGroup: boolean`
- Specs:
  - `.agent/features/map-screen/fog-of-war.md` (presets, labels/colors, group mode)
  - `AGENTS.md`, if it lists generated catalogs or scripts
- Tests:
  - a new `src/__tests__/light-sources.test.ts`
  - a new `src/__tests__/vision-group-drag.test.ts`
  - e2e `aoe-vision.e2e.ts`: the Lights… picker adds a labelled vision; the group toggle moves all

**Acceptance criteria:**
- [ ] **Generator: extraction.** It extracts `{ name, brightFt, dimFt }` from entry text (after stripping `{@tag x|y}` markup to its display text) for:
  - "bright light in a N-foot radius and dim light for an additional M feet"
  - the variants that miss that naive pattern. Check Torch (items-base or items, PHB/XPHB), Daylight, Continual Flame, Light, Dancing Lights, and Lamp. Print the unmatched light-related names to stderr so the variants can be reviewed, and handle each with a regex, not with hand-added numbers.
- [ ] **Generator: output.**
  - It dedupes by name (prefer PHB, then XPHB, then the first source) and sorts by name.
  - It appends the hand-added `Darkvision 60 ft` (0/60) and `Darkvision 120 ft` (0/120) in sorted order.
  - The header comment states it is generated by `scripts/gen-light-sources.py` from 5etools data, mirroring `spellAoes.ts`.
- [ ] **Output contents:**
  - Torch 20/20, Lamp 15/30, Hooded Lantern 30/30, Candle 5/5, Light 20/20, Daylight 60/60.
  - Run the script and commit its output. Unit tests assert these values, the sort, no duplicates, and the darkvision entries.
- [ ] **Lights… picker:** Add Vision gains `Lights…`, which opens the picker. Choosing an entry adds a circle vision at the map centre (same placement as the existing Add Vision presets) with `sizeFt = brightFt`, `dimFt`, `label = name` and the default feather.
- [ ] **Group mode:**
  - A 🔗 toggle (`aria-pressed`) in the Vision header, in both the DM panel and the Explore window, persists in the map's stored state.
  - When it is on, dragging any vision dot applies the same map-space delta to every vision without `followsView`. All of them are clamped to the map, and each keeps its offset as long as nothing hits the edge. Exactly one `map-vision` broadcast is sent per move frame, not one per vision.
- [ ] **Unit tests:**
  - catalog contents
  - the group drag delta, clamping and `followsView` exclusion
  - the single broadcast per frame
- [ ] **e2e:**
  - Lights… → "Torch" creates a vision whose card label is "Torch" and whose summary reads `20/+20 ft`.
  - With group mode on, dragging one of two visions moves both: their positions change by the same delta in the next `map-vision` WS message.

**Verify:** `python3 scripts/gen-light-sources.py` (it regenerates the catalog with no diff), then `make typecheck && make test-coverage && make build && OBSIDIAN_VERSIONS="earliest/earliest latest/latest" make test-e2e`.

**Commit:** `feat(map-screen): 5e light-source presets, labelled visions and group drag`.

---

## Phase 7: Coordinator: final gate, docs sweep, PR (no subagent)

- [ ] **Final gate:** run the full gate on the branch: `make typecheck && make test-coverage && make build && make test-visual && OBSIDIAN_VERSIONS="earliest/earliest latest/latest" make test-e2e`.
- [ ] **Docs sweep:**
  - Every spec listed in the design is updated.
  - `AGENTS.md` lists any new files that its file map documents.
  - The root `obsidian-dm-screen` skill needs no change, or is updated after loading `ai-docs`.
- [ ] **Version files:** they read `1.2.0` while the latest stable is `1.2.1`; the release workflow computes the bump from tags. Before the first push, check whether `release.yml` needs the version files to equal the latest stable; follow the skill's rule.
- [ ] **Push and open the PR:**
  - `git push -u origin feature/explorer-windows-and-restore`
  - `gh pr create` with the title from the design and the label `release:minor`
- [ ] **CI:** all checks green, including e2e ×2, visual and Analyze.
- [ ] **Merge (only with the user's OK):** squash-merge (`gh pr merge --squash --delete-branch`), then confirm release `1.3.0` is published.
- [ ] **Root repo:** update the submodule pointer only if the user asks.
