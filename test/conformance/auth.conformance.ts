import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { get, Viewer } from "./helpers";
import { startTarget, type Target } from "./target";

let t: Target;
beforeAll(async () => {
  t = await startTarget();
});
afterAll(async () => {
  await t.stop();
});

describe("HTTP token", () => {
  it.each(["/", "/player.js", "/map", "/map.css"])("answers 401 on %s without a token", async (path) => {
    expect((await get(t, path, { token: null })).status).toBe(401);
  });

  it("answers 401 on a wrong token", async () => {
    expect((await get(t, "/", { token: "f".repeat(32) })).status).toBe(401);
  });

  it.each(["/", "/map"])("parks the token in a strict cookie on %s", async (path) => {
    const res = await get(t, path);
    expect(res.headers["set-cookie"]).toEqual([
      `dmScreenKey=${t.viewToken}; Path=/; SameSite=Strict; Max-Age=86400`,
    ]);
  });

  it("accepts the token from the cookie alone", async () => {
    const res = await get(t, "/player.js", { token: null, headers: { Cookie: `dmScreenKey=${t.viewToken}` } });
    expect(res.status).toBe(200);
  });
});

describe("WebSocket handshake", () => {
  it("closes 1008 without a token", async () => {
    expect(await new Viewer(t, "player", { token: null }).closed).toBe(1008);
  });

  it("closes 1008 on a wrong token", async () => {
    expect(await new Viewer(t, "map", { token: "f".repeat(32) }).closed).toBe(1008);
  });

  it("opens with the token in the cookie", async () => {
    const v = new Viewer(t, "player", { token: null, headers: { Cookie: `dmScreenKey=${t.viewToken}` } });
    await v.settled();
    expect(v.closeCode).toBeNull();
    v.close();
    await v.closed;
  });

  it("closes 1008 on a cross-origin handshake", async () => {
    const v = new Viewer(t, "player", { headers: { Origin: "http://evil.example" } });
    expect(await v.closed).toBe(1008);
  });

  it("opens on a same-origin handshake", async () => {
    const v = new Viewer(t, "player", { headers: { Origin: `http://${t.host}` } });
    await v.settled();
    expect(v.closeCode).toBeNull();
    v.close();
    await v.closed;
  });
});
