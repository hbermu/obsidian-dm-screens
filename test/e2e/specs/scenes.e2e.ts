import { browser, expect } from "@wdio/globals";
import { addMap, DEFAULT_PORT, openFixtureNote, openPanel, panelButton, startServer, waitForNoticesToClear } from "../helpers/obsidian";
import { WsRecorder } from "../helpers/ws";

// A 1×1 PNG: enough for a fog mask that must survive the save/load round trip.
const FOG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function sceneButton(cls: "save" | "load", section: "player" | "map") {
  const buttons = await browser.$(".dm-control-panel").$$(`.dm-scene-${cls}-btn`);
  return buttons[section === "player" ? 0 : 1];
}

async function saveScene(section: "player" | "map", name: string): Promise<void> {
  await (await sceneButton("save", section)).click();
  const input = browser.$(".dm-scene-name-input");
  await input.waitForExist();
  await input.setValue(name);
  await browser.$(".modal").$("button=Save").click();
  await browser.waitUntil(
    () => browser.executeObsidian(({ app }, path) => app.vault.adapter.exists(path), `DM Screen/Scenes/${name}.md`),
    { timeoutMsg: `scene note ${name} never written` },
  );
  await waitForNoticesToClear();
}

async function pickScene(section: "player" | "map", name: string): Promise<void> {
  await (await sceneButton("load", section)).click();
  await browser.$(".prompt-input").waitForExist();
  await browser.keys(name);
  await browser.waitUntil(async () => (await browser.$(".suggestion-item").getText()).includes(name));
  await browser.keys("Enter");
}

describe("scenes", function () {
  let player: WsRecorder;
  let map: WsRecorder;

  before(async function () {
    await openPanel();
    await openFixtureNote();
    await startServer();
    player = await WsRecorder.connect(DEFAULT_PORT, "player");
    map = await WsRecorder.connect(DEFAULT_PORT, "map");
  });

  after(function () {
    player.close();
    map.close();
  });

  it("saves the player screen as a scene note with a dm-scene block", async function () {
    await (await panelButton("Add Image")).click();
    await player.waitFor("image-layers-sync", { where: (m) => (m.payload.layers as unknown[]).length === 1 });
    await saveScene("player", "Tavern");

    const note = await browser.executeObsidian(({ app }) => app.vault.adapter.read("DM Screen/Scenes/Tavern.md"));
    expect(note.startsWith("# Tavern\n\n```dm-scene\n")).toBe(true);
    expect(note).toContain("vault:attachments/map.png");
  });

  it("loads the player scene from its rendered card", async function () {
    const seen = player.count("image-layers-sync");
    await (await panelButton("Clear All Layers")).click();
    await player.waitFor("image-layers-sync", { skip: seen, where: (m) => (m.payload.layers as unknown[]).length === 0 });

    const cleared = player.count("image-layers-sync");
    // Open the note in its own tab in reading view and press the card's Load
    // inside that tab: the rendered card is the code block processor's output,
    // and the test window is too small for WebDriver to call the tab visible.
    const clicked = await browser.executeObsidian(async ({ app }) => {
      const leaf = app.workspace.getLeaf(true);
      await leaf.setViewState({ type: "markdown", state: { file: "DM Screen/Scenes/Tavern.md", mode: "preview" }, active: true });
      for (let i = 0; i < 50; i++) {
        const btn = leaf.view.containerEl.querySelector<HTMLButtonElement>(".dm-scene-card .dm-scene-card-load");
        if (btn) {
          btn.click();
          return true;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    });
    expect(clicked).toBe(true);

    const sync = await player.waitFor("image-layers-sync", {
      skip: cleared,
      where: (m) => (m.payload.layers as unknown[]).length === 1,
    });
    const layer = (sync.payload.layers as Record<string, unknown>[])[0];
    expect(layer.label).toBe("Home (embed)");
    expect(layer.visible).toBe(false);
    expect(layer).not.toHaveProperty("source");
  });

  it("round-trips a map scene with its fog and walls through the picker", async function () {
    await openFixtureNote();
    await addMap();
    await browser.executeObsidian(async ({ app }, fog) => {
      const leaf = app.workspace.getLeavesOfType("dm-control-panel")[0];
      const mapPanel = (leaf.view as any).mapPanel;
      await mapPanel.commitWalls([{ x1: 0, y1: 0, x2: 100, y2: 0, door: true, open: false }]);
      await mapPanel.commitFog(fog);
    }, FOG);
    await saveScene("map", "Crypt");

    await (await panelButton("Stop Map")).click();
    await map.waitFor("map-clear");
    const before = map.count("map-walls");
    const fogBefore = map.count("map-fog");

    await pickScene("map", "Crypt");
    const walls = await map.waitFor("map-walls", {
      skip: before,
      where: (m) => (m.payload.walls as unknown[]).length === 1,
    });
    expect((walls.payload.walls as Record<string, unknown>[])[0]).toMatchObject({ door: true, open: false });
    const fog = await map.waitFor("map-fog", { skip: fogBefore, where: (m) => m.payload.dataUrl === FOG });
    expect(fog.payload.dataUrl).toBe(FOG);
    const show = map.messages.filter((m) => m.type === "map-show").pop()!;
    expect(show.payload.url).toBe("/vault/attachments/map.png");
  });
});
