# Map Screen Touch Input

> The DM panel's map gestures work with a finger. Every drag, hit-test and context action in the Map Screen section and Exploration Mode is written once against Pointer Events, so a mouse, a finger and a pen all drive the same code; on top of that the stage takes a two-finger pinch to zoom and pan, a finger explores on the lift rather than the press so a pinch never toggles a door, a long press stands in for the right-click a touchscreen does not have, and hit targets grow to a finger's size while the drawn markers stay small. This is what lets a tablet or a phone run the session (`../remote-server/overview.md`), and it changes nothing for a DM on a mouse.

## Source files

- `src/views/pointerDrag.ts` — `trackPointerDrag` (one drag for mouse, touch and pen, listening on `document` and filtered by `pointerId`), `LONG_PRESS_MS`, `onLongPress`, `blockWebkitGestures`
- `src/views/pinchZoom.ts` — `StageView`, `IDENTITY_VIEW`, `MIN_ZOOM`, `MAX_ZOOM`, `clampView`, `zoomAbout`, `panBy`, `trackPinch`, `trackWheelZoom`
- `src/views/MapExploreModal.ts` — the exploration stage's pinch/wheel zoom, the deferred exploration tap, long-press AoE removal, `blockWebkitGestures` on the modal
- `src/views/MapScreenPanel.ts` — `trackDrag(start: PointerEvent, onMove, onEnd?)`: the panel-side drags (pan preview, viewport rectangle, AoE and vision dots) over the same helper
- `styles.css` — the `Touch` block: `touch-action: none` on every drag surface, and the `@media (pointer: coarse)` rules that grow the hit targets
- `test/visual/harness/touch-entry.ts` — the harness page that runs the two gesture modules and the real stylesheet under a browser's own fingers

## Settings used

- none

## Requirements

1. Every DM-side map gesture shall be driven by Pointer Events (`pointerdown`/`pointermove`/`pointerup`/`pointercancel`), so one implementation serves a mouse, a finger and a pen. No map gesture listens for `mousedown`, `mousemove` or `mouseleave`.
2. `trackPointerDrag(start, { onMove, onEnd?, onRelease? })` shall attach its `pointermove`, `pointerup` and `pointercancel` listeners to `document` and ignore every event whose `pointerId` differs from the starting one, so a drag survives leaving the element and a second finger never steers it. It returns a function that detaches the listeners; `onRelease` runs whichever way the drag ends, including that teardown, and `onEnd` runs only on a real `pointerup`/`pointercancel`.
3. When the browser takes a gesture over and fires `pointercancel`, `trackPointerDrag` shall end the drag exactly as a `pointerup` does, so no drag or drag lock can outlive the finger.
4. Every element that starts a drag shall carry `touch-action: none` (`.dm-explore-overlay`, `.dm-explore-markers`, `.dm-explore-inner`, `.dm-map-preview-stage`, `.dm-fog-stage`, the AoE/vision dots and handles, the viewport rectangles), or the browser would claim the gesture for a scroll and cancel the pointer stream mid-drag. The exploration stage itself shall not, so the AoE, Vision and Combat windows floating over it keep scrolling under a finger.
5. While the pointer is coarse (`@media (pointer: coarse)`), the marker hit areas shall grow to a finger's size through the `::before` inset (`-17px × var(--dm-map-zoom)`, against `-9px` on a fine pointer) without changing what is drawn, and the bar buttons (`.dm-explore-bar button`, `.dm-section-actions button`, `.dm-explore-open-btn`) shall be at least 44 px in both dimensions.
6. `onLongPress(el, run)` shall run `run` when a touch or pen pointer is held on `el` for `LONG_PRESS_MS` (500) without travelling more than 10 px, and shall not arm for a mouse, which has a button of its own. Lifting, cancelling or moving beyond the slop before the timer fires cancels it. It returns a disposer that clears the timer and detaches.
7. The Exploration Mode markers shall offer a long press as the touch equivalent of the right-click that removes an AoE (`fog-of-war.md` requirement 52), and the handlers shall be torn down with each `renderMarkers` and on close so a re-render leaves no duplicate.
8. `blockWebkitGestures(el)` shall `preventDefault` WebKit's own `gesturestart`, `gesturechange` and `gestureend` on `el`, so a pinch inside the stage does not also zoom the whole Obsidian window on iOS and macOS Safari. Exploration Mode applies it to `modalEl` and drops it on close.

### Pinch, wheel and the stage view

