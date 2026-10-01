import { describe, expect, it, vi } from "vitest";
import { createRepaintScheduler, finiteScale, fitScale, sizeCanvas } from "../views/mapStage";

describe("fitScale", () => {
  it("letterboxes against whichever axis runs out first", () => {
    expect(fitScale(600, 340, 1200, 340)).toBe(0.5);
    expect(fitScale(600, 340, 600, 680)).toBe(0.5);
  });

  it("returns null for a container that cannot be measured", () => {
    expect(fitScale(0, 340, 1200, 800)).toBeNull();
    expect(fitScale(600, 0, 1200, 800)).toBeNull();
  });

  it("returns null for a degenerate map box", () => {
    expect(fitScale(600, 340, 0, 800)).toBeNull();
    expect(fitScale(600, 340, 1200, 0)).toBeNull();
  });

  it("returns null for non-finite input", () => {
    expect(fitScale(Number.NaN, 340, 1200, 800)).toBeNull();
    expect(fitScale(600, 340, Number.POSITIVE_INFINITY, 800)).toBeNull();
  });
});

describe("finiteScale", () => {
  it("passes a finite positive scale through", () => {
    expect(finiteScale(0.25)).toBe(0.25);
  });

  it("refuses zero, negative and non-finite scales", () => {
    expect(finiteScale(0)).toBeNull();
    expect(finiteScale(-1)).toBeNull();
    expect(finiteScale(Number.NaN)).toBeNull();
    expect(finiteScale(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

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
