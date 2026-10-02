import { browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import { openPanel, openFixtureNote, startServer, panelButton, addMap, DEFAULT_PORT } from "../helpers/obsidian";
import { WsRecorder } from "../helpers/ws";

const MAP_W = 560;
const MAP_H = 420;
const DOOR = { x: 140, y: 220 };

describe("exploration mode", function () {
  let rec: WsRecorder;

  before(async function () {
    await openPanel();
    await openFixtureNote();
    await startServer();
    rec = await WsRecorder.connect(DEFAULT_PORT, "map");
    await addMap();
    await rec.waitFor("map-show");

    await browser.executeObsidian(async ({ app }) => {
      const view = app.workspace.getLeavesOfType("dm-control-panel")[0].view as any;
      await view.mapPanel.commitWalls([
        { x1: 140, y1: 0, x2: 140, y2: 180 },
        { x1: 140, y1: 180, x2: 140, y2: 260, door: true, open: false },
        { x1: 140, y1: 260, x2: 140, y2: 420 },
      ]);
    });
    await rec.waitFor("map-walls", { where: (m) => (m.payload.walls as unknown[]).length === 3 });
  });

  after(async function () {
    await browser.releaseActions();
    rec.close();
  });

  it("Explore opens a near-fullscreen surface with the table-play controls", async function () {
    await (await panelButton("Explore")).click();
    const modal = browser.$(".dm-explore-modal");
    await expect(modal).toExist();
    await expect(modal.$(".dm-explore-overlay")).toExist();
    await expect(modal.$(".dm-explore-markers")).toExist();
    for (const text of ["Reveal All", "Cover All", "Exit"]) {
      await expect(modal.$(`button=${text}`)).toExist();
    }

    const coverage = await browser.executeObsidian(() => {
      const r = document.querySelector(".dm-explore-modal")!.getBoundingClientRect();
      return (r.width * r.height) / (window.innerWidth * window.innerHeight);
    });
    expect(coverage).toBeGreaterThan(0.8);
  });

  it("explore bar shows visible source label", async function () {
    const modal = browser.$(".dm-explore-modal");
    await expect(modal).toExist();
    const label = await modal.$(".dm-explore-bar .dm-explore-title.dm-source-label");
    await expect(label).toExist();
    const text = await label.getText();
    expect(text).toBe("Home");
  });

  it("holding Shift toggles the exploration focus class", async function () {
    const markers = browser.$(".dm-explore-modal .dm-explore-markers");

    await browser.action("key").down(Key.Shift).perform(true);
    await browser.waitUntil(async () =>
      ((await markers.getAttribute("class")) ?? "").includes("dm-explore-focus"),
    );

    await browser.action("key").up(Key.Shift).perform();
    await browser.waitUntil(async () =>
      !((await markers.getAttribute("class")) ?? "").includes("dm-explore-focus"),
    );
  });

  it("a Shift-click on a door marker opens the door and broadcasts map-walls", async function () {
    const r = await browser.executeObsidian(() => {
      const rect = document.querySelector(".dm-explore-modal .dm-explore-overlay")!.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    });
    const x = Math.round(r.left + (DOOR.x * r.width) / MAP_W);
    const y = Math.round(r.top + (DOOR.y * r.height) / MAP_H);

    const seen = rec.count("map-walls");
    await browser.action("key").down(Key.Shift).perform(true);
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ x, y })
      .down()
      .up()
      .perform();
    await browser.action("key").up(Key.Shift).perform();

    const walls = await rec.waitFor("map-walls", {
      skip: seen,
      where: (m) => (m.payload.walls as Record<string, unknown>[]).some((w) => w.door === true && w.open === true),
    });
    expect((walls.payload.walls as unknown[]).length).toBe(3);
  });

  it("clicking inside a room toggles its fog and commits map-fog twice", async function () {
    const r = await browser.executeObsidian(() => {
      const rect = document.querySelector(".dm-explore-modal .dm-explore-overlay")!.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    });
    const x = Math.round(r.left + (70 * r.width) / MAP_W);
    const y = Math.round(r.top + (210 * r.height) / MAP_H);

    let seen = rec.count("map-fog");
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ x, y })
      .down()
      .up()
      .perform();
    const first = await rec.waitFor("map-fog", { skip: seen });
    expect(typeof first.payload.dataUrl).toBe("string");

    seen = rec.count("map-fog");
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ x, y })
      .down()
      .up()
      .perform();
    const second = await rec.waitFor("map-fog", { skip: seen });
    expect(second.payload.dataUrl).not.toBe(first.payload.dataUrl);

    await browser.$(".dm-explore-modal").$("button=Exit").click();
    await browser.waitUntil(async () => !(await browser.$(".dm-explore-modal").isExisting()));
  });

  it("floating windows minimize and restore", async function () {
    await (await panelButton("Explore")).click();
    const modal = browser.$(".dm-explore-modal");
    await expect(modal).toExist();

    const aoesWindow = await modal.$(".dm-floating-window");
    const minimizeBtn = await aoesWindow.$(".dm-floating-window-minimize");
    await expect(minimizeBtn).toExist();

    const body = await aoesWindow.$(".dm-floating-window-body");
    const isMinimized = () => aoesWindow.getAttribute("class").then((c) => c?.includes("dm-floating-window-minimized") ?? false);

    expect(await isMinimized()).toBe(false);
    await expect(body).toBeDisplayed();

    await minimizeBtn.click();
    expect(await isMinimized()).toBe(true);
    await expect(body).not.toBeDisplayed();

    await minimizeBtn.click();
    expect(await isMinimized()).toBe(false);
    await expect(body).toBeDisplayed();

    await modal.$("button=Exit").click();
    await browser.waitUntil(async () => !(await modal.isExisting()));
  });

  it("windows can be dragged by their header and stay inside the stage", async function () {
    await (await panelButton("Explore")).click();
    const modal = browser.$(".dm-explore-modal");
    await expect(modal).toExist();

    const initialPos = await browser.executeObsidian(() => {
      const win = document.querySelectorAll(".dm-floating-window")[1] as HTMLElement;
      return { left: win.style.left, top: win.style.top };
    });

    const headerBox = await browser.executeObsidian(() => {
      const header = document.querySelectorAll(".dm-floating-window")[1]!.querySelector(".dm-floating-window-header") as HTMLElement;
      const rect = header.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const centerX = Math.round(headerBox.x + headerBox.width / 2);
    const centerY = Math.round(headerBox.y + headerBox.height / 2);

    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ x: centerX, y: centerY })
      .down()
      .move({ x: centerX - 100, y: centerY + 50 })
      .up()
      .perform();

    const newPos = await browser.executeObsidian(() => {
      const win = document.querySelectorAll(".dm-floating-window")[1] as HTMLElement;
      const stage = document.querySelector(".dm-explore-stage") as HTMLElement;
      return {
        left: win.style.left,
        top: win.style.top,
        winLeft: win.offsetLeft,
        winTop: win.offsetTop,
        stageWidth: stage.clientWidth,
        stageHeight: stage.clientHeight,
      };
    });

    expect(newPos.left).not.toBe(initialPos.left);
    expect(newPos.top).not.toBe(initialPos.top);
    expect(newPos.winLeft).toBeGreaterThanOrEqual(0);
    expect(newPos.winTop).toBeGreaterThanOrEqual(0);

    await modal.$("button=Exit").click();
    await browser.waitUntil(async () => !(await modal.isExisting()));
  });

  it("window bodies have no horizontal scrollbar", async function () {
    await (await panelButton("Explore")).click();
    const modal = browser.$(".dm-explore-modal");
    await expect(modal).toExist();

    const scrollInfo = await browser.executeObsidian(() => {
      const windows = Array.from(document.querySelectorAll(".dm-floating-window"));
      return windows.map((w) => {
        const body = w.querySelector(".dm-floating-window-body") as HTMLElement;
        return {
          scrollWidth: body.scrollWidth,
          clientWidth: body.clientWidth,
        };
      });
    });

    for (const info of scrollInfo) {
      expect(info.scrollWidth).toBeLessThanOrEqual(info.clientWidth);
    }

    await modal.$("button=Exit").click();
    await browser.waitUntil(async () => !(await modal.isExisting()));
  });

  it("opens from the header of a collapsed Map Screen section and drives scale, grid and combat", async function () {
    const sectionTitle = browser.$(".dm-control-panel").$("h3=Map Screen");
    await sectionTitle.click();
    await expect(panelButton("Rotate: 0°")).not.toBeDisplayed();
    await expect(panelButton("Explore")).toBeDisplayed();

    await (await panelButton("Explore")).click();
    const modal = browser.$(".dm-explore-modal");
    await expect(modal).toExist();
    const combat = await browser.executeObsidian(() =>
      Array.from(document.querySelectorAll(".dm-explore-modal .dm-floating-window-title")).some(
        (t) => t.textContent === "Combat",
      ),
    );
    expect(combat).toBe(true);
    await expect(modal.$(".dm-floating-window .dm-combat-tabs")).toExist();

    let seen = rec.count("map-view");
    await modal.$("button=Scale: fit screen").click();
    await rec.waitFor("map-view", { skip: seen, where: (m) => m.payload.mode === "physical" });
    await expect(modal.$("button=Scale: physical 1″")).toExist();

    seen = rec.count("map-config");
    await modal.$("button=Grid: off").click();
    await rec.waitFor("map-config", { skip: seen, where: (m) => m.payload.showGrid === true });
    await expect(modal.$("button=Grid: on")).toExist();

    await modal.$("button=Scale: physical 1″").click();
    await modal.$("button=Grid: on").click();
    await modal.$("button=Exit").click();
    await browser.waitUntil(async () => !(await modal.isExisting()));
    await sectionTitle.click();
    await expect(panelButton("Rotate: 0°")).toBeDisplayed();
  });
});
