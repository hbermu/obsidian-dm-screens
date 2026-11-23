// Pinch-to-zoom and two-finger pan for the exploration stage. A mouse has a
// wheel and a tablet has two fingers, so both drive the same view state: a
// zoom factor and a pixel offset from the stage centre, which the caller puts
// on the stage's CSS transform.
//
// Two fingers never mean "explore": the first finger of a pinch must not toggle
// a door, so `onStart` lets the caller cancel whatever the single-finger path
// had begun.

export interface StageView {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export const IDENTITY_VIEW: StageView = { zoom: 1, offsetX: 0, offsetY: 0 };
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;

// Past the stage edge there is nothing to look at, so the offset is capped at
// the overhang the zoom creates. At zoom 1 that is 0 and the map re-centres.
export function clampView(view: StageView, width: number, height: number): StageView {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom));
  const maxX = ((zoom - 1) * width) / 2;
  const maxY = ((zoom - 1) * height) / 2;
  return {
    zoom,
    offsetX: Math.min(maxX, Math.max(-maxX, view.offsetX)),
    offsetY: Math.min(maxY, Math.max(-maxY, view.offsetY)),
  };
}

// Keeps the content under the anchor where it is, so the map grows around the
// fingers (or the cursor) instead of around the stage centre. Anchor
// coordinates are pixels from the stage centre.
export function zoomAbout(
  view: StageView,
  nextZoom: number,
  anchorX: number,
  anchorY: number,
  width: number,
  height: number
): StageView {
  const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
  const ratio = target / view.zoom;
  return clampView(
    {
      zoom: target,
      offsetX: anchorX - (anchorX - view.offsetX) * ratio,
      offsetY: anchorY - (anchorY - view.offsetY) * ratio,
    },
    width,
    height
  );
}

export function panBy(view: StageView, dx: number, dy: number, width: number, height: number): StageView {
  return clampView({ ...view, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy }, width, height);
}

export interface PinchOptions {
  view: () => StageView;
  apply: (view: StageView) => void;
  // The stage's own box, which the offset clamp is measured against.
  size: () => { width: number; height: number };
  // Fires once per gesture, when the second finger lands.
  onStart?: () => void;
}

interface Baseline {
  distance: number;
  midX: number;
  midY: number;
  view: StageView;
}

export function trackPinch(el: HTMLElement, opts: PinchOptions): () => void {
  const points = new Map<number, { x: number; y: number }>();
  let baseline: Baseline | null = null;

  const centre = () => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  // Relative to the stage centre, which is what the offset is measured from.
  const spread = () => {
    const [a, b] = [...points.values()];
    const c = centre();
    return {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      midX: (a.x + b.x) / 2 - c.x,
      midY: (a.y + b.y) / 2 - c.y,
    };
  };

  const down = (e: PointerEvent) => {
    if (e.pointerType === "mouse") return;
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size !== 2) return;
    baseline = { ...spread(), view: opts.view() };
    opts.onStart?.();
  };

  const move = (e: PointerEvent) => {
    if (!points.has(e.pointerId)) return;
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!baseline || points.size !== 2) return;
    e.preventDefault();
    const now = spread();
    if (!(baseline.distance > 0)) return;
    const { width, height } = opts.size();
    const zoomed = zoomAbout(
      baseline.view,
      (baseline.view.zoom * now.distance) / baseline.distance,
      baseline.midX,
      baseline.midY,
      width,
      height
    );
    opts.apply(panBy(zoomed, now.midX - baseline.midX, now.midY - baseline.midY, width, height));
  };

  // A third finger, or one lifted, invalidates the baseline: the next pair
  // starts its own gesture rather than jumping by the difference.
  const up = (e: PointerEvent) => {
    if (!points.delete(e.pointerId)) return;
    if (points.size < 2) baseline = null;
  };

  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
  };
}

// A trackpad pinch and a ctrl-wheel arrive the same way, so the desktop keeps
// the gesture it already understands. A plain wheel is left alone — the modal
// has scrollable windows over the stage.
export function trackWheelZoom(el: HTMLElement, opts: Omit<PinchOptions, "onStart">): () => void {
  const wheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const view = opts.view();
    const { width, height } = opts.size();
    const factor = Math.exp(-e.deltaY / 300);
    opts.apply(
      zoomAbout(
        view,
        view.zoom * factor,
        e.clientX - (r.left + r.width / 2),
        e.clientY - (r.top + r.height / 2),
        width,
        height
      )
    );
  };
  el.addEventListener("wheel", wheel, { passive: false });
  return () => el.removeEventListener("wheel", wheel);
}
