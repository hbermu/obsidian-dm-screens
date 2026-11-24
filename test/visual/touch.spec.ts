import path from "node:path";
import { test, expect, type CDPSession, type Page } from "@playwright/test";

// Real fingers in a real engine. The unit tests drive the gesture modules
// through synthesised pointer events, which cannot say whether the browser
// hands those events over at all: `touch-action`, the coarse-pointer hit sizes
// and the pointer stream a tablet actually produces only exist here.
//
// Playwright's touchscreen drives a single finger, so anything needing two —
// or a real inertial scroll — goes through Chromium's CDP touch injection and
// is skipped on WebKit, which has no equivalent. WebKit still runs every
// single-finger case, which is where the engine differences bite.

const pageUrl = `file://${process.env.HARNESS_TOUCH_PAGE ?? path.resolve(__dirname, ".harness/touch.html")}`;

interface Probe {
  view: { zoom: number; offsetX: number; offsetY: number };
  tapped: Array<{ x: number; y: number }>;
  dotDrag: Array<{ x: number; y: number }>;
  dotPresses: number;
  cancels: number;
  dotLongPress: number;
  pointerTypes: string[];
  pinchStarts: number;
}

const probe = (page: Page) => page.evaluate(() => (window as unknown as { __touch: Probe }).__touch);

async function centre(page: Page, selector: string) {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, width: b.width, height: b.height };
}

const touchAction = (page: Page, selector: string) =>
  page.evaluate(
    (sel) => getComputedStyle(document.querySelector(sel) as Element).touchAction,
    selector
  );

type Point = { x: number; y: number; id: number };

async function sendTouch(cdp: CDPSession, type: string, touchPoints: Point[]) {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints } as never);
}

async function swipe(cdp: CDPSession, from: { x: number; y: number }, dx: number, dy: number, steps = 5) {
  await sendTouch(cdp, "touchStart", [{ ...from, id: 1 }]);
  for (let i = 1; i <= steps; i += 1) {
    await sendTouch(cdp, "touchMove", [{ x: from.x + (dx * i) / steps, y: from.y + (dy * i) / steps, id: 1 }]);
  }
  await sendTouch(cdp, "touchEnd", []);
}

async function pinch(cdp: CDPSession, at: { x: number; y: number }, from: number, to: number) {
  const pair = (half: number): Point[] => [
    { x: at.x - half, y: at.y, id: 1 },
    { x: at.x + half, y: at.y, id: 2 },
  ];
  await sendTouch(cdp, "touchStart", pair(from / 2));
  for (let i = 1; i <= 4; i += 1) {
    await sendTouch(cdp, "touchMove", pair((from + ((to - from) * i) / 4) / 2));
  }
  await sendTouch(cdp, "touchEnd", []);
}

test.beforeEach(async ({ page }) => {
  await page.goto(pageUrl);
  await page.waitForFunction(() => (window as unknown as { __touch?: Probe }).__touch !== undefined);
});

test("the profile reports a coarse pointer, so the 44px hit rules are in force", async ({ page }) => {
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  // The drawn dot stays small — the target around it is what grows.
  expect((await centre(page, ".dm-map-aoe-dot")).width).toBeLessThan(20);
});

test("the drag surfaces hold the gesture, the windows over them still scroll", async ({ page }) => {
  expect(await touchAction(page, ".dm-explore-inner")).toBe("none");
  expect(await touchAction(page, ".dm-map-aoe-dot")).toBe("none");
  // The stage itself must stay scrollable, or the AoE and Vision windows
  // floating over it could not be scrolled with a finger.
  expect(await touchAction(page, ".dm-floating-window-body")).toBe("auto");
});

