// Geometry shared by the DM pan preview and the Exploration modal. Both
// letterbox-fit a rotated map box into a container and convert screen deltas
// through a measured scale. The map screen at /map does not: it fills the
// viewport. The fog editor does not either: it sizes through a CSS aspect-ratio
// and never rotates. The canvas plumbing both previews also share with the map
// client lives in ../map/canvas.

export function fitScale(
  containerWidth: number,
  containerHeight: number,
  rotatedWidth: number,
  rotatedHeight: number
): number | null {
  if (!(containerWidth > 0) || !(containerHeight > 0)) return null;
  if (!(rotatedWidth > 0) || !(rotatedHeight > 0)) return null;
  const scale = Math.min(containerWidth / rotatedWidth, containerHeight / rotatedHeight);
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

// A detached or hidden element measures zero, and dividing by it yields
// ±Infinity, which a map-bounds clamp turns into "snap to the edge". Callers
// pass their measured scale through here and refuse the gesture on null.
export function finiteScale(scale: number): number | null {
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

// The rotation handle sits at the shape's tip. On a map reduced to fit a phone
// that can put it a handful of screen pixels from the anchor dot — far closer
// than two touch targets are wide — and the handle, drawn later, took every
// press meant to move the AoE. It is pushed out to a minimum on-screen
// distance instead: the lever gets longer, the angle it reports does not
// change. An unmeasurable stage keeps the shape's own distance.
export const MIN_HANDLE_GAP_PX = 48;

export function handleDistance(shapeDistance: number, scale: number | null): number {
  if (scale === null || !(scale > 0)) return shapeDistance;
  return Math.max(shapeDistance, MIN_HANDLE_GAP_PX / scale);
}
