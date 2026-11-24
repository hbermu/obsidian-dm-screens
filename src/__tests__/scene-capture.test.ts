import { describe, expect, it, vi } from "vitest";
import { parseYaml, TFile } from "obsidian";
import { ReplayCache } from "../server";
import { captureMapScene, capturePlayerScene, writeScene } from "../scenes/capture";
import { extractSceneBlock, parseScene, sourceFromVaultUrl } from "../scenes/format";
import type { ImageLayer } from "../types";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const HASH = "b".repeat(64);

function layer(over: Partial<ImageLayer>): ImageLayer {
  return {
    id: "l1", label: "A", dataUrl: PNG, x: 1, y: 2, width: 3, height: 4, zIndex: 5, rotation: 0,
    visible: true, fogEnabled: false, fogDataUrl: "", bordered: true, ...over,
  };
}

function makePlugin() {
  return {
    settings: { cacheBaseFolder: ".dm-screen", hydrusDefaultLoop: true, hydrusDefaultMuted: false },
    replayCache: new ReplayCache(),
    transport: { sourceOf: (url: string) => sourceFromVaultUrl(url, ".dm-screen") },
  } as any;
}

function makeVault() {
  const notes = new Map<string, string>();
  const bins = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const file = (path: string) => Object.assign(new TFile(), { path });
  const app = {
    vault: {
      getAbstractFileByPath: (p: string) => (notes.has(p) ? file(p) : null),
      create: vi.fn(async (p: string, text: string) => void notes.set(p, text)),
      modify: vi.fn(async (f: { path: string }, text: string) => void notes.set(f.path, text)),
      adapter: {
        exists: async (p: string) => dirs.has(p) || bins.has(p) || notes.has(p),
        mkdir: async (p: string) => void dirs.add(p),
        writeBinary: async (p: string, data: ArrayBuffer) => void bins.set(p, new Uint8Array(data)),
        list: async (p: string) => ({ files: [...bins.keys()].filter((k) => k.startsWith(`${p}/`)), folders: [] }),
        remove: async (p: string) => void bins.delete(p),
        rmdir: async (p: string) => void dirs.delete(p),
      },
    },
  } as any;
  return { app, notes, bins, dirs };
}

describe("capturePlayerScene", () => {
  it("captures the background with its cached loop/mute and every layer by source", () => {
    const plugin = makePlugin();
    plugin.replayCache.record({ type: "show-background-media", payload: { url: "/vault/bg.mp4", mediaType: "video", loop: false, muted: true } });
    const panel = {
      activeBackgroundUrl: "/vault/bg.mp4",
      imageLayers: [
        layer({ id: "l1", source: `hydrus:${HASH}`, fogEnabled: true, fogDataUrl: PNG, bordered: false }),
        layer({ id: "l2", label: "B", source: "vault:Art/b.png" }),
      ],
    } as any;
    const { scene, fogs, skipped } = capturePlayerScene(plugin, panel, "Tavern");
    expect(scene).toEqual({
      version: 1,
      kind: "player",
      name: "Tavern",
      background: { source: "vault:bg.mp4", mediaType: "video", loop: false, muted: true },
      layers: [
        { source: `hydrus:${HASH}`, label: "A", x: 1, y: 2, width: 3, height: 4, zIndex: 5, rotation: 0, visible: true, bordered: false, fog: "l1.png" },
        { source: "vault:Art/b.png", label: "B", x: 1, y: 2, width: 3, height: 4, zIndex: 5, rotation: 0, visible: true, bordered: true, fog: null },
      ],
    });
    expect(fogs).toEqual({ "l1.png": PNG });
    expect(skipped).toEqual([]);
  });

  it("falls back to the default loop and mute and skips layers without a source", () => {
    const panel = { activeBackgroundUrl: "/vault/bg.png", imageLayers: [layer({ label: "Legacy" })] } as any;
    const { scene, skipped } = capturePlayerScene(makePlugin(), panel, "x");
    expect(scene.kind === "player" && scene.background).toEqual({ source: "vault:bg.png", mediaType: "image", loop: true, muted: false });
    expect(scene.kind === "player" && scene.layers).toEqual([]);
    expect(skipped).toEqual(["Legacy"]);
  });
});

