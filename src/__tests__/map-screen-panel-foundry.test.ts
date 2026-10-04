import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { MapScreenPanel } from "../views/MapScreenPanel";
import { FoundryImportConfirmModal, FoundrySceneModal } from "../views/FoundryImportModals";
import type { FoundryScene } from "../map/foundry";
import type { HydrusFile } from "../hydrus/client";

const lookup = vi.hoisted(() => ({
  findFoundryModules: vi.fn(),
  loadModuleScenes: vi.fn(),
}));
vi.mock("../hydrus/foundryModules", () => lookup);

const MODULE: HydrusFile = { hash: "c".repeat(64), mime: "application/zip", ext: ".zip", size: 1000, knownTags: [] };
const SCENE: FoundryScene = {
  name: "Abbey Prison",
  background: "maps/AbbeyPrison_Day.webp",
  width: 1000,
  height: 800,
  gridSize: 100,
  walls: [{ x1: 0, y1: 0, x2: 1000, y2: 0 }],
};

function makePanel(client: object | null = {}) {
  const plugin = {
    settings: { mapConfigs: {}, mapDefaultPxPerSquare: 140, mapScreenProfiles: {}, tvWidth: 1920, tvHeight: 1080, mapFogTvOpacity: 1 },
    broadcast: () => {},
    saveSettings: () => Promise.resolve(),
    buildHydrusClient: () => client,
    app: { vault: { adapter: { exists: () => Promise.resolve(false) } } },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const panel = new MapScreenPanel(plugin as any, { render: vi.fn(), beginDrag: vi.fn() } as any);
  panel.activeMap = { url: "/vault/abbey.jpg", mediaType: "image", naturalWidth: 2000, naturalHeight: 1600 };
  (panel as unknown as { activeMapTags: string[] }).activeMapTags = ["name:abbey prison", "original day"];
  const commitWalls = vi.spyOn(panel, "commitWalls").mockResolvedValue();
  const applyGridConfig = vi.spyOn(panel, "applyGridConfig").mockImplementation(() => {});
  return { panel, commitWalls, applyGridConfig };
}

function answerConfirm(accepted: boolean, before?: () => void) {
  const asked: string[] = [];
  vi.spyOn(FoundryImportConfirmModal.prototype, "open").mockImplementation(function (this: FoundryImportConfirmModal) {
    this.onOpen();
    asked.push(this.contentEl.textContent ?? "");
    before?.();
    (accepted ? this.contentEl.querySelector(".mod-cta") : this.contentEl.querySelector("button"))!.dispatchEvent(new MouseEvent("click"));
  });
  return asked;
}

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const proto = HTMLElement.prototype as any;
  proto.empty ??= function (this: HTMLElement) { this.replaceChildren(); };
  proto.addClass ??= function (this: HTMLElement, cls: string) { this.classList.add(cls); };
  proto.setText ??= function (this: HTMLElement, text: string) { this.textContent = text; };
  proto.createEl ??= function (this: HTMLElement, tag: string, opts?: { text?: string; cls?: string }) {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    this.appendChild(el);
    return el;
  };
  proto.createDiv ??= function (this: HTMLElement, opts?: { cls?: string }) {
    return proto.createEl.call(this, "div", opts);
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

afterEach(() => {
  vi.restoreAllMocks();
  lookup.findFoundryModules.mockReset();
  lookup.loadModuleScenes.mockReset();
});

describe("MapScreenPanel.offerFoundryWalls", () => {
  it("imports the module's walls, scaled to the map, once the DM accepts", async () => {
    lookup.findFoundryModules.mockResolvedValue([MODULE]);
    lookup.loadModuleScenes.mockResolvedValue([SCENE]);
    const asked = answerConfirm(true);
    const notice = vi.spyOn(obsidian, "Notice");
    const { panel, commitWalls, applyGridConfig } = makePanel();
    panel.walls = [{ x1: 1, y1: 1, x2: 2, y2: 2 }];

    await panel.offerFoundryWalls("/vault/abbey.jpg");

    expect(lookup.findFoundryModules).toHaveBeenCalledWith(expect.anything(), ["name:abbey prison", "original day"]);
    expect(asked[0]).toContain('Foundry module for "abbey prison"');
    expect(asked[0]).toContain("replaces the 1 walls");
    expect(commitWalls).toHaveBeenCalledWith([{ x1: 0, y1: 0, x2: 2000, y2: 0 }]);
    expect(applyGridConfig).toHaveBeenCalledWith(200, 0, 0);
    expect(notice).toHaveBeenCalledWith("Imported 1 walls (0 doors) — grid set to 200 px/square");
  });

  it("leaves the walls alone when the DM skips", async () => {
    lookup.findFoundryModules.mockResolvedValue([MODULE]);
    answerConfirm(false);
    const { panel, commitWalls } = makePanel();
    await panel.offerFoundryWalls("/vault/abbey.jpg");
    expect(lookup.loadModuleScenes).not.toHaveBeenCalled();
    expect(commitWalls).not.toHaveBeenCalled();
  });

  it("asks nothing when Hydrus has no module for the map", async () => {
    lookup.findFoundryModules.mockResolvedValue([]);
    const asked = answerConfirm(true);
    const { panel, commitWalls } = makePanel();
    await panel.offerFoundryWalls("/vault/abbey.jpg");
    expect(asked).toEqual([]);
    expect(commitWalls).not.toHaveBeenCalled();
  });

  it("drops the import when another map becomes active meanwhile", async () => {
    lookup.findFoundryModules.mockResolvedValue([MODULE]);
    lookup.loadModuleScenes.mockResolvedValue([SCENE]);
    const { panel, commitWalls } = makePanel();
    answerConfirm(true, () => {
      panel.activeMap = { url: "/vault/other.jpg", mediaType: "image", naturalWidth: 100, naturalHeight: 100 };
    });
    await panel.offerFoundryWalls("/vault/abbey.jpg");
    expect(lookup.loadModuleScenes).not.toHaveBeenCalled();
    expect(commitWalls).not.toHaveBeenCalled();
  });

  it("does nothing without a configured Hydrus client", async () => {
    const { panel } = makePanel(null);
    await panel.offerFoundryWalls("/vault/abbey.jpg");
    expect(lookup.findFoundryModules).not.toHaveBeenCalled();
  });

  it("swallows a failed lookup so the map still loads", async () => {
    lookup.findFoundryModules.mockRejectedValue(new Error("Hydrus 500 on /get_files/search_files"));
    const { panel, commitWalls } = makePanel();
    await expect(panel.offerFoundryWalls("/vault/abbey.jpg")).resolves.toBeUndefined();
    expect(commitWalls).not.toHaveBeenCalled();
  });
});

describe("Foundry import modals", () => {
  it("closing the confirmation without a choice counts as Skip", async () => {
    lookup.findFoundryModules.mockResolvedValue([MODULE]);
    vi.spyOn(FoundryImportConfirmModal.prototype, "open").mockImplementation(function (this: FoundryImportConfirmModal) {
      this.onOpen();
      this.onClose();
    });
    const { panel, commitWalls } = makePanel();
    await panel.offerFoundryWalls("/vault/abbey.jpg");
    expect(lookup.loadModuleScenes).not.toHaveBeenCalled();
    expect(commitWalls).not.toHaveBeenCalled();
  });

  const conflicting: FoundryScene[] = [
    { ...SCENE, name: "Abbey Prison Cells" },
    { ...SCENE, name: "Abbey Prison Yard", walls: [{ x1: 0, y1: 0, x2: 0, y2: 800 }] },
  ];

  it("a scene chosen in the picker survives Obsidian closing the picker first", async () => {
    vi.spyOn(FoundrySceneModal.prototype, "open").mockImplementation(function (this: FoundrySceneModal) {
      this.onClose();
      this.onChooseItem(this.getItems()[1]);
    });
    const { panel } = makePanel();
    const scene = await panel.pickFoundryScene(conflicting);
    expect(scene!.name).toBe("Abbey Prison Yard");
  });

  it("dismissing the picker resolves with no scene, so nothing is imported", async () => {
    lookup.findFoundryModules.mockResolvedValue([MODULE]);
    lookup.loadModuleScenes.mockResolvedValue(conflicting);
    answerConfirm(true);
    const picker = vi.spyOn(FoundrySceneModal.prototype, "open").mockImplementation(function (this: FoundrySceneModal) {
      this.onClose();
    });
    const { panel, commitWalls } = makePanel();
    await panel.offerFoundryWalls("/vault/abbey.jpg");
    expect(picker).toHaveBeenCalledTimes(1);
    expect(commitWalls).not.toHaveBeenCalled();
  });
});

describe("MapScreenPanel.setVaultMap — Foundry lookup trigger", () => {
  beforeAll(() => {
    // happy-dom never loads image bytes; report a fixed natural size instead.
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 2000;
        naturalHeight = 1600;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_url: string) {
          queueMicrotask(() => this.onload?.());
        }
      }
    );
  });

  function panelForSetVaultMap() {
    const { panel } = makePanel();
    const adapter = panel["plugin"].app.vault.adapter as unknown as Record<string, unknown>;
    adapter.getResourcePath = (p: string) => `app://local/${p}`;
    const offer = vi.spyOn(panel, "offerFoundryWalls").mockResolvedValue();
    return { panel, offer };
  }

  it("looks for a Foundry module when the map comes from Hydrus", async () => {
    const { panel, offer } = panelForSetVaultMap();
    await panel.setVaultMap("cache/hydrus/abcd.jpg", "image", { hydrusHash: "abcd", knownTags: ["name:abbey prison"] });
    expect(offer).toHaveBeenCalledWith(panel.activeMap!.url);
  });

  it("never queries Hydrus for a note image", async () => {
    const { panel, offer } = panelForSetVaultMap();
    await panel.setVaultMap("attachments/map.jpg", "image", { noteBasename: "Session 3" });
    expect(panel.activeMap).not.toBeNull();
    expect(offer).not.toHaveBeenCalled();
  });
});
