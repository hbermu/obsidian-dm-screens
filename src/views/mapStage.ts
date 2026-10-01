// Geometry plumbing shared by the DM pan preview and the Exploration modal.
// Both letterbox-fit a rotated map box into a container, convert screen deltas
// through a measured scale, repaint a canvas overlay on every pointer move, and
// size that canvas to the box. The map screen at /map does not: it fills the
// viewport. The fog editor does not either: it sizes through a CSS aspect-ratio
// and never rotates.

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

// Assigning canvas.width or .height reallocates the backing store and re-uploads
// a GPU texture even when the value is unchanged. A drag repaints on every
// pointer move, so the assignment is guarded.
export function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): boolean {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}

export interface RepaintScheduler {
  schedule: () => void;
  cancel: () => void;
}

// Pointer moves arrive faster than frames. Coalescing into one repaint per frame
// also keeps every measurement ahead of the style writes it feeds, which is what
// stops the read-after-write layout thrashing.
export function createRepaintScheduler(repaint: () => void): RepaintScheduler {
  let frame: number | null = null;
  return {
    schedule: () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        repaint();
      });
    },
    cancel: () => {
      if (frame === null) return;
      cancelAnimationFrame(frame);
      frame = null;
    },
  };
}
