import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { http, notices } from "./remote-fakes";
import { makeRemotePlugin } from "./remote-plugin";

vi.mock("obsidian", async (importOriginal) => {
  const fakes = await import("./remote-fakes");
  return { ...(await importOriginal<typeof import("obsidian")>()), requestUrl: (req: any) => fakes.fakeRequestUrl(req), Notice: fakes.FakeNotice };
});

import { AssetPublisher, PROGRESS_NOTICE_BYTES } from "../transport/assetUpload";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function makePublisher(files: Record<string, Uint8Array> = {}, hydrus = false) {
  const plugin = makeRemotePlugin(files);
  const sources: Array<[string, string]> = [];
  const publisher = new AssetPublisher({
    plugin,
    endpoint: () => ({ base: "https://dm.example.lan", token: "control-token" }),
    hydrusOnServer: () => hydrus,
    recordSource: (asset, source) => sources.push([asset, source]),
  });
  return { plugin, publisher, sources };
}

// A server that stores uploads in memory and answers the asset API.
function fakeStore(chunkSize = 4) {
  const stored = new Map<string, string>();
  const uploads = new Map<string, { size: number; ext: string; chunks: Uint8Array[]; received: number }>();
  http.routes.push((c) => {
    const meta = /^\/api\/assets\/([0-9a-f]{64})$/.exec(c.path);
    if (c.method === "GET" && meta) return stored.has(meta[1]) ? { status: 200, json: { sha256: meta[1], ext: stored.get(meta[1]) } } : { status: 404 };
    if (c.method === "POST" && c.path === "/api/uploads") {
      const body = c.body as { size: number; ext: string };
      uploads.set("u1", { size: body.size, ext: body.ext, chunks: [], received: 0 });
      return { status: 201, json: { id: "u1", chunkSize } };
    }
    const chunk = /^\/api\/uploads\/u1\?offset=(\d+)$/.exec(c.path);
    if (c.method === "PUT" && chunk) {
      const u = uploads.get("u1")!;
      const chunk = new Uint8Array(c.body as ArrayBuffer);
      u.chunks.push(chunk);
      u.received += chunk.length;
      return { status: 200, json: { received: u.received } };
    }
    if (c.method === "POST" && c.path === "/api/uploads/u1/complete") {
      const u = uploads.get("u1")!;
      const hash = sha(Buffer.concat(u.chunks));
      stored.set(hash, u.ext);
      return { status: 200, json: { sha256: hash, ext: u.ext } };
    }
    return undefined;
  });
  return stored;
}

beforeEach(() => {
  http.reset();
  notices.length = 0;
});

