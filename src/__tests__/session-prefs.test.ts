import { describe, expect, it, vi } from "vitest";
import { fakeRequestUrl, http } from "./remote-fakes";

vi.mock("obsidian", async (importOriginal) => {
  const fakes = await import("./remote-fakes");
  return { ...(await importOriginal<typeof import("obsidian")>()), requestUrl: (req: any) => fakes.fakeRequestUrl(req) };
});

import { SessionPreferences } from "../integrations/prefs";
import { DEFAULT_SETTINGS } from "../settings";

function makePlugin(mode: "embedded" | "remote") {
  return {
    settings: { ...DEFAULT_SETTINGS },
    saveSettings: vi.fn(async () => {}),
    transport: { mode },
    remote: mode === "remote" ? { endpoint: () => ({ base: "https://dm.example.lan", token: "t" }) } : null,
  } as any;
}

describe("SessionPreferences in embedded mode", () => {
  it("reads and writes data.json", async () => {
    const plugin = makePlugin("embedded");
    const prefs = new SessionPreferences(plugin);
    expect(prefs.get("mapDefaultPxPerSquare")).toBe(DEFAULT_SETTINGS.mapDefaultPxPerSquare);
    await prefs.set("mapDefaultPxPerSquare", 70);
    expect(plugin.settings.mapDefaultPxPerSquare).toBe(70);
    expect(plugin.saveSettings).toHaveBeenCalled();
  });
});

describe("SessionPreferences in remote mode", () => {
  it("falls back to the plugin's default for a key the server never had", () => {
    const prefs = new SessionPreferences(makePlugin("remote"));
    expect(prefs.get("hydrusDefaultLoop")).toBe(DEFAULT_SETTINGS.hydrusDefaultLoop);
    prefs.apply({ hydrusDefaultLoop: false });
    expect(prefs.get("hydrusDefaultLoop")).toBe(false);
  });

  it("writes one key to the server and never to data.json", async () => {
    http.reset();
    http.routes.push(() => ({ status: 204 }));
    const plugin = makePlugin("remote");
    const prefs = new SessionPreferences(plugin);
    await prefs.set("ddbInspirationPulse", false);
    expect(http.calls).toEqual([
      { method: "PUT", path: "/api/prefs/ddbInspirationPulse", body: false, auth: "Bearer t" },
    ]);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(prefs.get("ddbInspirationPulse")).toBe(false);
  });
});
