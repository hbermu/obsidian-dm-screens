import { describe, expect, it, vi } from "vitest";
import { ReplayCache } from "../server";
import { EmbeddedTransport } from "../transport/embedded";
import { fogSidecarPath } from "../map/fog";
import { wallsSidecarPath } from "../map/walls";
import type { StoredMapState } from "../map/types";

function makePlugin(server: { broadcast: (m: unknown) => void } | null = null) {
  const files: Record<string, Uint8Array> = {};
  const plugin = {
    server,
    replayCache: new ReplayCache(),
    settings: { mapConfigs: {} as Record<string, StoredMapState>, mapScreenProfiles: {} as Record<string, unknown> },
    saveSettings: vi.fn(() => Promise.resolve()),
    app: {
      vault: {
        adapter: {
          exists: (p: string) => Promise.resolve(p in files),
          readBinary: (p: string) => Promise.resolve(files[p].slice().buffer),
          writeBinary: (p: string, data: ArrayBuffer) => {
            files[p] = new Uint8Array(data);
            return Promise.resolve();
          },
          mkdir: () => Promise.resolve(),
        },
      },
    },
  };
  return { plugin, files, transport: new EmbeddedTransport(plugin as any) };
}

const MSG = { type: "combat-scale", payload: { scale: 1 } };

describe("EmbeddedTransport", () => {
  it("is live exactly while the server runs", () => {
    const { plugin, transport } = makePlugin();
    expect(transport.isLive()).toBe(false);
    (plugin as any).server = { broadcast: vi.fn() };
    expect(transport.isLive()).toBe(true);
  });

  it("forwards a broadcast to the running server", () => {
    const server = { broadcast: vi.fn() };
    const { plugin, transport } = makePlugin(server);
    transport.broadcast(MSG);
    expect(server.broadcast).toHaveBeenCalledWith(MSG);
    expect(plugin.replayCache.entries.size).toBe(0);
  });

  it("records a broadcast in the replay cache while the server is stopped", () => {
    const { plugin, transport } = makePlugin();
    transport.broadcast(MSG);
    expect(plugin.replayCache.entries.get("combat-scale")).toBe(JSON.stringify(MSG));
  });

  it("drops a live-only message while the server is stopped", () => {
    const { plugin, transport } = makePlugin();
    transport.sendLive(MSG);
    expect(plugin.replayCache.entries.size).toBe(0);
  });

  it("sends a live-only message to the running server", () => {
    const server = { broadcast: vi.fn() };
    const { transport } = makePlugin(server);
    transport.sendLive(MSG);
    expect(server.broadcast).toHaveBeenCalledWith(MSG);
  });
});

describe("EmbeddedTransport map data", () => {
  const state = { mode: "fit", panX: 0, panY: 0, rotation: 0 } as unknown as StoredMapState;

  it("keeps map configs in settings and saves them", () => {
    const { plugin, transport } = makePlugin();
    transport.mapData.setConfig("/vault/a.png", state);
    expect(plugin.settings.mapConfigs["/vault/a.png"]).toEqual(state);
    expect(plugin.settings.mapConfigs["/vault/a.png"]).not.toBe(state);
    expect(transport.mapData.config("/vault/a.png")).toEqual(state);
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("sets and deletes calibration profiles in settings", () => {
    const { plugin, transport } = makePlugin();
    transport.mapData.setProfile("1920x1080@1", { diagonalInches: 43, fineTune: 1 });
    expect(transport.mapData.profiles()).toEqual({ "1920x1080@1": { diagonalInches: 43, fineTune: 1 } });
    transport.mapData.setProfile("1920x1080@1", null);
    expect(plugin.settings.mapScreenProfiles).toEqual({});
    expect(plugin.saveSettings).toHaveBeenCalledTimes(2);
  });

  it("stores fog and walls in the vault sidecars", async () => {
    const { files, transport } = makePlugin();
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    await transport.mapData.saveFog("/vault/a.png", png);
    await transport.mapData.saveWalls("/vault/a.png", [{ x1: 0, y1: 0, x2: 1, y2: 1 }]);
    expect(Object.keys(files).sort()).toEqual([fogSidecarPath("/vault/a.png"), wallsSidecarPath("/vault/a.png")].sort());
    expect(await transport.mapData.loadFog("/vault/a.png")).toBe(png);
    expect(await transport.mapData.loadWalls("/vault/a.png")).toEqual([{ x1: 0, y1: 0, x2: 1, y2: 1 }]);
  });
});
