import { App, Modal, Notice } from "obsidian";
import { unzipSync } from "fflate/browser";
import type DmScreenPlugin from "../main";
import type { MapScreenPanel, ActiveMap } from "./MapScreenPanel";
import { fogCanvasSize, gridCellRectAt } from "../map/fog";
import { buildBlockedMask, floodRegion, regionToCanvas, rotateWalls, segmentCrossesBox, type WallImportResult } from "../map/walls";
import { blocksSight } from "../map/los";
import type { MapRotation, MapWall } from "../map/types";
import { parseUvttWalls } from "../map/uvtt";
import { collectFoundryScenes, sceneImportResult, type FoundryScene } from "../map/foundry";
import { debug } from "../debug";
import { blockWebkitGestures, onLongPress, trackTapOrDrag } from "./pointerDrag";
import { attachStageZoom, IDENTITY_VIEW, type StageView } from "./pinchZoom";

type FogTool = "brush" | "rect" | "cell" | "gridrect" | "room";
type FogMode = "reveal" | "cover";
type EditorMode = "fog" | "walls";
type WallsTool = "select" | "wall" | "door" | "erase" | "toggle" | "rect";

const SELECTION_COLOR = "#9ad4ff";

export class MapFogModal extends Modal {
  private tool: FogTool = "brush";
  private mode: FogMode = "reveal";
  private editorMode: EditorMode = "fog";
  private wallsTool: WallsTool = "wall";
  private wallsSnap = false;
  private brushPct = 5;
  private fogCanvas: HTMLCanvasElement;
  private redrawOverlay: (() => void) | null = null;
  private cleanupDrag: (() => void) | null = null;
  private cancelStageZoom: Array<() => void> = [];
  private cancelWebkitGestures: (() => void) | null = null;
  private cancelChainLongPress: (() => void) | null = null;
  // Painting fog with a finger needs the map bigger than the modal; the stage
  // carries the same pinch/wheel zoom as Exploration Mode.
  private stageView: StageView = { ...IDENTITY_VIEW };
  // local working copy; mutations call commitWalls
  private walls: MapWall[] = [];
  // chain anchor in natural map coords
  private chainAnchor: { x: number; y: number } | null = null;
  // cursor in natural map coords for preview segment
  private cursorNatural: { x: number; y: number } | null = null;
  // rect wall tool: natural-coord corner of in-progress drag
  private rectAnchor: { x: number; y: number } | null = null;
  // select tool: the walls under the DM's hand, by identity, so an edit that
  // rebuilds them re-registers the replacements
  private selection = new Set<MapWall>();
  // select tool: natural-coord corner of the marquee, and the live move offset
  private marqueeAnchor: { x: number; y: number } | null = null;
  private selectionDrag: { dx: number; dy: number } | null = null;
  private syncSelectionUi: (() => void) | null = null;
  // The raw parse of the last import, kept so its orientation can be changed
  // without picking the file again.
  private lastImport: { result: WallImportResult; label: string; rotation: MapRotation } | null = null;
  private cancelWallKeys: (() => void) | null = null;

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

  private commit() {
    void this.panel.commitFog(this.fogCanvas.toDataURL("image/png"));
  }

  onOpen() {
    this.walls = [...this.panel.walls];
    this.modalEl.addClass("dm-fog-modal");
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Fog of War" });

    // Tab row
    const tabRow = contentEl.createDiv("dm-fog-tabs");
    const fogTabBtn = tabRow.createEl("button", { text: "Fog" });
    const wallsTabBtn = tabRow.createEl("button", { text: "Walls" });
    const zoomBtn = tabRow.createEl("button", { cls: "dm-fog-zoom-btn" });
    const syncTabActive = () => {
      fogTabBtn.classList.toggle("dm-fog-active", this.editorMode === "fog");
      wallsTabBtn.classList.toggle("dm-fog-active", this.editorMode === "walls");
    };
    syncTabActive();

    const bar = contentEl.createDiv("dm-fog-toolbar");

    const stage = contentEl.createDiv("dm-fog-stage");
    stage.style.aspectRatio = `${this.map.naturalWidth} / ${this.map.naturalHeight}`;

    const inner = stage.createDiv("dm-fog-inner");

    const resourceUrl = this.plugin.transport.displayUrl(this.map.url);
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
      debug("MapFogModal: no resource path for", this.map.url);
    }

    const overlay = inner.createEl("canvas", { cls: "dm-fog-overlay" });
    overlay.width = this.fogCanvas.width;
    overlay.height = this.fogCanvas.height;

    const fogScale = this.fogCanvas.width / this.map.naturalWidth;