test("the panel's own drag surfaces hold the gesture, and its targets fit a finger", async ({ page }) => {
  // The DM panel's Player Screen section: a layer rectangle moves and the
  // inline fog canvas paints, so both keep the gesture, while the preview
  // around them stays scrollable (`touch-input.md` requirements 4 and 21).
  expect(await touchAction(page, ".dm-layer-rect")).toBe("none");
  // The preview area itself keeps scrolling the panel.
  expect(await touchAction(page, ".dm-layer-preview")).toBe("auto");
  expect(await touchAction(page, ".dm-fog-draw-canvas-inline")).toBe("none");

  const sizes = await page.evaluate(() => {
    const box = (sel: string) => {
      const r = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
      return { w: r.width, h: r.height };
    };
    return { layerBtn: box(".dm-layer-btn"), toolbarBtn: box(".dm-fog-toolbar button"), slider: box("input[type=range]") };
  });
  expect(sizes.toolbarBtn.h).toBeGreaterThanOrEqual(44);
  expect(sizes.toolbarBtn.w).toBeGreaterThanOrEqual(44);
  // The layer row's icon buttons grow in height only — see the stylesheet.
  expect(sizes.layerBtn.h).toBeGreaterThanOrEqual(44);
  expect(sizes.slider.h).toBeGreaterThanOrEqual(28);
});

test("the compact layout's tabs are a finger's size and the closed sheet keeps off the map", async ({ page }) => {
  const sizes = await page.evaluate(() => {
    const host = document.querySelector(".dm-explore-sheet-host") as HTMLElement;
    const tabs = Array.from(host.querySelectorAll(".dm-explore-tabs button")) as HTMLElement[];
    const sheet = host.querySelector(".dm-explore-sheet") as HTMLElement;
    const closedHeight = sheet.getBoundingClientRect().height;
    host.classList.add("dm-explore-sheet-open");
    const openHeight = sheet.getBoundingClientRect().height;
    host.classList.remove("dm-explore-sheet-open");
    return {
      tabs: tabs.map((t) => ({ h: t.getBoundingClientRect().height, w: t.getBoundingClientRect().width })),
      closedHeight,
      openHeight,
      stage: (document.querySelector(".dm-explore-stage") as HTMLElement).getBoundingClientRect().height,
    };
  });

  expect(sizes.tabs).toHaveLength(3);
  for (const tab of sizes.tabs) {
    expect(tab.h).toBeGreaterThanOrEqual(44);
    // Three tabs share the width, so each one is still comfortably wide.
    expect(tab.w).toBeGreaterThanOrEqual(44);
  }
  // Closed, the sheet takes no height at all: only the tab row is on screen.
  expect(sizes.closedHeight).toBe(0);
  expect(sizes.openHeight).toBeGreaterThan(0);
  expect(sizes.openHeight).toBeLessThan(sizes.stage);
});

test("a narrow panel lays its sections out down the column, never sideways", async ({ page }) => {
  const layout = await page.evaluate(() => {
    const panel = document.querySelector(".dm-control-panel") as HTMLElement;
    const r = (sel: string) => (panel.querySelector(sel) as HTMLElement).getBoundingClientRect();
    const buttons = Array.from(panel.querySelectorAll(".dm-section-actions button")) as HTMLElement[];
    return {
      overflow: panel.scrollWidth - panel.clientWidth,
      panelRight: panel.getBoundingClientRect().right,
      titleBottom: r("h3").bottom,
      actionsTop: r(".dm-section-actions").top,
      buttons: buttons.map((b) => {
        const box = b.getBoundingClientRect();
        return { h: box.height, right: box.right };
      }),
      urlRight: r(".dm-server-url-link").right,
      addWidth: r(".dm-layer-btn-row > button.mod-cta").width,
      rowWidth: r(".dm-layer-btn-row").width,
    };
  });

  // Nothing is reached by scrolling the panel sideways.
  expect(layout.overflow).toBeLessThanOrEqual(0);
  // The three section buttons sit on their own row under the title…
  expect(layout.actionsTop).toBeGreaterThanOrEqual(layout.titleBottom);
  expect(layout.buttons).toHaveLength(3);
  for (const button of layout.buttons) {
    // …each one whole and a finger tall.
    expect(button.right).toBeLessThanOrEqual(layout.panelRight + 0.5);
    expect(button.h).toBeGreaterThanOrEqual(44);
  }
  // The join URL stays inside the panel, and the primary action is full width.
  expect(layout.urlRight).toBeLessThanOrEqual(layout.panelRight + 0.5);
  expect(layout.addWidth).toBeCloseTo(layout.rowWidth, 0);
});

