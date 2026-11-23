import { describe, expect, it, vi } from "vitest";
import {
  clampView,
  IDENTITY_VIEW,
  MAX_ZOOM,
  panBy,
  trackPinch,
  trackWheelZoom,
  zoomAbout,
  type StageView,
} from "../views/pinchZoom";

const W = 800;
const H = 600;

describe("stage view maths", () => {
  it("clamps the zoom to the fit..max range", () => {
    expect(clampView({ ...IDENTITY_VIEW, zoom: 0.2 }, W, H).zoom).toBe(1);
    expect(clampView({ ...IDENTITY_VIEW, zoom: 99 }, W, H).zoom).toBe(MAX_ZOOM);
  });

  it("allows only the overhang the zoom creates, and re-centres at fit", () => {
    expect(clampView({ zoom: 2, offsetX: 9999, offsetY: -9999 }, W, H)).toEqual({
      zoom: 2,
      offsetX: 400,
      offsetY: -300,
    });
    expect(clampView({ zoom: 1, offsetX: 50, offsetY: 50 }, W, H)).toEqual(IDENTITY_VIEW);
  });

  it("zooms about the anchor, keeping the content under it in place", () => {
    const anchorX = 100;
    const anchorY = -50;
    const view = zoomAbout(IDENTITY_VIEW, 2, anchorX, anchorY, W, H);
    const contentAt = (v: StageView, screen: number, offset: "offsetX" | "offsetY") =>
      (screen - v[offset]) / v.zoom;
    expect(contentAt(view, anchorX, "offsetX")).toBeCloseTo(contentAt(IDENTITY_VIEW, anchorX, "offsetX"), 6);
    expect(contentAt(view, anchorY, "offsetY")).toBeCloseTo(contentAt(IDENTITY_VIEW, anchorY, "offsetY"), 6);
  });

  it("zooming back out to fit forgets the pan", () => {
    const inThen = zoomAbout(IDENTITY_VIEW, 3, 200, 100, W, H);
    expect(zoomAbout(inThen, 1, 200, 100, W, H)).toEqual(IDENTITY_VIEW);
  });

  it("pans by the delta within the clamp", () => {
    expect(panBy({ zoom: 2, offsetX: 0, offsetY: 0 }, 30, -40, W, H)).toEqual({ zoom: 2, offsetX: 30, offsetY: -40 });
    expect(panBy({ zoom: 2, offsetX: 390, offsetY: 0 }, 30, 0, W, H).offsetX).toBe(400);
  });
});

function stage() {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0, toJSON: () => ({}) });
  let view: StageView = { ...IDENTITY_VIEW };
  const apply = vi.fn((v: StageView) => {
    view = v;
  });
  return { el, apply, opts: { view: () => view, apply, size: () => ({ width: W, height: H }) } };
}

const touch = (type: string, pointerId: number, clientX: number, clientY: number) =>
  new PointerEvent(type, { pointerId, pointerType: "touch", clientX, clientY, bubbles: true, cancelable: true });

