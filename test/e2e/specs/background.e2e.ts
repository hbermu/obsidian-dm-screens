import { browser, expect } from "@wdio/globals";
import { openPanel, openFixtureNote, startServer, panelButton, DEFAULT_PORT } from "../helpers/obsidian";
import { WsRecorder } from "../helpers/ws";

describe("background media from a real note", function () {
  let rec: WsRecorder;

  before(async function () {
    await openPanel();
    await openFixtureNote();
    await startServer();
    rec = await WsRecorder.connect(DEFAULT_PORT, "player");
  });

  after(function () {
    rec.close();
  });

  it("Add BG broadcasts show-background-media for the note embed", async function () {
    await (await panelButton("Add BG")).click();
    const show = await rec.waitFor("show-background-media");
    expect(show.payload.mediaType).toBe("image");
    expect(typeof show.payload.url).toBe("string");
    await expect(panelButton("Stop BG")).toExist();
  });

  it("background preview shows source label chip with note basename", async function () {
    rec.send({ type: "client-info", payload: { width: 1920, height: 1080 } });
    await new Promise((r) => setTimeout(r, 200));
    const label = await browser.$(".dm-preview-bg .dm-source-label");
    await expect(label).toExist();
    const text = await label.getText();
    expect(text).toBe("Home");
  });

  it("Stop BG broadcasts hide-background-media", async function () {
    await (await panelButton("Stop BG")).click();
    await rec.waitFor("hide-background-media");
    await expect(panelButton("Add BG")).toExist();
  });
});
