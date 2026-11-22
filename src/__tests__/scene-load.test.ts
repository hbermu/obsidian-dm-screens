import { beforeEach, describe, expect, it, vi } from "vitest";

const notices: string[] = [];
vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<typeof import("obsidian")>()),
  Notice: class {
    constructor(message: string) {
      notices.push(message);
    }
  },
}));

import { listScenes, loadMapScene, loadPlayerScene, loadScene } from "../scenes/load";
import { serializeSceneNote, type MapScene, type PlayerScene } from "../scenes/format";
import { stringifyYaml } from "obsidian";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
const PNG_URL = "data:image/png;base64,iVBORw==";

function makePlugin(files: Record<string, Uint8Array>) {
  return {
    hydrusCache: null,
    buildHydrusClient: () => null,
    imageToDataUrl: vi.fn(async (p: string) => (p in files ? `data:image/png;base64,${p}` : "")),
    app: {
      vault: {
        adapter: {
          exists: async (p: string) => p in files,
          readBinary: async (p: string) => files[p].slice().buffer,
        },
      },
    },
  } as any;
}

const PLAYER: PlayerScene = {
  version: 1,
  kind: "player",
  name: "Tavern",
  background: { source: "vault:bg.png", mediaType: "image", loop: false, muted: true },
  layers: [
    { source: "vault:a.png", label: "A", x: 1, y: 2, width: 3, height: 4, zIndex: 7, rotation: 90, visible: false, bordered: false, fog: "l1.png" },
    { source: "vault:missing.png", label: "Gone", x: 0, y: 0, width: 1, height: 1, zIndex: 1, rotation: 0, visible: true, bordered: true, fog: null },
    { source: `hydrus:${"c".repeat(64)}`, label: "Offline", x: 0, y: 0, width: 1, height: 1, zIndex: 2, rotation: 0, visible: true, bordered: true, fog: null },
  ],
};

const MAP: MapScene = {
  version: 1,
  kind: "map",
  name: "Crypt",
  map: { source: "vault:crypt.png", mediaType: "image" },
  view: { mode: "fit", panX: 0.5, panY: 0.5, rotation: 0 },
  grid: { pxPerSquare: 70, gridOffsetX: 0, gridOffsetY: 0, showGrid: true, gridColor: "#000", gridOpacity: 1 },
  fog: "map.png",
  walls: [{ x1: 0, y1: 0, x2: 1, y2: 1 }],
  aoes: [],
  visions: [],
};

beforeEach(() => {
  notices.length = 0;
});

describe("loadPlayerScene", () => {
  it("applies the background and the resolvable layers with geometry and fog, reporting the rest once", async () => {
    const plugin = makePlugin({ "bg.png": PNG_BYTES, "a.png": PNG_BYTES, "Scenes/Tavern.fog/l1.png": PNG_BYTES });
    const panel = { applyPlayerScene: vi.fn() } as any;
    await loadPlayerScene(plugin, panel, PLAYER, "Scenes/Tavern.md");

    const [background, layers] = panel.applyPlayerScene.mock.calls[0];
    expect(background).toEqual({ vaultPath: "bg.png", mediaType: "image", loop: false, muted: true, hydrusHash: undefined });
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({
      label: "A", dataUrl: "data:image/png;base64,a.png", x: 1, y: 2, width: 3, height: 4, zIndex: 7, rotation: 90,
      visible: false, bordered: false, fogEnabled: true, fogDataUrl: PNG_URL, source: "vault:a.png",
    });
    expect(notices).toEqual(['Scene "Tavern" loaded without: Gone, Offline (not found).']);
  });

  it("clears the background when the scene has none", async () => {
    const panel = { applyPlayerScene: vi.fn() } as any;
    await loadPlayerScene(makePlugin({}), panel, { ...PLAYER, background: null, layers: [] }, "S.md");
    expect(panel.applyPlayerScene).toHaveBeenCalledWith(null, []);
    expect(notices).toEqual([]);
  });
});

describe("loadMapScene", () => {
  it("applies the map with the scene's state and fog", async () => {
    const plugin = makePlugin({ "crypt.png": PNG_BYTES, "Scenes/Crypt.fog/map.png": PNG_BYTES });
    const panel = { mapPanel: { applyMapScene: vi.fn(async () => true) } } as any;
    await loadMapScene(plugin, panel, MAP, "Scenes/Crypt.md");
    expect(panel.mapPanel.applyMapScene).toHaveBeenCalledWith(
      "crypt.png",
      "image",
      { hydrusHash: undefined, knownTags: undefined },
      { view: MAP.view, grid: MAP.grid, fog: PNG_URL, walls: MAP.walls, aoes: [], visions: [] }
    );
    expect(notices).toEqual([]);
  });

  it("loads nothing when the map is missing", async () => {
    const panel = { mapPanel: { applyMapScene: vi.fn() } } as any;
    await loadMapScene(makePlugin({}), panel, MAP, "Scenes/Crypt.md");
    expect(panel.mapPanel.applyMapScene).not.toHaveBeenCalled();
    expect(notices).toEqual(['Scene "Crypt": its map is no longer available, so nothing was loaded.']);
  });
});

describe("loadScene", () => {
  it("opens the panel and waits for its restore before applying", async () => {
    const order: string[] = [];
    let release!: () => void;
    const panel = {
      restored: new Promise<void>((r) => (release = r)).then(() => order.push("restored")),
      applyPlayerScene: vi.fn(() => order.push("applied")),
    };
    const plugin = { ...makePlugin({}), openDmControlPanel: vi.fn(async () => panel) };
    const done = loadScene(plugin, { ...PLAYER, background: null, layers: [] }, "S.md");
    release();
    await done;
    expect(order).toEqual(["restored", "applied"]);
  });
});

describe("listScenes", () => {
  it("lists scenes of one kind under the folder, sorted by name", async () => {
    const notes: Record<string, string> = {
      "Scenes/b.md": serializeSceneNote({ ...PLAYER, name: "Beta" }, stringifyYaml),
      "Scenes/sub/a.md": serializeSceneNote({ ...PLAYER, name: "Alpha" }, stringifyYaml),
      "Scenes/map.md": serializeSceneNote(MAP, stringifyYaml),
      "Elsewhere/c.md": serializeSceneNote({ ...PLAYER, name: "Outside" }, stringifyYaml),
      "Scenes/plain.md": "# Not a scene",
      "Scenes/broken.md": "```dm-scene\n{\"version\": 9}\n```\n",
    };
    const app = {
      vault: {
        getMarkdownFiles: () => Object.keys(notes).map((path) => ({ path })),
        cachedRead: async (f: { path: string }) => notes[f.path],
      },
    } as any;
    const names = (await listScenes(app, "Scenes", "player")).map((e) => e.scene.name);
    expect(names).toEqual(["Alpha", "Beta"]);
    expect((await listScenes(app, "Scenes", "map")).map((e) => e.file.path)).toEqual(["Scenes/map.md"]);
  });
});
