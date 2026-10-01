import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installNapiCanvas, pixelAt } from "../../test/canvas/napi-canvas-shim";
import { eraseVision, normalizeVision } from "../map/vision";
import type { MapVision } from "../map/types";

let uninstall: () => void;

beforeEach(() => {
  uninstall = installNapiCanvas();
});

afterEach(() => {
  uninstall();
  vi.restoreAllMocks();
});

describe("dim-light visions", () => {
  it("normalizeVision defaults missing dimFt to 0", () => {
    const vision = { id: "v1", shape: "circle", x: 100, y: 100, sizeFt: 20, featherFt: 0 } as MapVision;
    const normalized = normalizeVision(vision);
    expect(normalized.dimFt).toBe(0);
  });

  it("normalizeVision defaults negative dimFt to 0", () => {
    const vision = { id: "v1", shape: "circle", x: 100, y: 100, sizeFt: 20, dimFt: -10, featherFt: 0 } as MapVision;
    const normalized = normalizeVision(vision);
    expect(normalized.dimFt).toBe(0);
  });

  it("normalizeVision defaults NaN dimFt to 0", () => {
    const vision = { id: "v1", shape: "circle", x: 100, y: 100, sizeFt: 20, dimFt: NaN, featherFt: 0 } as MapVision;
    const normalized = normalizeVision(vision);
    expect(normalized.dimFt).toBe(0);
  });

  it("normalizeVision defaults string dimFt to 0", () => {
    const vision = { id: "v1", shape: "circle", x: 100, y: 100, sizeFt: 20, dimFt: "20" as unknown as number, featherFt: 0 };
    const normalized = normalizeVision(vision);
    expect(normalized.dimFt).toBe(0);
  });

  it("normalizeVision preserves valid dimFt", () => {
    const vision = { id: "v1", shape: "circle", x: 100, y: 100, sizeFt: 20, dimFt: 10, featherFt: 0 };
    const normalized = normalizeVision(vision);
    expect(normalized.dimFt).toBe(10);
  });

  it("renders bright zone fully transparent when dimFt is 0", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 200;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fillRect(0, 0, 200, 200);

    const vision: MapVision = {
      id: "v1",
      shape: "circle",
      x: 100,
      y: 100,
      sizeFt: 20,
      dimFt: 0,
      featherFt: 0,
    };

    eraseVision(ctx, vision, 1, 5);

    const center = pixelAt(canvas, 100, 100);
    expect(center[3]).toBe(0);

    const inside = pixelAt(canvas, 115, 100);
    expect(inside[3]).toBe(0);

    const outside = pixelAt(canvas, 125, 100);
    expect(outside[3]).toBe(255);
  });

  it("renders dim ring darkened with rgba(0,0,0,0.5)", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 400;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fillRect(0, 0, 400, 400);

    const vision: MapVision = {
      id: "v1",
      shape: "circle",
      x: 200,
      y: 200,
      sizeFt: 20,
      dimFt: 10,
      featherFt: 0,
    };

    eraseVision(ctx, vision, 1, 5);

    const brightCenter = pixelAt(canvas, 200, 200);
    expect(brightCenter[3]).toBe(0);

    const dimRing = pixelAt(canvas, 225, 200);
    expect(dimRing[3]).toBeGreaterThan(0);
    expect(dimRing[3]).toBeLessThan(255);

    const outside = pixelAt(canvas, 235, 200);
    expect(outside[3]).toBe(255);
  });

  it("handles darkvision-only (sizeFt=0, dimFt>0)", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 400;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fillRect(0, 0, 400, 400);

    const vision: MapVision = {
      id: "v1",
      shape: "circle",
      x: 200,
      y: 200,
      sizeFt: 0,
      dimFt: 30,
      featherFt: 0,
    };

    eraseVision(ctx, vision, 1, 5);

    const center = pixelAt(canvas, 200, 200);
    expect(center[3]).toBeGreaterThan(0);
    expect(center[3]).toBeLessThan(255);

    const dimEdge = pixelAt(canvas, 228, 200);
    expect(dimEdge[3]).toBeGreaterThan(0);
    expect(dimEdge[3]).toBeLessThan(255);

    const outside = pixelAt(canvas, 235, 200);
    expect(outside[3]).toBe(255);
  });

  it("applies feather to outer edge of dim zone", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 400;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fillRect(0, 0, 400, 400);

    const vision: MapVision = {
      id: "v1",
      shape: "circle",
      x: 200,
      y: 200,
      sizeFt: 20,
      dimFt: 10,
      featherFt: 5,
    };

    eraseVision(ctx, vision, 1, 5);

    const brightCenter = pixelAt(canvas, 200, 200);
    expect(brightCenter[3]).toBe(0);

    const dimRing = pixelAt(canvas, 225, 200);
    expect(dimRing[3]).toBeGreaterThan(0);
    expect(dimRing[3]).toBeLessThan(255);

    const featherBand = pixelAt(canvas, 232, 200);
    expect(featherBand[3]).toBeGreaterThan(0);
    expect(featherBand[3]).toBeLessThan(255);

    const outside = pixelAt(canvas, 240, 200);
    expect(outside[3]).toBe(255);
  });

  it("renders square dim zones correctly", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 400;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fillRect(0, 0, 400, 400);

    const vision: MapVision = {
      id: "v1",
      shape: "square",
      x: 200,
      y: 200,
      sizeFt: 20,
      dimFt: 10,
      featherFt: 0,
    };

    eraseVision(ctx, vision, 1, 5);

    const brightCenter = pixelAt(canvas, 200, 200);
    expect(brightCenter[3]).toBe(0);

    const dimCorner = pixelAt(canvas, 225, 200);
    expect(dimCorner[3]).toBeGreaterThan(0);
    expect(dimCorner[3]).toBeLessThan(255);

    const outside = pixelAt(canvas, 235, 200);
    expect(outside[3]).toBe(255);
  });

  it("feather with dimFt=0 starts at alpha 1.0, not 0.5", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 400;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fillRect(0, 0, 400, 400);

    const vision: MapVision = {
      id: "v1",
      shape: "circle",
      x: 200,
      y: 200,
      sizeFt: 20,
      dimFt: 0,
      featherFt: 5,
    };

    eraseVision(ctx, vision, 1, 5);

    const center = pixelAt(canvas, 200, 200);
    expect(center[3]).toBe(0);

    const brightInside = pixelAt(canvas, 215, 200);
    expect(brightInside[3]).toBe(0);

    const featherMid = pixelAt(canvas, 222, 200);
    expect(featherMid[3]).toBeGreaterThan(100);
    expect(featherMid[3]).toBeLessThan(200);

    const outside = pixelAt(canvas, 230, 200);
    expect(outside[3]).toBe(255);
  });

  it("dimAlpha=1.0 fully erases dim zone (for baking)", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 400;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fillRect(0, 0, 400, 400);

    const vision: MapVision = {
      id: "v1",
      shape: "circle",
      x: 200,
      y: 200,
      sizeFt: 20,
      dimFt: 10,
      featherFt: 0,
    };

    eraseVision(ctx, vision, 1, 5, 1.0);

    const brightCenter = pixelAt(canvas, 200, 200);
    expect(brightCenter[3]).toBe(0);

    const dimRing = pixelAt(canvas, 225, 200);
    expect(dimRing[3]).toBe(0);

    const outside = pixelAt(canvas, 235, 200);
    expect(outside[3]).toBe(255);
  });

  it("dimAlpha=0.5 half-erases dim zone (for live rendering)", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 400;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fillRect(0, 0, 400, 400);

    const vision: MapVision = {
      id: "v1",
      shape: "circle",
      x: 200,
      y: 200,
      sizeFt: 20,
      dimFt: 10,
      featherFt: 0,
    };

    eraseVision(ctx, vision, 1, 5, 0.5);

    const brightCenter = pixelAt(canvas, 200, 200);
    expect(brightCenter[3]).toBe(0);

    const dimRing = pixelAt(canvas, 225, 200);
    expect(dimRing[3]).toBeGreaterThan(100);
    expect(dimRing[3]).toBeLessThan(160);

    const outside = pixelAt(canvas, 235, 200);
    expect(outside[3]).toBe(255);
  });
});
