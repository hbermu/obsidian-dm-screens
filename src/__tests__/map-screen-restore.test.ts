import { beforeAll, describe, expect, it, vi } from "vitest";
import { MapScreenPanel } from "../views/MapScreenPanel";
import { Notice } from "obsidian";

beforeAll(() => {
  if (!HTMLElement.prototype.addClass) {
    HTMLElement.prototype.addClass = function (cls: string) {
      this.classList.add(cls);
    };
  }
});

vi.mock("../hydrus/recoverImage", () => ({
  recoverVaultImage: vi.fn(),
}));

vi.mock("obsidian", async () => {
  const actual = await vi.importActual<typeof import("../../test/stubs/obsidian")>(
    "../../test/stubs/obsidian"
  );
  return {
    ...actual,
    Notice: vi.fn(),
  };
});

function makeServerStub() {
  return {
    broadcast: vi.fn(),
    forgetCached: vi.fn(),
    cachedEntries: vi.fn(() => []),
  };
}

function makePlugin(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
      mapConfigs: {},
      mapDefaultPxPerSquare: 140,
      mapScreenProfiles: {},
      tvWidth: 1920,
      tvHeight: 1080,
      hydrusDefaultLoop: true,
      hydrusDefaultMuted: true,
      mapFogTvOpacity: 1,
      lastBroadcastCache: {},
      ...((overrides.settings as object) ?? {}),
    },
    server: null,
    saveSettings: vi.fn(async () => {}),
    broadcastMapCalibration: vi.fn(),
    app: { vault: { adapter: { exists: vi.fn() } } },
    ...overrides,
  } as any;
}

function makePanel(plugin = makePlugin()) {
  const host = {
    render: vi.fn(),
    beginDrag: vi.fn(() => vi.fn()),
  };
  const panel = new MapScreenPanel(plugin as any, host as any);
  return { panel, host, plugin };
}

describe("MapScreenPanel restore with missing non-Hydrus map", () => {
  it("drops the map, shows Notice, clears state, calls forgetCached when server is running", async () => {
    const { recoverVaultImage } = await import("../hydrus/recoverImage");
    vi.mocked(recoverVaultImage).mockResolvedValue("missing");

    const { panel, host, plugin } = makePanel(makePlugin({ server: makeServerStub() }));
    panel.activeMap = { url: "/vault/.dm-screen/test.jpg", mediaType: "image", naturalWidth: 2000, naturalHeight: 3000 };
    panel.aoes = [{ id: "aoe-1", shape: "circle", sizeFt: 20, widthFt: 0, color: "#ff0000", opacity: 0.5, rotation: 0, x: 100, y: 200 }];
    panel.visions = [{ id: "v-1", shape: "circle", x: 500, y: 600, sizeFt: 30, featherFt: 5 }];
    panel.walls = [{ x1: 0, y1: 0, x2: 100, y2: 100, door: false, open: false }];
    panel.fogDataUrl = "data:image/png;base64,iVBORw0K";

    await (panel as any).checkAndRecoverMap();

    expect(Notice).toHaveBeenCalledWith('Map "test.jpg" is no longer available');
    expect(panel.activeMap).toBeNull();
    expect(panel.aoes).toEqual([]);
    expect(panel.visions).toEqual([]);
    expect(panel.walls).toEqual([]);
    expect(panel.fogDataUrl).toBeNull();
    expect(plugin.server.forgetCached).toHaveBeenCalledWith([
      "map-show",
      "map-view",
      "map-config",
      "map-aoe-sync",
      "map-vision",
      "map-fog",
      "map-walls",
    ]);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(host.render).toHaveBeenCalledTimes(1);
  });

  it("drops the map, shows Notice, clears state, deletes cache entries and saves when server is null", async () => {
    const { recoverVaultImage } = await import("../hydrus/recoverImage");
    vi.mocked(recoverVaultImage).mockResolvedValue("missing");

    const { panel, host, plugin } = makePanel(
      makePlugin({
        settings: {
          lastBroadcastCache: {
            "map-show": '{"type":"map-show","payload":{}}',
            "map-view": '{"type":"map-view","payload":{}}',
            "map-config": '{"type":"map-config","payload":{}}',
            "map-aoe-sync": '{"type":"map-aoe-sync","payload":{}}',
            "map-vision": '{"type":"map-vision","payload":{}}',
            "map-fog": '{"type":"map-fog","payload":{}}',
            "map-walls": '{"type":"map-walls","payload":{}}',
          },
        },
      })
    );
    panel.activeMap = { url: "/vault/maps/missing.png", mediaType: "image", naturalWidth: 2000, naturalHeight: 3000 };

    await (panel as any).checkAndRecoverMap();

    expect(Notice).toHaveBeenCalledWith('Map "missing.png" is no longer available');
    expect(panel.activeMap).toBeNull();
    expect(plugin.settings.lastBroadcastCache).toEqual({});
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(host.render).toHaveBeenCalledTimes(1);
  });

  it("extracts filename from complex vault path", async () => {
    const { recoverVaultImage } = await import("../hydrus/recoverImage");
    vi.mocked(recoverVaultImage).mockResolvedValue("missing");

    const { panel } = makePanel();
    panel.activeMap = { url: "/vault/campaigns/eberron/sharn/lower-city.webp", mediaType: "image", naturalWidth: 4000, naturalHeight: 6000 };

    await (panel as any).checkAndRecoverMap();

    expect(Notice).toHaveBeenCalledWith('Map "lower-city.webp" is no longer available');
  });

  it("falls back to 'map' when filename cannot be extracted", async () => {
    const { recoverVaultImage } = await import("../hydrus/recoverImage");
    vi.mocked(recoverVaultImage).mockResolvedValue("missing");

    const { panel } = makePanel();
    panel.activeMap = { url: "/vault/", mediaType: "image", naturalWidth: 2000, naturalHeight: 3000 };

    await (panel as any).checkAndRecoverMap();

    expect(Notice).toHaveBeenCalledWith('Map "map" is no longer available');
  });
});
