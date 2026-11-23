import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { get, msg, png } from "./helpers";
import { onlyOn, startTarget, type Target } from "./target";

let t: Target;
beforeEach(async () => {
  t = await startTarget();
});
afterEach(async () => {
  await t.stop();
});

const status = async (url: string, token?: string | null) => (await get(t, url, { token })).status;

describe("display allowlist", () => {
  it("serves a published medium only while it is on screen as the background", async () => {
    const url = await t.publish(png(1), "png");
    expect(await status(url)).toBe(404);

    await t.broadcast(msg("show-background-media", { url, mediaType: "image" }));
    const res = await get(t, url);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    expect([...res.body]).toEqual([...png(1)]);

    await t.broadcast(msg("hide-background-media"));
    expect(await status(url)).toBe(404);
  });

  it("checks the token before the allowlist", async () => {
    const url = await t.publish(png(2), "png");
    await t.broadcast(msg("show-background-media", { url, mediaType: "image" }));
    expect(await status(url, null)).toBe(401);
  });

  it("admits layer images and layer fog, replacing the set on every sync", async () => {
    const a = await t.publish(png(3), "png");
    const fog = await t.publish(png(4), "png");
    const b = await t.publish(png(5), "png");
    await t.broadcast(msg("image-layers-sync", { layers: [{ id: "1", dataUrl: a, fogDataUrl: fog }] }));
    expect(await status(a)).toBe(200);
    expect(await status(fog)).toBe(200);

    await t.broadcast(msg("image-layers-sync", { layers: [{ id: "2", dataUrl: b, fogDataUrl: "" }] }));
    expect(await status(a)).toBe(404);
    expect(await status(fog)).toBe(404);
    expect(await status(b)).toBe(200);
  });

  it("keeps the map through clear and revokes it on map-clear", async () => {
    const map = await t.publish(png(6), "png");
    const bg = await t.publish(png(7), "png");
    await t.broadcast(msg("map-show", { url: map, mediaType: "image", naturalWidth: 1, naturalHeight: 1 }));
    await t.broadcast(msg("show-background-media", { url: bg, mediaType: "image" }));

    await t.broadcast(msg("clear"));
    expect(await status(bg)).toBe(404);
    expect(await status(map)).toBe(200);

    await t.broadcast(msg("map-clear"));
    expect(await status(map)).toBe(404);
  });

  it("drops the background slot when the background becomes a data URL", async () => {
    const url = await t.publish(png(8), "png");
    await t.broadcast(msg("show-background-media", { url, mediaType: "image" }));
    await t.broadcast(msg("show-background-media", { url: "data:image/png;base64,AA==", mediaType: "image" }));
    expect(await status(url)).toBe(404);
  });
});

describe.runIf(onlyOn("embedded"))("vault routing", () => {
  it("rejects traversal with 400 before the allowlist", async () => {
    expect(await status("/vault/..%2F.obsidian%2Fplugins%2Fdm-screen%2Fdata.json")).toBe(400);
  });
});

describe.runIf(onlyOn("remote"))("remote-only asset serving", () => {
  it("never serves /vault/", async () => {
    expect(await status("/vault/anything.png")).toBe(404);
  });

  it("admits the map fog mask", async () => {
    const fog = await t.publish(png(9), "png");
    await t.broadcast(msg("map-fog", { dataUrl: fog, opacity: 1 }));
    expect(await status(fog)).toBe(200);
  });

  it("answers a byte range with 206", async () => {
    const url = await t.publish(png(10), "png");
    await t.broadcast(msg("show-background-media", { url, mediaType: "image" }));
    const res = await get(t, url, { headers: { Range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 2-5/${png(10).length}`);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect([...res.body]).toEqual([...png(10).slice(2, 6)]);
  });
});
