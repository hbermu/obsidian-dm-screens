# Battlemap Preview Stability — Design

**Date:** 2026-10-01
**Status:** Approved. Delivered in three sequential phases, one PR each.

## Goal

Make the battlemap preview usable during a live session. Two reported symptoms drive this work:

1. Dragging or rotating an AoE sometimes teleports it to the edge of the map.
2. The preview is not fluid; it sometimes collapses and stops working.

Both are defects in the DOM glue around the preview, not in the geometry maths. `src/map/transform.ts` and `src/map/aoe.ts` are pure, total over non-finite input, and covered by `map-transform.test.ts` and `map-aoe-render.test.ts`. They are not touched by this work.

## Root causes

### The AoE teleport

`effectiveScale()` in `src/views/MapScreenPanel.ts` reads `stage.offsetWidth`. `DmControlPanel.render()` calls `container.empty()` and rebuilds the whole panel. A drag's `onMove` closure survives on `document`, but its `stage` is detached, so `offsetWidth` is `0`, `effectiveScale()` returns `0`, `deltaToMap` divides by zero and yields `±Infinity`, and `aoe.x = Math.max(0, Math.min(nw, startAoeX + d.x))` clamps the AoE onto the map edge and broadcasts it.

The D&D Beyond poller cycles every 2–8 seconds (`CYCLE_PAUSE_MIN_MS` / `CYCLE_PAUSE_MAX_MS` in `src/dndbeyond/poller.ts`), and each successful poll reaches `debouncedRender()`. While an encounter is tracked, a full panel rebuild lands inside a one-second drag often.

`DmControlPanel` already defers a background render while a panel field has focus (`isEditingPanelField`). It has no equivalent protection for a drag in progress.

### The collapsed preview

`layoutStage()` is the only code that gives the preview stage and its container a size, and it returns early when `preview.clientWidth` is `0`. A collapsed section is `display: none` (`.dm-section-collapsed > *:not(:first-child)`), and `makeCollapsible` only toggles a CSS class — it never re-renders. So a background render that lands while the Map Screen section is collapsed, or while the DM panel sits in a hidden sidebar tab, leaves the stage with no inline size; expanding the section then shows a zero-height box that never recovers. The repository contains no `ResizeObserver`, so resizing the Obsidian sidebar does not recover it either.

### The jitter

Three compounding costs, all per mouse event:

- `redrawAoes()` assigns `aoeCanvas.width` and `.height` on every `mousemove`. Assigning `.width` reallocates the backing store and re-uploads a GPU texture. In `fit` mode the preview zoom reaches 6×, which is roughly 8.5 MP per event.
- `positionMarkers()` writes `style.left`/`style.top` and `redrawAoes()` then reads `stage.clientWidth`, forcing a synchronous layout every frame.
- All three previews (`MapScreenPanel`, `MapExploreModal`, `MapFogModal`) load the map through `getResourcePath` at natural resolution. A full-resolution Czepeku export is 4480×7000 — about 125 MB decoded, at the edge of Chromium's decoded-image cache — and every panel rebuild recreates the element.

### The TV

`applyLayout()` in `src/map/map.ts` assigns `canvas.width = Math.round(vw * dpr)` unconditionally, unlike the fog canvas which guards on change. It runs on every `map-view` and `map-aoe-sync`, which arrive throttled at 80 ms — about 12.5 per second during a drag.

`visibilityPolygon` in `src/map/los.ts` is O(n²): it casts three rays per wall endpoint against every segment. Walls imported from UVTT or a Foundry module routinely number in the hundreds. A vision bound to the view makes a pan drag emit `map-vision` at the same 12.5 Hz, and each message triggers a full `recompositeFog()`.

## Approach (chosen)

**Phased: fix the defects in place, then extract the shared stage, then address the TV.**

Phase 1 repairs both reported symptoms with small, local changes. Phase 2 extracts a shared `MapStage` module that owns preview geometry for all three consumers and removes the per-event allocation. Phase 3 instruments the map client before changing it.

The ordering is deliberate. The extraction is the right end state — the same geometry is written three times and each copy carries different defects — but putting it first would leave the reported bugs unfixed for the duration of a refactor. Phase 2 absorbs what Phase 1 adds: the `ResizeObserver` is born in the panel and migrates into `MapStage`.

**Rejected alternative: a single canvas renderer.** Drawing map, AoEs, fog and markers into one canvas would eliminate the layout thrashing and the DOM markers outright. It also discards specified behaviour — `scale-and-grid.md` requirements 6b, 6c and 6d describe the stage element, the percentage-positioned markers and their counter-scaling — and forces a rewrite of the e2e specs that hit-test `.dm-map-aoe-dot`. The cost is large and the benefit over the chosen approach is small.

**Rejected alternative: surgical patches without extraction.** Cheaper to reach green, but it preserves the triplication, so the next defect in this area again appears three times with three different shapes.

## Design

### 1. Drag lock (Phase 1)

`DmControlPanel` gains a `dragDepth` counter and a `beginDrag(): () => void` method that increments it and returns the matching release. `renderFromBackground()` defers when `dragDepth > 0`, exactly as it already does for a focused field, and the deferred render is flushed when the last drag ends. Every `mousedown` handler in `MapScreenPanel` and `MapExploreModal` goes through it.

This removes the cause. The poller can no longer empty the container mid-drag.

### 2. Non-finite scale guard (Phase 1)

`effectiveScale()` returns `number | null` — `null` when the measured stage width is not finite or not positive. `screenToMap` and `deltaToMap` propagate the `null`, and every `onMove` returns without mutating state.

