import { describe, expect, it } from "vitest";
import { parseYaml, stringifyYaml } from "obsidian";
import {
  extractSceneBlock,
  parseScene,
  parseSceneSource,
  sanitizeSceneFileName,
  sceneFogFolder,
  sceneNotePath,
  sceneSummary,
  serializeSceneNote,
  sourceFromVaultPath,
  sourceFromVaultUrl,
  type MapScene,
  type PlayerScene,
} from "../scenes/format";

const HASH = "a".repeat(64);

const PLAYER: PlayerScene = {
  version: 1,
  kind: "player",
  name: "Tavern",
  background: { source: "vault:Maps/tavern.jpg", mediaType: "image", loop: true, muted: true },
  layers: [
    { source: `hydrus:${HASH}`, label: "Barkeep", x: 10, y: 20, width: 30, height: 60, zIndex: 3, rotation: 90, visible: true, bordered: false, fog: "layer-1.png" },
  ],
};

const MAP: MapScene = {
  version: 1,
  kind: "map",
  name: "Crypt",
  map: { source: "vault:Maps/crypt.png", mediaType: "image" },
  view: { mode: "physical", panX: 0.3, panY: 0.7, rotation: 90 },
  grid: { pxPerSquare: 70, gridOffsetX: 1, gridOffsetY: 2, showGrid: true, gridColor: "#000000", gridOpacity: 0.4 },
  fog: "map.png",
  walls: [{ x1: 0, y1: 0, x2: 10, y2: 0, door: true, open: false }],
  aoes: [],
  visions: [],
};

const roundTrip = (scene: PlayerScene | MapScene) =>
  parseScene(extractSceneBlock(serializeSceneNote(scene, stringifyYaml))!, parseYaml);

describe("scene format", () => {
  it.each([PLAYER, MAP])("round-trips a $kind scene through a note", (scene) => {
    expect(roundTrip(scene)).toEqual({ ok: true, scene });
  });

  it("writes the name as the note heading followed by one dm-scene block", () => {
    const note = serializeSceneNote(PLAYER, stringifyYaml);
    expect(note.startsWith("# Tavern\n\n```dm-scene\n")).toBe(true);
    expect(note.trimEnd().endsWith("```")).toBe(true);
  });

  it("reads the first dm-scene block and ignores other fences", () => {
    const note = "intro\n```js\nnope\n```\n```dm-scene\n{\"a\":1}\n```\n";
    expect(extractSceneBlock(note)).toBe('{"a":1}\n');
    expect(extractSceneBlock("no block here")).toBeNull();
  });

  it.each([
    [{ ...PLAYER, version: 2 }, "unknown version 2"],
    [{ ...PLAYER, kind: "combat" }, "unknown kind combat"],
    [{ ...PLAYER, name: "" }, "name is missing"],
    [{ ...PLAYER, layers: [{ ...PLAYER.layers[0], source: "/vault/x.png" }] }, "layers[0].source is not a vault: or hydrus: reference"],
    [{ ...PLAYER, layers: [{ ...PLAYER.layers[0], x: "1" }] }, "layers[0].x is not a number"],
    [{ ...PLAYER, background: { source: "vault:a.png" } }, "background needs a source and a mediaType"],
    [{ ...MAP, view: { ...MAP.view, rotation: 45 } }, "view.rotation must be 0, 90, 180 or 270"],
    [{ ...MAP, walls: undefined }, "walls is missing"],
    [{ ...MAP, map: { source: "hydrus:short", mediaType: "image" } }, "map needs a source and a mediaType"],
  ])("rejects %#", (data, error) => {
    expect(parseScene(JSON.stringify(data), parseYaml)).toEqual({ ok: false, error });
  });

  it("reports unparseable YAML instead of throwing", () => {
    const res = parseScene("{", parseYaml);
    expect(res.ok).toBe(false);
  });
});

describe("scene sources", () => {
  it("parses vault and hydrus references", () => {
    expect(parseSceneSource("vault:Maps/a b.png")).toEqual({ kind: "vault", path: "Maps/a b.png" });
    expect(parseSceneSource(`hydrus:${HASH}`)).toEqual({ kind: "hydrus", hash: HASH });
    expect(parseSceneSource("vault:")).toBeNull();
    expect(parseSceneSource(`hydrus:${HASH.toUpperCase()}`)).toBeNull();
  });

  it("saves a Hydrus-cached file by hash and anything else by path", () => {
    expect(sourceFromVaultPath(`.dm-screen/hydrus/${HASH}.png`, ".dm-screen")).toBe(`hydrus:${HASH}`);
    expect(sourceFromVaultPath("Maps/a.png", ".dm-screen")).toBe("vault:Maps/a.png");
    expect(sourceFromVaultUrl("/vault/Maps%2Fa%20b.png", ".dm-screen")).toBe("vault:Maps/a b.png");
    expect(sourceFromVaultUrl("data:image/png;base64,AA==", ".dm-screen")).toBeNull();
  });
});

describe("scene paths", () => {
  it("sanitises the file name and places the note in the folder", () => {
    expect(sanitizeSceneFileName(' a/b:c*d?"e<f>g|h\\i ')).toBe("a-b-c-d--e-f-g-h-i");
    expect(sceneNotePath("/DM Screen/Scenes/", "Act 1: Tavern")).toBe("DM Screen/Scenes/Act 1- Tavern.md");
    expect(sceneNotePath("", "Top")).toBe("Top.md");
  });

  it("keeps fog masks in a folder named after the note", () => {
    expect(sceneFogFolder("DM Screen/Scenes/Crypt.md")).toBe("DM Screen/Scenes/Crypt.fog");
  });

  it("summarises both kinds", () => {
    expect(sceneSummary(PLAYER)).toBe("1 layer + background");
    expect(sceneSummary({ ...PLAYER, background: null, layers: [] })).toBe("0 layers");
    expect(sceneSummary(MAP)).toBe("1 wall, 0 AoE, 0 vision");
  });
});
