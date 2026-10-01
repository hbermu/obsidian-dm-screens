import { describe, expect, it, vi, beforeEach } from "vitest";
import { PlayerScreenServer } from "../server";

function makePlugin() {
  return {
    app: {
      vault: {
        getAbstractFileByPath: () => null,
        readBinary: async () => new ArrayBuffer(0),
        adapter: {
          exists: async () => true,
        },
      },
    },
    settings: { serverPort: 3000 },
  } as any;
}

describe("Server: hide-background-media cache purge", () => {
  let server: PlayerScreenServer;

  beforeEach(() => {
    server = new PlayerScreenServer(makePlugin());
  });

  it("show-background-media is cached", () => {
    server.broadcast({ type: "show-background-media", payload: { url: "/vault/a.png", mediaType: "image" } });

    const cache = (server as any).lastState as Map<string, string>;
    expect(cache.has("show-background-media")).toBe(true);
  });

  it("hide-background-media deletes the show-background-media cache entry", () => {
    server.broadcast({ type: "show-background-media", payload: { url: "/vault/a.png", mediaType: "image" } });
    server.broadcast({ type: "hide-background-media", payload: {} });

    const cache = (server as any).lastState as Map<string, string>;
    expect(cache.has("show-background-media")).toBe(false);
    expect(cache.has("hide-background-media")).toBe(false);
  });

  it("hide-background-media with no prior show does nothing", () => {
    server.broadcast({ type: "hide-background-media", payload: {} });

    const cache = (server as any).lastState as Map<string, string>;
    expect(cache.size).toBe(0);
  });
});

describe("Server: map-clear preserves map-calibration", () => {
  let server: PlayerScreenServer;

  beforeEach(() => {
    server = new PlayerScreenServer(makePlugin());
  });

  it("map-clear purges map-* entries but keeps map-calibration", () => {
    server.broadcast({ type: "map-show", payload: { url: "/vault/map.png" } });
    server.broadcast({ type: "map-view", payload: { mode: "fit", panX: 0, panY: 0, rotation: 0 } });
    server.broadcast({ type: "map-config", payload: { pxPerSquare: 50 } });
    server.broadcast({ type: "map-calibration", payload: { profiles: {} } });
    server.broadcast({ type: "map-aoe-sync", payload: { aoes: [] } });
    server.broadcast({ type: "map-vision", payload: { visions: [] } });

    server.broadcast({ type: "map-clear", payload: {} });

    const cache = (server as any).lastState as Map<string, string>;
    expect(cache.has("map-show")).toBe(false);
    expect(cache.has("map-view")).toBe(false);
    expect(cache.has("map-config")).toBe(false);
    expect(cache.has("map-aoe-sync")).toBe(false);
    expect(cache.has("map-vision")).toBe(false);
    expect(cache.has("map-calibration")).toBe(true);
  });

  it("map-clear does not affect player channel entries", () => {
    server.broadcast({ type: "show-background-media", payload: { url: "/vault/a.png", mediaType: "image" } });
    server.broadcast({ type: "image-layers-sync", payload: { layers: [] } });
    server.broadcast({ type: "map-show", payload: { url: "/vault/map.png" } });

    server.broadcast({ type: "map-clear", payload: {} });

    const cache = (server as any).lastState as Map<string, string>;
    expect(cache.has("show-background-media")).toBe(true);
    expect(cache.has("image-layers-sync")).toBe(true);
    expect(cache.has("map-show")).toBe(false);
  });
});

describe("Server: state-changed event", () => {
  let server: PlayerScreenServer;

  beforeEach(() => {
    server = new PlayerScreenServer(makePlugin());
  });

  it("onStateChange returns an unsubscribe function", () => {
    const cb = vi.fn();
    const unsub = server.onStateChange(cb);
    expect(typeof unsub).toBe("function");
  });

  it("fires callback after a broadcast", () => {
    const cb = vi.fn();
    server.onStateChange(cb);

    server.broadcast({ type: "show-background-media", payload: { url: "/vault/a.png", mediaType: "image" } });

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("fires callback after a clear", () => {
    const cb = vi.fn();
    server.onStateChange(cb);

    server.broadcast({ type: "clear", payload: {} });

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("fires callback after map-clear", () => {
    const cb = vi.fn();
    server.onStateChange(cb);

    server.broadcast({ type: "map-clear", payload: {} });

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not fire after unsubscribe", () => {
    const cb = vi.fn();
    const unsub = server.onStateChange(cb);

    unsub();
    server.broadcast({ type: "show-background-media", payload: { url: "/vault/a.png", mediaType: "image" } });

    expect(cb).not.toHaveBeenCalled();
  });

  it("supports multiple subscribers", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    server.onStateChange(cb1);
    server.onStateChange(cb2);

    server.broadcast({ type: "show-background-media", payload: { url: "/vault/a.png", mediaType: "image" } });

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});
