import type DmScreenPlugin from "../main";
import type { PlayerMessage } from "../server";
import { fogSidecarPath, loadFogSidecar, saveFogSidecar, type FogAdapter } from "../map/fog";
import { loadWallsSidecar, saveWallsSidecar } from "../map/walls";
import type { MapWall, ScreenProfile, StoredMapState } from "../map/types";
import { debug } from "../debug";
import { buildJoinUrl } from "../auth";
import { vaultPathFromUrl } from "../server";
import { sourceFromVaultUrl } from "../scenes/format";
import type { JoinLink, MapDataStore, SceneTransport } from "./transport";
import { encodeVaultPath, toWire } from "./wire";

// The first non-internal IPv4 address: what a screen on the LAN dials.
function lanAddress(): string | null {
  try {
    const os = require("os") as typeof import("os");
    for (const list of Object.values(os.networkInterfaces())) {
      for (const iface of list ?? []) {
        if (iface.family === "IPv4" && !iface.internal) return iface.address;
      }
    }
  } catch {
    /* no os module (mobile): no LAN address to offer */
  }
  return null;
}

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
    const wire = toWire(message);
    if (this.plugin.server) {
      this.plugin.server.broadcast(wire);
      return;
    }
    debug("broadcast (server stopped, cached only):", message.type);
    this.plugin.replayCache.record(wire);
  }

  sendLive(message: PlayerMessage): void {
    this.plugin.server?.broadcast(toWire(message));
  }

  async publishMedia(url: string): Promise<string> {
    return url;
  }

  async mediaUrl(vaultPath: string): Promise<string> {
    return `/vault/${encodeVaultPath(vaultPath)}`;
  }

  displayUrl(url: string): string | null {
    const vaultPath = vaultPathFromUrl(url);
    if (vaultPath === null) return url;
    const adapter = this.plugin.app.vault.adapter as { getResourcePath?: (p: string) => string };
    return adapter.getResourcePath?.(vaultPath) ?? null;
  }

  sourceOf(url: string): string | null {
    return sourceFromVaultUrl(url, this.plugin.settings.cacheBaseFolder);
  }

  rememberSource(_url: string, _source: string): void {}

  joinLink(path: "/" | "/map"): JoinLink | null {
    if (!this.plugin.server) return null;
    const host = lanAddress() ?? "localhost";
    const port = this.plugin.settings.serverPort;
    const text = `http://${host}:${port}${path === "/" ? "" : path}`;
    return { href: buildJoinUrl(host, port, this.plugin.settings.accessToken, path), text };
  }
}
