import { describe, expect, it, vi } from "vitest";

// Obsidian mobile has neither Node's http nor ws: any load of them throws.
vi.mock("http", () => {
  throw new Error("http does not exist on mobile");
});
vi.mock("ws", () => {
  throw new Error("ws does not exist on mobile");
});
vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<typeof import("obsidian")>()),
  Platform: { isDesktop: false, isMobile: true, isDesktopApp: false, isIosApp: true, isAndroidApp: false, isTablet: true },
}));

import DmScreenPlugin from "../main";
import { DEFAULT_SETTINGS } from "../settings";
import { ReplayCache } from "../server";
import { RemoteTransport, deviceName } from "../transport/remote";

function mobilePlugin() {
  const plugin = Object.create(DmScreenPlugin.prototype) as DmScreenPlugin;
  plugin.settings = { ...DEFAULT_SETTINGS, serverMode: "embedded" } as any;
  plugin.server = null;
  plugin.replayCache = new ReplayCache();
  plugin.exploreModals = new Set();
  return plugin;
}

describe("loading on Obsidian mobile", () => {
  it("loads the plugin modules without touching http or ws", () => {
    expect(typeof DmScreenPlugin).toBe("function");
    expect(typeof ReplayCache).toBe("function");
  });

  it("runs remote whatever mode data.json stores, without rewriting it", () => {
    const plugin = mobilePlugin();
    expect(plugin.effectiveServerMode()).toBe("remote");
    expect((plugin as any).buildTransport()).toBeInstanceOf(RemoteTransport);
    expect(plugin.settings.serverMode).toBe("embedded");
  });

  it("never starts the embedded server", () => {
    const plugin = mobilePlugin();
    plugin.startServer();
    expect(plugin.server).toBeNull();
  });

  it("names an iPad as such to the server", () => {
    expect(deviceName()).toBe("iPad");
  });
});
