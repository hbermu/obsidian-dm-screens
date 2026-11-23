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
