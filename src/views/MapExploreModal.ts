import { App, Modal, Notice, setIcon } from "obsidian";
import type DmScreenPlugin from "../main";
import type { MapScreenPanel, ActiveMap } from "./MapScreenPanel";
import { fogCanvasSize } from "../map/fog";
import { buildBlockedMask, floodRegion, regionToCanvas } from "../map/walls";
import { vaultPathFromUrl } from "../server";
import { resolveSourceLabel } from "../sourceLabel";
import type { MapRotation, MapWall } from "../map/types";
import { renderAoe } from "../map/aoe";
import { anchorToView, DEFAULT_VISION_COLOR, moveVisions, visionDragTargets } from "../map/vision";
import { gridLinePositions, rotatePoint } from "../map/transform";
import { debug } from "../debug";
import { fitScale } from "./mapStage";
import { createRepaintScheduler } from "../map/canvas";
import { FloatingWindow, type WindowState } from "./FloatingWindow";

// Table-play surface. Left-click alternates the two exploration gestures —
// toggle a door, reveal/cover a room — while the DM's view keeps the map's
// configured rotation. On top of that, the DM can drag the players' viewport
// rectangle (physical mode), and move the AoE and vision markers configured in
// the panel. Doors are ALWAYS room boundaries here (regardless of open/closed),
// so a room stays discrete even with an open door; open/closed only affects LoS
// on the player screen via the map-walls broadcast.
export class MapExploreModal extends Modal {
  private fogCanvas: HTMLCanvasElement;
  private redrawOverlay: (() => void) | null = null;
  private renderMarkers: (() => void) | null = null;
  private cleanupListeners: (() => void) | null = null;
  // Force-detaches an in-progress document drag if the modal closes mid-gesture.
  private activeDrag: (() => void) | null = null;
  private walls: MapWall[] = [];
  private hoverCell: { x: number; y: number } | null = null;
  private blockedCache: { walls: MapWall[]; fogScale: number; mask: Uint8Array } | null = null;
  private hoverRegion: { cellX: number; cellY: number; region: Uint8Array | null } | null = null;
  private aoesWindow: FloatingWindow | null = null;
  private visionWindow: FloatingWindow | null = null;
  private combatWindow: FloatingWindow | null = null;
  private disposeCombatMirror: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    app: App,
    private plugin: DmScreenPlugin,
    private panel: MapScreenPanel,
    private map: ActiveMap
  ) {
    super(app);
    this.fogCanvas = this.buildFogCanvas();
  }

  private buildFogCanvas(): HTMLCanvasElement {
    const { width, height } = fogCanvasSize(this.map.naturalWidth, this.map.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const existing = this.panel.fogDataUrl;
    if (existing) {
      const img = new Image();
      img.onload = () => {
        canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
        this.redrawOverlay?.();
      };
      img.src = existing;
    }
    return canvas;
  }

  private ctx(): CanvasRenderingContext2D {
    return this.fogCanvas.getContext("2d")!;
  }

  private commitFog() {
    void this.panel.commitFog(this.fogCanvas.toDataURL("image/png"));
  }

  onOpen() {
    this.walls = [...this.panel.walls];
    this.modalEl.addClass("dm-explore-modal");
    const { contentEl } = this;
    contentEl.addClass("dm-explore-content");

    const nw = this.map.naturalWidth;
    const nh = this.map.naturalHeight;
    const rotation = (this.panel.state.rotation ?? 0) as MapRotation;
    const invRotation = ((360 - rotation) % 360) as MapRotation;
    const sideways = rotation % 180 !== 0;
    const fogScale = this.fogCanvas.width / nw;
    const doorRadius = Math.max(10, this.panel.state.pxPerSquare * fogScale * 0.35);

    const bar = contentEl.createDiv("dm-explore-bar");
    const savedLabel = this.plugin.settings.lastSourceLabels?.map;
    const sourceLabel = savedLabel || resolveSourceLabel({ url: this.map.url, plugin: this.plugin });
    const labelEl = bar.createEl("span", { cls: "dm-source-label dm-explore-title" });
    labelEl.textContent = sourceLabel.label;
    labelEl.title = sourceLabel.title;
    const revealAll = bar.createEl("button", { text: "Reveal All" });
    const coverAll = bar.createEl("button", { text: "Cover All", cls: "mod-warning" });
    const lockBtn = bar.createEl("button", { cls: "dm-explore-lock-btn" });
    const syncLockIcon = () => {
      setIcon(lockBtn, this.panel.viewLocked ? "lock" : "unlock");
      lockBtn.title = this.panel.viewLocked
        ? "View locked — the players' viewport can't be moved. Click to unlock."
        : "Lock the players' view so it can't be dragged by accident";
      lockBtn.toggleClass("dm-fog-active", this.panel.viewLocked);
    };
    syncLockIcon();
    lockBtn.addEventListener("click", () => {
      this.panel.viewLocked = !this.panel.viewLocked;
      syncLockIcon();
      this.renderMarkers?.();
    });
    const scaleBtn = bar.createEl("button");
    const gridBtn = bar.createEl("button");
    const syncToggleLabels = () => {
      scaleBtn.textContent = this.panel.state.mode === "physical" ? "Scale: physical 1″" : "Scale: fit screen";
      gridBtn.textContent = this.panel.state.showGrid ? "Grid: on" : "Grid: off";
    };
    syncToggleLabels();
    const exitBtn = bar.createEl("button", { text: "Exit" });

    const body = contentEl.createDiv("dm-explore-body");
    const stage = body.createDiv("dm-explore-stage");
    // The inner box carries the map's exact aspect and rotates to the TV
    // orientation; the overlay and markers are its children so they rotate
    // solidly with the map. Client↔fog/map conversions un-rotate through
    // invRotation and read the inner overlay's own rect (robust under rotation,
    // and layout-free in tests where the rect is stubbed).
    const inner = stage.createDiv("dm-explore-inner");

    const vaultPath = vaultPathFromUrl(this.map.url);
    const adapter = this.plugin.app.vault.adapter as { getResourcePath?: (p: string) => string };
    const resourceUrl = vaultPath ? adapter.getResourcePath?.(vaultPath) : null;
    if (resourceUrl) {
      if (this.map.mediaType === "video") {
        const v = inner.createEl("video");
        v.src = resourceUrl;
        v.muted = true;
        v.loop = true;
        v.autoplay = true;
        v.playsInline = true;
        v.play().catch(() => {});
      } else {
        const img = inner.createEl("img");
        img.src = this.panel.previewMediaSrc(this.map, resourceUrl);
        img.alt = "";
      }
    } else {
      debug("MapExploreModal: no resource path for", this.map.url);
    }

    const overlay = inner.createEl("canvas", { cls: "dm-explore-overlay" });
    overlay.width = this.fogCanvas.width;
    overlay.height = this.fogCanvas.height;
    const octx = overlay.getContext("2d")!;
    // Markers layer sits on top but passes clicks through to the overlay; only
    // the dots and the viewport rect (pointer-events: auto) capture drags.
    const markers = inner.createDiv("dm-explore-markers");

    const layout = () => {
      const rotW = sideways ? nh : nw;
      const rotH = sideways ? nw : nh;
      const s = fitScale(stage.clientWidth, stage.clientHeight, rotW, rotH);
      if (s === null) return;
      inner.style.width = `${nw * s}px`;
      inner.style.height = `${nh * s}px`;
      inner.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
    };
    layout();
    requestAnimationFrame(layout);

    const paint = () => {
      octx.clearRect(0, 0, overlay.width, overlay.height);

      octx.globalAlpha = 0.5;
      octx.drawImage(this.fogCanvas, 0, 0);
      octx.globalAlpha = 1;

      if (this.hoverCell) {
        const region = this.hoverRegionFor(this.hoverCell.x, this.hoverCell.y, fogScale);
        if (region) {
          const hc = regionToCanvas(region, this.fogCanvas.width, this.fogCanvas.height);
          const hctx = hc.getContext("2d")!;
          hctx.globalCompositeOperation = "source-in";
          hctx.fillStyle = "rgba(123,216,143,0.25)";
          hctx.fillRect(0, 0, hc.width, hc.height);
          octx.drawImage(hc, 0, 0);
        }
      }

      if (this.panel.state.showGrid) {
        octx.save();
        octx.globalAlpha = this.panel.state.gridOpacity;
        octx.strokeStyle = this.panel.state.gridColor;
        octx.lineWidth = 1;
        octx.beginPath();
        const { gridOffsetX, gridOffsetY, pxPerSquare } = this.panel.state;
        for (const x of gridLinePositions(0, gridOffsetX, pxPerSquare, fogScale, overlay.width)) {
          octx.moveTo(x, 0);
          octx.lineTo(x, overlay.height);
        }
        for (const y of gridLinePositions(0, gridOffsetY, pxPerSquare, fogScale, overlay.height)) {
          octx.moveTo(0, y);
          octx.lineTo(overlay.width, y);
        }
        octx.stroke();
        octx.restore();
      }

      // AoE footprints at fog scale (mapRotation 0 — the inner box already
      // carries the view rotation via CSS transform).
      for (const aoe of this.panel.aoes) {
        renderAoe(octx, aoe, fogScale, 0, 0, this.panel.state.pxPerSquare, 0);
      }

      // Vision range outlines.
      octx.save();
      octx.lineWidth = 2;
      const ftToPxScaled = (this.panel.state.pxPerSquare / 5) * fogScale;
      for (const v of this.panel.visions) {
        const color = v.color ?? DEFAULT_VISION_COLOR;
        octx.strokeStyle = color;
        octx.setLineDash([6, 4]);
        const brightR = v.sizeFt * ftToPxScaled;
        octx.beginPath();
        if (v.shape === "circle") {
          octx.arc(v.x * fogScale, v.y * fogScale, brightR, 0, Math.PI * 2);
        } else {
          octx.rect(v.x * fogScale - brightR, v.y * fogScale - brightR, brightR * 2, brightR * 2);
        }
        octx.stroke();

        if (v.dimFt > 0) {
          const dimR = (v.sizeFt + v.dimFt) * ftToPxScaled;
          octx.strokeStyle = `${color}88`;
          octx.setLineDash([3, 3]);
          octx.beginPath();
          if (v.shape === "circle") {
            octx.arc(v.x * fogScale, v.y * fogScale, dimR, 0, Math.PI * 2);
          } else {
            octx.rect(v.x * fogScale - dimR, v.y * fogScale - dimR, dimR * 2, dimR * 2);
          }
          octx.stroke();
        }
      }
      octx.restore();

      // Faint walls so room boundaries are legible.
      octx.save();
      octx.globalAlpha = 0.35;
      octx.lineWidth = 2;
      for (const w of this.walls) {
        octx.strokeStyle = w.door ? "#44aaff" : "#f5d90a";
        octx.beginPath();
        octx.moveTo(w.x1 * fogScale, w.y1 * fogScale);
        octx.lineTo(w.x2 * fogScale, w.y2 * fogScale);
        octx.stroke();
      }
      octx.restore();

      // Big, obvious door markers: green when open, grey when closed.
      for (const w of this.walls) {
        if (!w.door) continue;
        const mx = ((w.x1 + w.x2) / 2) * fogScale;
        const my = ((w.y1 + w.y2) / 2) * fogScale;
        octx.save();
        octx.fillStyle = w.open ? "#7bd88f" : "#888888";
        octx.strokeStyle = "rgba(0,0,0,0.6)";
        octx.lineWidth = 2;
        octx.beginPath();
        octx.arc(mx, my, doorRadius, 0, Math.PI * 2);
        octx.fill();
        octx.stroke();
        octx.restore();
      }
    };
    // The repaint walks the fog image, every AoE, vision, wall and door. Hover
    // and marker drags fire it per pointer move, so it is coalesced per frame.
    const painter = createRepaintScheduler(paint);
    const redraw = painter.schedule;
    this.cancelOverlayRepaint = painter.cancel;
    this.redrawOverlay = redraw;
    paint();

    // Overlay geometry, read fresh so it survives layout/rotation changes. The
    // rotated overlay's AABB preserves its centre; its unrotated client size is
    // the AABB dims swapped back when the view is sideways.
    const overlayGeom = () => {
      const b = overlay.getBoundingClientRect();
      return {
        cx: b.left + b.width / 2,
        cy: b.top + b.height / 2,
        uw: sideways ? b.height : b.width,
        uh: sideways ? b.width : b.height,
      };
    };
    const toFog = (clientX: number, clientY: number) => {
      const { cx, cy, uw, uh } = overlayGeom();
      const r = rotatePoint(clientX - cx, clientY - cy, invRotation);
      return {
        x: (r.x / uw + 0.5) * this.fogCanvas.width,
        y: (r.y / uh + 0.5) * this.fogCanvas.height,
      };
    };
    // An overlay that cannot be measured (the modal closing under a live drag)
    // would divide by zero and clamp every marker to the map edge, so the
    // conversion refuses instead of returning a non-finite point.
    const deltaToMap = (dx: number, dy: number): { x: number; y: number } | null => {
      const { uw, uh } = overlayGeom();
      if (!(uw > 0) || !(uh > 0)) return null;
      const r = rotatePoint(dx, dy, invRotation);
      return { x: (r.x / uw) * nw, y: (r.y / uh) * nh };
    };

    const renderMarkers = () => {
      markers.empty();
      this.buildAoeMarkers(markers, nw, nh, rotation, overlayGeom, deltaToMap, redraw);
      this.buildVisionMarkers(markers, nw, nh, deltaToMap, redraw);
      this.buildViewportRect(markers, nw, nh, deltaToMap, redraw);
    };
    this.renderMarkers = renderMarkers;
    this.disposeOverlayRepaint = this.panel.registerOverlayRepaint(() => {
      renderMarkers();
      redraw();
    });

    const refresh = () => {
      renderWindows();
      renderMarkers();
      redraw();
    };

    const defaultAoesState: WindowState = this.plugin.settings.exploreWindows?.["aoes"] || {
      x: 1 - (260 + 260 + 12 + 12) / stage.clientWidth,
      y: 12 / stage.clientHeight,
      minimized: false,
    };
    const defaultVisionState: WindowState = this.plugin.settings.exploreWindows?.["vision"] || {
      x: 1 - (260 + 12) / stage.clientWidth,
      y: 12 / stage.clientHeight,
      minimized: false,
    };

    this.aoesWindow = new FloatingWindow(stage, {
      id: "aoes",
      title: "AoEs",
      initial: defaultAoesState,
      onChange: (state) => {
        this.plugin.settings.exploreWindows["aoes"] = state;
        void this.plugin.saveSettings();
      },
    });

    this.visionWindow = new FloatingWindow(stage, {
      id: "vision",
      title: "Vision",
      initial: defaultVisionState,
      onChange: (state) => {
        this.plugin.settings.exploreWindows["vision"] = state;
        void this.plugin.saveSettings();
      },
    });

    this.combatWindow = new FloatingWindow(stage, {
      id: "combat",
      title: "Combat",
      width: 320,
      initial: this.plugin.settings.exploreWindows?.["combat"] || {
        x: 12 / stage.clientWidth,
        y: 12 / stage.clientHeight,
        minimized: false,
      },
      onChange: (state) => {
        this.plugin.settings.exploreWindows["combat"] = state;
        void this.plugin.saveSettings();
      },
    });
    this.disposeCombatMirror = this.panel.registerCombatMirror(this.combatWindow);

    const renderWindows = () => {
      this.aoesWindow!.body.empty();
      this.visionWindow!.body.empty();
      this.panel.renderAoeSection(this.aoesWindow!.body, this.map, refresh);
      this.panel.renderVisionSection(this.visionWindow!.body, this.map, refresh);
    };

    renderWindows();
    renderMarkers();

    this.resizeObserver = new ResizeObserver(() => {
      this.aoesWindow?.clamp();
      this.visionWindow?.clamp();
      this.combatWindow?.clamp();
    });
    this.resizeObserver.observe(stage);

    revealAll.addEventListener("click", () => {
      this.ctx().clearRect(0, 0, this.fogCanvas.width, this.fogCanvas.height);
      redraw();
      this.commitFog();
    });
    coverAll.addEventListener("click", () => {
      const ctx = this.ctx();
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, this.fogCanvas.width, this.fogCanvas.height);
      redraw();
      this.commitFog();
    });
    scaleBtn.addEventListener("click", () => {
      this.panel.toggleScaleMode();
      syncToggleLabels();
      refresh();
    });
    gridBtn.addEventListener("click", () => {
      this.panel.toggleGrid();
      syncToggleLabels();
      redraw();
    });
    exitBtn.addEventListener("click", () => this.close());

    const nearestDoor = (fx: number, fy: number): MapWall | null => {
      const mx = fx / fogScale;
      const my = fy / fogScale;
      const hitRadius = (doorRadius + 6) / fogScale;
      let nearest: MapWall | null = null;
      let nearestDist = Infinity;
      for (const w of this.walls) {
        if (!w.door) continue;
        const cx = (w.x1 + w.x2) / 2;
        const cy = (w.y1 + w.y2) / 2;
        const d = Math.hypot(mx - cx, my - cy);
        if (d < hitRadius && d < nearestDist) {
          nearestDist = d;
          nearest = w;
        }
      }
      return nearest;
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const { x: fx, y: fy } = toFog(e.clientX, e.clientY);

      const door = nearestDoor(fx, fy);
      if (door) {
        const toggled = door;
        this.walls = this.walls.map((w) => (w === toggled ? { ...w, open: !w.open } : w));
        this.hoverRegion = null;
        void this.panel.commitWalls([...this.walls]);
        redraw();
        return;
      }

      const region = this.hoverRegionFor(Math.floor(fx), Math.floor(fy), fogScale);
      if (!region) {
        new Notice("That point is inside a wall");
        return;
      }
      const revealed = this.ctx().getImageData(Math.floor(fx), Math.floor(fy), 1, 1).data[3] < 128;
      const rc = regionToCanvas(region, this.fogCanvas.width, this.fogCanvas.height);
      const ctx = this.ctx();
      ctx.globalCompositeOperation = revealed ? "source-over" : "destination-out";
      ctx.drawImage(rc, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      redraw();
      this.commitFog();
    };

    const onMove = (e: MouseEvent) => {
      const { x: fx, y: fy } = toFog(e.clientX, e.clientY);
      const cx = Math.floor(fx);
      const cy = Math.floor(fy);
      if (this.hoverCell && this.hoverCell.x === cx && this.hoverCell.y === cy) return;
      this.hoverCell = { x: cx, y: cy };
      redraw();
    };

    const onLeave = () => {
      if (!this.hoverCell) return;
      this.hoverCell = null;
      this.hoverRegion = null;
      redraw();
    };

    overlay.addEventListener("mousedown", onDown);
    overlay.addEventListener("mousemove", onMove);
    overlay.addEventListener("mouseleave", onLeave);

    // Hold Shift to focus exploration: the markers layer goes pointer-transparent
    // so clicks fall straight through to the overlay's door/room gestures — even
    // over the viewport rect and AoE/vision dots — without locking the view.
    // Released the instant Shift is up; blur resets it (Shift held during alt-tab).
    const setFocus = (on: boolean) => markers.toggleClass("dm-explore-focus", on);
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Shift") setFocus(true); };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === "Shift") setFocus(false); };
    const onBlur = () => setFocus(false);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    this.cleanupListeners = () => {
      overlay.removeEventListener("mousedown", onDown);
      overlay.removeEventListener("mousemove", onMove);
      overlay.removeEventListener("mouseleave", onLeave);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }

  // Draggable AoE anchor dots (+ rotation handle for non-symmetric shapes);
  // right-click removes. Mirrors the panel pan-preview markers.
  private buildAoeMarkers(
    layer: HTMLElement,
    nw: number,
    nh: number,
    rotation: MapRotation,
    overlayGeom: () => { cx: number; cy: number; uw: number; uh: number },
    deltaToMap: (dx: number, dy: number) => { x: number; y: number } | null,
    redraw: () => void
  ) {
    const ftToPx = this.panel.state.pxPerSquare / 5;
    for (const aoe of this.panel.aoes) {
      const dot = layer.createDiv("dm-map-aoe-dot");
      dot.style.background = aoe.color;
      dot.title = `${aoe.label ?? aoe.shape} ${aoe.sizeFt}ft — drag to move, right-click to remove`;
      const handle =
        aoe.shape === "circle" || aoe.shape === "ring" ? null : layer.createDiv("dm-map-aoe-rot-handle");
      if (handle) {
        handle.style.background = aoe.color;
        handle.title = "Drag to rotate";
      }
      const handleDistPx = () => (aoe.shape === "square" ? aoe.sizeFt / 2 : aoe.sizeFt) * ftToPx;
      const position = () => {
        dot.style.left = `${(aoe.x / nw) * 100}%`;
        dot.style.top = `${(aoe.y / nh) * 100}%`;
        if (handle) {
          const rad = (aoe.rotation * Math.PI) / 180;
          const hx = aoe.x + Math.cos(rad) * handleDistPx();
          const hy = aoe.y + Math.sin(rad) * handleDistPx();
          handle.style.left = `${(hx / nw) * 100}%`;
          handle.style.top = `${(hy / nh) * 100}%`;
        }
      };
      position();

      dot.addEventListener("contextmenu", (ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.panel.removeAoe(aoe.id);
        this.renderMarkers?.();
        redraw();
      });

      dot.addEventListener("mousedown", (ev: MouseEvent) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        const startX = ev.clientX;
        const startY = ev.clientY;
        const startAoeX = aoe.x;
        const startAoeY = aoe.y;
        this.beginDrag(
          (me) => {
            const d = deltaToMap(me.clientX - startX, me.clientY - startY);
            if (!d) return;
            aoe.x = Math.max(0, Math.min(nw, startAoeX + d.x));
            aoe.y = Math.max(0, Math.min(nh, startAoeY + d.y));
            position();
            redraw();
            this.panel.broadcastAoes();
          },
          () => this.panel.broadcastAoes(true)
        );
      });

      handle?.addEventListener("mousedown", (ev: MouseEvent) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.beginDrag(
          (me) => {
            const { cx, cy, uw } = overlayGeom();
            if (!(uw > 0)) return;
            const s = uw / nw;
            const r = rotatePoint(aoe.x - nw / 2, aoe.y - nh / 2, rotation);
            const centerX = cx + r.x * s;
            const centerY = cy + r.y * s;
            const deg = (Math.atan2(me.clientY - centerY, me.clientX - centerX) * 180) / Math.PI - rotation;
            aoe.rotation = (((Math.round(deg / 5) * 5) % 360) + 360) % 360;
            position();
            redraw();
            this.panel.broadcastAoes();
          },
          () => this.panel.broadcastAoes(true)
        );
      });
    }
  }

  // Draggable dots for the visions configured in the panel (move-only).
  private buildVisionMarkers(
    layer: HTMLElement,
    nw: number,
    nh: number,
    deltaToMap: (dx: number, dy: number) => { x: number; y: number } | null,
    redraw: () => void
  ) {
    const positions: Array<() => void> = [];
    for (const vision of this.panel.visions) {
      const dot = layer.createDiv("dm-map-vision-dot");
      dot.title = `${vision.label ?? vision.shape} ${vision.sizeFt}ft vision — drag to move`;
      dot.style.background = vision.color ?? DEFAULT_VISION_COLOR;
      const position = () => {
        dot.style.left = `${(vision.x / nw) * 100}%`;
        dot.style.top = `${(vision.y / nh) * 100}%`;
      };
      position();
      positions.push(position);
      dot.addEventListener("mousedown", (ev: MouseEvent) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        const startX = ev.clientX;
        const startY = ev.clientY;
        const targets = visionDragTargets(this.panel.visions, vision, this.panel.visionGroup);
        const starts = targets.map((v) => ({ x: v.x, y: v.y }));
        this.beginDrag(
          (me) => {
            const d = deltaToMap(me.clientX - startX, me.clientY - startY);
            if (!d) return;
            moveVisions(targets, starts, d.x, d.y, nw, nh);
            for (const v of targets) if (v.followsView) anchorToView(v, this.panel.state.panX, this.panel.state.panY);
            for (const reposition of positions) reposition();
            redraw();
            this.panel.broadcastVisions();
          },
          () => this.panel.broadcastVisions(true)
        );
      });
    }
  }

  // Draggable players'-viewport rectangle (physical mode only) — repositions
  // the visible window on the table TV without touching the DM's own rotated
  // view. While the view is locked the rect is inert (dashed, no pointer). A
  // vision bound to the view (followsView) is dragged along by applyExplorePan,
  // so redraw + re-place the vision dots on every step.
  private buildViewportRect(
    layer: HTMLElement,
    nw: number,
    nh: number,
    deltaToMap: (dx: number, dy: number) => { x: number; y: number } | null,
    redraw: () => void
  ) {
    if (this.panel.state.mode !== "physical") return;
    const vis = this.panel.playerViewportMapSize();
    if (!vis) return;

    const rect = layer.createDiv("dm-map-viewport-rect");
    rect.toggleClass("dm-explore-rect-locked", this.panel.viewLocked);
    const position = () => {
      rect.style.width = `${Math.min((vis.w / nw) * 100, 100)}%`;
      rect.style.height = `${Math.min((vis.h / nh) * 100, 100)}%`;
      rect.style.left = `${((this.panel.state.panX - vis.w / 2) / nw) * 100}%`;
      rect.style.top = `${((this.panel.state.panY - vis.h / 2) / nh) * 100}%`;
    };
    position();
    if (this.panel.viewLocked) return;

    const hasBoundVision = this.panel.visions.some((v) => v.followsView);
    rect.addEventListener("mousedown", (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const startX = ev.clientX;
      const startY = ev.clientY;
      const startPanX = this.panel.state.panX;
      const startPanY = this.panel.state.panY;
      const step = (me: MouseEvent, immediate: boolean) => {
        const d = deltaToMap(me.clientX - startX, me.clientY - startY);
        if (!d) return;
        this.panel.applyExplorePan(startPanX + d.x, startPanY + d.y, immediate);
        position();
        // A bound vision moved with the view — repaint its footprint (overlay)
        // and its dot (markers layer).
        if (hasBoundVision) {
          redraw();
          this.renderMarkers?.();
        }
      };
      this.beginDrag(
        (me) => step(me, false),
        (me) => step(me, true)
      );
    });
  }

  private disposeOverlayRepaint: (() => void) | null = null;
  private cancelOverlayRepaint: (() => void) | null = null;

  private beginDrag(onMove: (e: MouseEvent) => void, onUp?: (e: MouseEvent) => void) {
    // Tear down any prior drag whose mouseup was missed (e.g. released off-window)
    // so its document listeners can't outlive this one or the modal.
    this.activeDrag?.();
    const release = this.panel.beginPanelDrag();
    const move = (e: MouseEvent) => onMove(e);
    const up = (e: MouseEvent) => {
      cleanup();
      onUp?.(e);
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      release();
      this.activeDrag = null;
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    this.activeDrag = cleanup;
  }

  private blockedMask(fogScale: number): Uint8Array {
    const cached = this.blockedCache;
    if (cached && cached.walls === this.walls && cached.fogScale === fogScale) return cached.mask;
    const mask = buildBlockedMask(
      this.walls,
      this.fogCanvas.width,
      this.fogCanvas.height,
      fogScale,
      this.panel.state.pxPerSquare,
      () => true
    );
    this.blockedCache = { walls: this.walls, fogScale, mask };
    return mask;
  }

  private computeRegion(fx: number, fy: number, fogScale: number): Uint8Array | null {
    return floodRegion(this.blockedMask(fogScale), this.fogCanvas.width, this.fogCanvas.height, fx, fy);
  }

  private hoverRegionFor(cellX: number, cellY: number, fogScale: number): Uint8Array | null {
    const cached = this.hoverRegion;
    if (cached && cached.cellX === cellX && cached.cellY === cellY) return cached.region;
    const region = this.computeRegion(cellX, cellY, fogScale);
    this.hoverRegion = { cellX, cellY, region };
    return region;
  }

  onClose() {
    this.activeDrag?.();
    this.activeDrag = null;
    this.cleanupListeners?.();
    this.cleanupListeners = null;
    this.renderMarkers = null;
    this.hoverCell = null;
    this.hoverRegion = null;
    this.blockedCache = null;
    this.redrawOverlay = null;
    this.cancelOverlayRepaint?.();
    this.cancelOverlayRepaint = null;
    this.disposeOverlayRepaint?.();
    this.disposeOverlayRepaint = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.aoesWindow?.destroy();
    this.aoesWindow = null;
    this.visionWindow?.destroy();
    this.visionWindow = null;
    this.disposeCombatMirror?.();
    this.disposeCombatMirror = null;
    this.combatWindow?.destroy();
    this.combatWindow = null;
    this.panel.refreshPanel();
    this.contentEl.empty();
  }
}
