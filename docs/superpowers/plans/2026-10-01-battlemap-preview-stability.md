# Battlemap Preview Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the DM battlemap preview stable and fluid — stop AoEs teleporting to the map edge, stop the preview collapsing to zero height, and remove the per-mouse-event allocation that makes it stutter.

**Architecture:** Three sequential phases, one PR each. Phase 1 repairs both reported defects in place. Phase 2 extracts a shared `MapStage` module that owns preview geometry for all three previews and removes per-event canvas reallocation. Phase 3 instruments the map client on the real TV before changing it. The pure geometry in `src/map/transform.ts` and `src/map/aoe.ts` is not touched.

**Tech Stack:** TypeScript strict, Obsidian plugin API, esbuild, vitest, WebdriverIO (real Obsidian e2e), Playwright (visual). Everything runs in Docker via `make`; there is no Node toolchain on the host.

**User Verification:** YES — the user reviews a written summary after each phase and gives the go-ahead before the next phase starts. Encoded as the final task of each phase.

---

## Ground rules for every task

These are repository rules, not suggestions. `.claude/hooks/bash-precheck.sh` blocks violations locally and CI mirrors them.

- **Never run `node`, `npm`, `npx`, `tsc`, `vitest` or `esbuild` on the host.** Use `make typecheck`, `make test`, `make build`.
- **Run `make typecheck && make test` before every commit.** Both must pass.
- **Never use `--no-verify` or `--no-gpg-sign`.** A hook block is a rule violation, not an obstacle to route around.
- **Every commit that touches `src/` must touch `.agent/features/` in the same commit.** `spec-update-check` enforces it in CI.
- **No "what this does" comments, no docstrings, no dead code, no backwards-compat shims.** Comments explain non-obvious *why* only.
- **Build DOM with `createEl`/`createDiv`/`createSpan` and text nodes.** Assigning `innerHTML` is banned except `innerHTML = ""` to clear.
- **Instrument non-trivial paths with `debug()` from `src/debug.ts`.** Never log a URL, key or body verbatim. Do not log per-frame events.
- The branch for Phase 1 is `fix/dm-preview-stability` and already exists. Phases 2 and 3 get their own branches.

---

# PHASE 1 — Correctness

Branch: `fix/dm-preview-stability`. PR title: `fix(dm-preview): keep AoE drags and the pan preview stable`. Bump label: `release:minor` (requirement 6 of `scale-and-grid.md` changes observably).

## Task 1: Drag lock on the DM panel

**Goal:** A background re-render can no longer empty the panel while a preview drag is in progress.

**Files:**
- Modify: `src/views/DmControlPanel.ts` — near `renderFromBackground` / `isEditingPanelField` / `flushPendingRender`
- Test: `src/__tests__/dm-panel-drag-lock.test.ts` (create)

**Acceptance Criteria:**
- [ ] `beginDrag()` returns a release function; nested drags are counted, not booleaned
- [ ] `renderFromBackground()` defers while `dragDepth > 0`
- [ ] Releasing the last drag flushes a deferred render
- [ ] Releasing a drag with no deferred render pending does not render

**Verify:** `make test` → `dm-panel-drag-lock.test.ts` passes

**Steps:**

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/dm-panel-drag-lock.test.ts`. Follow the construction style of the existing `map-screen-panel-aoe.test.ts` — do not invent a new harness. The test drives the three public seams only.

```ts
import { describe, it, expect, vi } from "vitest";

// Build the panel the same way map-screen-panel-aoe.test.ts does.
// The point under test is the deferral decision, so stub render().

