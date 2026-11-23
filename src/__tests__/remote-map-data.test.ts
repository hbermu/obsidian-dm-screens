import { beforeEach, describe, expect, it, vi } from "vitest";
import { flush, http, notices } from "./remote-fakes";

vi.mock("obsidian", async (importOriginal) => {
  const fakes = await import("./remote-fakes");
  return { ...(await importOriginal<typeof import("obsidian")>()), requestUrl: (req: any) => fakes.fakeRequestUrl(req), Notice: fakes.FakeNotice };
});

import { RemoteMapData } from "../transport/remoteMapData";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

function make() {
  const publisher = { publishDataUrl: vi.fn(async () => `/assets/${"e".repeat(64)}.png`) };
  const store = new RemoteMapData(() => ({ base: "https://dm.example.lan", token: "t" }), publisher as any);
  return { store, publisher };
}

beforeEach(() => {
  http.reset();
  notices.length = 0;
  http.routes.push((c) => (c.method === "PUT" || c.method === "DELETE" ? { status: 204 } : undefined));
});

describe("RemoteMapData", () => {
  it("loads the whole document once and reads from it", async () => {
    http.routes.unshift((c) =>
      c.path === "/api/mapdata"
        ? { status: 200, json: { configs: { "/assets/m.png": { mode: "fit" } }, profiles: { "1920x1080@1": { diagonalInches: 43 } }, walls: { "/assets/m.png": [{ x1: 1 }] }, fog: {}, sources: { "m.png": "vault:m.png" } } }
        : undefined
    );
    const { store } = make();
    await store.load();
    expect(store.config("/assets/m.png")).toEqual({ mode: "fit" });
    expect(store.profiles()).toEqual({ "1920x1080@1": { diagonalInches: 43 } });
    expect(await store.loadWalls("/assets/m.png")).toEqual([{ x1: 1 }]);
    expect(store.source("m.png")).toBe("vault:m.png");
    expect(await store.loadFog("/assets/m.png")).toBeNull();
  });

  it("writes each change with one PUT, the key URL-encoded, and a removal with DELETE", async () => {
    const { store } = make();
    store.setConfig("/assets/a b.png", { mode: "physical" } as any);
    store.setProfile("1920x1080@1", null);
    await store.saveWalls("/assets/a b.png", []);
    await flush();
    expect(http.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /api/mapdata/configs/%2Fassets%2Fa%20b.png",
      "DELETE /api/mapdata/profiles/1920x1080%401",
      "PUT /api/mapdata/walls/%2Fassets%2Fa%20b.png",
    ]);
  });

  it("stores fog as a published asset and reads it back as a PNG data URL", async () => {
    const { store, publisher } = make();
    await store.saveFog("/assets/m.png", "data:image/png;base64,AAAA");
    expect(publisher.publishDataUrl).toHaveBeenCalledWith("data:image/png;base64,AAAA");
    expect(http.calls[0].body).toBe(`/assets/${"e".repeat(64)}.png`);
    http.routes.unshift((c) => (c.path === `/assets/${"e".repeat(64)}.png` ? { status: 200, arrayBuffer: PNG.slice().buffer } : undefined));
    expect(await store.loadFog("/assets/m.png")).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    await store.saveFog("/assets/m.png", null);
    expect(await store.loadFog("/assets/m.png")).toBeNull();
    expect(http.calls.at(-1)!.method).toBe("DELETE");
  });

  it("records a source only when it changes", async () => {
    const { store } = make();
    store.setSource("x.png", "vault:x.png");
    store.setSource("x.png", "vault:x.png");
    await flush();
    expect(http.calls.filter((c) => c.path.startsWith("/api/mapdata/sources/"))).toHaveLength(1);
  });

  it("warns once when the server refuses a write", async () => {
    http.routes.unshift(() => ({ status: 500 }));
    const { store } = make();
    store.setConfig("/assets/a.png", {} as any);
    store.setConfig("/assets/b.png", {} as any);
    await flush();
    await flush();
    expect(notices).toHaveLength(1);
  });
});
