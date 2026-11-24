# Fog Drawing Tools

> Six tools split into two rows: reveal (outlined icons) clears fog, fog (filled icons) adds fog. Each row has a circle, a rectangle, and a freehand brush.

## Source files

- `src/views/DmControlPanel.ts` — `createFogToolBtn`, `setupInlineFogDrawing`, `applyFreehand`, `applyShape`, `refreshOverlay`, `fogTool` state

## Settings used

- `none`

## Requirements

1. The DM panel shall expose six tool buttons when `layer.fogEnabled` is true: `reveal-circle`, `reveal-rect`, `reveal-eraser` (reveal row); `fog-circle`, `fog-rect`, `fog-pen` (fog row).
2. When the user clicks a tool button, the DM panel shall set `fogTool` to the tool's identifier and `fogEditLayerId` to the layer's id.
3. The currently selected tool's button shall carry the `dm-fog-tool-active` CSS class.
4. The reveal tools shall draw with composite operation `destination-out`. The fog tools shall draw with composite operation `source-over` and fill colour black.
5. The freehand tools (`reveal-eraser`, `fog-pen`) shall apply a filled circle of radius `fogCanvas.width * 0.05` at every pointer move while the pointer is down, for a cursor, a finger and a pen alike (`../map-screen/touch-input.md` requirement 1).
6. The shape tools (`*-circle`, `*-rect`) shall draw a preview outline on the inline canvas while the pointer drags, and commit the filled shape to the offscreen fog canvas on release.
7. The circle tools shall commit an ellipse defined by the bounding rectangle of (press, release). The rectangle tools shall commit the bounding rectangle directly.
8. If the bounding rectangle's width AND height are both 3 fog-canvas pixels or less, the shape tool shall not commit anything on release. (A drag where either dimension exceeds 3 px still commits — that lets the DM draw thin rectangles deliberately.)
9. When a draw completes (release, or `pointerleave` for freehand), the DM panel shall encode the offscreen fog canvas back to a data URL via `syncFogToLayer`, store it in `layer.fogDataUrl`, broadcast `image-layers-sync`, and update the preview fog overlay.
10. If the Shift key is held on the release that finishes a stroke (any tool — shape or freehand, including the `pointerleave` path that closes a freehand stroke that exits the canvas), the panel shall stay in fog-edit mode; otherwise it shall exit fog-edit mode and re-render. A finger carries no Shift, so a touch stroke always leaves fog-edit mode.
11. While a touch or pen pointer draws, the stroke shall begin only once the gesture is unambiguous — the finger lifted where it landed, or it started travelling — so the first finger of a pinch paints nothing (`../map-screen/touch-input.md` requirement 15). A tap stamps once at the point pressed.

## Tests covering this

(No direct unit test of the drawing path; the canvas APIs are not available under happy-dom. The fog state changes are exercised indirectly via the layer-controls tests in `dm-control-combat.test.ts`.)

## Non-goals

- Adjustable brush size or shape.
- Polygon / lasso tools.
- Bucket-fill or auto-detect of regions.
- Smoothing strokes with Bezier interpolation.
- Pressure sensitivity / pen tablet support.
