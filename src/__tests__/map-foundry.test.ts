import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  parseNedb,
  parseLeveldbLog,
  parseLeveldbEntries,
  foundrySceneToWalls,
  collectFoundryScenes,
  chooseScene,
  sceneImportResult,
  sceneTokens,
  type FoundryScene,
} from "../map/foundry";

// Single-scene modules: the only scene is the one imported.
function parseFoundryModule(entries: Record<string, Uint8Array>) {
  const scenes = collectFoundryScenes(entries);
  if (scenes.length === 0) throw new Error("No scene with walls found in module");
  return sceneImportResult(scenes[0]);
}

// Hand-made synthetic fixtures using only public-domain data.

// Encode LevelDB WAL records: each is one FULL record whose data is the key
// bytes (so parseLeveldbEntries can recover it) followed by the JSON value.
function makeWal(records: { key: string; doc: object }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const { key, doc } of records) {
    const data = enc.encode(key + " " + JSON.stringify(doc));
    const header = new Uint8Array(7);
    header[4] = data.length & 0xff;
    header[5] = (data.length >> 8) & 0xff;
    header[6] = 1; // FULL
    parts.push(header, data);
  }
  parts.push(new Uint8Array(7)); // zero header terminates the block
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

describe("parseNedb", () => {
  it("parses valid docs, ignores $$deleted and blank lines", () => {
    const text = [
      JSON.stringify({ _id: "abc", name: "Room", width: 1000, height: 800, grid: 100, walls: [] }),
      JSON.stringify({ _id: "del", $$deleted: true }),
      "",
    ].join("\n");
    const docs = parseNedb(text);
    expect(docs).toHaveLength(1);
    expect((docs[0] as Record<string, unknown>)["name"]).toBe("Room");
  });

  it("ignores lines that are not valid JSON", () => {
    const text = "not json\n" + JSON.stringify({ _id: "1", name: "X", width: 100, height: 100, grid: 50, walls: [] });
    const docs = parseNedb(text);
    expect(docs).toHaveLength(1);
  });
});

describe("foundrySceneToWalls", () => {
  const baseScene = {
    name: "Room",
    width: 1000,
    height: 800,
    grid: 100,
    walls: [
      // sense:20 plain wall
      { c: [0, 0, 100, 0], sense: 20, door: 0 },
      // sense:0 → filtered out
      { c: [100, 0, 100, 100], sense: 0 },
      // door:1, ds:0 (closed)
      { c: [0, 0, 0, 100], door: 1, ds: 0, sense: 20 },
      // zero-length → skipped
      { c: [50, 50, 50, 50], sense: 20 },
    ],
  };

  it("returns gridSize 100 and 2 walls (sense:0 filtered, zero-length skipped)", () => {
    const scene = foundrySceneToWalls(baseScene as Record<string, unknown>);
    expect(scene).not.toBeNull();
    expect(scene!.gridSize).toBe(100);
    // wall (0,0,100,0) and door (0,0,0,100 closed); sense:0 and zero-length excluded
    expect(scene!.walls).toHaveLength(2);
    expect(scene!.walls[0]).toEqual({ x1: 0, y1: 0, x2: 100, y2: 0 });
    expect(scene!.walls[1]).toEqual({ x1: 0, y1: 0, x2: 0, y2: 100, door: true });
    expect(scene!.walls[1].open).toBeUndefined();
  });

  it("ds:1 produces open:true on a door", () => {
    const scene = foundrySceneToWalls({
      name: "S",
      width: 500,
      height: 500,
      grid: 50,
      walls: [{ c: [0, 0, 50, 0], door: 1, ds: 1, sense: 20 }],
    });
    expect(scene).not.toBeNull();
    expect(scene!.walls[0].open).toBe(true);
  });

  it("grid as {size:70} is accepted", () => {
    const scene = foundrySceneToWalls({
      name: "S",
      width: 700,
      height: 700,
      grid: { size: 70 },
      walls: [{ c: [0, 0, 70, 0], sense: 20 }],
    });
    expect(scene).not.toBeNull();
    expect(scene!.gridSize).toBe(70);
  });

  it("returns null when all walls are filtered", () => {
    const scene = foundrySceneToWalls({
      name: "Empty",
      width: 100,
      height: 100,
      grid: 50,
      walls: [{ c: [0, 0, 50, 0], sense: 0 }],
    });
    expect(scene).toBeNull();
  });

  it("subtracts the padded-scene inset so walls sit relative to the image", () => {
    // width 1000, grid 100, padding 0.25 → padX = ceil(1000*0.25/100)*100 = 300;
    // height 800 → padY = ceil(800*0.25/100)*100 = 200.
    const scene = foundrySceneToWalls({
      name: "Padded",
      width: 1000,
      height: 800,
      grid: 100,
      padding: 0.25,
      walls: [{ c: [300, 200, 400, 200], sense: 20 }],
    });
    expect(scene!.walls[0]).toEqual({ x1: 0, y1: 0, x2: 100, y2: 0 });
  });
});

