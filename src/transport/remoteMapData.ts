import { Notice } from "obsidian";
import { pngDataUrl } from "../map/fog";
import type { MapWall, ScreenProfile, StoredMapState } from "../map/types";
import { debugWarn } from "../debug";
import type { AssetPublisher } from "./assetUpload";
import { callApi, type RemoteEndpoint } from "./remoteApi";
import type { MapDataStore } from "./transport";

interface MapDataDoc {
  configs: Record<string, StoredMapState>;
  profiles: Record<string, ScreenProfile>;
  fog: Record<string, string>;
  walls: Record<string, MapWall[]>;
  sources: Record<string, string>;
}

const empty = (): MapDataDoc => ({ configs: {}, profiles: {}, fog: {}, walls: {}, sources: {} });

// The server's map-data store, read once per hello and written per change,
// so whichever device takes control next sees the same grids, fog and walls.
export class RemoteMapData implements MapDataStore {
  private doc: MapDataDoc = empty();
  private warned = false;

  constructor(private endpoint: () => RemoteEndpoint, private publisher: AssetPublisher) {}

  async load(): Promise<void> {
    const res = await callApi(this.endpoint(), "GET", "/api/mapdata");
    this.doc = res.status === 200 ? { ...empty(), ...res.json } : empty();
  }

  private write(collection: keyof MapDataDoc, key: string, value: unknown | null): void {
    const path = `/api/mapdata/${collection}/${encodeURIComponent(key)}`;
    const call = value === null ? callApi(this.endpoint(), "DELETE", path) : callApi(this.endpoint(), "PUT", path, value);
    void call.then((res) => {
      if (res.status === 204 || this.warned) return;
      this.warned = true;
      debugWarn("RemoteMapData: write answered", res.status, "for", collection);
      new Notice("The remote server did not save a map setting; it may be lost on the next hand-over.");
    });
  }

  config(mapUrl: string): StoredMapState | undefined {
    return this.doc.configs[mapUrl];
  }

  setConfig(mapUrl: string, state: StoredMapState): void {
    this.doc.configs[mapUrl] = { ...state };
    this.write("configs", mapUrl, state);
  }

  profiles(): Record<string, ScreenProfile> {
    return this.doc.profiles;
  }

  setProfile(key: string, profile: ScreenProfile | null): void {
    if (profile) this.doc.profiles[key] = { ...profile };
    else delete this.doc.profiles[key];
    this.write("profiles", key, profile);
  }

  async loadFog(mapUrl: string): Promise<string | null> {
    const asset = this.doc.fog[mapUrl];
    if (!asset) return null;
    const res = await callApi(this.endpoint(), "GET", asset);
    return res.status === 200 ? pngDataUrl(new Uint8Array(res.arrayBuffer)) : null;
  }

  async saveFog(mapUrl: string, dataUrl: string | null): Promise<void> {
    if (!dataUrl) {
      delete this.doc.fog[mapUrl];
      this.write("fog", mapUrl, null);
      return;
    }
    const asset = await this.publisher.publishDataUrl(dataUrl);
    this.doc.fog[mapUrl] = asset;
    this.write("fog", mapUrl, asset);
  }

  async loadWalls(mapUrl: string): Promise<MapWall[]> {
    return this.doc.walls[mapUrl] ?? [];
  }

  async saveWalls(mapUrl: string, walls: MapWall[]): Promise<void> {
    this.doc.walls[mapUrl] = walls;
    this.write("walls", mapUrl, walls);
  }

  source(assetName: string): string | null {
    return this.doc.sources[assetName] ?? null;
  }

  setSource(assetName: string, source: string): void {
    if (this.doc.sources[assetName] === source) return;
    this.doc.sources[assetName] = source;
    this.write("sources", assetName, source);
  }
}
