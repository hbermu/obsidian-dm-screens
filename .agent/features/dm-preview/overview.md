# DM Preview

> A scaled, pannable, zoomable canvas in the DM Control Panel that mirrors what the player screen displays. The DM manipulates layers directly on the preview; pan and zoom are local to the DM and are not broadcast to players.

## Source files

- `src/views/DmControlPanel.ts` — `renderPlayerScreenSection` builds the preview area, `setupPreviewPanZoom` binds middle-click pan handlers (no wheel zoom — see `pan-zoom.md`), `resetDmView`, `getEffectiveResolution`, `getPlayerViewport`
- `src/views/MapScreenPanel.ts` — the map pan preview renders a source label chip
- `src/sourceLabel.ts` — `resolveSourceLabel` computes human labels shown in the preview chips
- `src/player/player.ts` — `updateViewport` consumes `viewport-update` payloads (the player-side analogue to DM pan/zoom; currently used only via the broadcaster, not bound to a DM control)
- `styles.css` — `.dm-preview-bg`, `.dm-map-preview-stage`, `.dm-source-label` chip styling

## Settings used

- `tvWidth`, `tvHeight` — fallback resolution (1920×1080) used when no client is connected

## Requirements

1. The preview area shall have an aspect ratio equal to the effective resolution's `width / height`.
2. The effective resolution shall be the resolution of the selected connected client (set via the resolution badges in `../multi-screen/overview.md`), or the first connected client's resolution, or `(tvWidth, tvHeight)` as a fallback.
3. The preview's inner container shall apply `transform: translate(<dmPanX>%, <dmPanY>%) scale(<dmZoom>)`, where `dmZoom` defaults to `1`, `dmPanX` to `0`, and `dmPanY` to `0` on every open.
4. The preview shall render every image layer with its percentage geometry, sorted by `zIndex` ascending, with the colour-swatch border and label overlay used for DM affordance (one of eight rotating colours per layer index).
5. When a layer is hidden (`layer.visible === false`), the preview shall render it with `opacity: 0.25` and a dashed border.
6. Pan/zoom controls are specified in `pan-zoom.md`.
7. The green viewport indicator (when exactly one client is connected) is specified in `viewport-indicator.md`.
8. `render()` shall preserve the panel's scroll position across full rebuilds: the container's `scrollTop` is captured before emptying and re-applied after the rebuild (and once more on the next animation frame, since the map pan preview sizes itself a frame later).
9. Each top-level panel section (Player Screen Server, Player Screen, Map Screen, COMBAT) shall be collapsible by clicking its title: `makeCollapsible` adds a ▾/▸ chevron to the title, and while collapsed only the section's first child (the title, or COMBAT's header row with the Live indicator) stays visible. The state lives in the in-memory `collapsedSections` set — it survives re-renders (toggling flips a CSS class without re-rendering) but resets when the panel reopens; all sections start expanded. The Media from Hydrus bar between the first two sections is not a section and never collapses (`../hydrus-integration/overview.md` requirement 1).
10. The background preview overlay and the map preview stage shall each render a `.dm-source-label` chip at their top-left corner (see `../background-media/overview.md` requirement 22 and `../map-screen/overview.md` requirement 22). The chip displays the resolved label with ellipsis overflow, is absolutely positioned, never wider than the preview, and shows the full hash or filename in its `title` attribute. When `.dm-source-label` has the `.dm-explore-title` modifier (used in the Exploration Mode bar per `../map-screen/overview.md` requirement 23), it shall not be absolutely positioned and shall use `flex: 1 1 auto; min-width: 0` to ellipsise within the bar's flex layout.
11. The plugin UI shall define CSS custom properties `--dm-radius: 8px` and `--dm-radius-lg: 12px` on `.dm-control-panel`, `.dm-hydrus-modal`, `.dm-send-modal`, `.dm-fog-modal`, and `.dm-explore-modal`. Every `border-radius` in `styles.css` (except `50%` and radii ≤ 3px) shall use one of these variables: `var(--dm-radius)` for radii 4–10px, `var(--dm-radius-lg)` for 12px.

## Tests covering this

- `src/__tests__/effective-resolution.test.ts` — `getEffectiveResolution` falls back through selected → first-client → settings
- `src/__tests__/viewport-calc.test.ts` — `getPlayerViewport` math used by fit / align buttons and the indicator

## Non-goals

- Broadcasting DM pan/zoom to players (DM pan/zoom is intentionally local).
- Multi-monitor DM view. Exactly one DM preview canvas.
- Animating DM pan/zoom transitions. Transforms apply immediately on each event.
- Per-layer rotation in the preview interaction. Rotation is handled via the rotation buttons in `../image-layers/layer-controls.md`; the preview just applies the resulting CSS transform.
