// One drag implementation for mouse, touch and pen. Pointer events deliver
// all three, so the DM panel's gestures work with a finger on a tablet with
// the code the mouse already uses.
//
// The listeners sit on the document rather than the element: a drag that
// leaves the element, or ends off-window, still finishes. `pointercancel`
// matters on touch — the browser fires it when it takes the gesture over
// (a scroll, a system edge swipe), and without handling it the drag would
// never end. An element that starts a drag needs `touch-action: none`, or
// the browser claims the gesture before the first move arrives.

export interface DragOptions {
  onMove: (e: PointerEvent) => void;
  onEnd?: (e: PointerEvent) => void;
  // Runs whichever way the drag finishes, including a cancel.
  onRelease?: () => void;
}

export function trackPointerDrag(start: PointerEvent, opts: DragOptions): () => void {
  const id = start.pointerId;
  const move = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    opts.onMove(e);
  };
  const finish = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    cleanup();
    opts.onEnd?.(e);
  };
  const cleanup = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", finish);
    document.removeEventListener("pointercancel", finish);
    opts.onRelease?.();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", finish);
  return cleanup;
}

// A finger that travels further than this was panning or pinching, not
// pressing a point.
export const TAP_SLOP = 12;

export type GestureIntent = "tap" | "stroke";

export interface GestureOptions {
  // What the gesture does, run once, at the moment the gesture is committed
  // to. A gesture whose work is all in `onMove` leaves it out and is still
  // gated the same way.
  act?: (e: PointerEvent) => void;
  onMove?: (e: PointerEvent) => void;
  onEnd?: (e: PointerEvent) => void;
  // "tap": a finger that slides was panning and does nothing. "stroke": a
  // finger that slides starts the gesture where it landed.
  intent?: GestureIntent;
  slop?: number;
}

// A cursor acts on the press, because nothing else can arrive. A finger cannot:
// the first finger of a pinch looks exactly like a press, so the action waits
// until the gesture is unambiguous — the finger lifted where it landed (a tap),
// or it started travelling (a stroke). Until then nothing is painted, toggled
// or revealed, and `onEnd` runs only for a gesture that acted, so cancelling
// the returned disposer — which is what a pinch does — commits nothing.
export function trackTapOrDrag(start: PointerEvent, opts: GestureOptions): () => void {
  const defer = start.pointerType === "touch" || start.pointerType === "pen";
  const slop = opts.slop ?? TAP_SLOP;
  const stroke = opts.intent === "stroke";
  let acted = false;
  const act = (e: PointerEvent) => {
    if (acted) return;
    acted = true;
    opts.act?.(e);
  };
  if (!defer) act(start);
  let travelled = false;
  return trackPointerDrag(start, {
    onMove: (m) => {
      if (!travelled && Math.hypot(m.clientX - start.clientX, m.clientY - start.clientY) > slop) {
        travelled = true;
        // The stroke belongs to the point the finger landed on, not to the
        // point where it crossed the slop.
        if (defer && stroke) act(start);
      }
      if (acted) opts.onMove?.(m);
    },
    onEnd: (e) => {
      if (defer && !travelled) act(e);
      if (acted) opts.onEnd?.(e);
    },
  });
}

export const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

// Touch has no right button, so a long press stands in for the context menu.
// A mouse keeps using `contextmenu`; this only arms for touch and pen.
export function onLongPress(el: HTMLElement, run: (e: PointerEvent) => void): () => void {
  let timer: number | null = null;
  const stop = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  const down = (e: PointerEvent) => {
    if (e.pointerType === "mouse") return;
    const { clientX, clientY } = e;
    stop();
    timer = window.setTimeout(() => {
      timer = null;
      run(e);
    }, LONG_PRESS_MS);
    const moved = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId) return;
      if (Math.hypot(m.clientX - clientX, m.clientY - clientY) > LONG_PRESS_SLOP) stop();
    };
    const up = () => {
      stop();
      document.removeEventListener("pointermove", moved);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
    };
    document.addEventListener("pointermove", moved);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
  };
  el.addEventListener("pointerdown", down);
  return () => {
    stop();
    el.removeEventListener("pointerdown", down);
  };
}

// Safari fires its own gesture events for a pinch, which zoom the whole page
// on top of whatever the element does. Suppressing them keeps a two-finger
// gesture inside the map.
export function blockWebkitGestures(el: HTMLElement): () => void {
  const stop = (e: Event) => e.preventDefault();
  const names = ["gesturestart", "gesturechange", "gestureend"];
  for (const name of names) el.addEventListener(name, stop);
  return () => {
    for (const name of names) el.removeEventListener(name, stop);
  };
}