describe("AssetPublisher — vault files", () => {
  it("reuses a file the server already knows by fingerprint, without reading it", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const { plugin, publisher, sources } = makePublisher({ "Maps/a.png": bytes });
    http.routes.push((c) => (c.path === "/api/assets/lookup" ? { status: 200, json: { sha256: "f".repeat(64), ext: "png" } } : undefined));
    expect(await publisher.publishVaultPath("Maps/a.png")).toBe(`/assets/${"f".repeat(64)}.png`);
    expect(http.calls.find((c) => c.path === "/api/assets/lookup")!.body).toEqual({ path: "Maps/a.png", size: 3, mtime: 1000 });
    expect(plugin.app.vault.adapter.readBinary).not.toHaveBeenCalled();
    expect(sources).toEqual([[`${"f".repeat(64)}.png`, "vault:Maps/a.png"]]);
  });

  it("uploads a file the server lacks in chunks, with its fingerprint, and memoises the result", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const { publisher } = makePublisher({ "Maps/b.PNG": bytes });
    fakeStore(4);
    const url = await publisher.publishVaultPath("Maps/b.PNG");
    expect(url).toBe(`/assets/${sha(bytes)}.png`);
    const create = http.calls.find((c) => c.path === "/api/uploads")!;
    expect(create.body).toEqual({ size: 10, ext: "png", fingerprint: { path: "Maps/b.PNG", size: 10, mtime: 1000 } });
    expect(http.calls.filter((c) => c.method === "PUT").map((c) => c.path)).toEqual([
      "/api/uploads/u1?offset=0",
      "/api/uploads/u1?offset=4",
      "/api/uploads/u1?offset=8",
    ]);
    expect(http.calls.every((c) => c.auth === "Bearer control-token")).toBe(true);
    const before = http.calls.length;
    expect(await publisher.publishVaultPath("Maps/b.PNG")).toBe(url);
    expect(http.calls.length).toBe(before);
  });

  it("resumes from the server's offset on a 409", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const { publisher } = makePublisher({ "c.png": bytes });
    let first = true;
    http.routes.push((c) => {
      if (c.method === "PUT" && c.path.endsWith("offset=0") && first) {
        first = false;
        return { status: 409, json: { received: 0 } };
      }
      return undefined;
    });
    fakeStore(6);
    expect(await publisher.publishVaultPath("c.png")).toBe(`/assets/${sha(bytes)}.png`);
  });

  it("asks for a Hydrus file by hash, then has the server fetch it, before any upload", async () => {
    const hash = "a".repeat(64);
    const path = `.dm-screen/hydrus/${hash}.png`;
    const { plugin, publisher } = makePublisher({ [path]: Uint8Array.from([1]) }, true);
    http.routes.push((c) => (c.path === "/api/assets/hydrus" ? { status: 200, json: { sha256: hash, ext: "png" } } : undefined));
    expect(await publisher.publishVaultPath(path)).toBe(`/assets/${hash}.png`);
    expect(http.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /api/assets/${hash}`, "POST /api/assets/hydrus"]);
    expect(plugin.app.vault.adapter.stat).not.toHaveBeenCalled();
  });

  it("names the missing file, never a URL, when a vault file is gone", async () => {
    const { publisher } = makePublisher();
    await expect(publisher.publishVaultPath("Maps/gone.png")).rejects.toThrow("gone.png is not in the vault");
  });

  it("shows a progress notice for a large upload and hides it at the end", async () => {
    const big = new Uint8Array(PROGRESS_NOTICE_BYTES + 1);
    const { publisher } = makePublisher({ "big.mp4": big });
    fakeStore(PROGRESS_NOTICE_BYTES);
    await publisher.publishVaultPath("big.mp4");
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toBe("Uploading big.mp4… 100%");
    expect(notices[0].hidden).toBe(true);
  });
});

describe("AssetPublisher — data URLs and messages", () => {
  it("skips the upload of a data URL whose hash the server already holds", async () => {
    const bytes = Uint8Array.from([9, 9, 9]);
    const stored = fakeStore();
    stored.set(sha(bytes), "png");
    const { publisher } = makePublisher();
    expect(await publisher.publishDataUrl(`data:image/png;base64,${b64(bytes)}`)).toBe(`/assets/${sha(bytes)}.png`);
    expect(http.calls.some((c) => c.path === "/api/uploads")).toBe(false);
  });

  it("refuses an unsupported data URL type", async () => {
    const { publisher } = makePublisher();
    await expect(publisher.publishDataUrl("data:image/svg+xml;base64,AA==")).rejects.toThrow("unsupported media type image/svg+xml");
  });

  it("rewrites every media field, records layer sources and strips them", async () => {
    fakeStore();
    const { publisher, sources } = makePublisher({ "bg.png": Uint8Array.from([1]) });
    http.routes.push((c) => (c.path === "/api/assets/lookup" ? { status: 404 } : undefined));
    const png = `data:image/png;base64,${b64(Uint8Array.from([5, 6]))}`;
    const assetOf = `/assets/${sha(Uint8Array.from([5, 6]))}.png`;

    const bg = await publisher.rewrite({ type: "show-background-media", payload: { url: "/vault/bg.png", mediaType: "image" } });
    expect(bg.payload.url).toBe(`/assets/${sha(Uint8Array.from([1]))}.png`);
    const fog = await publisher.rewrite({ type: "map-fog", payload: { dataUrl: png, opacity: 1 } });
    expect(fog.payload.dataUrl).toBe(assetOf);
    const none = await publisher.rewrite({ type: "map-fog", payload: { dataUrl: null, opacity: 1 } });
    expect(none.payload.dataUrl).toBeNull();
    const sync = await publisher.rewrite({
      type: "image-layers-sync",
      payload: { layers: [{ id: "1", dataUrl: png, fogDataUrl: "", source: "vault:Art/x.png" }] },
    });
    expect(sync.payload.layers).toEqual([{ id: "1", dataUrl: assetOf, fogDataUrl: "" }]);
    expect(sources).toContainEqual([assetOf.slice("/assets/".length), "vault:Art/x.png"]);
    const untouched = await publisher.rewrite({ type: "combat-scale", payload: { scale: 1 } });
    expect(untouched).toEqual({ type: "combat-scale", payload: { scale: 1 } });
  });
});
