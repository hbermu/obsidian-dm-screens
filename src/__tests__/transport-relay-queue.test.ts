import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket, flush, http, notices } from "./remote-fakes";
import { makeRemotePlugin } from "./remote-plugin";

vi.mock("obsidian", async (importOriginal) => {
  const fakes = await import("./remote-fakes");
  return { ...(await importOriginal<typeof import("obsidian")>()), requestUrl: (req: any) => fakes.fakeRequestUrl(req), Notice: fakes.FakeNotice };
});

import { RemoteTransport } from "../transport/remote";

async function active() {
  const plugin = makeRemotePlugin();
  const t = new RemoteTransport(plugin, { onSession: vi.fn(), onRole: vi.fn(), onMirror: vi.fn(), onScreens: vi.fn(), onStatus: vi.fn() });
  t.connect();
  const ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.receive("control-hello", { viewToken: "v", role: "active", holder: null, hydrus: false, cache: {}, clients: [] });
  await flush();
  return { plugin, t, ws };
}

// Controls when each message's media are published.
function gate(t: RemoteTransport) {
  const pending = new Map<string, () => void>();
  vi.spyOn(t.publisher, "rewrite").mockImplementation((m) => {
    const key = (m.payload as { tag?: string }).tag;
    if (!key) return Promise.resolve(m);
    return new Promise((resolve) => pending.set(key, () => resolve(m)));
  });
  return pending;
}

const relayed = (ws: FakeWebSocket) => ws.sent.filter((s) => s.type === "relay").map((s) => s.payload.message);

beforeEach(() => {
  http.reset();
  notices.length = 0;
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  http.routes.push((c) => (c.path === "/api/mapdata" ? { status: 200, json: {} } : undefined));
});

describe("relay queue", () => {
  it("records the original message locally and relays the rewritten one", async () => {
    const { plugin, t, ws } = await active();
    vi.spyOn(t.publisher, "rewrite").mockResolvedValue({ type: "map-show", payload: { url: "/assets/x.png" } });
    t.broadcast({ type: "map-show", payload: { url: "/vault/Maps/x.png" } });
    await flush();
    expect(JSON.parse(plugin.replayCache.entries.get("map-show")!).payload.url).toBe("/vault/Maps/x.png");
    expect(relayed(ws)).toEqual([{ type: "map-show", payload: { url: "/assets/x.png" } }]);
  });

  it("holds a geometry patch until the sync queued ahead of it is published", async () => {
    const { t, ws } = await active();
    const pending = gate(t);
    t.broadcast({ type: "image-layers-sync", payload: { tag: "s1" } });
    t.broadcast({ type: "image-layers-geometry", payload: {} });
    await flush();
    expect(relayed(ws)).toEqual([]);
    pending.get("s1")!();
    await flush();
    await flush();
    expect(relayed(ws).map((m) => m.type)).toEqual(["image-layers-sync", "image-layers-geometry"]);
  });

  it("drops a waiting message when a newer one of the same type arrives", async () => {
    const { t, ws } = await active();
    const pending = gate(t);
    t.broadcast({ type: "map-fog", payload: { tag: "old" } });
    t.broadcast({ type: "map-fog", payload: { tag: "new" } });
    pending.get("new")!();
    pending.get("old")!();
    await flush();
    await flush();
    expect(relayed(ws)).toEqual([{ type: "map-fog", payload: { tag: "new" } }]);
  });

  it("drops a message whose media fail, says which, and keeps relaying the rest", async () => {
    const { t, ws } = await active();
    vi.spyOn(t.publisher, "rewrite").mockImplementation((m) =>
      m.type === "map-show" ? Promise.reject(new Error("crypt.png is not in the vault")) : Promise.resolve(m)
    );
    t.broadcast({ type: "map-show", payload: {} });
    t.broadcast({ type: "combat-scale", payload: { scale: 1 } });
    await flush();
    await flush();
    expect(notices.at(-1)!.message).toBe("Not sent to the screens: crypt.png is not in the vault");
    expect(relayed(ws).map((m) => m.type)).toEqual(["combat-scale"]);
  });
});
