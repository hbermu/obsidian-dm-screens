import { describe, expect, it, vi } from "vitest";
import { LocalGateway } from "../integrations/local";
import { DEFAULT_SETTINGS } from "../settings";

function makePlugin(over: Partial<typeof DEFAULT_SETTINGS> = {}) {
  return {
    settings: { ...DEFAULT_SETTINGS, ...over },
    hydrusCache: { markUsed: vi.fn(async () => {}) },
    transport: { mode: "embedded", mediaUrl: async (p: string) => `/vault/${p}` },
  } as any;
}

describe("LocalGateway capabilities", () => {
  it("reports an integration only once it is enabled and complete", () => {
    expect(new LocalGateway(makePlugin()).capabilities()).toEqual({ hydrus: false, ddb: false, webhooks: [] });

    const half = new LocalGateway(makePlugin({ hydrusEnabled: true, hydrusApiUrl: "http://h.local" }));
    expect(half.capabilities().hydrus).toBe(false);

    const full = new LocalGateway(
      makePlugin({
        hydrusEnabled: true,
        hydrusApiUrl: "http://hydrus.local:45869",
        hydrusApiKey: "k",
        ddbEnabled: true,
        ddbCobaltSession: "cookie",
        webhooks: [{ id: "1", name: "Telegram", url: "https://a.example", imageField: "photo", captionField: "caption", extraFields: [] }],
      })
    );
    expect(full.capabilities()).toEqual({ hydrus: true, ddb: true, webhooks: ["Telegram"] });
  });

  it("offers no client while the integration is off", () => {
    const g = new LocalGateway(makePlugin());
    expect(g.hydrus()).toBeNull();
    expect(g.ddb()).toBeNull();
    expect(g.webhooks().targets()).toEqual([]);
  });

  it("refuses to send to a target that is no longer configured", async () => {
    const g = new LocalGateway(makePlugin());
    await expect(g.webhooks().send("gone", "data:image/png;base64,AA==", "")).rejects.toThrow("no longer configured");
  });
});