describe("DmControlPanel drag lock", () => {
  it("defers a background render while a drag is active", () => {
    const panel = makePanel();
    const render = vi.spyOn(panel, "render").mockImplementation(() => {});
    const endDrag = panel.beginDrag();

    panel.renderFromBackground();
    expect(render).not.toHaveBeenCalled();

    endDrag();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("counts nested drags and only flushes on the last release", () => {
    const panel = makePanel();
    const render = vi.spyOn(panel, "render").mockImplementation(() => {});
    const endOuter = panel.beginDrag();
    const endInner = panel.beginDrag();

    panel.renderFromBackground();
    endInner();
    expect(render).not.toHaveBeenCalled();

    endOuter();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("does not render on release when nothing was deferred", () => {
    const panel = makePanel();
    const render = vi.spyOn(panel, "render").mockImplementation(() => {});
    panel.beginDrag()();
    expect(render).not.toHaveBeenCalled();
  });

  it("is idempotent — releasing twice does not double-flush", () => {
    const panel = makePanel();
    const render = vi.spyOn(panel, "render").mockImplementation(() => {});
    const end = panel.beginDrag();
    panel.renderFromBackground();
    end();
    end();
    expect(render).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `make test`
Expected: FAIL — `panel.beginDrag is not a function`

- [ ] **Step 3: Implement**

In `src/views/DmControlPanel.ts`, beside `pendingBackgroundRender`:

```ts
  private dragDepth = 0;

  // A background render (a DDB poll, a client connecting) must not empty the
  // container while a preview drag is live: the drag's closures hold a stage
  // that would become detached, and a detached stage measures zero, which the
  // conversion helpers cannot distinguish from a legitimate scale.
  beginDrag(): () => void {
    this.dragDepth++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.dragDepth--;
      if (this.dragDepth === 0) this.flushPendingRender();
    };
  }
```

Extend the existing guard:

```ts
  private renderFromBackground() {
    if (this.dragDepth > 0 || this.isEditingPanelField()) {
      this.pendingBackgroundRender = true;
      return;
    }
    this.render();
  }
```

`flushPendingRender` already defers to the next tick and re-checks `isEditingPanelField`; extend its re-check to include `this.dragDepth > 0` so a release that overlaps a focused field still defers.

- [ ] **Step 4: Run the test and watch it pass**

Run: `make test`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `make typecheck`
Expected: exit 0

No commit yet — Task 2 lands in the same commit as its spec change.

---

## Task 2: Non-finite scale guard in the pan preview

**Goal:** A drag over a stage that cannot be measured is inert instead of clamping the AoE to the map edge.

**Files:**
- Modify: `src/views/MapScreenPanel.ts:583-594` (`effectiveScale`, `screenToMap`, `deltaToMap`) and every `onMove` that consumes them
- Modify: `src/views/MapExploreModal.ts` — the same guard on its `deltaToMap` / `overlayGeom` consumers
- Modify: `.agent/features/map-screen/scale-and-grid.md`
- Test: `src/__tests__/map-screen-panel-aoe.test.ts` (extend)

**Acceptance Criteria:**
- [ ] `effectiveScale()` returns `null` when the measured stage width is not finite or not positive
- [ ] `screenToMap` and `deltaToMap` return `null` rather than a non-finite point
- [ ] Every AoE, vision and viewport-rect `onMove` returns early on `null` without mutating state or broadcasting
- [ ] A drag over a zero-width stage leaves `aoe.x` and `aoe.y` exactly as they were

**Verify:** `make test` → the new "zero-width stage" cases in `map-screen-panel-aoe.test.ts` pass

**Steps:**

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/map-screen-panel-aoe.test.ts`:

```ts
  it("leaves an AoE untouched when the stage cannot be measured mid-drag", () => {
    const { panel, stage, dot } = renderPreviewWithOneAoe();
    const aoe = panel.aoes[0];
    const startX = aoe.x;
    const startY = aoe.y;

    dot.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 100, clientY: 100 }));
    // The panel re-rendered underneath the drag: the stage is detached.
    Object.defineProperty(stage, "offsetWidth", { value: 0, configurable: true });
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400, clientY: 400 }));

    expect(aoe.x).toBe(startX);
    expect(aoe.y).toBe(startY);
  });
```

Add the mirror case for the rotation handle asserting `aoe.rotation` is unchanged.

- [ ] **Step 2: Run the test and watch it fail**

Run: `make test`
Expected: FAIL — `aoe.x` is the map's natural width (the `Infinity` clamp)

- [ ] **Step 3: Implement**

```ts
    // A detached or hidden stage measures zero. Dividing by it yields
    // ±Infinity, which the map-bounds clamp turns into "snap to the edge" —
    // the same failure scale-and-grid.md requirement 11 guards against inside
    // transform.ts, at the boundary that was left outside it.
    const effectiveScale = (): number | null => {
      const s = (stage.offsetWidth / nw) * this.previewZoom;
      return Number.isFinite(s) && s > 0 ? s : null;
    };
    const screenToMap = (clientX: number, clientY: number): { x: number; y: number } | null => {
      const s = effectiveScale();
      if (s === null) return null;
      const b = stage.getBoundingClientRect();
      const r = rotatePoint(clientX - (b.left + b.width / 2), clientY - (b.top + b.height / 2), invRotation);
      return { x: nw / 2 + r.x / s, y: nh / 2 + r.y / s };
    };
    const deltaToMap = (dx: number, dy: number): { x: number; y: number } | null => {
      const s = effectiveScale();
      if (s === null) return null;
      const r = rotatePoint(dx, dy, invRotation);
      return { x: r.x / s, y: r.y / s };
    };
```

Every consumer gains an early return. The AoE dot's `onMove` becomes:

```ts
        const onMove = (me: MouseEvent) => {
          const d = deltaToMap(me.clientX - startX, me.clientY - startY);
          if (!d) return;
          aoe.x = Math.max(0, Math.min(nw, startAoeX + d.x));
          aoe.y = Math.max(0, Math.min(nh, startAoeY + d.y));
          positionMarkers();
          redrawAoes();
          this.broadcastAoes();
        };
```

Apply the same shape to the rotation handle's `onMove` (which also replaces its `if (!b.width) return` with the `effectiveScale()` check), the vision dot's `onMove`, and the viewport-rect / click-to-centre `onMove`. In `MapExploreModal`, apply the identical guard to its `deltaToMap` consumers.

- [ ] **Step 4: Run the test and watch it pass**

Run: `make test`
Expected: PASS

- [ ] **Step 5: Update the spec**

In `.agent/features/map-screen/scale-and-grid.md`, extend requirement 6c with a sentence stating that a screen-to-map conversion is only applied when the stage reports a finite positive width, and that a drag whose stage has become unmeasurable is a no-op rather than a clamp to the map bounds. Cross-reference requirement 11.

- [ ] **Step 6: Commit**

```bash
git add src/views/DmControlPanel.ts src/views/MapScreenPanel.ts src/views/MapExploreModal.ts \
        src/__tests__/dm-panel-drag-lock.test.ts src/__tests__/map-screen-panel-aoe.test.ts \
        .agent/features/map-screen/scale-and-grid.md
git commit -m "fix(dm-preview): stop AoE drags snapping to the map edge"
```

---

## Task 3: Wire every preview drag through the drag lock

**Goal:** Every `mousedown` that starts a preview drag registers with `beginDrag()` and releases on `mouseup`.

**Files:**
- Modify: `src/views/MapScreenPanel.ts` — AoE dot, rotation handle, vision dot, viewport rect / click-to-centre, `startLookAround`
- Modify: `src/views/MapExploreModal.ts` — `beginDrag` helper, AoE dot, rotation handle, vision dot, viewport rect
- Test: `src/__tests__/map-screen-panel-aoe.test.ts` (extend)

**Acceptance Criteria:**
- [ ] Each drag's `onUp` calls the release exactly once, including when the drag ends outside the window
- [ ] `MapExploreModal`'s existing `beginDrag(onMove, onUp)` helper routes through the panel's lock rather than growing a second mechanism
- [ ] No drag path can leak the lock — a missed release would freeze the panel's background renders permanently

**Verify:** `make test` → extended `map-screen-panel-aoe.test.ts` passes

**Steps:**

- [ ] **Step 1: Write the failing test**

```ts
  it("holds the panel's drag lock for the duration of an AoE drag", () => {
    const { panel, host, dot } = renderPreviewWithOneAoe();
    const render = vi.spyOn(host, "render").mockImplementation(() => {});

    dot.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 10, clientY: 10 }));
    host.renderFromBackground();
    expect(render).not.toHaveBeenCalled();

    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(render).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `make test`
Expected: FAIL — the render is not deferred

- [ ] **Step 3: Implement**

The repeated listener pair is the thing to centralise. Add one private helper on `MapScreenPanel` and use it everywhere — this replaces five copies of the same `document.addEventListener` / `removeEventListener` pair, so it is not a single-use helper:

```ts
  private trackDrag(onMove: (e: MouseEvent) => void, onEnd?: () => void) {
    const release = this.host.beginDrag();
    const move = (e: MouseEvent) => onMove(e);
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      release();
      onEnd?.();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }
```

Rewrite each drag site to call it. In `MapExploreModal`, make its existing `beginDrag(onMove, onUp)` delegate to `this.panel.trackDrag(...)` — expose `trackDrag` as internal rather than private for that one consumer.

- [ ] **Step 4: Run and watch it pass**

Run: `make test`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
make typecheck && make test
git add src/views/MapScreenPanel.ts src/views/MapExploreModal.ts src/__tests__/map-screen-panel-aoe.test.ts
git commit -m "refactor(dm-preview): route every preview drag through one tracker"
```

---

## Task 4: Resize-driven relayout

**Goal:** The preview recovers its size when its container becomes visible or changes width, instead of staying collapsed at zero height.

**Files:**
- Modify: `src/views/MapScreenPanel.ts` — `renderPanPreview`, plus a `previewResizeObserver` field
- Modify: `src/views/DmControlPanel.ts` — `onClose` disconnects it
- Modify: `.agent/features/map-screen/scale-and-grid.md`
- Test: `src/__tests__/map-screen-panel-aoe.test.ts` (extend)

**Acceptance Criteria:**
- [ ] A `ResizeObserver` on the preview container calls `layoutStage()`
- [ ] It is disconnected at the start of every `renderPanPreview` so re-renders do not stack observers
- [ ] It is disconnected in `DmControlPanel.onClose`
- [ ] `layoutStage()` keeps its existing zero-width early return — the observer fires on hide too

**Verify:** `make test` → the relayout case passes

**Steps:**

- [ ] **Step 1: Write the failing test**

`ResizeObserver` does not exist in the vitest DOM environment. Stub it in the test file alongside the existing Obsidian HTMLElement polyfills, capturing the callback so the test can fire it:

```ts
  it("re-lays out the stage when the preview container gains width", () => {
    const { panel, preview, stage, fireResize } = renderPreviewCollapsed();
    expect(stage.style.width).toBe("");

    Object.defineProperty(preview, "clientWidth", { value: 600, configurable: true });
    fireResize();

    expect(stage.style.width).not.toBe("");
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `make test`
Expected: FAIL — `stage.style.width` is still empty

- [ ] **Step 3: Implement**

```ts
  private previewResizeObserver: ResizeObserver | null = null;
```

At the top of `renderPanPreview`, before building the DOM:

```ts
    this.previewResizeObserver?.disconnect();
    this.previewResizeObserver = null;
```

After `layoutStage(); requestAnimationFrame(layoutStage);`:

```ts
    // A collapsed section is display:none, so the first layout measures zero
    // and bails. makeCollapsible only flips a CSS class — nothing re-renders —
    // so without this the preview stays a zero-height box after expanding.
    this.previewResizeObserver = new ResizeObserver(() => layoutStage());
    this.previewResizeObserver.observe(preview);
```

Add `disconnectPreviewObserver()` to `MapScreenPanel` and call it from `DmControlPanel.onClose`, beside the existing `panZoomAbort?.abort()`.

- [ ] **Step 4: Run and watch it pass**

Run: `make test`
Expected: PASS

- [ ] **Step 5: Update the spec**

In `.agent/features/map-screen/scale-and-grid.md`, extend requirement 6b: the stage is re-laid out whenever its container resizes, which covers expanding a collapsed section, revealing a hidden sidebar tab and resizing the sidebar — a collapsed section measures zero and the layout is deferred until it does not.

- [ ] **Step 6: Commit**

```bash
make typecheck && make test
git add src/views/MapScreenPanel.ts src/views/DmControlPanel.ts \
        src/__tests__/map-screen-panel-aoe.test.ts .agent/features/map-screen/scale-and-grid.md
git commit -m "fix(dm-preview): relayout the pan preview when its container resizes"
```

---

## Task 5: Marker hit targets and the click-to-centre threshold

**Goal:** Missing a marker by two pixels no longer moves what the players see.

**Files:**
- Modify: `styles.css` — `.dm-map-aoe-dot`, `.dm-map-vision-dot`, `.dm-map-aoe-rot-handle`
- Modify: `src/views/MapScreenPanel.ts` — the physical-mode `preview` mousedown handler
- Modify: `.agent/features/map-screen/scale-and-grid.md` requirement 6, `.agent/features/map-screen/aoe-overlays.md` requirement 7
- Test: `src/__tests__/map-screen-panel-aoe.test.ts` (extend)

**Acceptance Criteria:**
- [ ] Markers keep their current on-screen size at every zoom
- [ ] The pointer-capturing area is a constant ~18 px regardless of preview zoom
- [ ] A mousedown followed by mouseup with no movement does not change `state.panX` / `state.panY`
- [ ] A mousedown followed by movement of 3 px or more pans as before
- [ ] A drag that starts on the viewport rectangle is unaffected by the threshold

**Verify:** `make test` → the threshold cases pass

**Steps:**

- [ ] **Step 1: Write the failing test**

```ts
  it("ignores a click that does not move", () => {
    const { panel, preview } = renderPhysicalPreview();
    const { panX, panY } = panel.state;

    preview.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 200, clientY: 120 }));
    document.dispatchEvent(new MouseEvent("mouseup"));

    expect(panel.state.panX).toBe(panX);
    expect(panel.state.panY).toBe(panY);
  });

  it("pans once the pointer crosses the threshold", () => {
    const { panel, preview } = renderPhysicalPreview();
    const before = panel.state.panX;

    preview.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 200, clientY: 120 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 240, clientY: 120 }));

    expect(panel.state.panX).not.toBe(before);
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `make test`
Expected: FAIL — the first case pans on mousedown

- [ ] **Step 3: Implement the CSS**

The marker keeps its size; a transparent pseudo-element that does not counter-scale carries the hit area.

```css
/* The marker counter-scales so it stays visually small at high preview zoom,
   which also shrinks what the pointer can hit — at 3x a 10px dot offers about
   3px of target, and a near miss re-centres the players' view. The pseudo
   element restores a constant target without changing what is drawn. */
.dm-map-aoe-dot::before,
.dm-map-vision-dot::before,
.dm-map-aoe-rot-handle::before {
  content: "";
  position: absolute;
  inset: calc(-9px * var(--dm-map-zoom, 1));
}
```

- [ ] **Step 4: Implement the threshold**

In the physical-mode `preview` mousedown handler, replace the immediate `applyPan` with a deferred first application:

```ts
      const fromRect = e.target === rect;
      let panStarted = fromRect;
      const onMove = (ev: MouseEvent) => {
        if (!panStarted) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < PAN_START_THRESHOLD_PX) return;
          panStarted = true;
        }
        if (fromRect) {
          const d = deltaToMap(ev.clientX - startX, ev.clientY - startY);
          if (!d) return;
          applyPan(startPanX + d.x, startPanY + d.y);
        } else {
          const m = screenToMap(ev.clientX, ev.clientY);
          if (!m) return;
          applyPan(m.x, m.y);
        }
      };
```

with `const PAN_START_THRESHOLD_PX = 3;` beside `VIEW_BROADCAST_THROTTLE_MS`. The `onUp` only broadcasts and persists when `panStarted` is true.

- [ ] **Step 5: Run and watch it pass**

Run: `make test`
Expected: PASS

- [ ] **Step 6: Update the specs**

`scale-and-grid.md` requirement 6: clicking elsewhere in the preview re-centres the pan **once the pointer has moved at least 3 px**, so a stray click cannot move the players' view. `aoe-overlays.md` requirement 7: the anchor dot and rotation handle present a constant pointer target that does not counter-scale with the preview zoom, while the drawn marker still does.

- [ ] **Step 7: Commit**

```bash
make typecheck && make test
git add styles.css src/views/MapScreenPanel.ts src/__tests__/map-screen-panel-aoe.test.ts \
        .agent/features/map-screen/scale-and-grid.md .agent/features/map-screen/aoe-overlays.md
git commit -m "fix(dm-preview): widen marker hit targets and gate click-to-centre"
```

---

## Task 6: Restore the in-place repaint path

**Goal:** Size, width and opacity edits repaint the preview without rebuilding the panel, as `aoe-overlays.md` requirement 8 already specifies, and the dead `redrawPreviewAoes` field is gone.

**Files:**
- Modify: `src/views/MapScreenPanel.ts` — `redrawPreviewAoes` → `repaintOverlays`, `renderAoeRow`, `renderVisionSection`
- Modify: `src/views/MapExploreModal.ts` — register its overlay repaint
- Modify: `.agent/features/map-screen/aoe-overlays.md`
- Test: `src/__tests__/map-screen-panel-aoe.test.ts` (extend)

**Acceptance Criteria:**
- [ ] `repaintOverlays()` repaints the canvas **and** repositions the DOM markers (changing `sizeFt` moves the rotation handle)
- [ ] Size, width and opacity edits call it and do not call `host.render()`
- [ ] Structural edits (add, delete, clear, shape, colour, rotation field) still call the host re-render, per requirement 8
- [ ] The opacity slider survives a full drag — it is no longer destroyed mid-gesture
- [ ] No field is assigned and never read

**Verify:** `make test` → the in-place repaint cases pass

**Steps:**

- [ ] **Step 1: Write the failing test**

```ts
  it("repaints in place on a size edit without rebuilding the panel", () => {
    const { panel, host, sizeInput } = renderPreviewWithOneAoe();
    const render = vi.spyOn(host, "render").mockImplementation(() => {});

    sizeInput.value = "40";
    sizeInput.dispatchEvent(new Event("change"));

    expect(panel.aoes[0].sizeFt).toBe(40);
    expect(render).not.toHaveBeenCalled();
  });

  it("still rebuilds the panel on a shape change", () => {
    const { host, shapeSelect } = renderPreviewWithOneAoe();
    const render = vi.spyOn(host, "render").mockImplementation(() => {});

    shapeSelect.value = "cone";
    shapeSelect.dispatchEvent(new Event("change"));

    expect(render).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `make test`
Expected: FAIL — the size edit calls `render`

- [ ] **Step 3: Implement**

Replace the dead field with a registry the two hosts write into:

```ts
  private overlayRepaints = new Set<() => void>();

  registerOverlayRepaint(repaint: () => void): () => void {
    this.overlayRepaints.add(repaint);
    return () => this.overlayRepaints.delete(repaint);
  }

  // Size and width edits move the rotation handle, so an in-place repaint has
  // to reposition the DOM markers as well as repaint the canvas.
  repaintOverlays() {
    for (const repaint of this.overlayRepaints) repaint();
  }
```

In `renderPanPreview`, register a closure that calls `redrawAoes()` and every marker's positioner; keep the returned disposer and call it at the top of the next `renderPanPreview` and from `disconnectPreviewObserver()`. `MapExploreModal` registers its `redraw` plus `renderMarkers` and disposes on close.

In `renderAoeRow`, the `sizeInput` and `widthInput` `change` handlers and both `opacityInput` handlers call `this.repaintOverlays()` instead of `onChange()`. The `shapeSelect`, `colorSwatch`, `rotInput` and `removeBtn` handlers keep `onChange()`.

- [ ] **Step 4: Run and watch it pass**

Run: `make test`
Expected: PASS

- [ ] **Step 5: Update the spec**

`aoe-overlays.md` requirement 8: name `repaintOverlays()` as the in-place path and state that it repaints the overlay canvas and repositions the markers, that size, width and opacity edits use it, and that both the DM preview and the Exploration modal register into it.

Check requirement 7's "Source files" block still matches, and fix any sentence that no longer holds — `AGENTS.md` requires pre-existing drift to be corrected in the same commit.

- [ ] **Step 6: Commit**

```bash
make typecheck && make test
git add src/views/MapScreenPanel.ts src/views/MapExploreModal.ts \
        src/__tests__/map-screen-panel-aoe.test.ts .agent/features/map-screen/aoe-overlays.md
git commit -m "fix(dm-preview): repaint AoE overlays in place on size and opacity edits"
```

---

## Task 7: Phase 1 verification and PR

**Goal:** Phase 1 is proven green and opened as a PR.

**Files:** none

**Acceptance Criteria:**
- [ ] `make typecheck`, `make test` and `make build` all pass
- [ ] `grep '"version"' manifest.json` shows a stable version with no `-beta.N`
- [ ] The PR is open against `main` with the `release:minor` label

**Verify:** `gh pr checks` → all six required checks pass

**Steps:**

- [ ] **Step 1: Full local gate**

```bash
make typecheck && make test && make build
```
Expected: all three exit 0

- [ ] **Step 2: Pre-push manifest check**

```bash
grep '"version"' manifest.json
```
Expected: a bare stable version. If it carries `-beta.N`, bump the three version files to the latest stable tag first — `git ls-remote --tags origin | grep -oE 'refs/tags/v?[0-9]+\.[0-9]+\.[0-9]+$' | sed 's|.*/||; s|^v||' | sort -V | tail -1` — and commit that as `chore(repo): bump version files to X.Y.Z`.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin fix/dm-preview-stability
gh pr create --base main \
  --title "fix(dm-preview): keep AoE drags and the pan preview stable" \
  --label release:minor \
  --body "..."
```

The body states the two defects, their mechanisms, and the one deliberate behaviour change (the 3 px threshold).

- [ ] **Step 4: Report to the user**

**User Verification Required:**
Before marking this task complete, you MUST call AskUserQuestion:
```yaml
AskUserQuestion:
  question: "Phase 1 is green and the PR is open. Proceed to Phase 2 (extract MapStage, remove per-event canvas allocation, downscaled preview thumbnail)?"
  header: "Verification"
  options:
    - label: "Proceed to Phase 2"
      description: "Phase 1 accepted; start the extraction"
    - label: "Rework Phase 1"
      description: "Something is wrong or missing; fix before moving on"
```

**If the user selects rework:** the task is NOT complete. Fix, then re-verify.

```json:metadata
{"files": [], "verifyCommand": "make typecheck && make test && make build", "acceptanceCriteria": ["six CI checks pass", "PR open with release:minor"], "requiresUserVerification": true, "userVerificationPrompt": "Phase 1 is green and the PR is open. Proceed to Phase 2?"}
```

---

# PHASE 2 — Extraction and panel fluidity

Branch: `refactor/map-stage`. PR title: `refactor(dm-preview): extract the shared map stage`. Bump label: none (patch).

Phase 2 starts only after Phase 1's PR is merged, so it branches from the updated `main`.

## Task 8: Extract `MapStage`

**Goal:** One module owns preview geometry; all three previews consume it.

**Files:**
- Create: `src/views/mapStage.ts`
- Create: `src/__tests__/map-stage.test.ts`
- Modify: `src/views/MapScreenPanel.ts`, `src/views/MapExploreModal.ts`, `src/views/MapFogModal.ts`
- Modify: `.agent/features/map-screen/overview.md`, `scale-and-grid.md`, `fog-of-war.md` (source-file blocks)

**Acceptance Criteria:**
- [ ] `MapStage` exposes: size against a container, observe resize, `effectiveScale(): number | null`, `screenToMap`, `deltaToMap`, `applyTransform`, `scheduleRepaint`, `dispose`
- [ ] It references no AoE, vision, fog or WebSocket type
- [ ] All three previews use it; no copy of the conversion maths remains
- [ ] `scheduleRepaint()` coalesces multiple calls within one frame into a single repaint
- [ ] Measurement happens once per frame, before style writes

**Verify:** `make test` → `map-stage.test.ts` passes and the existing preview suites still pass

**Steps:** to be expanded at the start of Phase 2 against the then-current `main`, since Phase 1's tasks reshape the call sites this module absorbs. The interface above and the acceptance criteria are fixed now and do not change.

---

## Task 9: Stop reallocating canvases per mouse event

**Goal:** Canvas backing stores are reallocated only when their dimensions actually change, and repaints run once per frame.

**Files:**
- Modify: `src/views/MapScreenPanel.ts` (`redrawAoes`), `src/views/MapExploreModal.ts` (`redraw`), `src/views/mapStage.ts`

**Acceptance Criteria:**
- [ ] `canvas.width` / `canvas.height` are assigned only when the computed value differs from the current one
- [ ] A drag generating ten `mousemove` events within one frame produces one repaint
- [ ] No `getBoundingClientRect` or `clientWidth` read happens after a style write within the same frame

**Verify:** `make test` → a repaint-coalescing unit test passes

---

## Task 10: Downscaled preview thumbnail

**Goal:** The full-resolution map is decoded once for the TV, never for the three previews.

**Files:**
- Modify: `src/views/MapScreenPanel.ts` — thumbnail cache keyed by map URL
- Modify: `src/views/MapExploreModal.ts`, `src/views/MapFogModal.ts` — consume it
- Modify: `.agent/features/map-screen/scale-and-grid.md`

**Acceptance Criteria:**
- [ ] One thumbnail per map URL, longest side capped at 2048, published as an object URL
- [ ] The object URL is revoked on map change, on `stopMap`, and on panel close
- [ ] Videos keep the original source
- [ ] The map client at `/map` is unchanged and still receives the original
- [ ] A map whose longest side is already below 2048 is used directly, with no re-encode

**Verify:** `make test` → thumbnail lifecycle test passes; `make test-visual` reviewed and baselines refreshed with `make test-visual-update` **inside the container** if they move

---

## Task 11: Phase 2 verification and PR

Same shape as Task 7.

**User Verification Required:**
Before marking this task complete, you MUST call AskUserQuestion:
```yaml
AskUserQuestion:
  question: "Phase 2 is green and the PR is open. Proceed to Phase 3 (instrument the map client on the real TV, then fix grid canvas reallocation and the O(n^2) line-of-sight)?"
  header: "Verification"
  options:
    - label: "Proceed to Phase 3"
      description: "Phase 2 accepted; start the TV work"
    - label: "Rework Phase 2"
      description: "Something is wrong or missing; fix before moving on"
```

```json:metadata
{"files": [], "verifyCommand": "make typecheck && make test && make build", "acceptanceCriteria": ["six CI checks pass"], "requiresUserVerification": true, "userVerificationPrompt": "Phase 2 is green and the PR is open. Proceed to Phase 3?"}
```

---

# PHASE 3 — Map client fluidity

Branch: `fix/map-client-repaint`. PR title: `fix(map-screen): stop rebuilding the grid canvas every frame`.

Phase 3 **measures before it patches.** Two fixes are certain; the third depends on the measurement.

## Task 12: Instrument the map client

**Goal:** Real numbers from the real TV for `applyLayout` and `recompositeFog`.

**Files:**
- Modify: `src/map/map.ts`

**Acceptance Criteria:**
- [ ] `applyLayout` and `recompositeFog` log elapsed milliseconds, wall count and vision count — summarised, never per-frame payloads
- [ ] Logging uses `console.*` directly, which is the documented exception for the browser bundles
- [ ] Measurements are taken on the actual table TV, with and without a view-bound vision, while dragging the pan

**Verify:** the user opens `/map` on the TV, drags the pan, and reports the logged timings

**User Verification Required:**
Before marking this task complete, you MUST call AskUserQuestion:
```yaml
AskUserQuestion:
  question: "With the map open on the TV and the pan being dragged, what does recompositeFog report?"
  header: "Verification"
  options:
    - label: "Under 16 ms"
      description: "Coalescing per frame is enough; no observable behaviour changes"
    - label: "Over 16 ms"
      description: "Take the trailing-timer path; line-of-sight resolves after the drag"
```

```json:metadata
{"files": ["src/map/map.ts"], "verifyCommand": "", "acceptanceCriteria": ["timings captured on the real TV"], "requiresUserVerification": true, "userVerificationPrompt": "With the map open on the TV and the pan being dragged, what does recompositeFog report?"}
```

## Task 13: Guard the grid canvas and coalesce `applyLayout`

**Goal:** The grid canvas is resized only when the viewport changes, and layout runs once per frame.

**Files:**
- Modify: `src/map/map.ts` — `applyLayout`
- Modify: `.agent/features/map-screen/scale-and-grid.md` requirement 10

**Acceptance Criteria:**
- [ ] `canvas.width` / `canvas.height` are assigned only on change, mirroring the guard `recompositeFog` already has
- [ ] `applyLayout` is coalesced to one call per animation frame
- [ ] A burst of `map-view` and `map-aoe-sync` messages within one frame produces one layout
- [ ] Nothing observable changes

**Verify:** `make test` → map client coalescing test passes

## Task 14: Line-of-sight cost

**Goal:** A pan drag with a view-bound vision stays fluid on the TV.

**Files:**
- Modify: `src/map/map.ts`
- Modify: `.agent/features/map-screen/fog-of-war.md` requirements 10 and 11 — **only if** the trailing-timer path is taken

**Acceptance Criteria (coalescing path, chosen when Task 12 reports under 16 ms):**
- [ ] `recompositeFog` is coalesced to one call per animation frame
- [ ] No specification requirement changes

**Acceptance Criteria (trailing-timer path, chosen when Task 12 reports over 16 ms):**
- [ ] During a drag, `recompositeFog` uses plain `eraseVision` with no `visibilityPolygon`
- [ ] A trailing timer about 150 ms after the last `map-vision` recomposites with `eraseVisionWithWalls`
- [ ] The timer is cleared on `map-clear`
- [ ] `fog-of-war.md` requirements 10 and 11 state the two-stage behaviour and that light may briefly cross a wall mid-drag

**Verify:** `make test` → the chosen path's test passes; confirmed by eye on the TV

## Task 15: Phase 3 verification and PR

Same shape as Task 7.

**User Verification Required:**
```yaml
AskUserQuestion:
  question: "Phase 3 is green and the PR is open. Is the battlemap preview now behaving at the table?"
  header: "Verification"
  options:
    - label: "Yes, done"
      description: "All three phases accepted; close the work"
    - label: "Still a problem"
      description: "Describe what still misbehaves; reopen"
```

```json:metadata
{"files": [], "verifyCommand": "make typecheck && make test && make build", "acceptanceCriteria": ["six CI checks pass"], "requiresUserVerification": true, "userVerificationPrompt": "Is the battlemap preview now behaving at the table?"}
```
