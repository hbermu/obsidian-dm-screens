import type DmScreenPlugin from "../main";
import type { PlayerMessage } from "../server";
import { fogSidecarPath, loadFogSidecar, saveFogSidecar, type FogAdapter } from "../map/fog";
import { loadWallsSidecar, saveWallsSidecar } from "../map/walls";
import type { MapWall, ScreenProfile, StoredMapState } from "../map/types";
import { debug } from "../debug";
import type { MapDataStore, SceneTransport } from "./transport";

class EmbeddedMapData implements MapDataStore {
  constructor(private plugin: DmScreenPlugin) {}

  private adapter(): FogAdapter {
    return this.plugin.app.vault.adapter as unknown as FogAdapter;
  }

  config(mapUrl: string): StoredMapState | undefined {
    return this.plugin.settings.mapConfigs[mapUrl];
  }

  setConfig(mapUrl: string, state: StoredMapState): void {
    this.plugin.settings.mapConfigs[mapUrl] = { ...state };
    void this.plugin.saveSettings();
  }

  profiles(): Record<string, ScreenProfile> {
    return this.plugin.settings.mapScreenProfiles;
  }

  setProfile(key: string, profile: ScreenProfile | null): void {
    if (profile) this.plugin.settings.mapScreenProfiles[key] = { ...profile };
    else delete this.plugin.settings.mapScreenProfiles[key];
    void this.plugin.saveSettings();
  }

  loadFog(mapUrl: string): Promise<string | null> {
    return loadFogSidecar(this.adapter(), mapUrl);
  }

  async saveFog(mapUrl: string, dataUrl: string | null): Promise<void> {
    if (dataUrl) return saveFogSidecar(this.adapter(), mapUrl, dataUrl);
    const path = fogSidecarPath(mapUrl);
    const adapter = this.plugin.app.vault.adapter;
    if (await adapter.exists(path)) await adapter.remove(path);
  }

  loadWalls(mapUrl: string): Promise<MapWall[]> {
    return loadWallsSidecar(this.adapter(), mapUrl);
  }

  saveWalls(mapUrl: string, walls: MapWall[]): Promise<void> {
    return saveWallsSidecar(this.adapter(), mapUrl, walls);
  }
}

export class EmbeddedTransport implements SceneTransport {
  readonly mode = "embedded";
  readonly mapData: MapDataStore;

  constructor(private plugin: DmScreenPlugin) {
    this.mapData = new EmbeddedMapData(plugin);
  }

  isLive(): boolean {
    return !!this.plugin.server;
  }

  canEdit(): boolean {
    return true;
  }

  // The replay cache stays current while the server is stopped; the server
  // replays it to clients on start.
  broadcast(message: PlayerMessage): void {
    if (this.plugin.server) {
      this.plugin.server.broadcast(message);
      return;
    }
    debug("broadcast (server stopped, cached only):", message.type);
    this.plugin.replayCache.record(message);
  }

  sendLive(message: PlayerMessage): void {
    this.plugin.server?.broadcast(message);
  }
}