    const zoom = attachStageZoom({
      stage,
      zoomBtn,
      size: () => ({ width: stage.clientWidth, height: stage.clientHeight }),
      view: () => this.stageView,
      store: (view) => {
        this.stageView = view;
      },
      render: ({ zoom, offsetX, offsetY }) => {
        inner.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
      },
      // The finger that started painting is the first finger of a pinch, so
      // the stroke is abandoned rather than committed.
      onGestureStart: () => {
        this.cleanupDrag?.();
        this.cleanupDrag = null;
      },
    });
    zoom.apply();
    this.cancelStageZoom.push(zoom.cancel);
    // Safari would pinch-zoom the whole app on top of the stage's own gesture.
    this.cancelWebkitGestures = blockWebkitGestures(this.modalEl);


    const redraw = () => this.paintOverlay(overlay, fogScale);
    this.redrawOverlay = redraw;
    redraw();

    const renderFogToolbar = (barEl: HTMLElement) => {
      const modeBtns: Record<FogMode, HTMLButtonElement> = {} as never;
      const toolBtns: Record<FogTool, HTMLButtonElement> = {} as never;
      const syncActive = () => {
        for (const [m, b] of Object.entries(modeBtns)) b.classList.toggle("dm-fog-active", this.mode === (m as FogMode));
        for (const [t, b] of Object.entries(toolBtns)) b.classList.toggle("dm-fog-active", this.tool === (t as FogTool));
      };
      for (const m of ["reveal", "cover"] as FogMode[]) {
        modeBtns[m] = barEl.createEl("button", { text: m === "reveal" ? "Reveal" : "Cover" });
        modeBtns[m].addEventListener("click", () => { this.mode = m; syncActive(); });
      }
      barEl.createSpan({ text: "·", cls: "dm-status-detail" });
      const toolLabels: Record<FogTool, string> = { brush: "Brush", rect: "Rectangle", cell: "Grid cell", gridrect: "Grid rect", room: "Room" };
      for (const t of ["brush", "rect", "cell", "gridrect", "room"] as FogTool[]) {
        toolBtns[t] = barEl.createEl("button", { text: toolLabels[t] });
        toolBtns[t].addEventListener("click", () => { this.tool = t; syncActive(); });
      }
      syncActive();

      barEl.createSpan({ text: "Brush", cls: "dm-status-detail" });
      const sizeSlider = barEl.createEl("input", { type: "range" });
      sizeSlider.min = "2";
      sizeSlider.max = "15";
      sizeSlider.step = "1";
      sizeSlider.value = String(this.brushPct);
      sizeSlider.title = "Brush size (% of map width)";
      sizeSlider.addEventListener("input", () => { this.brushPct = parseInt(sizeSlider.value, 10); });

      const revealAll = barEl.createEl("button", { text: "Reveal All" });
      revealAll.addEventListener("click", () => {
        this.ctx().clearRect(0, 0, this.fogCanvas.width, this.fogCanvas.height);
        redraw();
        this.commit();
      });
      const coverAll = barEl.createEl("button", { text: "Cover All", cls: "mod-warning" });
      coverAll.addEventListener("click", () => {
        const ctx = this.ctx();
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, this.fogCanvas.width, this.fogCanvas.height);
        redraw();
        this.commit();
      });

