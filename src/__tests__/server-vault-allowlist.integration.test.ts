import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "http";
import type { AddressInfo } from "net";
import { PlayerScreenServer, ReplayCache } from "../server";

const TEST_TOKEN = "0123456789abcdef0123456789abcdef";

interface Spies {
  getAbstractFileByPath: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  readBinary: ReturnType<typeof vi.fn>;
}

function makePlugin(spies: Spies, bytes: ArrayBuffer) {
  return {
    app: {
      vault: {
        getAbstractFileByPath: spies.getAbstractFileByPath,
        readBinary: async () => bytes,
        adapter: {
          exists: spies.exists,
          readBinary: spies.readBinary,
        },
      },
    },
    settings: { serverPort: 0, accessToken: TEST_TOKEN },
  } as any;
}

async function startServer(spies: Spies, bytes: ArrayBuffer, cache?: ReplayCache): Promise<{
  server: PlayerScreenServer;
  port: number;
}> {
  const server = new PlayerScreenServer(makePlugin(spies, bytes), cache);
  server.start(0);
  const httpServer = (server as any).httpServer as {
    address(): AddressInfo | string | null;
    once(event: string, cb: () => void): void;
  };
  await new Promise<void>((resolveListening) => {
    const addr = httpServer.address();
    if (addr && typeof addr === "object") resolveListening();
    else httpServer.once("listening", () => resolveListening());
  });
  return { server, port: (httpServer.address() as AddressInfo).port };
}

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function fetch(port: number, path: string, token: string | null = TEST_TOKEN): Promise<Response> {
  const query = token === null ? "" : `?k=${encodeURIComponent(token)}`;
  return new Promise((resolve, reject) => {
    const req = get(`http://127.0.0.1:${port}${path}${query}`, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        })
      );
    });
    req.on("error", reject);
  });
}

// What survives here is what the conformance suite cannot state: that a denied
// path never reaches the vault adapter at all, and that the player page hands
// the browser the token so a reload without ?k= still renders. The serving,
// revocation and token rules themselves are asserted against both servers in
// test/conformance/ (assets, auth, http), and the allowlist's own bookkeeping
// in server-vault-allowlist.test.ts.
describe("PlayerScreenServer /vault/ display allowlist", () => {
  let server: PlayerScreenServer;
  let port: number;
  let spies: Spies;
  const payloadBytes = new TextEncoder().encode("BACKGROUND-VIDEO").buffer;

  beforeEach(async () => {
    spies = {
      getAbstractFileByPath: vi.fn(() => null),
      exists: vi.fn(async () => true),
      readBinary: vi.fn(async () => payloadBytes),
    };
    ({ server, port } = await startServer(spies, payloadBytes));
  });

  afterEach(() => {
    server.stop();
  });

  it("refuses to read plugin data.json without a matching broadcast (404, no disk read)", async () => {
    const res = await fetch(port, "/vault/.obsidian/plugins/dm-screen/data.json");
    expect(res.status).toBe(404);
    expect(spies.getAbstractFileByPath).not.toHaveBeenCalled();
    expect(spies.exists).not.toHaveBeenCalled();
    expect(spies.readBinary).not.toHaveBeenCalled();
  });

  it("sets the token cookie on the player page so a reload without ?k= still works", async () => {
    const res = await fetch(port, "/");
    expect(res.status).toBe(200);
    expect(String(res.headers["set-cookie"])).toContain(`dmScreenKey=${TEST_TOKEN}`);
    expect(String(res.headers["set-cookie"])).toContain("SameSite=Strict");
  });
});

describe("PlayerScreenServer allowlist seeded from the replay cache", () => {
  it("serves a background and map recorded while the server was stopped", async () => {
    const bytes = new TextEncoder().encode("OFFLINE").buffer;
    const spies = {
      getAbstractFileByPath: vi.fn(() => null),
      exists: vi.fn(async () => true),
      readBinary: vi.fn(async () => bytes),
    };
    const cache = new ReplayCache();
    cache.record({ type: "show-background-media", payload: { url: "/vault/bg.png", mediaType: "image" } });
    cache.record({ type: "map-show", payload: { url: "/vault/map.png", mediaType: "image" } });
    const { server, port } = await startServer(spies, bytes, cache);
    try {
      expect((await fetch(port, "/vault/bg.png")).status).toBe(200);
      expect((await fetch(port, "/vault/map.png")).status).toBe(200);
      expect((await fetch(port, "/vault/other.png")).status).toBe(404);
    } finally {
      server.stop();
    }
  });
});
