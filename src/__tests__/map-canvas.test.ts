import { describe, expect, it, vi } from "vitest";
import { createRepaintScheduler, sizeCanvas } from "../map/canvas";

describe("sizeCanvas", () => {
  it("assigns and reports a change on the first call", () => {
    const canvas = document.createElement("canvas");
    expect(sizeCanvas(canvas, 300, 200)).toBe(true);
    expect(canvas.width).toBe(300);
    expect(canvas.height).toBe(200);
  });

  it("does not reassign when the rounded size is unchanged", () => {
    const canvas = document.createElement("canvas");
    sizeCanvas(canvas, 300, 200);
    expect(sizeCanvas(canvas, 300.2, 199.8)).toBe(false);
  });

  it("reassigns when the size actually changes", () => {
    const canvas = document.createElement("canvas");
    sizeCanvas(canvas, 300, 200);
    expect(sizeCanvas(canvas, 301, 200)).toBe(true);
    expect(canvas.width).toBe(301);
  });

  it("never sizes a canvas to zero", () => {
    const canvas = document.createElement("canvas");
    sizeCanvas(canvas, 0, 0);
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
  });
});

describe("createRepaintScheduler", () => {
  it("coalesces many schedules into one repaint per frame", async () => {
    const repaint = vi.fn();
    const scheduler = createRepaintScheduler(repaint);

    for (let i = 0; i < 10; i++) scheduler.schedule();
    expect(repaint).not.toHaveBeenCalled();

    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(repaint).toHaveBeenCalledTimes(1);
  });

  it("schedules again after the frame has run", async () => {
    const repaint = vi.fn();
    const scheduler = createRepaintScheduler(repaint);

    scheduler.schedule();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    scheduler.schedule();
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    expect(repaint).toHaveBeenCalledTimes(2);
  });

  it("cancel drops a pending repaint", async () => {
    const repaint = vi.fn();
    const scheduler = createRepaintScheduler(repaint);

    scheduler.schedule();
    scheduler.cancel();
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    expect(repaint).not.toHaveBeenCalled();
  });

  it("cancel is inert when nothing is pending", () => {
    const scheduler = createRepaintScheduler(vi.fn());
    expect(() => scheduler.cancel()).not.toThrow();
  });
});
