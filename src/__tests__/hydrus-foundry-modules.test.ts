import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { zipSync } from "fflate";
import { HydrusClient, type HydrusFile } from "../hydrus/client";
import { FOUNDRY_MODULE_TAG, findFoundryModules, loadModuleScenes, readZipEntries, type RangeReader } from "../hydrus/foundryModules";

const enc = new TextEncoder();
const scene = (name: string) =>
  JSON.stringify({ _id: name, name, width: 1000, height: 800, grid: 100, walls: [{ c: [0, 0, 100, 0], sense: 20 }] }) + "\n";

// A module-shaped zip: a large incompressible artwork entry (stored, never
// inflated) next to the small scene pack the importer actually needs.
function moduleZip(): Uint8Array {
  const art = new Uint8Array(300_000);
  for (let i = 0; i < art.length; i++) art[i] = (i * 2654435761) >>> 24;
  return zipSync({
    "module.json": enc.encode('{"id":"test"}'),
    "assets/Map_Day.webp": [art, { level: 0 }],
    "packs/maps.db": enc.encode(scene("Hall") + scene("Hall (Night)")),
  });
}

function rangeReader(bytes: Uint8Array, honoursRange = true) {
  const calls: Array<[number, number]> = [];
  const read: RangeReader = async (start, end) => {
    calls.push([start, end]);
    return honoursRange ? { bytes: bytes.slice(start, end + 1), partial: true } : { bytes, partial: false };
  };
  return { read, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readZipEntries", () => {
  it("reads only the matching entries through ranged requests", async () => {
    const zip = moduleZip();
    const { read, calls } = rangeReader(zip);
    const entries = await readZipEntries(read, zip.length, /\.(db|log|ldb)$/i);
    expect(Object.keys(entries)).toEqual(["packs/maps.db"]);
    expect(new TextDecoder().decode(entries["packs/maps.db"])).toContain('"name":"Hall (Night)"');
    const fetched = calls.reduce((n, [s, e]) => n + (e - s + 1), 0);
    expect(fetched).toBeLessThan(zip.length / 2);
  });

  it("falls back to the whole archive when the server ignores Range", async () => {
    const zip = moduleZip();
    const { read, calls } = rangeReader(zip, false);
    const entries = await readZipEntries(read, zip.length, /\.db$/i);
    expect(Object.keys(entries)).toEqual(["packs/maps.db"]);
    expect(calls).toHaveLength(1);
  });

  it("rejects bytes that are not a zip archive", async () => {
    const junk = new Uint8Array(4096);
    await expect(readZipEntries(rangeReader(junk).read, junk.length, /\.db$/i)).rejects.toThrow("not a zip archive");
  });
});

describe("findFoundryModules / loadModuleScenes", () => {
  const client = new HydrusClient({ baseUrl: "https://hydrus-api.test", apiKey: "deadbeef" });
  const module: HydrusFile = { hash: "a".repeat(64), mime: "application/zip", ext: ".zip", size: 0, knownTags: [] };

  it("searches each name: tag together with the module type tag", async () => {
    const search = vi.spyOn(client, "searchFiles").mockResolvedValue({ hashes: [module.hash] });
    const meta = vi.spyOn(client, "getFileMetadata").mockResolvedValue([module]);
    const found = await findFoundryModules(client, ["name:abbey prison", "original day", "artist:czepeku"]);
    expect(search).toHaveBeenCalledWith(["name:abbey prison", FOUNDRY_MODULE_TAG], 8);
    expect(meta).toHaveBeenCalledWith([module.hash]);
    expect(found).toEqual([module]);
  });

  it("skips the search when the map has no name: tag", async () => {
    const search = vi.spyOn(client, "searchFiles");
    expect(await findFoundryModules(client, ["original day"])).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it("collects the scenes of every module and skips one that cannot be read", async () => {
    const zip = moduleZip();
    const good = { ...module, size: zip.length };
    const bad = { ...module, hash: "b".repeat(64), size: 4096 };
    vi.spyOn(client, "getFileRange").mockImplementation(async (hash, start, end) =>
      hash === good.hash ? { bytes: zip.slice(start, end + 1), partial: true } : { bytes: new Uint8Array(end - start + 1), partial: true }
    );
    const scenes = await loadModuleScenes(client, [bad, good]);
    expect(scenes.map((s) => s.name)).toEqual(["Hall", "Hall (Night)"]);
  });

  it("getFileRange sends a Range header and reports a partial answer", async () => {
    let headers: Record<string, string> | undefined;
    vi.spyOn(obsidian, "requestUrl").mockImplementation(((param: { headers?: Record<string, string> }) => {
      headers = param.headers;
      return Promise.resolve({ status: 206, json: {}, text: "", arrayBuffer: new Uint8Array([1, 2, 3]).buffer, headers: {} });
    }) as unknown as typeof obsidian.requestUrl);
    const res = await client.getFileRange(module.hash, 10, 12);
    expect(headers?.Range).toBe("bytes=10-12");
    expect(headers?.["Hydrus-Client-API-Access-Key"]).toBe("deadbeef");
    expect(res).toEqual({ bytes: new Uint8Array([1, 2, 3]), partial: true });
  });
});
