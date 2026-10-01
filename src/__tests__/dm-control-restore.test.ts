import { beforeAll, describe, expect, it, vi } from "vitest";
import { DmControlPanel } from "../views/DmControlPanel";
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
      lastBroadcastCache: {},
      ...((overrides.settings as object) ?? {}),
    },
    server: null,
    saveSettings: vi.fn(async () => {}),
    app: { workspace: { getLeavesOfType: () => [] }, vault: { adapter: { exists: vi.fn() } } },
    ...overrides,
  } as any;
}

function makePanel(plugin = makePlugin()): DmControlPanel {
  const panel = new DmControlPanel({} as any, plugin);
  (panel as any).render = vi.fn();
  (panel as any).debouncedRender = vi.fn();
  return panel;
}

describe("DmControlPanel restore with missing non-Hydrus background", () => {
  it("drops the background, shows Notice, clears state, calls forgetCached when server is running", async () => {
    const { recoverVaultImage } = await import("../hydrus/recoverImage");
    vi.mocked(recoverVaultImage).mockResolvedValue("missing");

    const plugin = makePlugin({ server: makeServerStub() });
    const panel = makePanel(plugin);
    panel.activeBackgroundUrl = "/vault/.dm-screen/test.jpg";
    (panel as any).activeVideoPath = null;

    await (panel as any).checkAndRecoverBackground();

    expect(Notice).toHaveBeenCalledWith('Background "test.jpg" is no longer available');
    expect(panel.activeBackgroundUrl).toBeNull();
    expect((panel as any).activeVideoPath).toBeNull();
    expect(plugin.server.forgetCached).toHaveBeenCalledWith(["show-background-media"]);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1); // setBackgroundLabel(null) saves
    expect((panel as any).render).toHaveBeenCalledTimes(1);
  });

  it("drops the background, shows Notice, clears state, deletes cache entry and saves when server is null", async () => {
    const { recoverVaultImage } = await import("../hydrus/recoverImage");
    vi.mocked(recoverVaultImage).mockResolvedValue("missing");

    const plugin = makePlugin({
      settings: {
        lastBroadcastCache: {
          "show-background-media": '{"type":"show-background-media","payload":{}}',
        },
      },
    });
    const panel = makePanel(plugin);
    panel.activeBackgroundUrl = "/vault/attachments/missing.png";
    (panel as any).activeVideoPath = null;

    await (panel as any).checkAndRecoverBackground();

    expect(Notice).toHaveBeenCalledWith('Background "missing.png" is no longer available');
    expect(panel.activeBackgroundUrl).toBeNull();
    expect((panel as any).activeVideoPath).toBeNull();
    expect(plugin.settings.lastBroadcastCache).toEqual({});
    expect(plugin.saveSettings).toHaveBeenCalledTimes(2); // setBackgroundLabel(null) + cache clear
    expect((panel as any).render).toHaveBeenCalledTimes(1);
  });

  it("extracts filename from complex vault path", async () => {
    const { recoverVaultImage } = await import("../hydrus/recoverImage");
    vi.mocked(recoverVaultImage).mockResolvedValue("missing");

    const plugin = makePlugin();
    const panel = makePanel(plugin);
    panel.activeBackgroundUrl = "/vault/maps/dungeon/level1/entrance.webp";

    await (panel as any).checkAndRecoverBackground();

    expect(Notice).toHaveBeenCalledWith('Background "entrance.webp" is no longer available');
  });

  it("uses URL when filename cannot be extracted", async () => {
    const { recoverVaultImage } = await import("../hydrus/recoverImage");
    vi.mocked(recoverVaultImage).mockResolvedValue("missing");

    const plugin = makePlugin();
    const panel = makePanel(plugin);
    panel.activeBackgroundUrl = "/vault/";

    await (panel as any).checkAndRecoverBackground();

    expect(Notice).toHaveBeenCalledWith('Background "/vault/" is no longer available');
  });
});