describe("trackPinch", () => {
  it("zooms by the ratio the fingers spread", () => {
    const { el, opts, apply } = stage();
    const onStart = vi.fn();
    trackPinch(el, { ...opts, onStart });

    el.dispatchEvent(touch("pointerdown", 1, 300, 300));
    expect(onStart).not.toHaveBeenCalled();
    el.dispatchEvent(touch("pointerdown", 2, 500, 300));
    expect(onStart).toHaveBeenCalledTimes(1);

    el.dispatchEvent(touch("pointermove", 2, 700, 300));

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0].zoom).toBeCloseTo(2, 6);
  });

  it("pans by the midpoint while the spread holds", () => {
    const { el, opts, apply } = stage();
    trackPinch(el, opts);

    el.dispatchEvent(touch("pointerdown", 1, 300, 300));
    el.dispatchEvent(touch("pointerdown", 2, 500, 300));
    // Spread ×2 first, so there is overhang for a pan to move into.
    el.dispatchEvent(touch("pointermove", 1, 200, 300));
    el.dispatchEvent(touch("pointermove", 2, 600, 300));
    const zoomed = apply.mock.calls.at(-1)![0];
    expect(zoomed.zoom).toBeCloseTo(2, 6);

    el.dispatchEvent(touch("pointermove", 1, 230, 300));
    el.dispatchEvent(touch("pointermove", 2, 630, 300));
    expect(apply.mock.calls.at(-1)![0].offsetX).toBeCloseTo(zoomed.offsetX + 30, 6);
  });

  it("ignores a single finger and a mouse", () => {
    const { el, opts, apply } = stage();
    trackPinch(el, opts);

    el.dispatchEvent(touch("pointerdown", 1, 300, 300));
    el.dispatchEvent(touch("pointermove", 1, 400, 300));
    el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 2, pointerType: "mouse", clientX: 500, clientY: 300, bubbles: true }));
    el.dispatchEvent(touch("pointermove", 1, 420, 300));

    expect(apply).not.toHaveBeenCalled();
  });

  // Otherwise the next pair would resume from the old spread and the map would
  // jump by the difference.
  it("starts a fresh gesture after a finger lifts", () => {
    const { el, opts, apply } = stage();
    const onStart = vi.fn();
    trackPinch(el, { ...opts, onStart });

    el.dispatchEvent(touch("pointerdown", 1, 300, 300));
    el.dispatchEvent(touch("pointerdown", 2, 500, 300));
    el.dispatchEvent(touch("pointermove", 2, 700, 300));
    el.dispatchEvent(touch("pointerup", 2, 700, 300));

    const calls = apply.mock.calls.length;
    el.dispatchEvent(touch("pointermove", 1, 100, 300));
    expect(apply.mock.calls.length).toBe(calls);

    el.dispatchEvent(touch("pointerdown", 2, 300, 300));
    expect(onStart).toHaveBeenCalledTimes(2);
    el.dispatchEvent(touch("pointermove", 2, 500, 300));
    expect(apply.mock.calls.at(-1)![0].zoom).toBeCloseTo(4, 6);
  });

  it("stops listening once disposed", () => {
    const { el, opts, apply } = stage();
    trackPinch(el, opts)();
    el.dispatchEvent(touch("pointerdown", 1, 300, 300));
    el.dispatchEvent(touch("pointerdown", 2, 500, 300));
    el.dispatchEvent(touch("pointermove", 2, 700, 300));
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("trackWheelZoom", () => {
  const wheel = ({ ctrlKey, metaKey, clientX, clientY, ...init }: WheelEventInit) => {
    const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    // happy-dom's WheelEvent implements only its own init members, so the
    // mouse ones it inherits on a real browser go on the instance.
    for (const [key, value] of Object.entries({ ctrlKey: !!ctrlKey, metaKey: !!metaKey, clientX, clientY })) {
      Object.defineProperty(e, key, { value });
    }
    return e;
  };

  it("zooms a ctrl-wheel about the cursor and leaves a plain wheel alone", () => {
    const { el, opts, apply } = stage();
    trackWheelZoom(el, opts);

    el.dispatchEvent(wheel({ deltaY: -100, clientX: 400, clientY: 300 }));
    expect(apply).not.toHaveBeenCalled();

    const e = wheel({ deltaY: -100, clientX: 400, clientY: 300, ctrlKey: true });
    el.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(apply.mock.calls[0][0].zoom).toBeGreaterThan(1);
  });

  it("scrolling the other way zooms out, and stops at fit", () => {
    const { el, opts, apply } = stage();
    trackWheelZoom(el, opts);
    for (let i = 0; i < 20; i += 1) {
      el.dispatchEvent(wheel({ deltaY: 100, clientX: 400, clientY: 300, metaKey: true }));
    }
    expect(apply.mock.calls.at(-1)![0]).toEqual(IDENTITY_VIEW);
  });
});
