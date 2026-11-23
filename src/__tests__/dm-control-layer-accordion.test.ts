import { beforeAll, describe, expect, it, vi } from "vitest";
import { DmControlPanel } from "../views/DmControlPanel";
import { ReplayCache } from "../server";
import type { ImageLayer } from "../types";

type ElOpts = { cls?: string; text?: string; type?: string; attr?: Record<string, string> };

function applyOpts(el: HTMLElement, arg?: string | ElOpts) {
  if (typeof arg === "string") {
    el.className = arg;
    return;
  }
  if (!arg) return;
  if (arg.cls) el.className = arg.cls;
  if (arg.text) el.textContent = arg.text;
  if (arg.type) (el as HTMLInputElement).type = arg.type;
  for (const [k, v] of Object.entries(arg.attr ?? {})) el.setAttribute(k, v);
}

beforeAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.addClass = function (this: HTMLElement, cls: string) { this.classList.add(cls); };
  proto.removeClass = function (this: HTMLElement, cls: string) { this.classList.remove(cls); };
  proto.toggleClass = function (this: HTMLElement, cls: string, on: boolean) { this.classList.toggle(cls, on); };
  proto.empty = function (this: HTMLElement) { this.innerHTML = ""; };
  proto.setText = function (this: HTMLElement, text: string) { this.textContent = text; };
  proto.createEl = function (this: HTMLElement, tag: string, arg?: ElOpts) {
    const el = document.createElement(tag);
    applyOpts(el, arg);
    this.appendChild(el);
    return el;
  };
  proto.createDiv = function (this: HTMLElement, arg?: string | ElOpts) {
    const el = document.createElement("div");
    applyOpts(el, arg);
    this.appendChild(el);
    return el;
  };
  proto.createSpan = function (this: HTMLElement, arg?: string | ElOpts) {
    const el = document.createElement("span");
    applyOpts(el, arg);
    this.appendChild(el);
    return el;
  };
});

const layer = (id: string, label: string): ImageLayer => ({
  id,
  label,
  dataUrl: "data:image/png;base64,AA==",
  x: 10,
  y: 10,
  width: 50,
  height: 50,
  rotation: 0,
  zIndex: id === "a" ? 2 : 1,
  visible: true,
  fogEnabled: false,
  fogDataUrl: "",
  bordered: true,
});

function makePanel() {
  const plugin = {
    settings: { combatTrackerScale: 1 },
    server: null,
    replayCache: new ReplayCache(),
    broadcast: vi.fn(),
    saveSettings: vi.fn(async () => {}),
    app: { workspace: { getLeavesOfType: () => [] }, plugins: { getPlugin: () => null } },
    sessionIsLocal: () => true,
    canEditSession: () => true,
    sourceLabels: () => ({}),
    transport: { isLive: () => false, canEdit: () => true, joinLink: () => null, mode: "embedded" },
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
  const contentEl = document.createElement("div");
  p.contentEl = contentEl;
  p.imageLayers = [layer("a", "Betty Borracha"), layer("b", "Victor")];
  p.broadcastAndRender = vi.fn();
  p.render = () => {
    contentEl.empty();
    p.renderPlayerScreenSection(contentEl);
  };
  p.render();
  return { panel, p, contentEl };
}

const rows = (el: HTMLElement) => Array.from(el.querySelectorAll(".dm-layer-row")) as HTMLElement[];
const nameRow = (row: HTMLElement) => row.querySelector(".dm-layer-name-row") as HTMLElement;
const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

// Ten buttons and two toggles per layer filled a phone screen with two layers
// on it, so a narrow panel shows one line each and opens one at a time.
describe("layer rows open one at a time", () => {
  it("starts with every layer closed", () => {
    const { contentEl } = makePanel();
    expect(rows(contentEl)).toHaveLength(2);
    expect(rows(contentEl).filter((r) => r.classList.contains("dm-layer-expanded"))).toHaveLength(0);
  });

  it("opens the layer whose name row is pressed", () => {
    const { contentEl, p } = makePanel();
    click(nameRow(rows(contentEl)[0]));

    expect(rows(contentEl)[0].classList.contains("dm-layer-expanded")).toBe(true);
    expect(rows(contentEl)[1].classList.contains("dm-layer-expanded")).toBe(false);
    expect(p.expandedLayerId).toBe("a");
  });

  it("closes the previous one, so the list never grows past one open layer", () => {
    const { contentEl } = makePanel();
    click(nameRow(rows(contentEl)[0]));
    click(nameRow(rows(contentEl)[1]));

    const open = rows(contentEl).filter((r) => r.classList.contains("dm-layer-expanded"));
    expect(open).toHaveLength(1);
    expect(open[0].querySelector(".dm-layer-label")!.textContent).toBe("Victor");
  });

  it("pressing the open layer again closes it", () => {
    const { contentEl, p } = makePanel();
    click(nameRow(rows(contentEl)[0]));
    click(nameRow(rows(contentEl)[0]));

    expect(rows(contentEl).filter((r) => r.classList.contains("dm-layer-expanded"))).toHaveLength(0);
    expect(p.expandedLayerId).toBeNull();
  });

  it("carries the chevron's state for a screen reader", () => {
    const { contentEl } = makePanel();
    const chevron = () => rows(contentEl)[0].querySelector(".dm-layer-expand") as HTMLElement;
    expect(chevron().getAttribute("aria-expanded")).toBe("false");
    click(nameRow(rows(contentEl)[0]));
    expect(chevron().getAttribute("aria-expanded")).toBe("true");
  });
});