This is the belt to the drag lock's braces, and it applies the invariant that `scale-and-grid.md` requirement 11 already states for `transform.ts` ("a NaN reaching the stage's CSS transform blanks the map screen with nothing in the console") at the panel boundary, which was left outside it. A drag over an unmeasurable stage becomes inert instead of clamping to the map edge.

### 3. Resize-driven relayout (Phase 1)

A `ResizeObserver` on the preview container calls `layoutStage()`. It is disconnected at the start of each `renderPanPreview` and in `onClose`. This recovers the collapsed preview on expand, on sidebar resize, and on tab reveal.

### 4. Marker hit targets and a drag threshold (Phase 1)

`.dm-map-aoe-dot` is 10 px and counter-scales by `1 / var(--dm-map-zoom)`, so at 3× zoom it offers about 3.3 px of hit area. A transparent `::before` that does not counter-scale gives a constant ~18 px hit target while the dot keeps its current size on screen.

In physical mode a `mousedown` anywhere in the preview re-centres the players' view immediately. A 3 px movement threshold before the first `applyPan` prevents a stray click from moving what the players see mid-session. This is the one deliberate behaviour change in the plan and it amends `scale-and-grid.md` requirement 6.

### 5. In-place repaint (Phase 1)

`aoe-overlays.md` requirement 8 states that size, width and opacity edits redraw the preview canvas in place. The code calls `host.render()` instead, which destroys the very slider being dragged. `redrawPreviewAoes` is assigned and never read — it is the abandoned mechanism for that requirement, and `AGENTS.md` forbids dead code.

It is revived as `repaintOverlays()`, which repaints the canvas **and** repositions the markers. Repositioning is necessary because changing `sizeFt` moves the rotation handle. Both the panel preview and the Explore modal register into it. Size, width and opacity edits call it; structural edits keep calling the host's re-render, as the requirement specifies.

### 6. `MapStage` (Phase 2)

A new `src/views/mapStage.ts` owns one concern: the DOM geometry of a map preview. It measures and sizes the stage against its container, observes resize, converts between screen and map coordinates with the Phase 1 guard, applies the transform (rotation, preview zoom, local pan), and coalesces repaints into one per animation frame.

It knows nothing about AoEs, fog, visions or WebSocket traffic. All three previews consume it. It is testable in isolation against the stubbed `getBoundingClientRect` the existing tests already use.

### 7. Allocation and layout discipline (Phase 2)

Canvas dimensions are assigned only when the value changes. Repaints run once per frame through `MapStage.scheduleRepaint()`. Measurement happens once per frame, before writes, which removes the read-after-write layout thrashing.

### 8. Downscaled preview bitmap (Phase 2)

`MapScreenPanel` caches one thumbnail per map URL: the image drawn into a canvas with its longest side capped at 2048, converted with `toBlob` and published as an object URL, revoked on map change and on panel close. All three previews use it. The map client keeps the original, where resolution is the point.

The accepted trade-off: at maximum zoom in `fit` mode (6×) the DM preview is visibly soft. In physical mode `zoomMax` usually computes to 1 for a large map on a TV, so it is not noticeable there. The preview is a navigation aid; the real output is the TV.

Videos keep the original source. Video decode is already streaming and bounded, and there is no cheap downscale.

### 9. Map client (Phase 3)

Phase 3 begins by measuring, not patching. The map bundle uses `console.*` directly — it cannot reach the plugin's Debug setting, which `AGENTS.md` documents as the intended exception — so timings go in `applyLayout` and `recompositeFog`, and the page is driven on the real TV with and without a view-bound vision.

Two fixes are certain regardless of the measurement: guard the grid canvas dimension assignment on change, and coalesce `applyLayout` into one call per animation frame.

The vision fix depends on the measurement. If coalescing `recompositeFog` to one call per frame is enough, nothing observable changes. If it is not, the drag path recomposites with plain `eraseVision` (no line-of-sight) and a trailing timer about 150 ms after the last message computes the wall-accurate version. That converges correct and stays fluid, at the cost of a moment during the drag where light crosses a wall, and it amends `fog-of-war.md` requirements 10 and 11.

## Specs to update

Each phase ships its spec changes in the same PR; `spec-update-check` enforces that a `src/` change is accompanied by a `.agent/features/` change.

- **Phase 1:** `map-screen/scale-and-grid.md` — relayout on container resize, inert drag over an unmeasurable stage, the 3 px threshold in requirement 6. `map-screen/aoe-overlays.md` — marker hit target in requirement 7, in-place repaint path in requirement 8.
- **Phase 2:** source-file blocks in `map-screen/overview.md`, `map-screen/scale-and-grid.md` and `map-screen/fog-of-war.md` for the new module; a note in `scale-and-grid.md` on the preview thumbnail and its resolution.
- **Phase 3:** `map-screen/scale-and-grid.md` requirement 10 for grid canvas sizing; `map-screen/fog-of-war.md` requirements 10 and 11 only if the trailing-timer path is taken.

## Testing

- `src/__tests__/map-screen-panel-aoe.test.ts` — a drag over a zero-width stage leaves the AoE untouched; a `sizeFt` edit repaints without a host re-render.
- A new case covering `renderFromBackground()` deferring while a drag is active and flushing on release.
- Phase 2 adds unit coverage for `MapStage` conversions and repaint coalescing.
- `make test-visual` is informational. If Phase 2's thumbnail moves a baseline, it is refreshed with `make test-visual-update` **inside the container** — host-rendered PNGs always diff.

## Out of scope

- `src/map/transform.ts` and `src/map/aoe.ts`. They work, they are total over non-finite input, and they are covered.
- The D&D Beyond poller and its cadence. The defect is that the panel rebuilds wholesale on each update, not that it polls. Narrowing `render()` is a larger refactor that deserves its own cycle.
- Anything outside the battlemap preview.
