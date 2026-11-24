import { describe, expect, it, vi } from "vitest";
import { ReplayCache } from "../server";
import { DEFAULT_SETTINGS } from "../settings";
import { EmbeddedTransport } from "../transport/embedded";

// A plugin with the real session accessors, switched between modes the way
// setServerMode does.
function makePlugin() {
  const plugin: any = {
    settings: {
      ...DEFAULT_SETTINGS,
      lastBroadcastCache: { "combat-scale": '{"type":"combat-scale","payload":{"scale":2}}' },
      lastImageLayers: '[{"id":"local-1"}]',
      lastSourceLabels: { map: { label: "Local map", title: "Local map" } },
    },
    server: { broadcast: vi.fn() },
    saveSettings: vi.fn(async () => {}),
    app: { vault: { adapter: {} } },
    remoteSourceLabels: {} as Record<string, unknown>,
    sessionIsLocal(): boolean {
      return this.transport.mode === "embedded";
    },
    sourceLabels() {
      return this.sessionIsLocal() ? (this.settings.lastSourceLabels ??= {}) : this.remoteSourceLabels;
    },
  };
  plugin.transport = new EmbeddedTransport(plugin);
  plugin.replayCache = new ReplayCache(plugin.settings.lastBroadcastCache);
  // The same subscription initReplayCache makes.
  plugin.replayCache.onChange(() => {
    if (!plugin.sessionIsLocal()) return;
    plugin.settings.lastBroadcastCache = plugin.replayCache.toRecord();
  });
  return plugin;
}

const goRemote = (plugin: any) => {
  plugin.transport = { mode: "remote" };
  plugin.remoteSourceLabels = {};
};
const goEmbedded = (plugin: any) => {
  plugin.transport = new EmbeddedTransport(plugin);
};

describe("switching to remote mode and back", () => {
  it("leaves the embedded session in data.json untouched", () => {
    const plugin = makePlugin();
    const before = JSON.parse(JSON.stringify(plugin.settings));

    goRemote(plugin);
    // The server's session replaces what this device holds in memory.
    plugin.replayCache.replace({ "map-show": '{"type":"map-show","payload":{"url":"/assets/x.png"}}' });
    plugin.sourceLabels().map = { label: "Remote map", title: "Remote map" };

    expect(plugin.settings.lastBroadcastCache).toEqual(before.lastBroadcastCache);
    expect(plugin.settings.lastImageLayers).toBe(before.lastImageLayers);
    expect(plugin.settings.lastSourceLabels).toEqual(before.lastSourceLabels);

    goEmbedded(plugin);
    expect(plugin.sourceLabels().map).toEqual({ label: "Local map", title: "Local map" });
  });

  it("keeps the two sessions' labels apart", () => {
    const plugin = makePlugin();
    goRemote(plugin);
    expect(plugin.sourceLabels().map).toBeUndefined();
    plugin.sourceLabels().map = { label: "Remote map", title: "Remote map" };

    goEmbedded(plugin);
    expect(plugin.sourceLabels().map.label).toBe("Local map");
  });

  it("resumes persisting once back in embedded mode", () => {
    const plugin = makePlugin();
    plugin.server = null; // stopped, so the transport records into the cache
    goRemote(plugin);
    plugin.replayCache.replace({ "map-show": "{}" });
    goEmbedded(plugin);

    plugin.transport.broadcast({ type: "combat-scale", payload: { scale: 3 } });
    expect(JSON.parse(plugin.settings.lastBroadcastCache["combat-scale"]).payload.scale).toBe(3);
  });

  it("drops the server's scene from memory when it reloads the local one", () => {
    const plugin = makePlugin();
    goRemote(plugin);
    plugin.replayCache.replace({ "map-show": '{"type":"map-show","payload":{"url":"/assets/x.png"}}' });
    goEmbedded(plugin);

    // What reloadLocalSession does: the device's own session comes back.
    plugin.replayCache.replace(plugin.settings.lastBroadcastCache);
    expect([...plugin.replayCache.entries.keys()]).toEqual(["combat-scale"]);
  });
});
