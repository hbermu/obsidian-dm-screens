import * as fs from "node:fs";
import { browser, expect } from "@wdio/globals";
import WebSocket from "ws";
import { addMap, openFixtureNote, openPanel, panelButton } from "../helpers/obsidian";
import { httpGet } from "../helpers/http";

// Only `make test-e2e-remote` sets this and starts the server container; the
// tokens match the e2e-server service in docker-compose.yml.
const BASE = process.env.DM_SCREEN_E2E_REMOTE_URL ?? "";
const VIEW = "e2e-view-0123456789abcdef0123456789";
const CONTROL = "e2e-ctrl-0123456789abcdef0123456789";
const FIXTURE_BYTES = fs.statSync("test/e2e/vault/attachments/map.png").size;

interface Msg {
  type: string;
  payload: any;
}

class Socket {
  readonly messages: Msg[] = [];
  private ws: WebSocket;
  readonly opened: Promise<void>;

  constructor(path: string) {
    this.ws = new WebSocket(`${BASE.replace(/^http/, "ws")}${path}`);
    this.ws.on("message", (d) => this.messages.push(JSON.parse(d.toString())));
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  send(msg: Msg) {
    this.ws.send(JSON.stringify(msg));
  }

  async waitFor(type: string, where: (m: Msg) => boolean = () => true, timeout = 15_000): Promise<Msg> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hit = this.messages.find((m) => m.type === type && where(m));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no '${type}' within ${timeout}ms (saw: ${this.messages.map((m) => m.type).join(", ")})`);
  }

  close() {
    this.ws.close();
  }
}

const status = () =>
  browser.executeObsidian(({ app }) => (app as any).plugins.plugins["dm-screen"].remote?.status as string | undefined);

async function waitForStatus(want: string) {
  await browser.waitUntil(async () => (await status()) === want, { timeout: 15_000, timeoutMsg: `remote status never became ${want}` });
}

describe("remote server mode", function () {
  let map: Socket;
  let player: Socket;

  before(async function () {
    if (!BASE) this.skip();
    await browser.executeObsidian(
      async ({ app }, base, token) => {
        const plugin = (app as any).plugins.plugins["dm-screen"];
        plugin.settings.remoteServerUrl = base;
        plugin.settings.remoteControlToken = token;
        await plugin.setServerMode("remote");
      },
      BASE,
      CONTROL,
    );
    await openPanel();
    await openFixtureNote();
    await (await panelButton("Connect")).click();
    await waitForStatus("active");
    map = new Socket(`/map?k=${VIEW}`);
    player = new Socket(`/?k=${VIEW}`);
    await map.opened;
    await player.opened;
  });

  after(function () {
    map?.close();
    player?.close();
  });

  it("publishes the map to the server and serves it to a screen by hash", async function () {
    await addMap();
    const show = await map.waitFor("map-show");
    expect(show.payload.url).toMatch(/^\/assets\/[0-9a-f]{64}\.png$/);
    expect(show.payload.naturalWidth).toBe(560);
    const res = await httpGet(`${BASE}${show.payload.url}`, VIEW);
    expect(res.status).toBe(200);
    expect(res.body.byteLength).toBe(FIXTURE_BYTES);
  });

  it("relays a layer as an asset URL without its vault source", async function () {
    await (await panelButton("Add Image")).click();
    const sync = await player.waitFor("image-layers-sync", (m) => m.payload.layers.length === 1);
    const layer = sync.payload.layers[0];
    expect(layer.dataUrl).toMatch(/^\/assets\/[0-9a-f]{64}\.png$/);
    expect(layer).not.toHaveProperty("source");
  });

  it("turns read-only when another device takes control, and takes it back", async function () {
    const other = new Socket(`/control?k=${CONTROL}&device=${"b".repeat(32)}&name=Tablet&protocol=1`);
    await other.opened;
    expect((await other.waitFor("control-hello")).payload.role).toBe("readonly");
    other.send({ type: "control-claim", payload: {} });
    await waitForStatus("readonly");
    const banner = browser.$(".dm-readonly-banner");
    await banner.waitForExist();
    await expect(banner).toHaveText(expect.stringContaining("Tablet has control"));
    expect(await browser.$(".dm-session").getProperty("inert")).toBe(true);

    await browser.$(".dm-take-control-btn").click();
    await browser.$(".modal").$("button=Take control").click();
    await waitForStatus("active");
    expect((await other.waitFor("control-role", (m) => m.payload.role === "readonly")).payload.holder.name).toBe("Desktop");
    other.close();
  });

  it("follows the server's integrations, not this device's settings", async function () {
    // The device is told Hydrus is configured; the server says otherwise,
    // and the server is what decides in remote mode.
    await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins["dm-screen"];
      plugin.settings.hydrusEnabled = true;
      plugin.settings.hydrusApiUrl = "http://hydrus.local:45869";
      plugin.settings.hydrusApiKey = "device-key";
      await plugin.saveSettings();
      (app.workspace.getLeavesOfType("dm-control-panel")[0].view as any).render();
    });
    expect(await browser.$(".dm-hydrus-bar").isExisting()).toBe(false);
    expect(await browser.executeObsidian(({ app }) => (app as any).plugins.plugins["dm-screen"].gateway.capabilities())).toEqual({
      hydrus: false,
      ddb: false,
      webhooks: [],
    });
  });

  it("offers no credential field in the settings tab", async function () {
    const headings = await browser.executeObsidian(({ app }) => {
      const plugin = (app as any).plugins.plugins["dm-screen"];
      const tab = plugin.settingTab;
      const host = document.createElement("div");
      tab.containerEl = host;
      tab.display();
      const text = host.textContent ?? "";
      return {
        text,
        inputs: host.querySelectorAll("input[type=password]").length,
      };
    });
    expect(headings.text).toContain("Integrations");
    // The credential fields themselves, not the words: the summary names the
    // services it provides.
    for (const gone of ["Enable Hydrus integration", "CobaltSession", "Add webhook"]) {
      expect(headings.text).not.toContain(gone);
    }
    // Only the control token remains a secret this device holds.
    expect(headings.inputs).toBe(1);
  });

  it("rebuilds the panel from the server's session after a reconnect", async function () {
    await (await panelButton("Disconnect")).click();
    await waitForStatus("disconnected");
    await browser.executeObsidian(({ app }) => {
      const view = app.workspace.getLeavesOfType("dm-control-panel")[0].view as any;
      view.imageLayers = [];
      view.mapPanel.activeMap = null;
    });
    await (await panelButton("Connect")).click();
    await waitForStatus("active");
    await browser.waitUntil(
      () =>
        browser.executeObsidian(({ app }) => {
          const view = app.workspace.getLeavesOfType("dm-control-panel")[0].view as any;
          return view.imageLayers.length === 1 && view.imageLayers[0].dataUrl.startsWith("data:image/") && !!view.mapPanel.activeMap;
        }),
      { timeout: 15_000, timeoutMsg: "the panel never rebuilt the layer and the map from the session" },
    );
  });
});