describe("foundrySceneToWalls — background", () => {
  const base = { name: "Hall", width: 1000, height: 800, grid: 100, walls: [{ c: [0, 0, 100, 0], sense: 20 }] };

  it("reads background.src from newer modules", () => {
    const scene = foundrySceneToWalls({ ...base, background: { src: "modules/x/maps/Hall_Roof_Day.webp" } });
    expect(scene!.background).toBe("modules/x/maps/Hall_Roof_Day.webp");
  });

  it("reads img from older modules", () => {
    expect(foundrySceneToWalls({ ...base, img: "modules/x/Hall_Night.jpg" })!.background).toBe("modules/x/Hall_Night.jpg");
  });

  it("leaves it empty when the scene names no background", () => {
    expect(foundrySceneToWalls({ ...base, background: { src: null } })!.background).toBe("");
  });
});

describe("chooseScene", () => {
  const scene = (name: string, opts: Partial<FoundryScene> = {}): FoundryScene => ({
    name,
    background: "",
    width: 1000,
    height: 800,
    gridSize: 100,
    walls: [{ x1: 0, y1: 0, x2: 100, y2: 0 }],
    ...opts,
  });
  const target = (tags: string[] = [], width = 2000, height = 1600) => ({ width, height, tags });
  const otherWalls = [{ x1: 0, y1: 0, x2: 0, y2: 300 }];

  it("returns no scene for an empty module", () => {
    expect(chooseScene([], target())).toEqual({ scene: null, candidates: [] });
  });

  it("treats day/night copies with identical walls as one match and prefers the base name", () => {
    const choice = chooseScene([scene("Guildhall (Night)"), scene("Guildhall")], target());
    expect(choice.scene!.name).toBe("Guildhall");
  });

  it("rules out rooms of another aspect ratio", () => {
    const choice = chooseScene(
      [scene("Library", { width: 1000, height: 1000, walls: otherWalls }), scene("Cannon Room")],
      target()
    );
    expect(choice.scene!.name).toBe("Cannon Room");
  });

  it("picks the scene whose name or background shares the map's variant tags", () => {
    const choice = chooseScene(
      [
        scene("The Vale 1 - 03a Barn Sunset Indoors", { background: "maps/GL_Barn_Indoors_Sunset.jpg" }),
        scene("The Vale 1 - 03b Barn Sunset Roof", { background: "maps/GL_Barn_Roof_Sunset.jpg", walls: otherWalls }),
      ],
      target(["name:vale barn", "roof", "sunset", "grid:gridless", "artist:czepeku"])
    );
    expect(choice.scene!.name).toBe("The Vale 1 - 03b Barn Sunset Roof");
  });

  it("reports an ambiguity when equally good scenes carry different walls", () => {
    const choice = chooseScene([scene("Room (A)"), scene("Room (B)", { walls: [...otherWalls, ...otherWalls] })], target());
    expect(choice.scene).toBeNull();
    expect(choice.candidates.map((s) => s.name)).toEqual(["Room (B)", "Room (A)"]);
  });

  it("ranks the scenes of the named map first in a module shared by several maps", () => {
    const choice = chooseScene(
      [
        scene("The Vale 1 - 08a ApplePress NewBeginnings Indoors Day"),
        scene("The Vale 1 - 01a Barn NewBeginnings Indoors Day", { walls: otherWalls }),
      ],
      target(["name:ages of the vale barn", "indoors"])
    );
    expect(choice.candidates[0].name).toBe("The Vale 1 - 01a Barn NewBeginnings Indoors Day");
  });

  it("asks instead of guessing when no scene carries every word of the map's name", () => {
    const choice = chooseScene(
      [scene("Drow Warship - 18a Sky", { background: "GL_DrowWarship_Sky.jpg" }), scene("Drow Warship - 01a Original", { walls: otherWalls })],
      target(["name:drow warship interior", "sky", "iridescent middle deck"])
    );
    expect(choice.scene).toBeNull();
    expect(choice.candidates[0].name).toBe("Drow Warship - 18a Sky");
  });

  it("ignores namespaced tags other than name:", () => {
    const choice = chooseScene(
      [scene("Hall"), scene("Fantasy Grid Cellar", { walls: otherWalls })],
      target(["name:hall", "genre:fantasy", "grid:gridless"])
    );
    expect(choice.scene!.name).toBe("Hall");
  });

  it("falls back to every scene when none has the map's shape", () => {
    const choice = chooseScene([scene("Square", { width: 500, height: 500 })], target());
    expect(choice.scene!.name).toBe("Square");
  });

  it("splits camelCase and separators into lowercase tokens without stop words", () => {
    expect([...sceneTokens("FlyingCastle_CannonRoom_Day of the-King 03a")]).toEqual(["flying", "castle", "cannon", "room", "day", "king"]);
  });
});

