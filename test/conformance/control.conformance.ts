import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, msg, sleep } from "./helpers";
import { onlyOn, type Target } from "./target";
import { api, ControlClient, CONTROL_TOKEN, DEVICE_A, DEVICE_B, spawnServer, VIEW_TOKEN, type RemoteServer } from "./drivers/remote";

describe.runIf(onlyOn("remote"))("control channel", () => {
  let server: RemoteServer;
  const open: ControlClient[] = [];
  const client = (device: string, extra: Record<string, string> = {}, headers?: Record<string, string>) => {
    const c = ControlClient.connect(server.baseUrl, device, extra, headers);
    open.push(c);
    return c;
  };
  // Viewer helpers take a Target; the control tests only need its address.
  const asTarget = (): Target => ({ name: "remote", baseUrl: server.baseUrl, host: server.host, viewToken: VIEW_TOKEN } as Target);

  beforeEach(async () => {
    server = await spawnServer();
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await server.stop();
  });

  describe("handshake", () => {
    it.each([
      ["no token", { k: "" }, 1008],
      ["the view token", { k: VIEW_TOKEN }, 1008],
      ["a malformed device id", { device: "XYZ" }, 1008],
      ["an empty name", { name: "" }, 1008],
      ["a name over 64 characters", { name: "n".repeat(65) }, 1008],
    ])("closes with %s", async (_label, extra, code) => {
      expect(await client(DEVICE_A, extra as Record<string, string>).closed).toBe(code);
    });

    it("closes 4001 with the server's protocol on a mismatch", async () => {
      const c = new ControlClient(server.baseUrl, { k: CONTROL_TOKEN, device: DEVICE_A, name: "A", protocol: "99" });
      open.push(c);
      const reason = new Promise<string>((r) => c.ws.once("close", (_code, why) => r(why.toString())));
      expect(await c.closed).toBe(4001);
      expect(await reason).toBe("protocol-mismatch:1");
    });

    it("accepts any Origin, since the token is explicit and Obsidian is never same-origin", async () => {
      const c = client(DEVICE_A, {}, { Origin: "app://obsidian.md" });
      expect((await c.waitFor("control-hello")).payload.role).toBe("active");
    });

    it("refuses a fifth control socket with 1013", async () => {
      for (let i = 0; i < 4; i++) await client(DEVICE_A).waitFor("control-hello");
      expect(await client(DEVICE_B).closed).toBe(1013);
    });

    it("greets with the protocol, the view token, the role, the cache and the screens", async () => {
      const a = client(DEVICE_A);
      const hello = await a.waitFor("control-hello");
      expect(hello.payload).toMatchObject({
        protocol: 1,
        viewToken: VIEW_TOKEN,
        role: "active",
        holder: { deviceId: DEVICE_A, name: "Device a" },
        integrations: { hydrus: false, ddb: false, webhooks: [] },
        prefs: {},
        cache: {},
        clients: [],
      });
      expect(typeof hello.payload.version).toBe("string");
    });
  });

  describe("lease", () => {
    it("makes the first device active and a second one read-only", async () => {
      const a = client(DEVICE_A);
      expect((await a.waitFor("control-hello")).payload.role).toBe("active");
      const b = client(DEVICE_B);
      const hello = await b.waitFor("control-hello");
      expect(hello.payload.role).toBe("readonly");
      expect(hello.payload.holder).toEqual({ deviceId: DEVICE_A, name: "Device a" });
    });

    it("gives the lease back silently to the same device after a reconnect", async () => {
      const a = client(DEVICE_A);
      await a.waitFor("control-hello");
      a.close();
      await a.closed;
      const b = client(DEVICE_B);
      expect((await b.waitFor("control-hello")).payload.role).toBe("readonly");
      const again = client(DEVICE_A);
      expect((await again.waitFor("control-hello")).payload.role).toBe("active");
    });

    it("hands the lease over on control-claim and tells everyone", async () => {
      const a = client(DEVICE_A);
      await a.waitFor("control-hello");
      const b = client(DEVICE_B);
      await b.waitFor("control-hello");
      b.send({ type: "control-claim", payload: {} });
      expect((await b.waitFor("control-role")).payload).toEqual({ role: "active", holder: { deviceId: DEVICE_B, name: "Device b" } });
      expect((await a.waitFor("control-role")).payload).toEqual({ role: "readonly", holder: { deviceId: DEVICE_B, name: "Device b" } });
    });

    it("makes every socket of the holder's device active", async () => {
      const a1 = client(DEVICE_A);
      await a1.waitFor("control-hello");
      const a2 = client(DEVICE_A);
      expect((await a2.waitFor("control-hello")).payload.role).toBe("active");
    });
  });

  describe("relay", () => {
    it("relays an active socket's message to viewers and mirrors it to read-only sockets", async () => {
      const a = client(DEVICE_A);
      await a.waitFor("control-hello");
      const b = client(DEVICE_B);
      await b.waitFor("control-hello");
      const viewer = await connect(asTarget(), "player");
      a.send({ type: "relay", payload: { message: msg("combat-scale", { scale: 1.5 }) } });
      expect((await viewer.waitFor("combat-scale")).payload).toEqual({ scale: 1.5 });
      expect((await b.waitFor("mirror")).payload).toEqual({ message: msg("combat-scale", { scale: 1.5 }) });
      viewer.close();
    });

    it("refuses a relay from a read-only socket", async () => {
      const a = client(DEVICE_A);
      await a.waitFor("control-hello");
      const b = client(DEVICE_B);
      await b.waitFor("control-hello");
      b.send({ type: "relay", payload: { message: msg("combat-scale", { scale: 2 }) } });
      expect((await b.waitFor("control-error")).payload).toEqual({ code: "not-active" });
      const fresh = client(DEVICE_B);
      expect((await fresh.waitFor("control-hello")).payload.cache).toEqual({});
    });

    it.each([
      ["a message without a type", { message: { payload: {} } }],
      ["a message without an object payload", { message: { type: "clear", payload: [] } }],
    ])("answers bad-message to %s and changes nothing", async (_label, payload) => {
      const a = client(DEVICE_A);
      await a.waitFor("control-hello");
      a.send({ type: "relay", payload });
      expect((await a.waitFor("control-error")).payload).toEqual({ code: "bad-message" });
    });

    it("hands a new controller the cache of both channels", async () => {
      const a = client(DEVICE_A);
      await a.waitFor("control-hello");
      a.send({ type: "relay", payload: { message: msg("combat-scale", { scale: 1 }) } });
      a.send({ type: "relay", payload: { message: msg("map-config", { pxPerSquare: 70 }) } });
      await sleep(200);
      const b = client(DEVICE_B);
      const cache = (await b.waitFor("control-hello")).payload.cache as Record<string, string>;
      expect(Object.keys(cache)).toEqual(["combat-scale", "map-config"]);
      expect(JSON.parse(cache["map-config"])).toEqual(msg("map-config", { pxPerSquare: 70 }));
    });

    it("closes a controller that sends more than 200 messages in a second", async () => {
      const a = client(DEVICE_A);
      await a.waitFor("control-hello");
      for (let i = 0; i < 210; i++) a.send({ type: "noise", payload: {} });
      expect(await a.closed).toBe(1008);
    });

    it("closes a controller that sends a frame over 1 MiB with 1009", async () => {
      const a = client(DEVICE_A);
      await a.waitFor("control-hello");
      a.send({ type: "relay", payload: { message: msg("waiting-screen", { title: "x".repeat(1100 * 1024), subtitle: "" }) } });
      expect(await a.closed).toBe(1009);
    });
  });

  describe("screens", () => {
    it("pushes the screen list when a viewer connects, reports itself and leaves", async () => {
      const a = client(DEVICE_A);
      await a.waitFor("control-hello");
      const viewer = await connect(asTarget(), "map");
      await a.waitFor("screens");
      viewer.send(JSON.stringify({ type: "client-info", payload: { width: 1920, height: 1080, devicePixelRatio: 1 } }));
      const reported = await a.waitFor("screens", { skip: 1 });
      expect(reported.payload.clients).toEqual([{ width: 1920, height: 1080, devicePixelRatio: 1, channel: "map" }]);
      viewer.close();
      expect((await a.waitFor("screens", { skip: 2 })).payload.clients).toEqual([]);
    });
  });

  describe("map data", () => {
    it("stores, returns and deletes entries per collection, with the control token only", async () => {
      expect((await api(server.baseUrl, "GET", "/api/mapdata", undefined, VIEW_TOKEN)).status).toBe(401);
      const key = encodeURIComponent("/vault/Maps/a b.png");
      expect((await api(server.baseUrl, "PUT", `/api/mapdata/configs/${key}`, JSON.stringify({ mode: "fit" }))).status).toBe(204);
      expect((await api(server.baseUrl, "PUT", `/api/mapdata/walls/${key}`, JSON.stringify([{ x1: 0 }]))).status).toBe(204);
      expect((await api(server.baseUrl, "PUT", `/api/mapdata/nope/${key}`, "{}")).status).toBe(404);
      expect((await api(server.baseUrl, "PUT", `/api/mapdata/fog/${key}`, "{not json")).status).toBe(400);
      expect((await api(server.baseUrl, "PUT", `/api/mapdata/fog/${key}`, JSON.stringify("x".repeat(1100 * 1024)))).status).toBe(413);
      const doc = (await api(server.baseUrl, "GET", "/api/mapdata")).json;
      expect(doc).toEqual({ configs: { "/vault/Maps/a b.png": { mode: "fit" } }, profiles: {}, fog: {}, walls: { "/vault/Maps/a b.png": [{ x1: 0 }] }, sources: {} });
      expect((await api(server.baseUrl, "DELETE", `/api/mapdata/configs/${key}`)).status).toBe(204);
      expect((await api(server.baseUrl, "GET", "/api/mapdata")).json.configs).toEqual({});
    });
  });

  describe("persistence", () => {
    it("restores the cache and map data after a restart", async () => {
      const keep = server.dataDir;
      const a = client(DEVICE_A);
      await a.waitFor("control-hello");
      a.send({ type: "relay", payload: { message: msg("map-config", { pxPerSquare: 70 }) } });
      await api(server.baseUrl, "PUT", "/api/mapdata/profiles/1920x1080%401", JSON.stringify({ diagonalInches: 43 }));
      await sleep(1500);
      a.close();
      const proc = server.proc;
      const exited = new Promise((r) => proc.once("exit", r));
      proc.kill("SIGTERM");
      await exited;
      server = await spawnServer({}, keep);
      const late = await connect(asTarget(), "map");
      expect(late.types()).toEqual(["map-config"]);
      late.close();
      expect((await api(server.baseUrl, "GET", "/api/mapdata")).json.profiles).toEqual({ "1920x1080@1": { diagonalInches: 43 } });
    });
  });
});