// A box that stays inside the panel can still hold a label that does not, which
// is what a share-the-row-evenly rule does once the share is narrower than the
// word on the button.
test("a panel too narrow for three buttons on one row wraps them instead of crushing them", async ({ page }) => {
  const row = await page.evaluate(() => {
    const panel = document.querySelector(".dm-control-panel") as HTMLElement;
    panel.style.width = "200px";
    const actions = panel.querySelector(".dm-section-actions") as HTMLElement;
    const buttons = Array.from(actions.querySelectorAll("button")) as HTMLElement[];
    const measured = {
      overflow: panel.scrollWidth - panel.clientWidth,
      actionsHeight: actions.getBoundingClientRect().height,
      buttons: buttons.map((b) => ({
        content: b.scrollWidth,
        box: b.clientWidth,
        h: b.getBoundingClientRect().height,
      })),
    };
    panel.style.width = "";
    return measured;
  });

  expect(row.overflow).toBeLessThanOrEqual(0);
  expect(row.buttons).toHaveLength(3);
  for (const button of row.buttons) {
    // The label fits the button it is written on.
    expect(button.content).toBeLessThanOrEqual(button.box + 0.5);
  }
  // Which it can only do by taking more than one row.
  expect(row.actionsHeight).toBeGreaterThan(Math.max(...row.buttons.map((b) => b.h)) + 1);
});

test("the section bar stays put while the panel scrolls, with finger-sized chips", async ({ page }) => {
  const nav = await page.evaluate(() => {
    const panel = document.querySelector(".dm-control-panel") as HTMLElement;
    const bar = panel.querySelector(".dm-section-nav") as HTMLElement;
    const chips = Array.from(bar.querySelectorAll(".dm-section-chip")) as HTMLElement[];
    const before = bar.getBoundingClientRect().top;
    panel.scrollTop = 300;
    const after = bar.getBoundingClientRect().top;
    const panelBox = panel.getBoundingClientRect();
    panel.scrollTop = 0;
    const style = getComputedStyle(bar);
    return {
      display: style.display,
      position: style.position,
      background: style.backgroundColor,
      blur: `${style.backdropFilter} ${(style as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter ?? ""}`,
      before,
      after,
      scrolled: panel.scrollTop,
      chips: chips.map((c) => ({
        h: c.getBoundingClientRect().height,
        right: c.getBoundingClientRect().right,
        bg: getComputedStyle(c).backgroundColor,
        active: c.classList.contains("dm-section-chip-active"),
      })),
      panelRight: panelBox.right,
      sections: panel.querySelectorAll(".dm-section").length,
    };
  });

  expect(nav.display).toBe("flex");
  expect(nav.position).toBe("sticky");
  // It paints no colour of its own: the panel's surface is primary in the main
  // area and secondary in a sidebar, so a painted band is the wrong shade half
  // the time. It blurs what passes under it instead.
  expect(nav.background).toBe("rgba(0, 0, 0, 0)");
  expect(nav.blur).toContain("blur");
  // It does not travel with the content it is there to navigate.
  expect(nav.after).toBeCloseTo(nav.before, 0);
  expect(nav.chips.length).toBeGreaterThanOrEqual(3);
  // The current section has to look current: a theme's `button:not(...)` rule
  // outweighs a lone class, and the active chip kept the theme's grey.
  const active = nav.chips.filter((c) => c.active);
  expect(active).toHaveLength(1);
  expect(active[0].bg).not.toBe(nav.chips.find((c) => !c.active)!.bg);
  for (const chip of nav.chips) {
    expect(chip.h).toBeGreaterThanOrEqual(44);
    // All of them fit the width: a nav bar you scroll sideways navigates badly.
    expect(chip.right).toBeLessThanOrEqual(nav.panelRight + 0.5);
  }
});

