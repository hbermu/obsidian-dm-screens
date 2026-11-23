import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onlyOn } from "./target";
import { api, ControlClient, DEVICE_A, spawnServer, VIEW_TOKEN, type RemoteServer } from "./drivers/remote";

describe.runIf(onlyOn("remote"))("server-side integrations", () => {
  let server: RemoteServer;
  const open: ControlClient[] = [];

  const connect = () => {
    const c = ControlClient.connect(server.baseUrl, DEVICE_A);
    open.push(c);
    return c;
  };

  beforeEach(async () => {
    server = await spawnServer();
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await server.stop();
  });

  it("tells a controller which integrations exist, without a single credential", async () => {
    const hello = await connect().waitFor("control-hello");
    expect(hello.payload.integrations).toEqual({ hydrus: false, ddb: false, webhooks: [] });
    const raw = JSON.stringify(hello.payload);
    for (const secret of ["HYDRUS", "COBALT", "apiKey", "cobalt"]) expect(raw).not.toContain(secret);
  });

  it("hands over the preferences and pushes a change to every controller", async () => {
    const a = connect();
    expect((await a.waitFor("control-hello")).payload.prefs).toEqual({});

    expect((await api(server.baseUrl, "PUT", "/api/prefs/hydrusDefaultLoop", JSON.stringify(false))).status).toBe(204);
    expect((await a.waitFor("prefs")).payload).toEqual({ prefs: { hydrusDefaultLoop: false } });

    const b = connect();
    expect((await b.waitFor("control-hello")).payload.prefs).toEqual({ hydrusDefaultLoop: false });
  });

  it("refuses an unknown preference and a value of the wrong shape", async () => {
    expect((await api(server.baseUrl, "PUT", "/api/prefs/ddbCobaltSession", JSON.stringify("x"))).status).toBe(404);
    expect((await api(server.baseUrl, "PUT", "/api/prefs/ddbInspirationPulse", JSON.stringify("yes"))).status).toBe(400);
  });

  it("opens no integration route to the view token", async () => {
    const paths: Array<[string, string]> = [
      ["GET", "/api/prefs"],
      ["GET", "/api/hydrus/verify"],
      ["GET", "/api/ddb/encounters"],
      ["POST", "/api/webhooks/Telegram/send"],
    ];
    for (const [method, path] of paths) {
      const send = JSON.stringify({ asset: `/assets/${"a".repeat(64)}.png` });
      const res = await api(server.baseUrl, method, path, method === "POST" ? send : undefined, VIEW_TOKEN);
      expect(res.status, path).toBe(401);
    }
  });

  it("answers not-implemented for an integration this server does not have", async () => {
    for (const [method, path] of [["GET", "/api/hydrus/verify"], ["GET", "/api/ddb/validate"]] as const) {
      expect((await api(server.baseUrl, method, path)).status, path).toBe(501);
    }
    // No targets configured, so no name can match. The body is well formed,
    // so this is the name check answering and not the body parser.
    const body = JSON.stringify({ asset: `/assets/${"a".repeat(64)}.png`, caption: "" });
    expect((await api(server.baseUrl, "POST", "/api/webhooks/Telegram/send", body)).status).toBe(404);
  });
});