describe("parseLeveldbLog", () => {
  it("decodes a single FULL record (type=1) with crc=0", () => {
    const doc = { _id: "wall1", name: "Hall", width: 200, height: 200, grid: 50, walls: [{ c: [0, 0, 50, 0], sense: 20 }] };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(doc));
    // Build a minimal WAL block: 4-byte crc=0, 2-byte length LE, 1-byte type=1, then data
    const header = new Uint8Array(7);
    header[4] = jsonBytes.length & 0xff;
    header[5] = (jsonBytes.length >> 8) & 0xff;
    header[6] = 1; // FULL
    const block = new Uint8Array(header.length + jsonBytes.length);
    block.set(header, 0);
    block.set(jsonBytes, 7);

    const docs = parseLeveldbLog(block);
    expect(docs).toHaveLength(1);
    const parsed = docs[0] as Record<string, unknown>;
    expect(parsed["name"]).toBe("Hall");
    expect(parsed["width"]).toBe(200);
  });

  it("recovers the LevelDB key alongside the doc", () => {
    const bytes = makeWal([
      { key: "!scenes!SCENEID01", doc: { _id: "SCENEID01", name: "Map" } },
      { key: "!scenes.walls!SCENEID01.WALLA", doc: { _id: "WALLA", c: [0, 0, 100, 0] } },
    ]);
    const entries = parseLeveldbEntries(bytes);
    expect(entries).toHaveLength(2);
    expect(entries[0].key).toBe("!scenes!SCENEID01");
    expect(entries[1].key).toBe("!scenes.walls!SCENEID01.WALLA");
    expect((entries[1].doc as Record<string, unknown>)["_id"]).toBe("WALLA");
  });
});

describe("parseFoundryModule — LevelDB with separate wall docs (newer Foundry)", () => {
  it("re-attaches !scenes.walls! docs to their scene by key", () => {
    // Scene stores walls as ID strings; geometry lives in separate keyed docs.
    const bytes = makeWal([
      { key: "!scenes!S1", doc: { _id: "S1", name: "Vault", width: 1400, height: 1000, grid: { size: 100 }, walls: ["W1", "W2", "W3"] } },
      { key: "!scenes.walls!S1.W1", doc: { _id: "W1", c: [0, 0, 100, 0], sight: 20 } },
      { key: "!scenes.walls!S1.W2", doc: { _id: "W2", c: [100, 0, 100, 100], door: 1, ds: 0, sight: 20 } },
      { key: "!scenes.walls!S1.W3", doc: { _id: "W3", c: [0, 0, 50, 0], sight: 0 } }, // non-blocking, filtered
    ]);
    const result = parseFoundryModule({ "packs/vault/000001.log": bytes });
    expect(result.pixelsPerGrid).toBe(100);
    expect(result.gridSquares).toEqual({ x: 14, y: 10 });
    expect(result.walls).toHaveLength(2); // W3 (sight:0) dropped
    expect(result.walls.filter((w) => w.door)).toHaveLength(1);
  });

  it("keeps each scene's own walls apart", () => {
    const bytes = makeWal([
      { key: "!scenes!BASE", doc: { _id: "BASE", name: "Tavern", width: 500, height: 500, grid: 100, walls: [] } },
      { key: "!scenes!NIGHT", doc: { _id: "NIGHT", name: "Tavern (Night)", width: 500, height: 500, grid: 100, walls: [] } },
      { key: "!scenes.walls!BASE.A", doc: { _id: "A", c: [0, 0, 100, 0] } },
      { key: "!scenes.walls!BASE.B", doc: { _id: "B", c: [100, 0, 100, 100] } },
      { key: "!scenes.walls!NIGHT.C", doc: { _id: "C", c: [0, 0, 200, 200] } },
    ]);
    const scenes = collectFoundryScenes({ "packs/tavern/000001.log": bytes });
    expect(scenes.find((s) => s.name === "Tavern")!.walls).toHaveLength(2);
    expect(scenes.find((s) => s.name === "Tavern (Night)")!.walls).toHaveLength(1);
  });
});

