import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AddressInfo } from "net";
import { PlayerScreenServer } from "../server";

const TEST_TOKEN = "0123456789abcdef0123456789abcdef";
const WRONG_TOKEN = "0123456789abcdef0123456789abcdee";

function makePlugin() {
  return {
    app: { vault: { adapter: { exists: async () => false, readBinary: async () => null } } },
    settings: { serverPort: 0, accessToken: TEST_TOKEN },
  } as any;
}

async function startServer(): Promise<{ server: PlayerScreenServer; port: number }> {
  const server = new PlayerScreenServer(makePlugin());
  server.start(0);
  const httpServer = (server as any).httpServer as {
    address(): AddressInfo | string | null;
    once(event: string, cb: () => void): void;
  };
  await new Promise<void>((done) => {
    const addr = httpServer.address();
    if (addr && typeof addr === "object") done();
    else httpServer.once("listening", () => done());
  });
  return { server, port: (httpServer.address() as AddressInfo).port };
}

interface Outcome {
  opened: boolean;
  code: number;
}

// Resolves once the socket settles either way, so a rejection is an assertion
// about the close code rather than a timeout.
function attempt(url: string, headers?: Record<string, string>): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    let opened = false;
    ws.on("open", () => {
      opened = true;
    });
    ws.on("close", (code: number) => resolve({ opened, code }));
    ws.on("error", () => {
      /* a rejected upgrade surfaces as close; swallow the paired error */
    });
    setTimeout(() => reject(new Error("socket never settled")), 4000);
  });
}

describe("PlayerScreenServer WebSocket authentication", () => {
  let server: PlayerScreenServer;
  let port: number;

  beforeEach(async () => {
    ({ server, port } = await startServer());
  });

  afterEach(() => {
    server.stop();
  });

  it("closes a handshake that carries no token", async () => {
    const out = await attempt(`ws://127.0.0.1:${port}/`);
    expect(out.code).toBe(1008);
  });

  it("closes a handshake that carries a wrong token", async () => {
    const out = await attempt(`ws://127.0.0.1:${port}/?k=${WRONG_TOKEN}`);
    expect(out.code).toBe(1008);
  });

  it("accepts a handshake with the right token and no Origin", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?k=${TEST_TOKEN}`);
    await new Promise<void>((done, fail) => {
      ws.on("open", () => done());
      ws.on("error", fail);
    });
    expect(server.clientCount).toBe(1);
    ws.close();
  });

  it("accepts a token supplied through the cookie instead of the query", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { cookie: `dmScreenKey=${TEST_TOKEN}` },
    });
    await new Promise<void>((done, fail) => {
      ws.on("open", () => done());
      ws.on("error", fail);
    });
    expect(server.clientCount).toBe(1);
    ws.close();
  });

  it("closes a handshake whose Origin is another host", async () => {
    const out = await attempt(`ws://127.0.0.1:${port}/?k=${TEST_TOKEN}`, {
      origin: "http://evil.example",
    });
    expect(out.code).toBe(1008);
  });

  it("accepts a handshake whose Origin matches the request host", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?k=${TEST_TOKEN}`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    await new Promise<void>((done, fail) => {
      ws.on("open", () => done());
      ws.on("error", fail);
    });
    expect(server.clientCount).toBe(1);
    ws.close();
  });

  it("routes an authenticated /map handshake to the map channel despite the query string", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/map?k=${TEST_TOKEN}`);
    await new Promise<void>((done, fail) => {
      ws.on("open", () => done());
      ws.on("error", fail);
    });
    expect((server as any).clientChannels.get([...(server as any).clients][0])).toBe("map");
    ws.close();
  });

  it("closes a client that floods more than 20 messages in a second", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?k=${TEST_TOKEN}`);
    await new Promise<void>((done, fail) => {
      ws.on("open", () => done());
      ws.on("error", fail);
    });
    const closed = new Promise<number>((done) => ws.on("close", (code: number) => done(code)));
    for (let i = 0; i < 40; i++) ws.send(JSON.stringify({ type: "noise", payload: {} }));
    expect(await closed).toBe(1008);
  });

  it("disconnectAllClients drops every socket", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?k=${TEST_TOKEN}`);
    await new Promise<void>((done, fail) => {
      ws.on("open", () => done());
      ws.on("error", fail);
    });
    const closed = new Promise<number>((done) => ws.on("close", (code: number) => done(code)));
    server.disconnectAllClients();
    expect(await closed).toBe(1008);
    expect(server.clientCount).toBe(0);
  });
});
