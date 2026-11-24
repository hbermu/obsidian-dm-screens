import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, get } from "./helpers";
import { startTarget, type Target } from "./target";

let t: Target;
beforeAll(async () => {
  t = await startTarget();
});
afterAll(async () => {
  await t.stop();
});

describe("viewer routes", () => {
  it.each([
    ["/", "text/html; charset=utf-8"],
    ["/index.html", "text/html; charset=utf-8"],
    ["/player.js", "application/javascript; charset=utf-8"],
    ["/player.css", "text/css; charset=utf-8"],
    ["/map", "text/html; charset=utf-8"],
    ["/map.js", "application/javascript; charset=utf-8"],
    ["/map.css", "text/css; charset=utf-8"],
  ])("serves %s as %s", async (path, type) => {
    const res = await get(t, path);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe(type);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("renders the default waiting text on the player page", async () => {
    const body = (await get(t, "/")).body.toString();
    expect(body).toContain("<h1>Player Screen</h1>");
    expect(body).toContain("<p>Waiting for DM to push content...</p>");
    expect(body).toContain('<script src="/player.js"></script>');
  });

  it("renders the map page shell", async () => {
    const body = (await get(t, "/map")).body.toString();
    expect(body).toContain('<div id="map-stage">');
    expect(body).toContain('<script src="/map.js"></script>');
  });

  it("answers 404 for an unknown path", async () => {
    expect((await get(t, "/nope")).status).toBe(404);
  });
});

describe("/health", () => {
  it("is open and reports status, viewer count, protocol and version", async () => {
    const before = JSON.parse((await get(t, "/health", { token: null })).body.toString());
    expect(before).toEqual({ status: "ok", clients: 0, protocol: 1, version: expect.any(String) });

    const viewer = await connect(t, "player");
    const during = JSON.parse((await get(t, "/health", { token: null })).body.toString());
    expect(during.clients).toBe(1);
    viewer.close();
    await viewer.closed;
  });
});
