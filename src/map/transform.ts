import type { MapGridConfig, MapRotation, MapView, ScreenProfile, StoredMapState } from "./types";

// CSS reference DPI — browsers cannot report the true physical DPI of a
// display, so this is the only honest fallback when no screen profile exists.
export const FALLBACK_PPI = 96;
export const DEFAULT_PX_PER_SQUARE = 140;

// These numbers arrive from a WebSocket payload, from a saved screen profile, or
// from a map config persisted by an earlier version. A NaN or Infinity reaching a
// CSS transform blanks the map screen silently, with nothing in the console, so
// every entry point coerces instead of trusting its caller.
export function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export const DEFAULT_GRID_CONFIG: MapGridConfig = {
  pxPerSquare: DEFAULT_PX_PER_SQUARE,
  gridOffsetX: 0,
  gridOffsetY: 0,
  showGrid: false,
  gridColor: "#000000",
  gridOpacity: 0.35,
};

export function defaultMapState(
  naturalWidth: number,
  naturalHeight: number,
  pxPerSquare: number = DEFAULT_PX_PER_SQUARE
): StoredMapState {
  return {
    ...DEFAULT_GRID_CONFIG,
    pxPerSquare: pxPerSquare > 0 ? pxPerSquare : DEFAULT_PX_PER_SQUARE,
    mode: "fit",
    panX: naturalWidth / 2,
    panY: naturalHeight / 2,
    rotation: 0,
  };
}

// Map point → screen direction under a CSS `rotate(θ)` (clockwise, y-down).
export function rotatePoint(
  rawX: number,
  rawY: number,
  rotation: MapRotation
): { x: number; y: number } {
  const x = finiteOr(rawX, 0);
  const y = finiteOr(rawY, 0);
  switch (rotation) {
    case 90: return { x: -y, y: x };
    case 180: return { x: -x, y: -y };
    case 270: return { x: y, y: -x };
    default: return { x, y };
  }
}

export function rotatedSize(
  naturalWidth: number,
  naturalHeight: number,
  rotation: MapRotation
): { width: number; height: number } {
  return rotation % 180 === 0
    ? { width: naturalWidth, height: naturalHeight }
    : { width: naturalHeight, height: naturalWidth };
}

export function profileKey(width: number, height: number, devicePixelRatio: number): string {
  return `${width}x${height}@${devicePixelRatio}`;
}

export function cssPixelsPerInch(
  width: number,
  height: number,
  profile: ScreenProfile | null | undefined
): number {
  if (!profile || !(profile.diagonalInches > 0)) return FALLBACK_PPI;
  const w = finiteOr(width, 0);
  const h = finiteOr(height, 0);
  if (!(w > 0) || !(h > 0)) return FALLBACK_PPI;
  const fineTune = finiteOr(profile.fineTune, 1) > 0 ? finiteOr(profile.fineTune, 1) : 1;
  return (Math.hypot(w, h) / profile.diagonalInches) * fineTune;
}

export function mapScale(
  view: MapView,
  ppi: number,
  pxPerSquare: number,
  naturalWidth: number,
  naturalHeight: number,
  viewportWidth: number,
  viewportHeight: number
): number {
  if (view.mode === "fit") {
    if (!(naturalWidth > 0) || !(naturalHeight > 0)) return 1;
    const vw = finiteOr(viewportWidth, 0);
    const vh = finiteOr(viewportHeight, 0);
    if (!(vw > 0) || !(vh > 0)) return 1;
    const rotated = rotatedSize(naturalWidth, naturalHeight, view.rotation ?? 0);
    return Math.min(vw / rotated.width, vh / rotated.height);
  }
  const square = finiteOr(pxPerSquare, DEFAULT_PX_PER_SQUARE);
  return (
    finiteOr(ppi, FALLBACK_PPI) / (square > 0 ? square : DEFAULT_PX_PER_SQUARE)
  );
}

// Translation for `translate(tx,ty) rotate(θ) scale(s)` (screen = T + s·R·p):
// the pan point lands at the viewport center. Fit mode pans to the map
// center, which also centers the rotated bounding box.
export function mapTranslation(
  view: MapView,
  scale: number,
  naturalWidth: number,
  naturalHeight: number,
  viewportWidth: number,
  viewportHeight: number
): { tx: number; ty: number } {
  const rotation = view.rotation ?? 0;
  const pan =
    view.mode === "fit"
      ? { x: finiteOr(naturalWidth, 0) / 2, y: finiteOr(naturalHeight, 0) / 2 }
      : { x: finiteOr(view.panX, 0), y: finiteOr(view.panY, 0) };
  const r = rotatePoint(pan.x, pan.y, rotation);
  const s = finiteOr(scale, 1);
  return {
    tx: finiteOr(viewportWidth, 0) / 2 - r.x * s,
    ty: finiteOr(viewportHeight, 0) / 2 - r.y * s,
  };
}

// Which map-axis lattice feeds each screen axis under rotation, as signed
// map-pixel offsets for gridLinePositions (vertical = screen-x lines,
// horizontal = screen-y lines).
export function gridAxisOffsets(
  rotation: MapRotation,
  gridOffsetX: number,
  gridOffsetY: number
): { vertical: number; horizontal: number } {
  switch (rotation) {
    case 90: return { vertical: -gridOffsetY, horizontal: gridOffsetX };
    case 180: return { vertical: -gridOffsetX, horizontal: -gridOffsetY };
    case 270: return { vertical: gridOffsetY, horizontal: -gridOffsetX };
    default: return { vertical: gridOffsetX, horizontal: gridOffsetY };
  }
}

// Keeps the physical-mode window inside the map: no black edge is ever
// visible, and an axis where the map is smaller than the window centers.
// A degenerate scale makes halfVis infinite, which also centers both axes.
export function clampPan(
  panX: number,
  panY: number,
  naturalWidth: number,
  naturalHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  scale: number,
  rotation: MapRotation
): { panX: number; panY: number } {
  const nw = finiteOr(naturalWidth, 0);
  const nh = finiteOr(naturalHeight, 0);
  const window = rotatedSize(finiteOr(viewportWidth, 0), finiteOr(viewportHeight, 0), rotation);
  const s = finiteOr(scale, 1);
  const halfVisW = window.width / (2 * s);
  const halfVisH = window.height / (2 * s);
  const minX = Math.min(halfVisW, nw / 2);
  const maxX = Math.max(nw - halfVisW, nw / 2);
  const minY = Math.min(halfVisH, nh / 2);
  const maxY = Math.max(nh - halfVisH, nh / 2);
  return {
    panX: finiteOr(Math.min(Math.max(finiteOr(panX, 0), minX), maxX), 0),
    panY: finiteOr(Math.min(Math.max(finiteOr(panY, 0), minY), maxY), 0),
  };
}

// Screen-space positions of grid lines along one axis. `mapOriginOnScreen` is
// the translation of the map's 0 coordinate; the grid lattice starts at
// `gridOffsetMapPx` in map pixels. Pitches at or below 1 screen px would paint
// a solid fill, so nothing is returned for them.
export function gridLinePositions(
  mapOriginOnScreen: number,
  gridOffsetMapPx: number,
  pxPerSquare: number,
  scale: number,
  viewportExtent: number
): number[] {
  const pitch = pxPerSquare * scale;
  if (!(pitch > 1)) return [];
  const origin = mapOriginOnScreen + gridOffsetMapPx * scale;
  const first = origin - Math.floor(origin / pitch) * pitch;
  const positions: number[] = [];
  for (let p = first; p <= viewportExtent; p += pitch) positions.push(p);
  return positions;
}
