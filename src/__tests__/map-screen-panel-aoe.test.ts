import { afterEach, describe, expect, it, vi } from "vitest";
import { MapScreenPanel } from "../views/MapScreenPanel";
import type { MapAoe, MapVision } from "../map/types";
import { anchorToView } from "../map/vision";
import { EmbeddedTransport } from "../transport/embedded";
import { SessionPreferences } from "../integrations/prefs";

interface Broadcast {
  type: string;
  payload: Record<string, unknown>;
}

function makePanel() {
  const broadcasts: Broadcast[] = [];
  const plugin = {
    settings: {
      mapConfigs: {} as Record<string, unknown>,
      mapDefaultPxPerSquare: 140,
      mapScreenProfiles: {},
      tvWidth: 1920,
      tvHeight: 1080,
      hydrusDefaultLoop: true,
      hydrusDefaultMuted: true,
      mapFogTvOpacity: 1,
    },
    server: {},
    broadcast: (msg: Broadcast) => broadcasts.push(msg),
    replayCache: { forget: () => {} },
    saveSettings: () => Promise.resolve(),
    broadcastMapCalibration: () => {},
    app: { vault: { adapter: { exists: () => Promise.resolve(false) } } },
  };
  (plugin as any).transport = new EmbeddedTransport(plugin as any);
  (plugin as any).prefs = new SessionPreferences(plugin as any);
  (plugin as any).sessionIsLocal ??= () => (plugin as any).transport?.mode !== "remote";
  (plugin as any).sourceLabels ??= () => ((plugin as any).settings.lastSourceLabels ??= {});
  (plugin as any).hydrusApi = () => null;
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const host = {
    render: vi.fn(),
    beginDrag: vi.fn(() => {
      const release = vi.fn();
      releases.push(release);
      return release;
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const panel = new MapScreenPanel(plugin as any, host as any);
  return { panel, broadcasts, host, releases };
}

const AOE: MapAoe = {
  id: "aoe-1",
  shape: "circle",
  sizeFt: 20,
  widthFt: 5,
  color: "#ff4400",
  opacity: 0.3,
  rotation: 0,
  x: 100,
  y: 200,
};

function cacheWith(view: Record<string, unknown>): Record<string, string> {
  return {
    "map-show": JSON.stringify({
      type: "map-show",
      payload: { url: "/vault/m.jpg", mediaType: "image", naturalWidth: 4480, naturalHeight: 7000 },
    }),
    "map-view": JSON.stringify({ type: "map-view", payload: view }),
    "map-aoe-sync": JSON.stringify({ type: "map-aoe-sync", payload: { aoes: [AOE] } }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// Every drag now starts from a pointer event, so one stands in for the press.
const press = (pointerId = 1) => new PointerEvent("pointerdown", { pointerId, clientX: 0, clientY: 0 });
const release = (pointerId = 1) => document.dispatchEvent(new PointerEvent("pointerup", { pointerId }));

describe("MapScreenPanel drag tracking", () => {
  it("releases the panel's drag lock when the pointer is released", () => {
    const { panel, releases } = makePanel();
    panel.trackDrag(press(), () => {});
    expect(releases[0]).not.toHaveBeenCalled();

    release();
    expect(releases[0]).toHaveBeenCalledTimes(1);
  });

  it("tears down a prior drag whose release was missed", () => {
    const { panel, releases } = makePanel();
    panel.trackDrag(press(), () => {});
    panel.trackDrag(press(), () => {});

    // Without this the lock would leak and the panel would stop accepting
    // background renders for the rest of its life.
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(releases[1]).not.toHaveBeenCalled();

    release();
    expect(releases[1]).toHaveBeenCalledTimes(1);
  });

  it("does not run the drag's onEnd when it is torn down by a newer drag", () => {
    const { panel } = makePanel();
    const onEnd = vi.fn();
    panel.trackDrag(press(), () => {}, onEnd);
    panel.trackDrag(press(), () => {});

    expect(onEnd).not.toHaveBeenCalled();
    release();
  });

  it("stops moving a torn-down drag", () => {
    const { panel } = makePanel();
    const firstMove = vi.fn();
    panel.trackDrag(press(), firstMove);
    panel.trackDrag(press(), () => {});

    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 50, clientY: 50 }));
    expect(firstMove).not.toHaveBeenCalled();
    release();
  });
});

describe("MapScreenPanel AoE lifecycle", () => {
  it("restoreFromCache restores the AoE list from the cached map-aoe-sync", () => {
    const { panel } = makePanel();
    panel.restoreFromCache(cacheWith({ mode: "fit", panX: 2240, panY: 3500, rotation: 0 }));
    expect(panel.aoes).toEqual([AOE]);
  });

  it("restoreFromCache re-clamps a stale physical pan to the viewport window", () => {
    const { panel } = makePanel();
    panel.restoreFromCache(cacheWith({ mode: "physical", panX: 0, panY: 0, rotation: 0 }));
    // Uncalibrated fallback: scale = 96/140; halfVisW = 1920·140/192 = 1400,
    // halfVisH = 1080·140/192 = 787.5 — pan (0,0) snaps to the window edge.
    expect(panel.state.panX).toBeCloseTo(1400, 6);
    expect(panel.state.panY).toBeCloseTo(787.5, 6);
  });

  it("restoreFromCache leaves a fit-mode pan untouched", () => {
    const { panel } = makePanel();
    panel.restoreFromCache(cacheWith({ mode: "fit", panX: 2240, panY: 3500, rotation: 0 }));
    expect(panel.state.panX).toBe(2240);
    expect(panel.state.panY).toBe(3500);
  });

  it("stopMap clears the AoE list and broadcasts map-clear", () => {
    const { panel, broadcasts } = makePanel();
    panel.activeMap = { url: "/vault/m.jpg", mediaType: "image", naturalWidth: 4480, naturalHeight: 7000 };
    panel.aoes = [AOE];
    panel.stopMap();
    expect(panel.aoes).toEqual([]);
    expect(panel.activeMap).toBeNull();
    expect(broadcasts.map((b) => b.type)).toEqual(["map-clear"]);
  });

  it("republish re-broadcasts map-aoe-sync only when AoEs exist", () => {
    const { panel, broadcasts } = makePanel();
    panel.activeMap = { url: "/vault/m.jpg", mediaType: "image", naturalWidth: 4480, naturalHeight: 7000 };
    panel.republish();
    expect(broadcasts.map((b) => b.type)).toEqual(["map-show", "map-config", "map-view", "map-fog", "map-walls"]);

    broadcasts.length = 0;
    panel.aoes = [AOE];
    panel.republish();
    expect(broadcasts.map((b) => b.type)).toEqual(["map-show", "map-config", "map-view", "map-aoe-sync", "map-fog", "map-walls"]);
    expect(broadcasts[3].payload).toEqual({ aoes: [AOE] });
  });

  it("syncBoundVisions carries a bound vision by its offset from the view centre and broadcasts", () => {
    const { panel, broadcasts } = makePanel();
    panel.activeMap = { url: "/vault/m.jpg", mediaType: "image", naturalWidth: 4480, naturalHeight: 7000 };
    // View centre at (400, 500) with the light at (500, 600); moving the view to
    // (600, 800) puts the light at (700, 900) — it keeps its place relative to the view.
    panel.state.panX = 400;
    panel.state.panY = 500;
    const bound: MapVision = { id: "v-1", shape: "circle", x: 500, y: 600, sizeFt: 30, dimFt: 0, featherFt: 5, followsView: true };
    anchorToView(bound, panel.state.panX, panel.state.panY);
    const free: MapVision = { id: "v-2", shape: "square", x: 999, y: 888, sizeFt: 30, dimFt: 0, featherFt: 5 };
    panel.visions = [bound, free];
    expect(panel.syncBoundVisions(true)).toBe(false);

    panel.state.panX = 600;
    panel.state.panY = 800;
    const changed = panel.syncBoundVisions(true);

    expect(changed).toBe(true);
    expect([bound.x, bound.y]).toEqual([700, 900]);
    expect([free.x, free.y]).toEqual([999, 888]);
    const vis = broadcasts.filter((b) => b.type === "map-vision");
    expect(vis).toHaveLength(1);
    expect((vis[0].payload as { visions: MapVision[] }).visions[0].x).toBe(700);
  });

  it("syncBoundVisions keeps a bound vision on the map but remembers its offset", () => {
    const { panel } = makePanel();
    panel.activeMap = { url: "/vault/m.jpg", mediaType: "image", naturalWidth: 4480, naturalHeight: 7000 };
    const bound: MapVision = {
      id: "v-1", shape: "circle", x: 0, y: 0, sizeFt: 30, dimFt: 0, featherFt: 5,
      followsView: true, viewOffsetX: -500, viewOffsetY: 0,
    };
    panel.visions = [bound];
    panel.state.panX = 200;
    panel.state.panY = 1000;
    panel.syncBoundVisions(true);
    expect([bound.x, bound.y]).toEqual([0, 1000]);
    panel.state.panX = 2000;
    panel.syncBoundVisions(true);
    expect([bound.x, bound.y]).toEqual([1500, 1000]);
  });

  it("syncBoundVisions centres a bound vision that has no offset yet", () => {
    const { panel } = makePanel();
    panel.activeMap = { url: "/vault/m.jpg", mediaType: "image", naturalWidth: 4480, naturalHeight: 7000 };
    const bound: MapVision = { id: "v-1", shape: "circle", x: 10, y: 20, sizeFt: 30, dimFt: 0, featherFt: 5, followsView: true };
    panel.visions = [bound];
    panel.state.panX = 1000;
    panel.state.panY = 1500;
    expect(panel.syncBoundVisions(true)).toBe(true);
    expect([bound.x, bound.y]).toEqual([1000, 1500]);
  });

  it("syncBoundVisions is a no-op (no broadcast) when no vision follows the view", () => {
    const { panel, broadcasts } = makePanel();
    panel.activeMap = { url: "/vault/m.jpg", mediaType: "image", naturalWidth: 4480, naturalHeight: 7000 };
    panel.state.panX = 1000;
    panel.state.panY = 1500;
    panel.visions = [{ id: "v-1", shape: "circle", x: 10, y: 20, sizeFt: 30, dimFt: 0, featherFt: 5 }];

    expect(panel.syncBoundVisions(true)).toBe(false);
    expect(broadcasts.filter((b) => b.type === "map-vision")).toHaveLength(0);
  });

  it("broadcastAoes throttles trailing sends and flushes immediately when forced", () => {
    vi.useFakeTimers();
    const { panel, broadcasts } = makePanel();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = panel as any;

    p.broadcastAoes();
    p.broadcastAoes();
    p.broadcastAoes();
    expect(broadcasts.length).toBe(0);
    vi.advanceTimersByTime(80);
    expect(broadcasts.length).toBe(1);

    p.broadcastAoes();
    p.broadcastAoes(true);
    expect(broadcasts.length).toBe(2);
    vi.advanceTimersByTime(500);
    expect(broadcasts.length).toBe(2);
  });
});
