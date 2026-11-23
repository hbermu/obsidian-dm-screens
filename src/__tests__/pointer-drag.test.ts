import { afterEach, describe, expect, it, vi } from "vitest";
import { blockWebkitGestures, LONG_PRESS_MS, onLongPress, trackPointerDrag } from "../views/pointerDrag";

const down = (pointerId = 1, over: Partial<PointerEventInit> = {}) =>
  new PointerEvent("pointerdown", { pointerId, pointerType: "touch", clientX: 0, clientY: 0, ...over });
const doc = (type: string, init: Partial<PointerEventInit>) =>
  document.dispatchEvent(new PointerEvent(type, { pointerId: 1, ...init }));

afterEach(() => {
  vi.useRealTimers();
});

describe("trackPointerDrag", () => {
  it("follows its own pointer and ignores a second finger", () => {
    const onMove = vi.fn();
    trackPointerDrag(down(1), { onMove });

    doc("pointermove", { clientX: 10 });
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 2, clientX: 99 }));

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][0].clientX).toBe(10);
  });

  it("ends on release and stops listening", () => {
    const onMove = vi.fn();
    const onEnd = vi.fn();
    const onRelease = vi.fn();
    trackPointerDrag(down(), { onMove, onEnd, onRelease });

    doc("pointerup", {});
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledTimes(1);

    doc("pointermove", { clientX: 5 });
    expect(onMove).not.toHaveBeenCalled();
  });

  // The browser fires this when it takes a touch gesture over; without it the
  // drag would never end and its lock would leak.
  it("ends on pointercancel", () => {
    const onRelease = vi.fn();
    trackPointerDrag(down(), { onMove: vi.fn(), onRelease });
    doc("pointercancel", {});
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("can be torn down before the pointer is released", () => {
    const onMove = vi.fn();
    const onEnd = vi.fn();
    const cancel = trackPointerDrag(down(), { onMove, onEnd });
    cancel();
    doc("pointermove", { clientX: 5 });
    doc("pointerup", {});
    expect(onMove).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });
});

describe("onLongPress", () => {
  it("fires for a finger held still", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    const run = vi.fn();
    onLongPress(el, run);

    el.dispatchEvent(down());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not fire for a mouse, which has a right button of its own", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    const run = vi.fn();
    onLongPress(el, run);

    el.dispatchEvent(down(1, { pointerType: "mouse" }));
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not fire when the finger moves away or lifts first", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    const run = vi.fn();
    onLongPress(el, run);

    el.dispatchEvent(down());
    doc("pointermove", { clientX: 40, clientY: 0 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(run).not.toHaveBeenCalled();

    el.dispatchEvent(down());
    doc("pointerup", {});
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(run).not.toHaveBeenCalled();
  });

  it("stops listening once disposed", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    const run = vi.fn();
    onLongPress(el, run)();
    el.dispatchEvent(down());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("blockWebkitGestures", () => {
  it("cancels Safari's own pinch events until disposed", () => {
    const el = document.createElement("div");
    const dispose = blockWebkitGestures(el);
    const fire = () => {
      const e = new Event("gesturestart", { cancelable: true });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(fire()).toBe(true);
    dispose();
    expect(fire()).toBe(false);
  });
});
