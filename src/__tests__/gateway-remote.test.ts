import { beforeEach, describe, expect, it, vi } from "vitest";
import { http } from "./remote-fakes";
import { makeRemotePlugin } from "./remote-plugin";

vi.mock("obsidian", async (importOriginal) => {
  const fakes = await import("./remote-fakes");
  return { ...(await importOriginal<typeof import("obsidian")>()), requestUrl: (req: any) => fakes.fakeRequestUrl(req) };
});

import { RemoteGateway, remoteCapabilities } from "../integrations/remote";

const HASH = "a".repeat(64);
const endpoint = () => ({ base: "https://dm.example.lan", token: "ctrl" });

function makeGateway(caps = { hydrus: true, ddb: true, webhooks: ["Telegram"] }) {
  const plugin = makeRemotePlugin();
  return { plugin, gateway: new RemoteGateway(plugin, caps, endpoint) };
}

const paths = () => http.calls.map((c) => `${c.method} ${c.path}`);

beforeEach(() => {
  http.reset();
});

describe("remoteCapabilities", () => {
  it("reads the server's block and treats anything else as absent", () => {
    expect(remoteCapabilities({ hydrus: true, ddb: false, webhooks: ["A", 2, "B"] })).toEqual({
      hydrus: true,
      ddb: false,
      webhooks: ["A", "B"],
    });
    expect(remoteCapabilities(undefined)).toEqual({ hydrus: false, ddb: false, webhooks: [] });
  });
});

describe("RemoteGateway — Hydrus", () => {
  it("offers nothing while the server has no Hydrus", () => {
    expect(makeGateway({ hydrus: false, ddb: false, webhooks: [] }).gateway.hydrus()).toBeNull();
  });

  it("maps each read method to its route, with the control token", async () => {
    http.routes.push((c) => {
      if (c.path === "/api/hydrus/services") return { status: 200, json: { services_v2: [{ name: "my tags", service_key: "k", type: 0 }] } };
      if (c.path === "/api/hydrus/search") return { status: 200, json: { hashes: [HASH] } };
      if (c.path === "/api/hydrus/metadata") return { status: 200, json: { metadata: [{ hash: HASH, mime: "image/png" }] } };
      if (c.path.startsWith("/api/hydrus/tags")) return { status: 200, json: { tags: [{ value: "dragon" }] } };
      return undefined;
    });
    const api = makeGateway().gateway.hydrus()!;

    expect((await api.getServices())[0]).toEqual({ name: "my tags", service_key: "k", type: 0 });
    expect(await api.searchFiles(["dragon"], 5)).toEqual({ hashes: [HASH] });
    expect((await api.getFileMetadata([HASH]))[0]).toMatchObject({ hash: HASH, mime: "image/png", ext: "png" });
    expect(await api.searchTags("dra")).toEqual([{ value: "dragon" }]);

    expect(paths()).toEqual([
      "GET /api/hydrus/services",
      "POST /api/hydrus/search",
      "POST /api/hydrus/metadata",
      "GET /api/hydrus/tags?search=dra",
    ]);
    expect(http.calls.every((c) => c.auth === "Bearer ctrl")).toBe(true);
    expect(http.calls[1].body).toEqual({ tags: ["dragon"], limit: 5 });
  });

  it("publishes by hash and reports the asset the server stored", async () => {
    http.routes.push((c) => {
      if (c.path === "/api/assets/hydrus") return { status: 200, json: { sha256: HASH, ext: "webm" } };
      if (c.path === "/api/hydrus/metadata") return { status: 200, json: { metadata: [{ hash: HASH, mime: "video/webm" }] } };
      return undefined;
    });
    const api = makeGateway().gateway.hydrus()!;
    expect(await api.publish(HASH)).toEqual({ url: `/assets/${HASH}.webm`, mediaType: "video", knownTags: [] });
    // Nothing local to mark; the server's retention governs the asset.
    await expect(api.markUsed(HASH)).resolves.toBeUndefined();
  });

  it("asks for a byte range when one is wanted", async () => {
    http.routes.push(() => ({ status: 206, arrayBuffer: Uint8Array.from([1, 2]).buffer }));
    const api = makeGateway().gateway.hydrus()!;
    expect(await api.getFileRange(HASH, 0, 1)).toEqual({ bytes: Uint8Array.from([1, 2]), partial: true });
    expect(paths()).toEqual([`GET /api/hydrus/file/${HASH}`]);
  });

  it("names the operation when the server refuses", async () => {
    http.routes.push(() => ({ status: 502 }));
    const api = makeGateway().gateway.hydrus()!;
    await expect(api.verifyAccess()).rejects.toThrow("Hydrus verify failed on the server (502)");
  });
});

describe("RemoteGateway — D&D Beyond", () => {
  it("lists encounters and starts tracking through the server", async () => {
    http.routes.push((c) => {
      if (c.path === "/api/ddb/encounters") return { status: 200, json: { data: [{ id: "enc-1", name: "Crypt", inProgress: true }] } };
      if (c.path === "/api/ddb/track") return { status: 204 };
      return undefined;
    });
    const { plugin, gateway } = makeGateway();
    const subscribed: Array<unknown> = [];
    (plugin as any).remote = { onDdbState: (fn: unknown) => subscribed.push(fn) };
    const api = gateway.ddb()!;

    expect(await api.getEncounters()).toEqual([{ id: "enc-1", name: "Crypt", inProgress: true }]);
    await api.track("enc-1", () => {});
    expect(http.calls.at(-1)).toMatchObject({ method: "POST", path: "/api/ddb/track", body: { encounterId: "enc-1" } });
    expect(subscribed.at(-1)).toBeTypeOf("function");

    await api.track(null, () => {});
    expect(http.calls.at(-1)!.body).toEqual({ encounterId: null });
    expect(subscribed.at(-1)).toBeNull();
  });

  it("turns the server's avatar map into layer URLs", async () => {
    http.routes.push(() => ({ status: 200, json: { "7": `/assets/${HASH}.png` } }));
    const api = makeGateway().gateway.ddb()!;
    expect(await api.getMonsterImages([7])).toEqual(new Map([[7, `/assets/${HASH}.png`]]));
  });
});

describe("RemoteGateway — webhooks", () => {
  it("lists the server's targets by name and sends the stored asset", async () => {
    http.routes.push(() => ({ status: 204 }));
    const api = makeGateway().gateway.webhooks();
    expect(api.targets()).toEqual([{ id: "Telegram", name: "Telegram" }]);

    await api.send("Telegram", `/assets/${HASH}.png`, "A dragon");
    expect(http.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/webhooks/Telegram/send",
      body: { asset: `/assets/${HASH}.png`, caption: "A dragon" },
    });
  });

  it("refuses to send something the server does not hold", async () => {
    const api = makeGateway().gateway.webhooks();
    await expect(api.send("Telegram", "data:image/png;base64,AA==", "")).rejects.toThrow("not reached the server");
    expect(http.calls).toEqual([]);
  });
});
