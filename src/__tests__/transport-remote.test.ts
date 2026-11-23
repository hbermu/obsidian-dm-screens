import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket, flush, http, notices } from "./remote-fakes";
import { makeRemotePlugin } from "./remote-plugin";

vi.mock("obsidian", async (importOriginal) => {
  const fakes = await import("./remote-fakes");
  return { ...(await importOriginal<typeof import("obsidian")>()), requestUrl: (req: any) => fakes.fakeRequestUrl(req), Notice: fakes.FakeNotice };
});

import { RemoteTransport } from "../transport/remote";

function hooks() {
  return { onSession: vi.fn(), onRole: vi.fn(), onMirror: vi.fn(), onScreens: vi.fn(), onStatus: vi.fn() };
}

function connected(role: "active" | "readonly" = "active") {
  const plugin = makeRemotePlugin();
  const h = hooks();
  const t = new RemoteTransport(plugin, h);
  t.connect();
  const ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.receive("control-hello", {
    protocol: 1,
    version: "2.0.0",
    viewToken: "view-token",
    role,
    holder: { deviceId: "d".repeat(32), name: "iPad" },
    hydrus: false,
    cache: { "combat-scale": '{"type":"combat-scale","payload":{"scale":1}}' },
    clients: [{ width: 1920, height: 1080, devicePixelRatio: 1, channel: "map" }],
  });
  return { plugin, h, t, ws };
}

beforeEach(() => {
  http.reset();
  notices.length = 0;
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  http.routes.push((c) => (c.path === "/api/mapdata" ? { status: 200, json: {} } : undefined));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RemoteTransport — connecting", () => {
  it("opens the control socket with the token, a stable device id, the device name and the protocol", () => {
    const plugin = makeRemotePlugin();
    const t = new RemoteTransport(plugin, hooks());
    t.connect();
    const url = new URL(FakeWebSocket.instances[0].url);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("wss://dm.example.lan/control");
    expect(url.searchParams.get("k")).toBe("control-token");
    expect(url.searchParams.get("device")).toMatch(/^[0-9a-f]{32}$/);
    expect(url.searchParams.get("name")).toBe("Desktop");
    expect(url.searchParams.get("protocol")).toBe("1");
    t.disconnect();
    t.connect();
    expect(new URL(FakeWebSocket.instances[1].url).searchParams.get("device")).toBe(url.searchParams.get("device"));
  });

  it("refuses a plaintext URL to a public host without opening a socket", () => {
    const plugin = makeRemotePlugin();
    plugin.settings.remoteServerUrl = "http://dm.example.com";
    new RemoteTransport(plugin, hooks()).connect();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(notices[0].message).toContain("must use https");
  });

  it("adopts the session on an active hello and becomes live", async () => {
    const { h, t } = connected("active");
    await flush();
    expect(t.status).toBe("active");
    expect(t.isLive() && t.canEdit()).toBe(true);
    expect(h.onSession).toHaveBeenCalledWith({ "combat-scale": '{"type":"combat-scale","payload":{"scale":1}}' }, true);
    expect(h.onScreens).toHaveBeenCalledWith([{ width: 1920, height: 1080, devicePixelRatio: 1, channel: "map" }]);
    expect(http.calls.map((c) => c.path)).toContain("/api/mapdata");
  });

  it("offers join links with the view token in the href only", async () => {
    const { t } = connected();
    await flush();
    expect(t.joinLink("/map")).toEqual({ href: "https://dm.example.lan/map?k=view-token", text: "https://dm.example.lan/map" });
    expect(t.joinLink("/")!.text).toBe("https://dm.example.lan");
  });

  it("previews server assets through the server with the control token", async () => {
    const { t } = connected();
    expect(t.displayUrl(`/assets/${"a".repeat(64)}.png`)).toBe(`https://dm.example.lan/assets/${"a".repeat(64)}.png?k=control-token`);
    expect(t.displayUrl("/vault/Maps/a.png")).toBe("app://local/Maps/a.png");
  });
});

describe("RemoteTransport — roles", () => {
  it("stays read-only on a read-only hello: nothing relayed, nothing recorded", async () => {
    const { plugin, t, ws } = connected("readonly");
    await flush();
    expect(t.canEdit()).toBe(false);
    t.broadcast({ type: "combat-scale", payload: { scale: 2 } });
    await flush();
    expect(ws.sent).toEqual([]);
    expect(plugin.replayCache.entries.size).toBe(0);
  });

  it("follows control-role and sends control-claim on take-over", async () => {
    const { h, t, ws } = connected("readonly");
    await flush();
    t.claim();
    expect(ws.sent).toEqual([{ type: "control-claim", payload: {} }]);
    ws.receive("control-role", { role: "active", holder: { deviceId: "x".repeat(32), name: "Desktop" } });
    expect(t.status).toBe("active");
    expect(h.onRole).toHaveBeenCalledWith(true);
    ws.receive("control-role", { role: "readonly", holder: { deviceId: "d".repeat(32), name: "iPad" } });
    expect(t.holder!.name).toBe("iPad");
    expect(t.canEdit()).toBe(false);
  });

  it("hands mirrored messages and screen lists to the plugin", async () => {
    const { h, ws } = connected("readonly");
    await flush();
    ws.receive("mirror", { message: { type: "map-view", payload: { mode: "fit" } } });
    ws.receive("screens", { clients: [] });
    expect(h.onMirror).toHaveBeenCalledWith({ type: "map-view", payload: { mode: "fit" } });
    expect(h.onScreens).toHaveBeenLastCalledWith([]);
  });
});

describe("RemoteTransport — disconnections", () => {
  it("names both protocols on a mismatch and does not retry", () => {
    vi.useFakeTimers();
    const { t, ws } = connected();
    ws.serverClose(4001, "protocol-mismatch:2");
    expect(notices.at(-1)!.message).toBe("Remote server speaks protocol 2, this plugin 1. Update the plugin or the server so they match.");
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(t.status).toBe("disconnected");
  });

  it("reports a rejected token and does not retry", () => {
    vi.useFakeTimers();
    const { ws } = connected();
    ws.serverClose(1008, "Unauthorized");
    expect(notices.at(-1)!.message).toBe("Remote server rejected the control token");
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reconnects with a doubling backoff and is read-only meanwhile", () => {
    vi.useFakeTimers();
    const { t, ws } = connected();
    ws.serverClose(1006);
    expect(t.status).toBe("connecting");
    expect(t.canEdit()).toBe(false);
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].serverClose(1006);
    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
    t.disconnect();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });
});
