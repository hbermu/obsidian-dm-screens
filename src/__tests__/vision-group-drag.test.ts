import { describe, expect, it } from "vitest";
import { moveVisions, visionDragTargets } from "../map/vision";
import type { MapVision } from "../map/types";

const vision = (id: string, x: number, y: number, followsView = false): MapVision => ({
  id, shape: "circle", x, y, sizeFt: 20, dimFt: 0, featherFt: 5, followsView,
});

const drag = (targets: MapVision[], dx: number, dy: number, nw = 1000, nh = 800) =>
  moveVisions(targets, targets.map((v) => ({ x: v.x, y: v.y })), dx, dy, nw, nh);

describe("visionDragTargets", () => {
  it("returns only the dragged vision when group mode is off", () => {
    const a = vision("a", 100, 100);
    const b = vision("b", 200, 200);
    expect(visionDragTargets([a, b], a, false)).toEqual([a]);
  });

  it("returns every unbound vision in group mode", () => {
    const a = vision("a", 100, 100);
    const b = vision("b", 200, 200);
    const bound = vision("c", 500, 400, true);
    expect(visionDragTargets([a, b, bound], a, true)).toEqual([a, b]);
  });

  it("moves a view-bound vision alone even in group mode", () => {
    const a = vision("a", 100, 100);
    const bound = vision("c", 500, 400, true);
    expect(visionDragTargets([a, bound], bound, true)).toEqual([bound]);
  });
});

describe("moveVisions", () => {
  it("applies the same delta to every target", () => {
    const a = vision("a", 100, 100);
    const b = vision("b", 300, 250);
    drag([a, b], 50, -20);
    expect([a.x, a.y, b.x, b.y]).toEqual([150, 80, 350, 230]);
  });

  it("clamps the shared delta so the formation keeps its shape at the edge", () => {
    const a = vision("a", 100, 100);
    const b = vision("b", 900, 700);
    drag([a, b], 300, 300);
    expect([a.x, a.y, b.x, b.y]).toEqual([200, 200, 1000, 800]);
    drag([a, b], -500, -500);
    expect([a.x, a.y, b.x, b.y]).toEqual([0, 0, 800, 600]);
  });

  it("clamps a single vision to the map like the one-by-one drag", () => {
    const a = vision("a", 10, 790);
    drag([a], -50, 50);
    expect([a.x, a.y]).toEqual([0, 800]);
  });

  it("measures from the drag start, not the last frame", () => {
    const a = vision("a", 100, 100);
    const starts = [{ x: 100, y: 100 }];
    moveVisions([a], starts, 10, 0, 1000, 800);
    moveVisions([a], starts, 30, 0, 1000, 800);
    expect(a.x).toBe(130);
  });
});