describe("captureMapScene", () => {
  it("captures map, view, grid, fog, walls, AoEs and visions", () => {
    const mapPanel = {
      activeMap: { url: `/vault/.dm-screen%2Fhydrus%2F${HASH}.png`, mediaType: "image", naturalWidth: 10, naturalHeight: 10 },
      state: { mode: "physical", panX: 0.2, panY: 0.8, rotation: 180, pxPerSquare: 70, gridOffsetX: 1, gridOffsetY: 2, showGrid: false, gridColor: "#fff", gridOpacity: 0.5 },
      fogDataUrl: PNG,
      walls: [{ x1: 0, y1: 0, x2: 1, y2: 1 }],
      aoes: [{ id: "a", shape: "circle", sizeFt: 20, widthFt: 5, color: "#f00", opacity: 0.4, rotation: 0, x: 0.5, y: 0.5 }],
      visions: [{ id: "v", shape: "circle", x: 0.1, y: 0.1, sizeFt: 30, dimFt: 0, featherFt: 0 }],
    } as any;
    const captured = captureMapScene(makePlugin(), mapPanel, "Crypt")!;
    expect(captured.scene).toMatchObject({
      kind: "map",
      map: { source: `hydrus:${HASH}`, mediaType: "image" },
      view: { mode: "physical", panX: 0.2, panY: 0.8, rotation: 180 },
      grid: { pxPerSquare: 70, gridOffsetX: 1, gridOffsetY: 2, showGrid: false, gridColor: "#fff", gridOpacity: 0.5 },
      fog: "map.png",
      walls: mapPanel.walls,
      aoes: mapPanel.aoes,
      visions: mapPanel.visions,
    });
    expect(captured.fogs).toEqual({ "map.png": PNG });
  });

  it("returns null without an active map", () => {
    expect(captureMapScene(makePlugin(), { activeMap: null } as any, "x")).toBeNull();
  });
});

describe("writeScene", () => {
  it("writes the note and its fog files, then cleans masks an overwrite no longer uses", async () => {
    const { app, notes, bins } = makeVault();
    const first = capturePlayerScene(makePlugin(), {
      activeBackgroundUrl: null,
      imageLayers: [
        layer({ id: "l1", source: "vault:a.png", fogEnabled: true, fogDataUrl: PNG }),
        layer({ id: "l2", label: "B", source: "vault:b.png", fogEnabled: true, fogDataUrl: PNG }),
      ],
    } as any, "Act 1: Tavern");
    const path = await writeScene(app, "DM Screen/Scenes", first);
    expect(path).toBe("DM Screen/Scenes/Act 1- Tavern.md");
    const parsed = parseScene(extractSceneBlock(notes.get(path)!)!, parseYaml);
    expect(parsed).toEqual({ ok: true, scene: first.scene });
    expect([...bins.keys()].sort()).toEqual(["DM Screen/Scenes/Act 1- Tavern.fog/l1.png", "DM Screen/Scenes/Act 1- Tavern.fog/l2.png"]);

    const second = capturePlayerScene(makePlugin(), {
      activeBackgroundUrl: null,
      imageLayers: [layer({ id: "l2", label: "B", source: "vault:b.png", fogEnabled: true, fogDataUrl: PNG })],
    } as any, "Act 1: Tavern");
    await writeScene(app, "DM Screen/Scenes", second);
    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    expect([...bins.keys()]).toEqual(["DM Screen/Scenes/Act 1- Tavern.fog/l2.png"]);
  });

  it("removes the fog folder when the scene has no masks left", async () => {
    const { app, bins, dirs } = makeVault();
    const fogged = capturePlayerScene(makePlugin(), {
      activeBackgroundUrl: null,
      imageLayers: [layer({ source: "vault:a.png", fogEnabled: true, fogDataUrl: PNG })],
    } as any, "S");
    await writeScene(app, "", fogged);
    const clean = capturePlayerScene(makePlugin(), { activeBackgroundUrl: null, imageLayers: [layer({ source: "vault:a.png" })] } as any, "S");
    await writeScene(app, "", clean);
    expect(bins.size).toBe(0);
    expect(dirs.has("S.fog")).toBe(false);
  });
});
