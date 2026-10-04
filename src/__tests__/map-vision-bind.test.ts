import { beforeAll, describe, expect, it, vi } from "vitest";
import { MapScreenPanel, type ActiveMap } from "../views/MapScreenPanel";
import type { MapVision } from "../map/types";

type ElOpts = { cls?: string; text?: string; type?: string; value?: string; attr?: Record<string, string> };

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const proto = HTMLElement.prototype as any;
  proto.empty ??= function (this: HTMLElement) { this.replaceChildren(); };
  proto.addClass ??= function (this: HTMLElement, cls: string) { this.classList.add(cls); };
  proto.removeClass ??= function (this: HTMLElement, cls: string) { this.classList.remove(cls); };
  proto.toggleClass ??= function (this: HTMLElement, cls: string, on: boolean) { this.classList.toggle(cls, on); };
  proto.setText ??= function (this: HTMLElement, text: string) { this.textContent = text; };
  proto.createEl ??= function (this: HTMLElement, tag: string, opts?: ElOpts | string) {
    const el = document.createElement(tag);
    const o: ElOpts = typeof opts === "string" ? { cls: opts } : opts ?? {};
    if (o.cls) el.className = o.cls;
    if (o.text) el.textContent = o.text;
    if (o.type) (el as HTMLInputElement).type = o.type;
    if (o.value !== undefined) (el as HTMLInputElement).value = o.value;
    for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, v);
    this.appendChild(el);
    return el;
  };
  proto.createDiv ??= function (this: HTMLElement, opts?: ElOpts | string) { return proto.createEl.call(this, "div", opts); };
  proto.createSpan ??= function (this: HTMLElement, opts?: ElOpts | string) { return proto.createEl.call(this, "span", opts); };
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

const MAP: ActiveMap = { url: "/vault/m.jpg", mediaType: "image", naturalWidth: 4480, naturalHeight: 7000 };

function setup(vision: MapVision) {
  const broadcasts: Array<{ type: string }> = [];
  const plugin = {
    settings: { mapConfigs: {}, mapDefaultPxPerSquare: 140, mapScreenProfiles: {}, tvWidth: 1920, tvHeight: 1080, mapFogTvOpacity: 1 },
    broadcast: (m: { type: string }) => broadcasts.push(m),
    saveSettings: () => Promise.resolve(),
    app: { vault: { adapter: { exists: () => Promise.resolve(false) } } },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const panel = new MapScreenPanel(plugin as any, { render: vi.fn(), beginDrag: vi.fn() } as any);
  panel.activeMap = MAP;
  panel.visions = [vision];
  (panel as unknown as { expandedVisionId: string }).expandedVisionId = vision.id;
  const clickBind = () => {
    const section = document.createElement("div");
    panel.renderVisionSection(section, MAP, () => {});
    (section.querySelector(".dm-map-vision-bind") as HTMLElement).dispatchEvent(new MouseEvent("click"));
  };
  return { panel, clickBind, broadcasts };
}

describe("Follow-view toggle", () => {
  it("binding a light away from the view centre leaves it in place, and panning carries it by the same amount", () => {
    // The request this behaviour comes from, in squares of 100 px: view centre
    // at (4,5) and the light at (5,6); moving the view to (6,8) puts the light at (7,9).
    const light: MapVision = { id: "torch", shape: "circle", x: 500, y: 600, sizeFt: 20, dimFt: 20, featherFt: 5 };
    const { panel, clickBind, broadcasts } = setup(light);
    panel.state.panX = 400;
    panel.state.panY = 500;

    clickBind();
    expect(light.followsView).toBe(true);
    expect([light.x, light.y]).toEqual([500, 600]);
    expect(broadcasts.some((b) => b.type === "map-vision")).toBe(true);

    panel.state.panX = 600;
    panel.state.panY = 800;
    panel.syncBoundVisions(true);
    expect([light.x, light.y]).toEqual([700, 900]);
  });

  it("unbinding drops the stored offset and leaves the light where the view last carried it", () => {
    const light: MapVision = { id: "torch", shape: "circle", x: 500, y: 600, sizeFt: 20, dimFt: 20, featherFt: 5 };
    const { panel, clickBind } = setup(light);
    panel.state.panX = 400;
    panel.state.panY = 500;
    clickBind();
    panel.state.panX = 600;
    panel.state.panY = 800;
    panel.syncBoundVisions(true);

    clickBind();
    expect(light.followsView).toBe(false);
    expect(light.viewOffsetX).toBeUndefined();
    expect(light.viewOffsetY).toBeUndefined();
    panel.state.panX = 1000;
    panel.syncBoundVisions(true);
    expect([light.x, light.y]).toEqual([700, 900]);
  });
});