describe("parseFoundryModule", () => {
  function makeNedbBytes(scene: object): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(scene) + "\n");
  }

  it("extracts walls and grid from a .db NeDB entry", () => {
    const scene = {
      _id: "abc",
      name: "TestMap",
      width: 1000,
      height: 800,
      grid: 100,
      walls: [
        { c: [0, 0, 1000, 0], sense: 20 },
        { c: [0, 0, 0, 800], sense: 20 },
      ],
    };
    const entries = { "packs/maps.db": makeNedbBytes(scene) };
    const result = parseFoundryModule(entries);
    expect(result.gridSquares).toEqual({ x: 10, y: 8 });
    expect(result.pixelsPerGrid).toBe(100);
    expect(result.walls).toHaveLength(2);
    // walls are in scene px (not scaled by parseFoundryModule)
    expect(result.walls[0]).toEqual({ x1: 0, y1: 0, x2: 1000, y2: 0 });
  });

  it("throws when no scene with walls found", () => {
    expect(() => parseFoundryModule({})).toThrow("No scene with walls found in module");
  });

  it("throws for entries with no valid scene", () => {
    const entries = { "packs/maps.db": new TextEncoder().encode("not json\n") };
    expect(() => parseFoundryModule(entries)).toThrow("No scene with walls found in module");
  });
});

describe("parseFoundryModule — LevelDB .log entries", () => {
  it("reads walls from a packs/*.log entry", () => {
    const scene = {
      _id: "xyz",
      name: "LogScene",
      width: 500,
      height: 500,
      grid: 50,
      walls: [{ c: [0, 0, 500, 0], sense: 20 }],
    };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(scene));
    const header = new Uint8Array(7);
    header[4] = jsonBytes.length & 0xff;
    header[5] = (jsonBytes.length >> 8) & 0xff;
    header[6] = 1; // FULL
    const block = new Uint8Array(7 + jsonBytes.length);
    block.set(header, 0);
    block.set(jsonBytes, 7);

    const entries = { "packs/scenes.log": block };
    const result = parseFoundryModule(entries);
    expect(result.walls).toHaveLength(1);
    expect(result.pixelsPerGrid).toBe(50);
  });
});

describe("parseFoundryModule — end-to-end with fflate zipSync", () => {
  it("importFoundryZip reads walls via zip unzipSync from a synthesized zip", () => {
    const scene = {
      _id: "zip1",
      name: "ZipRoom",
      width: 800,
      height: 600,
      grid: 80,
      walls: [{ c: [0, 0, 800, 0], sense: 20 }, { c: [0, 0, 0, 600], sense: 20 }],
    };
    const nedbStr = JSON.stringify(scene) + "\n";
    const zipped = zipSync({ "packs/maps.db": new TextEncoder().encode(nedbStr) });
    // Unzip manually and feed to parseFoundryModule to verify the chain
    const { unzipSync } = require("fflate") as typeof import("fflate");
    const entries = unzipSync(zipped, { filter: (f: { name: string }) => /\.(db|log|ldb)$/i.test(f.name) });
    const result = parseFoundryModule(entries);
    expect(result.walls).toHaveLength(2);
    expect(result.gridSquares).toEqual({ x: 10, y: 7.5 });
  });
});