      this.setupFogDrawing(overlay, redraw, fogScale);
    };

    const renderWallsToolbar = (barEl: HTMLElement) => {
      const wallToolBtns: Record<WallsTool, HTMLButtonElement> = {} as never;
      const syncActive = () => {
        for (const [t, b] of Object.entries(wallToolBtns)) b.classList.toggle("dm-fog-active", this.wallsTool === (t as WallsTool));
      };
      for (const [t, label] of [["select", "Select"], ["wall", "Wall"], ["door", "Door"], ["erase", "Erase"], ["toggle", "Toggle door"], ["rect", "Rect"]] as [WallsTool, string][]) {
        wallToolBtns[t] = barEl.createEl("button", { text: label });
        wallToolBtns[t].addEventListener("click", () => {
          this.wallsTool = t;
          // end any chain when switching tool
          this.chainAnchor = null;
          this.clearSelection();
          syncActive();
          redraw();
        });
      }
      syncActive();

      const snapLabel = barEl.createEl("label");
      snapLabel.createSpan({ text: "Snap" });
      const snapCb = snapLabel.createEl("input", { type: "checkbox" });
      snapCb.checked = this.wallsSnap;
      snapCb.addEventListener("change", () => { this.wallsSnap = snapCb.checked; });

      const importBtn = barEl.createEl("button", { text: "Import UVTT" });
      importBtn.addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".dd2vtt,.uvtt,.df2vtt,.json";
        input.addEventListener("change", () => {
          const file = input.files?.[0];
          if (!file) return;
          void file.text().then((text) => {
            let doc: unknown;
            try {
              doc = JSON.parse(text);
            } catch (err) {
              new Notice(`UVTT import failed: ${(err as Error).message}`, 6000);
              return;
            }
            this.importUvttDoc(doc);
          });
        });
        input.click();
      });

      const importFoundryBtn = barEl.createEl("button", { text: "Import Foundry" });
      importFoundryBtn.addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".zip";
        input.addEventListener("change", () => {
          const file = input.files?.[0];
          if (!file) return;
          void file.arrayBuffer().then((buf) => {
            this.importFoundryZip(new Uint8Array(buf));
          });
        });
        input.click();
      });

      const selRow = barEl.createDiv("dm-fog-selection-row");
      selRow.createSpan({ text: "Selection", cls: "dm-status-detail" });
      const selBtns: Array<{ el: HTMLButtonElement; needsSelection: boolean }> = [];
      const selAction = (label: string, title: string, run: () => void, needsSelection = true) => {
        const btn = selRow.createEl("button", { text: label });
        btn.title = title;
        btn.addEventListener("click", run);
        selBtns.push({ el: btn, needsSelection });
      };
      selAction("\u27f2", "Rotate the selection 90\u00b0 counter-clockwise", () => this.rotateSelection(270));
      selAction("\u27f3", "Rotate the selection 90\u00b0 clockwise", () => this.rotateSelection(90));
      selAction("To door", "Make every selected segment a closed door", () =>
        this.editSelection((w) => ({ ...w, door: true, open: false }))
      );
      selAction("To wall", "Make every selected segment a plain wall", () =>
        this.editSelection((w) => {
          const { door: _door, open: _open, ...plain } = w;
          return plain;
        })
      );
      selAction("Copy", "Copy the selection (Ctrl/Cmd+C)", () => this.copySelection());
      selAction("Paste", "Paste the copied walls (Ctrl/Cmd+V)", () => this.pasteWalls(), false);
      selAction("Delete", "Delete the selection (Delete)", () => this.deleteSelection());

      const rotateImportBtn = barEl.createEl("button");
      rotateImportBtn.title = "Turn the imported walls to match the map, in 90\u00b0 steps";
      rotateImportBtn.addEventListener("click", () => {
        const imported = this.lastImport;
        if (!imported) return;
        imported.rotation = ((imported.rotation + 90) % 360) as MapRotation;
        this.clearSelection();
        this.walls = this.panel.importWalls(imported.result, imported.label, imported.rotation);
        this.syncSelectionUi?.();
        this.redrawOverlay?.();
      });

      this.syncSelectionUi = () => {
        const count = this.selection.size;
        selRow.toggleClass("dm-fog-has-selection", count > 0);
        for (const { el, needsSelection } of selBtns) {
          el.disabled = needsSelection ? count === 0 : this.panel.wallClipboard.length === 0;
        }
        rotateImportBtn.style.display = this.lastImport ? "" : "none";
        rotateImportBtn.textContent = `Rotate import: ${this.lastImport?.rotation ?? 0}\u00b0`;
      };
      this.syncSelectionUi();

      this.setupWallsDrawing(overlay, redraw, fogScale);
    };

    const switchTab = (mode: EditorMode) => {
      this.editorMode = mode;
      // End any chain and rect drag on mode switch
      this.chainAnchor = null;
      this.cursorNatural = null;
      this.rectAnchor = null;
      this.clearSelection();
      // Cloning the overlay is how the previous mode's listeners are dropped.
      const newOverlay = overlay.cloneNode(false) as HTMLCanvasElement;
      overlay.replaceWith(newOverlay);
      bar.empty();
      this.syncSelectionUi = null;
      if (mode === "fog") {
        renderFogToolbar(bar);
      } else {
        renderWallsToolbar(bar);
      }
      syncTabActive();
      const newRedraw = () => this.paintOverlay(newOverlay, fogScale);
      this.redrawOverlay = newRedraw;
      newRedraw();
      if (mode === "fog") {
        this.setupFogDrawing(newOverlay, newRedraw, fogScale);
      } else {
        this.setupWallsDrawing(newOverlay, newRedraw, fogScale);
      }
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (this.editorMode !== "walls") return;
      const target = ev.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (ev.key === "Delete" || ev.key === "Backspace") {
        ev.preventDefault();
        this.deleteSelection();
        return;
      }
      if (!(ev.ctrlKey || ev.metaKey)) return;
      if (ev.key === "c" || ev.key === "C") {
        ev.preventDefault();
        this.copySelection();
      } else if (ev.key === "v" || ev.key === "V") {
        ev.preventDefault();
        this.pasteWalls();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    this.cancelWallKeys = () => document.removeEventListener("keydown", onKeyDown);

    fogTabBtn.addEventListener("click", () => switchTab("fog"));
    wallsTabBtn.addEventListener("click", () => switchTab("walls"));

    // Start in fog mode
    renderFogToolbar(bar);
  }

  private paintOverlay(canvas: HTMLCanvasElement, fogScale: number) {
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = this.editorMode === "fog" ? 0.55 : 0.25;
    ctx.drawImage(this.fogCanvas, 0, 0);
    ctx.globalAlpha = 1;

    const drag = this.selectionDrag;
    for (const w of this.walls) {
      const selected = this.selection.has(w);
      const off = selected && drag ? drag : { dx: 0, dy: 0 };
      ctx.save();
      ctx.lineWidth = selected ? 5 : 3;
      if (selected) {
        ctx.strokeStyle = SELECTION_COLOR;
      } else if (w.door) {
        ctx.strokeStyle = "#44aaff";
        if (w.open) ctx.setLineDash([8, 6]);
      } else {
        ctx.strokeStyle = "#f5d90a";
      }
      ctx.beginPath();
      ctx.moveTo((w.x1 + off.dx) * fogScale, (w.y1 + off.dy) * fogScale);
      ctx.lineTo((w.x2 + off.dx) * fogScale, (w.y2 + off.dy) * fogScale);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    if (this.editorMode !== "walls") return;

    if (this.chainAnchor && this.cursorNatural) {
      ctx.save();
      ctx.strokeStyle = this.wallsTool === "door" ? "#44aaff" : "#f5d90a";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(this.chainAnchor.x * fogScale, this.chainAnchor.y * fogScale);
      ctx.lineTo(this.cursorNatural.x * fogScale, this.cursorNatural.y * fogScale);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    const box = this.wallsTool === "rect" ? this.rectAnchor : this.marqueeAnchor;
    if (box && this.cursorNatural) {
      ctx.save();
      ctx.strokeStyle = this.wallsTool === "rect" ? "#f5d90a" : SELECTION_COLOR;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      const ax = box.x * fogScale;
      const ay = box.y * fogScale;
      ctx.strokeRect(ax, ay, this.cursorNatural.x * fogScale - ax, this.cursorNatural.y * fogScale - ay);
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  private clearSelection() {
    this.selection.clear();
    this.marqueeAnchor = null;
    this.selectionDrag = null;
    this.syncSelectionUi?.();
  }

  // Every group edit rebuilds the wall objects, so the selection is rebuilt
  // from the replacements the mapper returns.
  private editSelection(edit: (w: MapWall) => MapWall) {
    if (this.selection.size === 0) return;
    const next = new Set<MapWall>();
    this.walls = this.walls.map((w) => {
      if (!this.selection.has(w)) return w;
      const replacement = edit(w);
      next.add(replacement);
      return replacement;
    });
    this.selection = next;
    void this.panel.commitWalls([...this.walls]);
    this.syncSelectionUi?.();
    this.redrawOverlay?.();
  }

  private selectionBox(): { x: number; y: number; w: number; h: number } | null {
    if (this.selection.size === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const w of this.selection) {
      minX = Math.min(minX, w.x1, w.x2);
      minY = Math.min(minY, w.y1, w.y2);
      maxX = Math.max(maxX, w.x1, w.x2);
      maxY = Math.max(maxY, w.y1, w.y2);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // 90° steps around the selection's own centre: the box swaps sides, so the
  // rotated set is re-placed from the centre rather than from the old corner.
  private rotateSelection(rotation: MapRotation) {
    const box = this.selectionBox();
    if (!box) return;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const sideways = rotation % 180 !== 0;
    const originX = cx - (sideways ? box.h : box.w) / 2;
    const originY = cy - (sideways ? box.w : box.h) / 2;
    const rotated = new Map<MapWall, MapWall>();
    const source = [...this.selection];
    const local = source.map((w) => ({
      ...w,
      x1: w.x1 - box.x,
      y1: w.y1 - box.y,
      x2: w.x2 - box.x,
      y2: w.y2 - box.y,
    }));
    const turned = rotateWalls(local, rotation, box.w, box.h);
    turned.forEach((w, i) => {
      rotated.set(source[i], {
        ...w,
        x1: w.x1 + originX,
        y1: w.y1 + originY,
        x2: w.x2 + originX,
        y2: w.y2 + originY,
      });
    });
    this.editSelection((w) => rotated.get(w)!);
  }

  private deleteSelection() {
    if (this.selection.size === 0) return;
    this.walls = this.walls.filter((w) => !this.selection.has(w));
    void this.panel.commitWalls([...this.walls]);
    this.clearSelection();
    this.redrawOverlay?.();
  }

  private copySelection() {
    if (this.selection.size === 0) return;
    this.panel.wallClipboard = [...this.selection].map((w) => ({ ...w }));
    new Notice(`Copied ${this.panel.wallClipboard.length} walls`);
    this.syncSelectionUi?.();
  }

  // The pasted copy lands half a square off its source so it is visible and
  // grabbable where the original sits.
  private pasteWalls() {
    const clipboard = this.panel.wallClipboard;
    if (clipboard.length === 0) return;
    const offset = this.panel.state.pxPerSquare / 2;
    const pasted = clipboard.map((w) => ({
      ...w,
      x1: w.x1 + offset,
      y1: w.y1 + offset,
      x2: w.x2 + offset,
      y2: w.y2 + offset,
    }));
    this.walls = [...this.walls, ...pasted];
    void this.panel.commitWalls([...this.walls]);
    this.selection = new Set(pasted);
    this.panel.wallClipboard = pasted.map((w) => ({ ...w }));
    this.syncSelectionUi?.();
    this.redrawOverlay?.();
  }

  private ctx(): CanvasRenderingContext2D {
    return this.fogCanvas.getContext("2d")!;
  }

  private toFog(overlay: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
    const b = overlay.getBoundingClientRect();
    return {
      x: ((clientX - b.left) / b.width) * this.fogCanvas.width,
      y: ((clientY - b.top) / b.height) * this.fogCanvas.height,
    };
  }

  private applyMode(ctx: CanvasRenderingContext2D) {
    if (this.mode === "reveal") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "black";
    }
  }

  private setupFogDrawing(overlay: HTMLCanvasElement, redraw: () => void, fogScale: number) {
    const stampBrush = (fx: number, fy: number) => {
      const ctx = this.ctx();
      this.applyMode(ctx);
      ctx.beginPath();
      ctx.arc(fx, fy, (this.fogCanvas.width * this.brushPct) / 100, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    };

    const paintCell = (fx: number, fy: number) => {
      const cell = gridCellRectAt(fx / fogScale, fy / fogScale, {
        pxPerSquare: this.panel.state.pxPerSquare,
        gridOffsetX: this.panel.state.gridOffsetX,
        gridOffsetY: this.panel.state.gridOffsetY,
      });
      const ctx = this.ctx();
      this.applyMode(ctx);
      ctx.fillRect(cell.x * fogScale, cell.y * fogScale, cell.w * fogScale, cell.h * fogScale);
      ctx.globalCompositeOperation = "source-over";
    };

    const handleRoomClick = (fx: number, fy: number) => {
      const fw = this.fogCanvas.width;
      const fh = this.fogCanvas.height;

      // Room boundaries are the sight-blocking walls only (open doors merge rooms
      // here, unlike Exploration where every door is a boundary).
      const blocked = buildBlockedMask(this.walls, fw, fh, fogScale, this.panel.state.pxPerSquare, blocksSight);
      const region = floodRegion(blocked, fw, fh, fx, fy);
      if (!region) {
        new Notice("That point is inside a wall");
        return;
      }

      const ctx = this.ctx();
      this.applyMode(ctx);
      ctx.drawImage(regionToCanvas(region, fw, fh), 0, 0);
      ctx.globalCompositeOperation = "source-over";

      redraw();
      this.commit();
    };

    overlay.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.cleanupDrag?.();
      const start = this.toFog(overlay, e.clientX, e.clientY);

      if (this.tool === "room") {
        this.cleanupDrag = trackTapOrDrag(e, {
          act: (p) => {
            const at = this.toFog(overlay, p.clientX, p.clientY);
            handleRoomClick(at.x, at.y);
          },
          onEnd: () => {
            this.cleanupDrag = null;
          },
        });
        return;
      }

      if (this.tool === "rect" || this.tool === "gridrect") {
        const snapToGrid = this.tool === "gridrect";
        const cfg = {
          pxPerSquare: this.panel.state.pxPerSquare,
          gridOffsetX: this.panel.state.gridOffsetX,
          gridOffsetY: this.panel.state.gridOffsetY,
        };
        const onMove = (me: PointerEvent) => {
          const cur = this.toFog(overlay, me.clientX, me.clientY);
          redraw();
          const octx = overlay.getContext("2d")!;
          octx.strokeStyle = this.mode === "reveal" ? "#7bd88f" : "#f97583";
          octx.setLineDash([6, 4]);
          octx.lineWidth = 2;
          octx.strokeRect(start.x, start.y, cur.x - start.x, cur.y - start.y);
          octx.setLineDash([]);
        };
        const onUp = (me: PointerEvent) => {
          this.cleanupDrag = null;
          const end = this.toFog(overlay, me.clientX, me.clientY);
          if (Math.abs(end.x - start.x) < 1 || Math.abs(end.y - start.y) < 1) {
            redraw();
            return;
          }
          const ctx = this.ctx();
          this.applyMode(ctx);
          if (snapToGrid) {
            const minX = Math.min(start.x, end.x);
            const minY = Math.min(start.y, end.y);
            const maxX = Math.max(start.x, end.x);
            const maxY = Math.max(start.y, end.y);
            const a = gridCellRectAt(minX / fogScale, minY / fogScale, cfg);
            const b = gridCellRectAt(maxX / fogScale, maxY / fogScale, cfg);
            ctx.fillRect(a.x * fogScale, a.y * fogScale, (b.x + b.w - a.x) * fogScale, (b.y + b.h - a.y) * fogScale);
          } else {
            ctx.fillRect(
              Math.min(start.x, end.x),
              Math.min(start.y, end.y),
              Math.abs(end.x - start.x),
              Math.abs(end.y - start.y)
            );
          }
          ctx.globalCompositeOperation = "source-over";
          redraw();
          this.commit();
        };
        this.cleanupDrag = trackTapOrDrag(e, { onMove, onEnd: onUp, intent: "stroke" });
        return;
      }

      const paint = this.tool === "brush" ? stampBrush : paintCell;
      this.cleanupDrag = trackTapOrDrag(e, {
        intent: "stroke",
        act: () => {
          paint(start.x, start.y);
          redraw();
        },
        onMove: (me) => {
          const p = this.toFog(overlay, me.clientX, me.clientY);
          paint(p.x, p.y);
          redraw();
        },
        onEnd: () => {
          this.cleanupDrag = null;
          this.commit();
        },
      });
    });
  }

  private snapPoint(x: number, y: number): { x: number; y: number } {
    const pps = this.panel.state.pxPerSquare;
    const ox = this.panel.state.gridOffsetX;
    const oy = this.panel.state.gridOffsetY;
    return {
      x: ox + Math.round((x - ox) / pps) * pps,
      y: oy + Math.round((y - oy) / pps) * pps,
    };
  }

  private toNatural(overlay: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
    const fog = this.toFog(overlay, clientX, clientY);
    const fogScale = this.fogCanvas.width / this.map.naturalWidth;
    return { x: fog.x / fogScale, y: fog.y / fogScale };
  }

  private setupWallsDrawing(overlay: HTMLCanvasElement, redraw: () => void, fogScale: number) {
    const distToSegment = (px: number, py: number, w: MapWall): number => {
      const dx = w.x2 - w.x1;
      const dy = w.y2 - w.y1;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) return Math.hypot(px - w.x1, py - w.y1);
      const t = Math.max(0, Math.min(1, ((px - w.x1) * dx + (py - w.y1) * dy) / lenSq));
      return Math.hypot(px - (w.x1 + t * dx), py - (w.y1 + t * dy));
    };

    overlay.addEventListener("pointermove", (e: PointerEvent) => {
      this.cursorNatural = this.toNatural(overlay, e.clientX, e.clientY);
      if (this.chainAnchor || this.rectAnchor) redraw();
    });

    overlay.addEventListener("pointerleave", () => {
      this.cursorNatural = null;
      if (this.chainAnchor || this.rectAnchor) redraw();
    });

    const endChain = () => {
      if (!this.chainAnchor) return;
      this.chainAnchor = null;
      redraw();
    };
    overlay.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      // Right-click ends the chain
      endChain();
    });
    // A finger has no second button, so holding the map closes the chain.
    this.cancelChainLongPress?.();
    this.cancelChainLongPress = onLongPress(overlay, () => {
      this.cleanupDrag?.();
      this.cleanupDrag = null;
      endChain();
    });

    overlay.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.cleanupDrag?.();

      if (this.wallsTool === "select") {
        this.startSelectGesture(e, overlay, distToSegment, redraw, fogScale);
        return;
      }

      // The Rect tool is a drag; every other walls tool places or removes one
      // thing, so a finger commits it on the lift (`pointerDrag.ts`).
      if (this.wallsTool !== "rect") {
        this.cleanupDrag = trackTapOrDrag(e, {
          act: (p) => this.placeWall(this.natAt(overlay, p), distToSegment, redraw, fogScale),
          onEnd: () => {
            this.cleanupDrag = null;
          },
        });
        return;
      }

      this.rectAnchor = this.natAt(overlay, e);
      const onMove = (me: PointerEvent) => {
        this.cursorNatural = this.toNatural(overlay, me.clientX, me.clientY);
        redraw();
      };
      const onUp = (me: PointerEvent) => {
        this.cleanupDrag = null;
        const end = this.toNatural(overlay, me.clientX, me.clientY);
        const snapped = this.wallsSnap ? this.snapPoint(end.x, end.y) : end;
        const anchor = this.rectAnchor!;
        this.rectAnchor = null;
        const minX = Math.min(anchor.x, snapped.x);
        const minY = Math.min(anchor.y, snapped.y);
        const maxX = Math.max(anchor.x, snapped.x);
        const maxY = Math.max(anchor.y, snapped.y);
        if (maxX - minX < 0.5 || maxY - minY < 0.5) {
          redraw();
          return;
        }
        const newWalls: MapWall[] = [
          { x1: minX, y1: minY, x2: maxX, y2: minY },
          { x1: maxX, y1: minY, x2: maxX, y2: maxY },
          { x1: maxX, y1: maxY, x2: minX, y2: maxY },
          { x1: minX, y1: maxY, x2: minX, y2: minY },
        ];
        this.walls = [...this.walls, ...newWalls];
        void this.panel.commitWalls([...this.walls]);
        redraw();
      };
      const stop = trackTapOrDrag(e, { onMove, onEnd: onUp, intent: "stroke" });
      this.cleanupDrag = () => {
        stop();
        this.rectAnchor = null;
      };
    });
  }

  // Select: a press on a wall takes it (shift toggles it in or out), a press on
  // a selected wall drags the whole group, and a press on empty space pulls a
  // marquee — a tap there puts the selection down.
  private startSelectGesture(
    e: PointerEvent,
    overlay: HTMLCanvasElement,
    distToSegment: (px: number, py: number, w: MapWall) => number,
    redraw: () => void,
    fogScale: number
  ) {
    const start = this.toNatural(overlay, e.clientX, e.clientY);
    const hitRadius = 12 / fogScale;
    let hit: MapWall | null = null;
    let hitDist = Infinity;
    for (const w of this.walls) {
      const d = distToSegment(start.x, start.y, w);
      if (d < hitRadius && d < hitDist) {
        hitDist = d;
        hit = w;
      }
    }

    if (hit && e.shiftKey) {
      if (this.selection.has(hit)) this.selection.delete(hit);
      else this.selection.add(hit);
      this.syncSelectionUi?.();
      redraw();
      return;
    }

    if (hit) {
      if (!this.selection.has(hit)) {
        this.selection = new Set([hit]);
        this.syncSelectionUi?.();
      }
      const stop = trackTapOrDrag(e, {
        onMove: (m) => {
          const now = this.toNatural(overlay, m.clientX, m.clientY);
          this.selectionDrag = this.snapDelta(now.x - start.x, now.y - start.y);
          redraw();
        },
        onEnd: () => {
          this.cleanupDrag = null;
          const drag = this.selectionDrag;
          this.selectionDrag = null;
          if (!drag || (drag.dx === 0 && drag.dy === 0)) {
            redraw();
            return;
          }
          this.editSelection((w) => ({
            ...w,
            x1: w.x1 + drag.dx,
            y1: w.y1 + drag.dy,
            x2: w.x2 + drag.dx,
            y2: w.y2 + drag.dy,
          }));
        },
        intent: "stroke",
      });
      this.cleanupDrag = () => {
        stop();
        this.selectionDrag = null;
      };
      return;
    }

    this.marqueeAnchor = start;
    const stop = trackTapOrDrag(e, {
      onMove: (m) => {
        this.cursorNatural = this.toNatural(overlay, m.clientX, m.clientY);
        redraw();
      },
      onEnd: (m) => {
        this.cleanupDrag = null;
        const anchor = this.marqueeAnchor;
        this.marqueeAnchor = null;
        if (!anchor) return;
        const end = this.toNatural(overlay, m.clientX, m.clientY);
        const box = {
          minX: Math.min(anchor.x, end.x),
          minY: Math.min(anchor.y, end.y),
          maxX: Math.max(anchor.x, end.x),
          maxY: Math.max(anchor.y, end.y),
        };
        if (box.maxX - box.minX < 0.5 || box.maxY - box.minY < 0.5) {
          this.clearSelection();
          redraw();
          return;
        }
        if (!e.shiftKey) this.selection.clear();
        for (const w of this.walls) {
          if (segmentCrossesBox(w, box)) this.selection.add(w);
        }
        this.syncSelectionUi?.();
        redraw();
      },
      intent: "stroke",
    });
    this.cleanupDrag = () => {
      stop();
      this.marqueeAnchor = null;
    };
  }

  private snapDelta(dx: number, dy: number): { dx: number; dy: number } {
    if (!this.wallsSnap) return { dx, dy };
    const pps = this.panel.state.pxPerSquare;
    return { dx: Math.round(dx / pps) * pps, dy: Math.round(dy / pps) * pps };
  }

  private natAt(overlay: HTMLCanvasElement, e: PointerEvent): { x: number; y: number } {
    const nat = this.toNatural(overlay, e.clientX, e.clientY);
    return this.wallsSnap ? this.snapPoint(nat.x, nat.y) : nat;
  }

  // Wall, Door, Erase and Toggle door: one press places or removes one thing.
  private placeWall(
    nat: { x: number; y: number },
    distToSegment: (px: number, py: number, w: MapWall) => number,
    redraw: () => void,
    fogScale: number
  ) {
    if (this.wallsTool === "wall" || this.wallsTool === "door") {
      if (!this.chainAnchor) {
        this.chainAnchor = nat;
        redraw();
        return;
      }
      const anchor = this.chainAnchor;
      // Ignore zero-length segments
      if (Math.hypot(nat.x - anchor.x, nat.y - anchor.y) > 0.5) {
        const wall: MapWall = {
          x1: anchor.x,
          y1: anchor.y,
          x2: nat.x,
          y2: nat.y,
          ...(this.wallsTool === "door" ? { door: true, open: false } : {}),
        };
        this.walls = [...this.walls, wall];
        void this.panel.commitWalls([...this.walls]);
      }
      this.chainAnchor = nat;
      redraw();
      return;
    }

    const hitRadius = 12 / fogScale;
    const nearest = (eligible: (w: MapWall) => boolean): MapWall | null => {
      let found: MapWall | null = null;
      let foundDist = Infinity;
      for (const w of this.walls) {
        if (!eligible(w)) continue;
        const d = distToSegment(nat.x, nat.y, w);
        if (d < hitRadius && d < foundDist) {
          foundDist = d;
          found = w;
        }
      }
      return found;
    };

    if (this.wallsTool === "erase") {
      const hit = nearest(() => true);
      if (!hit) return;
      this.walls = this.walls.filter((w) => w !== hit);
      void this.panel.commitWalls([...this.walls]);
      redraw();
      return;
    }

    const door = nearest((w) => !!w.door);
    if (!door) return;
    this.walls = this.walls.map((w) => (w === door ? { ...w, open: !w.open } : w));
    void this.panel.commitWalls([...this.walls]);
    redraw();
  }

  importUvttDoc(doc: unknown) {
    let parsed;
    try {
      parsed = parseUvttWalls(doc);
    } catch (err) {
      new Notice(`UVTT import failed: ${(err as Error).message}`, 6000);
      return;
    }
    this.lastImport = { result: parsed, label: "UVTT file", rotation: 0 };
    this.clearSelection();
    this.walls = this.panel.importWalls(parsed, "UVTT file");
    this.syncSelectionUi?.();
    this.redrawOverlay?.();
  }

  async importFoundryZip(zipBytes: Uint8Array) {
    let scenes: FoundryScene[];
    try {
      scenes = collectFoundryScenes(unzipSync(zipBytes, { filter: (f) => /\.(db|log|ldb)$/i.test(f.name) }));
    } catch (err) {
      new Notice(`Foundry import failed: ${(err as Error).message}`, 6000);
      return;
    }
    if (scenes.length === 0) {
      new Notice("Foundry import failed: No scene with walls found in module", 6000);
      return;
    }
    const scene = await this.panel.pickFoundryScene(scenes);
    if (!scene) return;
    const label = `Foundry file "${scene.name}"`;
    this.lastImport = { result: sceneImportResult(scene), label, rotation: 0 };
    this.clearSelection();
    this.walls = this.panel.importWalls(this.lastImport.result, label);
    this.syncSelectionUi?.();
    this.redrawOverlay?.();
  }

  onClose() {
    // A drag can outlive the modal (Escape mid-stroke) — its listeners live on
    // document, not on the modal DOM.
    this.cleanupDrag?.();
    this.cleanupDrag = null;
    this.chainAnchor = null;
    this.cursorNatural = null;
    this.rectAnchor = null;
    this.redrawOverlay = null;
    for (const cancel of this.cancelStageZoom.splice(0)) cancel();
    this.cancelWebkitGestures?.();
    this.cancelWebkitGestures = null;
    this.cancelChainLongPress?.();
    this.cancelChainLongPress = null;
    this.cancelWallKeys?.();
    this.cancelWallKeys = null;
    this.selection.clear();
    this.marqueeAnchor = null;
    this.selectionDrag = null;
    this.syncSelectionUi = null;
    this.lastImport = null;
    this.stageView = { ...IDENTITY_VIEW };
    this.contentEl.empty();
  }
}
