import { beforeAll, describe, expect, it, vi } from "vitest";
import { DmControlPanel, type CombatMirror } from "../views/DmControlPanel";
import { ReplayCache } from "../server";

type ElOpts = { cls?: string; text?: string; type?: string; placeholder?: string; attr?: Record<string, string> };

function applyOpts(el: HTMLElement, arg?: string | ElOpts) {
  if (typeof arg === "string") {
    el.className = arg;
    return;
  }
  if (!arg) return;
  if (arg.cls) el.className = arg.cls;
  if (arg.text) el.textContent = arg.text;
  if (arg.type) (el as HTMLInputElement).type = arg.type;
  if (arg.placeholder) (el as HTMLInputElement).placeholder = arg.placeholder;
  for (const [k, v] of Object.entries(arg.attr ?? {})) el.setAttribute(k, v);
}

beforeAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.addClass = function (this: HTMLElement, cls: string) { this.classList.add(cls); };
  proto.toggleClass = function (this: HTMLElement, cls: string, on: boolean) { this.classList.toggle(cls, on); };
  proto.empty = function (this: HTMLElement) { this.innerHTML = ""; };
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

function makePanel(settings: Record<string, unknown> = {}) {
  const plugin = {
    settings: { ddbEnabled: false, ddbCobaltSession: "", combatTrackerScale: 1, ...settings },
    server: null,
    replayCache: new ReplayCache(),
    broadcast: vi.fn(),
    sendInitiativeUpdate: vi.fn(),
    saveSettings: vi.fn(async () => {}),
    app: { workspace: { getLeavesOfType: () => [] }, plugins: { getPlugin: () => null } },
  } as any;
  const panel = new DmControlPanel({} as any, plugin);
  const contentEl = document.createElement("div");
  document.body.appendChild(contentEl);
  (panel as any).contentEl = contentEl;
  // Only the COMBAT section and its mirrors — the rest of the panel is out of scope here.
  (panel as any).render = vi.fn(() => {
    contentEl.empty();
    (panel as any).renderInitiativeSection(contentEl);
    for (const mirror of (panel as any).combatMirrors) (panel as any).renderCombatMirror(mirror);
  });
  return { panel, contentEl };
}

function makeMirror(): CombatMirror & { extra: HTMLElement | null } {
  const body = document.createElement("div");
  document.body.appendChild(body);
  const mirror = {
    body,
    extra: null as HTMLElement | null,
    setTitleExtra(el: HTMLElement) { mirror.extra = el; },
  };
  return mirror;
}

describe("DmControlPanel combat mirror", () => {
  it("renders the combat body and the Live toggle into a registered mirror", () => {
    const { panel } = makePanel();
    panel.manualCombatants.push({ name: "Goblin", hp: 5, maxHp: 7, initiative: 12, active: true, statuses: [] });
    const mirror = makeMirror();

    panel.registerCombatMirror(mirror);

    expect(mirror.body.querySelector(".dm-combat-tabs")).not.toBeNull();
    expect(mirror.body.textContent).toContain("Goblin");
    const live = mirror.extra?.querySelector(".dm-emit-toggle") as HTMLButtonElement;
    expect(live.classList.contains("dm-emit-active")).toBe(true);
  });

  it("repaints the mirror on every panel render and stops once disposed", () => {
    const { panel } = makePanel();
    const mirror = makeMirror();
    const dispose = panel.registerCombatMirror(mirror);

    panel.manualCombatants.push({ name: "Orc", hp: 15, maxHp: 15, initiative: 8, active: false, statuses: [] });
    panel.render();
    expect(mirror.body.textContent).toContain("Orc");

    dispose();
    panel.manualCombatants.push({ name: "Troll", hp: 84, maxHp: 84, initiative: 3, active: false, statuses: [] });
    panel.render();
    expect(mirror.body.textContent).not.toContain("Troll");
  });

  it("hands the single D&D Beyond panel to the mirror and back to the section once disposed", () => {
    const { panel, contentEl } = makePanel({ ddbEnabled: true, ddbCobaltSession: "cobalt" });
    const ddbPanel = {
      setContainer: vi.fn(),
      isTracking: () => false,
      getActiveEncounterStatus: () => null,
    };
    (panel as any).ddbPanel = ddbPanel;
    (panel as any).combatTab = "dndbeyond";
    const mirror = makeMirror();

    const dispose = panel.registerCombatMirror(mirror);
    expect(ddbPanel.setContainer).toHaveBeenCalledTimes(1);
    expect(mirror.body.contains(ddbPanel.setContainer.mock.calls[0][0])).toBe(true);
    expect(contentEl.textContent).toContain("D&D Beyond is shown in the Explore window.");

    dispose();
    panel.render();
    expect(contentEl.contains(ddbPanel.setContainer.mock.calls[1][0])).toBe(true);
    expect(contentEl.textContent).not.toContain("shown in the Explore window");
  });

  it("defers a background render while a field inside the mirror is focused", () => {
    const { panel } = makePanel();
    const mirror = makeMirror();
    panel.registerCombatMirror(mirror);
    const render = panel.render as unknown as ReturnType<typeof vi.fn>;
    render.mockClear();

    (mirror.body.querySelector("input") as HTMLInputElement).focus();
    panel.renderFromBackground();
    expect(render).not.toHaveBeenCalled();
  });
});
