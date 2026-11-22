import { beforeAll, describe, expect, it, vi } from "vitest";
import { stringifyYaml } from "obsidian";

const loadScene = vi.fn();
vi.mock("../scenes/load", () => ({ loadScene: (...args: unknown[]) => loadScene(...args) }));

import { renderSceneCard } from "../scenes/codeBlock";
import type { PlayerScene } from "../scenes/format";

// Obsidian adds these helpers to HTMLElement; the card uses two of them.
beforeAll(() => {
  const make = function (this: HTMLElement, tag: string, opts?: { cls?: string; text?: string }) {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    this.appendChild(el);
    return el;
  };
  (HTMLElement.prototype as any).createEl ??= make;
  (HTMLElement.prototype as any).createDiv ??= function (this: HTMLElement, opts?: { cls?: string; text?: string }) {
    return make.call(this, "div", opts);
  };
});

const SCENE: PlayerScene = { version: 1, kind: "player", name: "Tavern", background: null, layers: [] };

const plugin = (editable = true) => ({ canEditSession: () => editable }) as any;

describe("renderSceneCard", () => {
  it("renders the name, a summary and a Load button that loads the scene", () => {
    const el = document.createElement("div");
    renderSceneCard(plugin(), stringifyYaml(SCENE), el, "Scenes/Tavern.md");
    expect(el.querySelector(".dm-scene-name")!.textContent).toBe("Tavern");
    expect(el.querySelector(".dm-scene-summary")!.textContent).toBe("Player screen · 0 layers");
    const btn = el.querySelector<HTMLButtonElement>(".dm-scene-card-load")!;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(loadScene).toHaveBeenCalledWith(expect.anything(), SCENE, "Scenes/Tavern.md");
  });

  it("disables Load when this device cannot edit the session", () => {
    const el = document.createElement("div");
    renderSceneCard(plugin(false), stringifyYaml(SCENE), el, "S.md");
    expect(el.querySelector<HTMLButtonElement>(".dm-scene-card-load")!.disabled).toBe(true);
  });

  it("renders the parse error instead of a card", () => {
    const el = document.createElement("div");
    renderSceneCard(plugin(), stringifyYaml({ ...SCENE, version: 7 }), el, "S.md");
    expect(el.querySelector(".dm-scene-error")!.textContent).toBe("DM Screen scene: unknown version 7");
    expect(el.querySelector(".dm-scene-card-load")).toBeNull();
  });
});
