import { beforeAll, describe, expect, it, vi } from "vitest";
import { DmControlPanel } from "../views/DmControlPanel";
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

function makePanel() {
  const plugin = {
    settings: { ddbEnabled: false, ddbCobaltSession: "", combatTrackerScale: 1 },
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
  (panel as any).render = vi.fn(() => {
    contentEl.empty();
    (panel as any).renderInitiativeSection(contentEl);
  });
  (panel as any).render();
  return { panel, contentEl };
}

function addRowInputs(contentEl: HTMLElement) {
  const row = contentEl.querySelector(".dm-add-combatant") as HTMLElement;
  return {
    name: row.querySelector('input[placeholder="Name"]') as HTMLInputElement,
    init: row.querySelector('input[placeholder="Init"]') as HTMLInputElement,
    hp: row.querySelector('input[placeholder="HP"]') as HTMLInputElement,
    button: row.querySelector("button") as HTMLButtonElement,
  };
}

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

describe("add-combatant draft survives a render", () => {
  it("re-applies the typed name, initiative and HP to the rebuilt inputs", () => {
    const { panel, contentEl } = makePanel();
    const before = addRowInputs(contentEl);
    type(before.name, "Mid Render");
    type(before.init, "15");
    type(before.hp, "12");

    (panel as any).render();

    const after = addRowInputs(contentEl);
    expect(after.name).not.toBe(before.name);
    expect(after.name.value).toBe("Mid Render");
    expect(after.init.value).toBe("15");
    expect(after.hp.value).toBe("12");
  });

  it("adds the combatant the DM typed even when a render replaced the inputs first", () => {
    const { panel, contentEl } = makePanel();
    const before = addRowInputs(contentEl);
    type(before.name, "Mid Render");
    type(before.init, "15");
    type(before.hp, "12");

    (panel as any).render();
    addRowInputs(contentEl).button.click();

    expect(panel.manualCombatants).toEqual([
      { name: "Mid Render", initiative: 15, hp: 12, maxHp: 12, active: false, statuses: [] },
    ]);
  });

  it("clears the draft once the combatant is added", () => {
    const { panel, contentEl } = makePanel();
    const before = addRowInputs(contentEl);
    type(before.name, "Goblin");
    before.button.click();

    const after = addRowInputs(contentEl);
    expect(after.name.value).toBe("");
    expect(after.init.value).toBe("");
    expect(after.hp.value).toBe("");
    expect(panel.manualCombatants).toHaveLength(1);
  });

  it("ignores the + button while the draft has no name", () => {
    const { contentEl } = makePanel();
    const row = addRowInputs(contentEl);
    type(row.init, "20");
    row.button.click();

    expect(addRowInputs(contentEl).init.value).toBe("20");
  });
});
