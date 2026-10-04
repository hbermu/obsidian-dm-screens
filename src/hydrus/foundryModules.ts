import { inflateSync, unzipSync } from "fflate";
import { debug, debugWarn } from "../debug";
import { collectFoundryScenes, type FoundryScene } from "../map/foundry";
import type { HydrusClient, HydrusFile } from "./client";

export const FOUNDRY_MODULE_TAG = "type:foundry module";
const MAX_MODULES = 8;
const WALL_DATA = /\.(db|log|ldb)$/i;
// End-of-central-directory record (22 bytes) plus the longest zip comment.
const EOCD_SEARCH = 22 + 0xffff;

export type RangeReader = (start: number, end: number) => Promise<{ bytes: Uint8Array; partial: boolean }>;

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

// A module zip is 100-500 MB of artwork around a few MB of scene data. Reading
// the central directory and then only the matching entries keeps an automatic
// import to a handful of small ranged requests.
export async function readZipEntries(read: RangeReader, size: number, wanted: RegExp): Promise<Record<string, Uint8Array>> {
  const filter = (f: { name: string }) => wanted.test(f.name);
  const tailStart = Math.max(0, size - EOCD_SEARCH);
  const tail = await read(tailStart, size - 1);
  if (!tail.partial) return unzipSync(tail.bytes, { filter });

  let eocd = -1;
  for (let i = tail.bytes.length - 22; i >= 0; i--) {
    if (u32(tail.bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip archive");
  const cdSize = u32(tail.bytes, eocd + 12);
  const cdOffset = u32(tail.bytes, eocd + 16);
  // Zip64 archives move these fields elsewhere; a whole read handles them.
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) return unzipSync((await read(0, size - 1)).bytes, { filter });

  const cd =
    cdOffset >= tailStart
      ? tail.bytes.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
      : (await read(cdOffset, cdOffset + cdSize - 1)).bytes;

  const entries: Record<string, Uint8Array> = {};
  let p = 0;
  while (p + 46 <= cd.length && u32(cd, p) === 0x02014b50) {
    const method = u16(cd, p + 10);
    const compSize = u32(cd, p + 20);
    const nameLen = u16(cd, p + 28);
    const local = u32(cd, p + 42);
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + u16(cd, p + 30) + u16(cd, p + 32);
    if (!wanted.test(name)) continue;
    if (method !== 0 && method !== 8) {
      debugWarn("Foundry module: skipping entry with unsupported compression", method);
      continue;
    }
    // The local header's extra field can differ from the central one, so its
    // own lengths locate the data.
    const header = (await read(local, local + 29)).bytes;
    const dataStart = local + 30 + u16(header, 26) + u16(header, 28);
    const data = compSize === 0 ? new Uint8Array(0) : (await read(dataStart, dataStart + compSize - 1)).bytes;
    entries[name] = method === 8 ? inflateSync(data) : data;
  }
  return entries;
}

export async function findFoundryModules(client: HydrusClient, mapTags: string[]): Promise<HydrusFile[]> {
  const names = mapTags.filter((t) => t.startsWith("name:"));
  if (names.length === 0) return [];
  const hashes = new Set<string>();
  for (const name of names) {
    for (const hash of (await client.searchFiles([name, FOUNDRY_MODULE_TAG], MAX_MODULES)).hashes) hashes.add(hash);
  }
  debug("Foundry module: search over", names.length, "name tags found", hashes.size, "modules");
  if (hashes.size === 0) return [];
  return client.getFileMetadata([...hashes].slice(0, MAX_MODULES));
}

export async function loadModuleScenes(client: HydrusClient, modules: HydrusFile[]): Promise<FoundryScene[]> {
  const scenes: FoundryScene[] = [];
  for (const module of modules) {
    try {
      const entries = await readZipEntries((start, end) => client.getFileRange(module.hash, start, end), module.size, WALL_DATA);
      const found = collectFoundryScenes(entries);
      debug("Foundry module:", module.hash.slice(0, 8), Object.keys(entries).length, "data entries,", found.length, "scenes with walls");
      scenes.push(...found);
    } catch (err) {
      debugWarn("Foundry module: could not read", module.hash.slice(0, 8), (err as Error).message);
    }
  }
  return scenes;
}