test("a closed layer is one line, an open one shows its controls", async ({ page }) => {
  const rows = await page.evaluate(() => {
    const box = (sel: string) => (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
    const shown = (sel: string) => getComputedStyle(document.querySelector(sel) as Element).display !== "none";
    return {
      closedHeight: box("#collapsed-layer").height,
      openHeight: box("#expanded-layer").height,
      closedControls: shown("#collapsed-layer .dm-layer-right-col"),
      closedToggles: shown("#collapsed-layer .dm-layer-left-bottom"),
      closedEye: shown("#collapsed-layer .dm-layer-vis-toggle"),
      openControls: shown("#expanded-layer .dm-layer-right-col"),
      chevron: box("#collapsed-layer .dm-layer-expand"),
    };
  });

  // Ten buttons and two toggles per layer filled the screen; closed, a layer
  // is its name, its eye and its opacity.
  expect(rows.closedControls).toBe(false);
  expect(rows.closedToggles).toBe(false);
  expect(rows.closedEye).toBe(true);
  expect(rows.openControls).toBe(true);
  expect(rows.closedHeight).toBeLessThan(rows.openHeight / 2);
  // The disclosure exists and is reachable.
  expect(rows.chevron.width).toBeGreaterThan(0);
});

test("a tap explores on the lift, as touch", async ({ page }) => {
  const overlay = await centre(page, ".dm-explore-overlay");
  await page.touchscreen.tap(overlay.x, overlay.y);

  const after = await probe(page);
  expect(after.pointerTypes).toEqual(["touch"]);
  expect(after.tapped).toHaveLength(1);
  expect(after.tapped[0].x).toBeCloseTo(overlay.x, 0);
});

test("a tap that lands beside a marker still hits it", async ({ page }) => {
  const dot = await centre(page, ".dm-map-aoe-dot");
  // 15px off centre: outside the 10px dot, inside the touch target.
  await page.touchscreen.tap(dot.x + 15, dot.y + 15);

  const after = await probe(page);
  expect(after.dotPresses).toBe(1);
  expect(after.tapped).toHaveLength(0);
});

test("holding a marker fires the long press that stands in for a right-click", async ({ page }) => {
  const dot = await centre(page, ".dm-map-aoe-dot");
  await page.touchscreen.tap(dot.x, dot.y);
  expect((await probe(page)).dotLongPress).toBe(0);

  await page.evaluate(() => {
    const el = document.querySelector(".dm-map-aoe-dot") as HTMLElement;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: 7,
        pointerType: "touch",
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        bubbles: true,
      })
    );
  });
  await expect.poll(async () => (await probe(page)).dotLongPress, { timeout: 2000 }).toBe(1);
});

test.describe("injected touch", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "touch injection is Chromium-only");

  let cdp: CDPSession;

  test.beforeEach(async ({ page }) => {
    cdp = await page.context().newCDPSession(page);
  });

  test("dragging a marker keeps the whole pointer stream", async ({ page }) => {
    const dot = await centre(page, ".dm-map-aoe-dot");
    await swipe(cdp, dot, 100, 0);

    const after = await probe(page);
    expect(after.dotPresses).toBe(1);
    // Without `touch-action: none` the engine would take the gesture for a
    // scroll and cancel the pointer partway through.
    expect(after.cancels).toBe(0);
    expect(after.dotDrag.at(-1)!.x).toBeCloseTo(dot.x + 100, 0);
  });

  test("a finger dragged across the map explores nothing", async ({ page }) => {
    const overlay = await centre(page, ".dm-explore-overlay");
    await swipe(cdp, overlay, 0, 120);
    expect((await probe(page)).tapped).toHaveLength(0);
  });

  test("pinching out zooms the stage and explores nothing", async ({ page }) => {
    const overlay = await centre(page, ".dm-explore-overlay");
    await pinch(cdp, overlay, 200, 400);

    const after = await probe(page);
    expect(after.pinchStarts).toBe(1);
    expect(after.view.zoom).toBeCloseTo(2, 1);
    expect(after.tapped).toHaveLength(0);
  });

  test("pinching back in returns the stage to fit", async ({ page }) => {
    const overlay = await centre(page, ".dm-explore-overlay");
    await pinch(cdp, overlay, 200, 400);
    await pinch(cdp, overlay, 400, 100);

    expect((await probe(page)).view).toEqual({ zoom: 1, offsetX: 0, offsetY: 0 });
  });
});
