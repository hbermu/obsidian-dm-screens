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

// A phone shows one section at a time, so the panel is a long column and
// needs a fixed way to move between its sections.
describe("section jump bar", () => {
  function panelWithSections() {
    const { panel, p, contentEl } = makePanel();
    p.render = () => {
      contentEl.empty();
      p.renderPlayerScreenSection(contentEl);
      p.renderInitiativeSection(contentEl);
      p.renderSectionNav(contentEl);
    };
    p.render();
    return { panel, p, contentEl };
  }

  const chips = (el: HTMLElement) => Array.from(el.querySelectorAll(".dm-section-chip")) as HTMLElement[];

  it("puts one chip per section, first in the panel, labelled in one word", () => {
    const { contentEl } = panelWithSections();
    expect(chips(contentEl).map((c) => c.textContent)).toEqual(["Player", "Combat"]);
    expect(contentEl.firstElementChild!.classList.contains("dm-section-nav")).toBe(true);
    // The full title is still what a screen reader announces.
    expect(chips(contentEl)[0].getAttribute("aria-label")).toBe("Player Screen");
  });

  it("marks the section being read", () => {
    const { contentEl } = panelWithSections();
    expect(chips(contentEl)[0].classList.contains("dm-section-chip-active")).toBe(true);
  });

  it("unfolds a folded section when its chip is pressed", () => {
    const { p, contentEl } = panelWithSections();
    const section = contentEl.querySelectorAll(".dm-section")[1] as HTMLElement;
    const scrolled: unknown[] = [];
    section.scrollIntoView = (...args: unknown[]) => void scrolled.push(args);
    p.collapsedSections.add("combat");
    section.classList.add("dm-section-collapsed");

    chips(contentEl)[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(section.classList.contains("dm-section-collapsed")).toBe(false);
    expect(p.collapsedSections.has("combat")).toBe(false);
    expect(scrolled).toHaveLength(1);
    expect(chips(contentEl)[1].classList.contains("dm-section-chip-active")).toBe(true);
  });

  // The first try computed this from `container.scrollTop` and the sections'
  // `offsetTop`. On a phone neither belongs to the panel — Obsidian scrolls an
  // ancestor — so every chip stayed unmarked. It is measured now.
  it("follows the scroll by measuring, whatever element is scrolling", async () => {
    const { contentEl } = panelWithSections();
    const nav = contentEl.querySelector(".dm-section-nav") as HTMLElement;
    const sections = Array.from(contentEl.querySelectorAll(".dm-section")) as HTMLElement[];
    const at = (el: HTMLElement, top: number) => {
      el.getBoundingClientRect = () => ({ top, bottom: top + 40, left: 0, right: 0, width: 0, height: 40, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    };
    // The bar sits at the top; Player is above it, Combat still below.
    at(nav, 0);
    at(sections[0], -200);
    at(sections[1], 300);
    Object.defineProperty(nav, "offsetParent", { configurable: true, get: () => contentEl });

    document.dispatchEvent(new Event("scroll"));
    await new Promise((r) => requestAnimationFrame(r));
    expect(chips(contentEl).map((c) => c.classList.contains("dm-section-chip-active"))).toEqual([true, false]);

    // Scrolled far enough for Combat to reach the bar.
    at(sections[1], 4);
    document.dispatchEvent(new Event("scroll"));
    await new Promise((r) => requestAnimationFrame(r));
    expect(chips(contentEl).map((c) => c.classList.contains("dm-section-chip-active"))).toEqual([false, true]);
  });

  it("stays out of it while the bar is hidden on a wide panel", async () => {
    const { contentEl } = panelWithSections();
    const nav = contentEl.querySelector(".dm-section-nav") as HTMLElement;
    Object.defineProperty(nav, "offsetParent", { configurable: true, get: () => null });

    document.dispatchEvent(new Event("scroll"));
    await new Promise((r) => requestAnimationFrame(r));
    // Untouched: the first chip from the initial mark, nothing re-computed.
    expect(chips(contentEl)[0].classList.contains("dm-section-chip-active")).toBe(true);
  });

  it("drops its scroll listener when the panel re-renders", () => {
    const { p, contentEl } = panelWithSections();
    const first = p.navAbort;
    p.render();
    expect(first.signal.aborted).toBe(true);
    expect(contentEl.querySelectorAll(".dm-section-nav")).toHaveLength(1);
  });

  it("renders no bar when there is only one section", () => {
    const { p, contentEl } = makePanel();
    p.render = () => {
      contentEl.empty();
      p.renderPlayerScreenSection(contentEl);
      p.renderSectionNav(contentEl);
    };
    p.render();
    expect(contentEl.querySelector(".dm-section-nav")).toBeNull();
  });
});
