import { beforeAll, describe, expect, it, vi } from "vitest";
import { DmControlPanel } from "../views/DmControlPanel";
import type { ImageLayer } from "../types";

beforeAll(() => {
  if (!HTMLElement.prototype.addClass) {
    HTMLElement.prototype.addClass = function (cls: string) {
      this.classList.add(cls);
    };
  }
});

const BOX = { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) };

function makePanel() {
  const plugin = {
    settings: { combatTrackerScale: 1 },
    server: null,
    app: { workspace: { getLeavesOfType: () => [] } },
    sessionIsLocal: () => true,
    sourceLabels: () => ({}),
    gateway: {
      capabilities: () => ({ hydrus: false, ddb: false, webhooks: [] }),
      hydrus: () => null,
      ddb: () => null,
      webhooks: () => ({ targets: () => [], send: async () => {} }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const panel = new DmControlPanel({} as never, plugin);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = panel as any;
  p.contentEl = document.createElement("div");
  p.broadcastLayerGeometry = vi.fn();
  p.broadcastImageLayers = vi.fn();
  return { panel, p };
}

function sized(box: Partial<typeof BOX> = {}) {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({ ...BOX, ...box }) as DOMRect;
  return el;
}

const press = (el: HTMLElement, x: number, y: number, over: Partial<PointerEventInit> = {}) =>
  el.dispatchEvent(
    new PointerEvent("pointerdown", {
      pointerId: 1,
      pointerType: "touch",
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
      ...over,
    })
  );
const move = (x: number, y: number) =>
  document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: x, clientY: y, bubbles: true }));
const lift = (x: number, y: number, over: Partial<PointerEventInit> = {}) =>
  document.dispatchEvent(
    new PointerEvent("pointerup", { pointerId: 1, clientX: x, clientY: y, bubbles: true, ...over })
  );

describe("DM preview look-around", () => {
  it("pans on a middle-button drag, tracked through the pointer", () => {
    const { p } = makePanel();
    const area = sized();
    const inner = document.createElement("div");
    p.setupPreviewPanZoom(area, inner);

    press(area, 200, 150, { pointerType: "mouse", button: 1 });
    move(280, 180);

    // +80px of 400 = +20%, +30px of 300 = +10%
    expect(p.dmPanX).toBeCloseTo(20, 6);
    expect(p.dmPanY).toBeCloseTo(10, 6);
    expect(inner.style.transform).toBe("translate(20%, 10%) scale(1)");
    lift(280, 180);
  });

  // The panel is a long scrolling column and the preview is a tall area in it,
  // so a finger's drag belongs to the panel's scroll, not to look-around.
  it("ignores a finger and the left mouse button", () => {
    const { p } = makePanel();
    const area = sized();
    const inner = document.createElement("div");
    p.setupPreviewPanZoom(area, inner);

    press(area, 200, 150);
    move(300, 150);
    lift(300, 150);
    press(area, 200, 150, { pointerType: "mouse", button: 0 });
    move(300, 150);
    lift(300, 150);

    expect(p.dmPanX).toBe(0);
    expect(inner.style.transform).toBe("");
  });

  it("stops panning once the button is released", () => {
    const { p } = makePanel();
    const area = sized();
    const inner = document.createElement("div");
    p.setupPreviewPanZoom(area, inner);

    press(area, 200, 150, { pointerType: "mouse", button: 1 });
    move(240, 150);
    lift(240, 150, { button: 1 });
    move(400, 150);

    expect(p.dmPanX).toBeCloseTo(10, 6);
  });
});

describe("dragging an image layer with a finger", () => {
  const layerAt = (x: number, y: number): ImageLayer => ({
    id: "l1",
    label: "L",
    dataUrl: "/vault/a.png",
    x,
    y,
    width: 10,
    height: 10,
    rotation: 0,
    zIndex: 1,
    visible: true,
    fogEnabled: false,
    fogDataUrl: "",
    bordered: true,
  });

  it("moves the layer and broadcasts while dragging, then once on release", () => {
    const { p } = makePanel();
    const layer = layerAt(10, 20);
    const rect = document.createElement("div");
    p.makeDraggable(rect, layer, sized());

    press(rect, 100, 100);
    move(140, 130);

    // +40px of 400 = +10%, +30px of 300 = +10%
    expect(layer.x).toBeCloseTo(20, 6);
    expect(layer.y).toBeCloseTo(30, 6);
    expect(rect.style.left).toBe("20%");
    expect(p.broadcastLayerGeometry).toHaveBeenCalledTimes(1);
    expect(p.broadcastImageLayers).not.toHaveBeenCalled();

    lift(140, 130);
    expect(p.broadcastImageLayers).toHaveBeenCalledTimes(1);
  });

  // The rectangle sits inside the preview, which has its own press handler.
  it("keeps the press away from the preview", () => {
    const { p } = makePanel();
    const area = sized();
    const inner = document.createElement("div");
    p.setupPreviewPanZoom(area, inner);
    const layer = layerAt(10, 20);
    const rect = document.createElement("div");
    area.appendChild(rect);
    p.makeDraggable(rect, layer, sized());

    press(rect, 100, 100);
    move(140, 130);

    expect(layer.x).toBeCloseTo(20, 6);
    expect(p.dmPanX).toBe(0);
    lift(140, 130);
  });

  it("a detached preview makes the drag a no-op instead of corrupting the layer", () => {
    const { p } = makePanel();
    const layer = layerAt(10, 20);
    const rect = document.createElement("div");
    p.makeDraggable(rect, layer, sized({ width: 0, height: 0 }));

    press(rect, 100, 100);
    move(140, 130);
    lift(140, 130);

    expect([layer.x, layer.y]).toEqual([10, 20]);
    expect(p.broadcastLayerGeometry).not.toHaveBeenCalled();
    expect(p.broadcastImageLayers).not.toHaveBeenCalled();
  });
});
