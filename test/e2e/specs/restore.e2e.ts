import { browser, expect } from "@wdio/globals";
import { openPanel, openFixtureNote, startServer, panelButton, addMap, DEFAULT_PORT } from "../helpers/obsidian";
import { WsRecorder } from "../helpers/ws";

describe("state persistence and recovery", function () {
  let playerRec: WsRecorder;
  let mapRec: WsRecorder;

  before(async function () {
    await openPanel();
    await openFixtureNote();
    await startServer();
    playerRec = await WsRecorder.connect(DEFAULT_PORT, "player");
    mapRec = await WsRecorder.connect(DEFAULT_PORT, "map");
  });

  after(function () {
    playerRec.close();
    mapRec.close();
  });

  it("Background: set, stop, reload — background is not restored", async function () {
    await (await panelButton("Add BG")).click();
    await playerRec.waitFor("show-background-media");
    await expect(panelButton("Stop BG")).toExist();

    await (await panelButton("Stop BG")).click();
    await playerRec.waitFor("hide-background-media");
    await expect(panelButton("Add BG")).toExist();

    await browser.executeObsidian(async ({ app }) => {
      await (app as any).plugins.disablePlugin("dm-screen");
      await (app as any).plugins.enablePlugin("dm-screen");
    });

    await openPanel();
    await startServer();

    await expect(panelButton("Add BG")).toExist();
    await expect(panelButton("Stop BG")).not.toExist();

    const cache = await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins["dm-screen"];
      return plugin.settings.lastBroadcastCache || {};
    });
    expect(cache["show-background-media"]).toBeUndefined();
  });

  it("Map: add, stop, reload — map is not restored", async function () {
    await addMap();

    await (await panelButton("Stop Map")).click();
    await expect(panelButton("Add Map")).toExist();

    mapRec.close();
    playerRec.close();

    await browser.executeObsidian(async ({ app }) => {
      await (app as any).plugins.disablePlugin("dm-screen");
      await (app as any).plugins.enablePlugin("dm-screen");
    });

    await openPanel();
    await startServer();

    playerRec = await WsRecorder.connect(DEFAULT_PORT, "player");
    mapRec = await WsRecorder.connect(DEFAULT_PORT, "map");

    await expect(panelButton("Add Map")).toExist();
    await expect(panelButton("Stop Map")).not.toExist();

    const cache = await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins["dm-screen"];
      return plugin.settings.lastBroadcastCache || {};
    });
    expect(cache["map-show"]).toBeUndefined();
  });

  it("Missing image: add map with temp file, delete, reload — map is dropped with Notice", async function () {
    const tempPath = "attachments/temp-map.png";

    const existed = await browser.executeObsidian(async ({ app }) => {
      const tempPath = "attachments/temp-map.png";
      const exists = await app.vault.adapter.exists(tempPath);
      if (!exists) {
        const fixtureBytes = await app.vault.adapter.readBinary("attachments/map.png");
        await app.vault.adapter.writeBinary(tempPath, fixtureBytes);
      }
      return exists;
    });

    if (existed) {
      throw new Error(
        `Test precondition violated: ${tempPath} already exists. Clean up before running this test.`
      );
    }

    await browser.executeObsidian(async ({ app }) => {
      const tempPath = "attachments/temp-map.png";
      const panel = (app as any).workspace.getLeavesOfType("dm-control-panel")[0].view;
      await panel.mapPanel.setVaultMap(tempPath, "image");
    });
    await panelButton("Stop Map").waitForExist();

    await browser.executeObsidian(async ({ app }) => {
      const tempPath = "attachments/temp-map.png";
      await app.vault.adapter.remove(tempPath);
    });

    mapRec.close();
    playerRec.close();

    await browser.executeObsidian(async ({ app }) => {
      await (app as any).plugins.disablePlugin("dm-screen");
      await (app as any).plugins.enablePlugin("dm-screen");
    });

    await openPanel();
    await startServer();

    playerRec = await WsRecorder.connect(DEFAULT_PORT, "player");
    mapRec = await WsRecorder.connect(DEFAULT_PORT, "map");

    await browser.waitUntil(
      async () => {
        const notices = await browser.$$(".notice");
        for (const notice of notices) {
          const text = await notice.getText();
          if (text.includes("no longer available")) {
            return true;
          }
        }
        return false;
      },
      { timeout: 5000, timeoutMsg: "Expected Notice with 'no longer available' not shown" }
    );

    await expect(panelButton("Add Map")).toExist();
    await expect(panelButton("Stop Map")).not.toExist();

    const cache = await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins["dm-screen"];
      return plugin.settings.lastBroadcastCache || {};
    });
    expect(cache["map-show"]).toBeUndefined();
  });
});
