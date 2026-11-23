import { blockWebkitGestures, onLongPress, trackPointerDrag } from "../../../src/views/pointerDrag";
import { IDENTITY_VIEW, trackPinch, trackWheelZoom, type StageView } from "../../../src/views/pinchZoom";

// A stand-in for the exploration stage: the same markup, the same classes out
// of the plugin's real stylesheet and the same gesture modules, with the panel
// and Obsidian left out. It exists so a real browser's real fingers drive the
// touch code — `touch-action`, hit sizes and the pointer sequences a tablet
// actually sends are things no DOM double can tell us about.

interface Probe {
  view: StageView;
  tapped: Array<{ x: number; y: number }>;
  dotDrag: Array<{ x: number; y: number }>;
  dotPresses: number;
  cancels: number;
  dotLongPress: number;
  pointerTypes: string[];
  pinchStarts: number;
}

const TAP_SLOP = 12;

const probe: Probe = {
  view: { ...IDENTITY_VIEW },
  tapped: [],
  dotDrag: [],
  dotPresses: 0,
  cancels: 0,
  dotLongPress: 0,
  pointerTypes: [],
  pinchStarts: 0,
};
(window as unknown as { __touch: Probe }).__touch = probe;

const stage = document.querySelector(".dm-explore-stage") as HTMLElement;
const inner = document.querySelector(".dm-explore-inner") as HTMLElement;
const overlay = document.querySelector(".dm-explore-overlay") as HTMLElement;
const dot = document.querySelector(".dm-map-aoe-dot") as HTMLElement;

const size = () => ({ width: inner.clientWidth, height: inner.clientHeight });
const applyView = (view: StageView) => {
  probe.view = view;
  inner.style.transform =
    `translate(calc(-50% + ${view.offsetX}px), calc(-50% + ${view.offsetY}px)) scale(${view.zoom})`;
  inner.style.setProperty("--dm-map-zoom", String(view.zoom));
};
applyView(probe.view);

let cancelTap: (() => void) | null = null;
const abortTap = () => {
  const cancel = cancelTap;
  cancelTap = null;
  cancel?.();
};

overlay.addEventListener("pointerdown", (e) => {
  probe.pointerTypes.push(e.pointerType);
  e.preventDefault();
  if (e.pointerType !== "touch" && e.pointerType !== "pen") {
    probe.tapped.push({ x: e.clientX, y: e.clientY });
    return;
  }
  abortTap();
  const { clientX: sx, clientY: sy } = e;
  let aborted = false;
  const stop = trackPointerDrag(e, {
    onMove: (m) => {
      if (Math.hypot(m.clientX - sx, m.clientY - sy) > TAP_SLOP) aborted = true;
    },
    onEnd: (u) => {
      if (!aborted) probe.tapped.push({ x: u.clientX, y: u.clientY });
    },
    onRelease: () => {
      cancelTap = null;
    },
  });
  cancelTap = () => {
    aborted = true;
    stop();
  };
});

dot.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  probe.dotPresses += 1;
  trackPointerDrag(e, { onMove: (m) => probe.dotDrag.push({ x: m.clientX, y: m.clientY }) });
});
// A browser that claimed the gesture for a scroll cancels the pointer stream,
// which is exactly what `touch-action: none` is there to prevent.
document.addEventListener("pointercancel", () => {
  probe.cancels += 1;
});
onLongPress(dot, () => {
  probe.dotLongPress += 1;
});

trackPinch(stage, {
  view: () => probe.view,
  apply: applyView,
  size,
  onStart: () => {
    probe.pinchStarts += 1;
    abortTap();
  },
});
trackWheelZoom(stage, { view: () => probe.view, apply: applyView, size });

// Safari pinches the page on top of the stage's own gesture; the modal
// suppresses that, so the harness does too.
blockWebkitGestures(stage);
