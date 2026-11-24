import { describe, expect, it } from "vitest";
import { rotateImportResult, rotateWalls, segmentCrossesBox, type WallImportResult } from "../map/walls";
import type { MapWall } from "../map/types";

describe("rotateWalls", () => {
  it("leaves the walls alone at 0°, as copies", () => {
    const walls: MapWall[] = [{ x1: 1, y1: 2, x2: 3, y2: 4 }];
    const out = rotateWalls(walls, 0, 100, 50);
    expect(out).toEqual(walls);
    expect(out[0]).not.toBe(walls[0]);
  });

  it("re-origins into the rotated box at 90°", () => {
    // The box is 100×50, so the rotated box is 50×100 and the top-left corner
    // of the source lands at the top-right of the result.
    const out = rotateWalls([{ x1: 0, y1: 0, x2: 100, y2: 50 }], 90, 100, 50);
    expect(out[0]).toEqual({ x1: 50, y1: 0, x2: 0, y2: 100 });
  });

  it("mirrors both axes at 180° inside the same box", () => {
    const out = rotateWalls([{ x1: 10, y1: 20, x2: 100, y2: 50 }], 180, 100, 50);
    expect(out[0]).toEqual({ x1: 90, y1: 30, x2: 0, y2: 0 });
  });

  it("returns to the original after four 90° turns", () => {
    const wall: MapWall = { x1: 10, y1: 20, x2: 70, y2: 40 };
    let out = [wall];
    let box = { w: 100, h: 50 };
    for (let i = 0; i < 4; i++) {
      out = rotateWalls(out, 90, box.w, box.h);
      box = { w: box.h, h: box.w };
    }
    expect(out[0]).toEqual(wall);
  });

  it("keeps the door and open flags", () => {
    const out = rotateWalls([{ x1: 0, y1: 0, x2: 10, y2: 0, door: true, open: true }], 270, 100, 50);
    expect(out[0].door).toBe(true);
    expect(out[0].open).toBe(true);
  });
});

describe("rotateImportResult", () => {
  const result: WallImportResult = {
    walls: [{ x1: 0, y1: 0, x2: 650, y2: 450 }],
    gridSquares: { x: 65, y: 45 },
    pixelsPerGrid: 10,
  };

  it("returns the same object at 0°", () => {
    expect(rotateImportResult(result, 0)).toBe(result);
  });

  it("swaps the grid squares at 90° and 270°, keeping px per grid", () => {
    expect(rotateImportResult(result, 90).gridSquares).toEqual({ x: 45, y: 65 });
    expect(rotateImportResult(result, 270).gridSquares).toEqual({ x: 45, y: 65 });
    expect(rotateImportResult(result, 90).pixelsPerGrid).toBe(10);
  });

  it("keeps the grid squares at 180°", () => {
    expect(rotateImportResult(result, 180).gridSquares).toEqual({ x: 65, y: 45 });
  });

  it("rotates the walls inside the file's own box", () => {
    // Box 650×450: the diagonal from the origin ends at the opposite corner,
    // which under 90° runs from the top-right corner down the long side.
    expect(rotateImportResult(result, 90).walls[0]).toEqual({ x1: 450, y1: 0, x2: 0, y2: 650 });
  });

  it("does not mutate the source result", () => {
    rotateImportResult(result, 90);
    expect(result.walls[0]).toEqual({ x1: 0, y1: 0, x2: 650, y2: 450 });
    expect(result.gridSquares).toEqual({ x: 65, y: 45 });
  });
});

describe("segmentCrossesBox", () => {
  const box = { minX: 100, minY: 100, maxX: 200, maxY: 200 };

  it("takes a wall fully inside", () => {
    expect(segmentCrossesBox({ x1: 120, y1: 120, x2: 180, y2: 180 }, box)).toBe(true);
  });

  it("takes a wall that only crosses the box", () => {
    expect(segmentCrossesBox({ x1: 0, y1: 150, x2: 400, y2: 150 }, box)).toBe(true);
  });

  it("takes a wall with one endpoint inside", () => {
    expect(segmentCrossesBox({ x1: 150, y1: 150, x2: 400, y2: 400 }, box)).toBe(true);
  });

  it("leaves a wall that misses the box", () => {
    expect(segmentCrossesBox({ x1: 0, y1: 0, x2: 50, y2: 50 }, box)).toBe(false);
    expect(segmentCrossesBox({ x1: 0, y1: 250, x2: 400, y2: 250 }, box)).toBe(false);
  });

  it("leaves a wall whose infinite line would cross but whose ends do not reach", () => {
    expect(segmentCrossesBox({ x1: 0, y1: 150, x2: 90, y2: 150 }, box)).toBe(false);
  });

  it("takes a wall lying on the box edge", () => {
    expect(segmentCrossesBox({ x1: 100, y1: 100, x2: 200, y2: 100 }, box)).toBe(true);
  });
});