9. The exploration stage's view shall be a `StageView` of `{ zoom, offsetX, offsetY }` — the offset in pixels from the stage centre — applied to `.dm-explore-inner` as `translate(calc(-50% + offsetX px), calc(-50% + offsetY px)) scale(zoom) rotate(<map rotation>deg)`. Every client↔fog conversion reads the overlay's live bounding rect (`fog-of-war.md` requirement 45), so the zoom needs no maths of its own and hit-testing stays correct at any zoom.
10. `clampView` shall hold the zoom in `MIN_ZOOM`..`MAX_ZOOM` (1..6) and each offset within the overhang the zoom creates (`(zoom − 1) × size / 2`), so the map cannot be pushed off the stage and returns to centred at zoom 1.
11. `zoomAbout(view, nextZoom, anchorX, anchorY, width, height)` shall keep the content under the anchor in place — `offset' = anchor − (anchor − offset) × nextZoom / zoom` — so the map grows around the fingers or the cursor rather than the stage centre, and shall clamp the result.
12. When a second touch or pen pointer lands on the stage, `trackPinch` shall start a gesture from the current spread, midpoint and view, and call `onStart`. While two pointers are down it shall apply `zoomAbout` at the starting midpoint with the zoom scaled by `distance / startDistance`, then pan by the midpoint's travel, so a pinch zooms and two fingers moving together pan. It shall ignore a mouse and a single finger.
13. When a pointer is lifted or cancelled, `trackPinch` shall drop the baseline, so the next pair of fingers starts its own gesture instead of resuming from the old spread.
14. When a pinch starts, Exploration Mode shall abandon the exploration tap the first finger began (requirement 15), so no door is toggled and no room is revealed by a zoom.
15. When a touch or pen pointer presses the exploration overlay, the modal shall defer the door/room gesture (`fog-of-war.md` requirements 46–48) until the pointer lifts, and run it only if the finger travelled no more than 12 px and the gesture was not taken over by a pinch. A mouse or any other pointer type acts on the press as before.
16. `trackWheelZoom` shall zoom about the cursor on a `wheel` carrying `ctrlKey` or `metaKey` — which is how a trackpad pinch arrives — by `exp(−deltaY / 300)`, and `preventDefault` it. A plain wheel shall be left alone, because the windows floating over the stage scroll with it.
17. The Exploration Mode bar shall carry a zoom button (`dm-explore-zoom-btn`) before the Scale toggle, reading `Zoom: <n>%` and carrying `dm-fog-active` while zoomed in. Clicking it while zoomed in shall return the stage to fit (`IDENTITY_VIEW`); at fit it does nothing.
18. While the stage is zoomed, `.dm-explore-inner` shall carry `--dm-map-zoom` set to the zoom, so the marker dots counter-scale and their touch targets stay the same size on screen however far the map is zoomed in (requirement 5).
19. On close, the modal shall detach the pinch and wheel listeners and reset the stage view to `IDENTITY_VIEW`, so the next session opens at fit.

## Tests covering this

- `src/__tests__/pointer-drag.test.ts` — `trackPointerDrag` follows its own pointer and ignores a second finger, ends on release, ends on `pointercancel`, and can be torn down mid-drag without firing `onEnd`; `onLongPress` fires for a held finger, never for a mouse, and not when the finger moves away or lifts first; `blockWebkitGestures` cancels Safari's pinch events until disposed (reqs 2, 3, 6, 8)
- `src/__tests__/pinch-zoom.test.ts` — the stage-view maths (zoom clamp, overhang clamp and re-centring at fit, anchor preservation, round trip back to fit, pan clamp) and the trackers: a spread zooms by its ratio, a moving midpoint pans, a single finger and a mouse are ignored, a lifted finger starts a fresh gesture, disposal detaches; `trackWheelZoom` zooms a ctrl/meta wheel about the cursor and leaves a plain wheel alone (reqs 10–13, 16)
- `src/__tests__/map-explore-modal.test.ts` — the touch cases: a tap explores on the lift and not the press, a finger that slides explores nothing, a second finger takes the gesture over (no fog commit, the stage at `scale(2)`), the zoom button reports the zoom and resets it to fit, and a closed modal no longer zooms (reqs 14, 15, 17–19)
- `src/__tests__/map-screen-panel-aoe.test.ts` — the panel's drags start from a `PointerEvent`, hold and release the panel drag lock, and a newer drag tears the previous one down without running its `onEnd` (reqs 1, 2)
- `test/visual/touch.spec.ts` — real fingers in Chromium and WebKit against the harness page carrying the shipped stylesheet: the tablet profiles report a coarse pointer while the drawn dot stays small, the drag surfaces are `touch-action: none` and the floating windows are not, a tap explores on the lift as `touch`, a tap 15 px off a marker still hits it, holding a marker fires the long press; and under Chromium's touch injection: a marker drag keeps the whole pointer stream with no cancel, a finger dragged across the map explores nothing, a pinch out zooms to 2× while exploring nothing, and a pinch back in returns the stage to fit (reqs 4, 5, 7, 12, 14, 15)

## Non-goals

- Touch in the Fog and Walls editor, the Hydrus explorer and the player-screen panels. Those still assume a cursor; only the Map Screen section and Exploration Mode are converted.
- Rotating the map with two fingers. Rotation stays the bar's 90° steps, because the map screen's rotation is a per-screen orientation rather than a free angle.
- Zooming what the players see. The stage view is the DM's own magnifier; it broadcasts nothing, and the players' window is still moved by the viewport rectangle (`fog-of-war.md` requirement 51).
- Multi-touch on more than two pointers. A third finger invalidates the gesture rather than starting a new kind of one.
