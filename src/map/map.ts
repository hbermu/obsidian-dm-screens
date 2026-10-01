// Map Screen - WebSocket client and rendering logic
// Runs in the browser on the table TV; renders one battlemap at physical
// 1-inch-per-square scale (or fit-to-screen) with an optional grid overlay.

import { safePlayerUrl } from "../player/safeUrl";
import { createRepaintScheduler, sizeCanvas } from "./canvas";
import {
  cssPixelsPerInch,
  gridAxisOffsets,
  gridLinePositions,
  mapScale,
  mapTranslation,
  profileKey,
  DEFAULT_GRID_CONFIG,
  FALLBACK_PPI,
  finiteOr,
} from "./transform";
import type { MapAoe, MapGridConfig, MapMediaPayload, MapRotation, MapView, MapVision, MapWall, ScreenProfile } from "./types";
import { renderAoe } from "./aoe";
import { eraseVisionWithWalls } from "./vision";

interface MapMessage {
  type: string;
  payload: Record<string, unknown>;
}

const MAX_PAYLOAD_ARRAY = 200;

const PERF_REPORT_INTERVAL_MS = 2000;

// The map bundle cannot reach the plugin's Debug setting, so it reports through
// console directly — the documented exception. Per-call logging would itself be
// the bottleneck at the rate these run, so calls are accumulated and summarised
// on an interval, and a quiet interval reports nothing.
class PerfSampler {
  private calls = 0;
  private totalMs = 0;
  private maxMs = 0;
  private lastReport = 0;

  constructor(private label: string, private context: () => string) {}

  sample<T>(run: () => T): T {
    const started = performance.now();
    const result = run();
    const elapsed = performance.now() - started;
    this.calls++;
    this.totalMs += elapsed;
    if (elapsed > this.maxMs) this.maxMs = elapsed;
    const now = performance.now();
    if (this.lastReport === 0) this.lastReport = now;
    if (now - this.lastReport >= PERF_REPORT_INTERVAL_MS) {
      console.log(
        `[Map Screen] ${this.label}: ${this.calls} calls in ${Math.round(now - this.lastReport)}ms,` +
          ` avg ${(this.totalMs / this.calls).toFixed(1)}ms, max ${this.maxMs.toFixed(1)}ms — ${this.context()}`
      );
      this.calls = 0;
      this.totalMs = 0;
      this.maxMs = 0;
      this.lastReport = now;
    }
    return result;
  }
}

class MapScreen {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hasConnectedOnce = false;

  private media: MapMediaPayload | null = null;
  private view: MapView = { mode: "fit", panX: 0, panY: 0 };
  private config: MapGridConfig = { ...DEFAULT_GRID_CONFIG };
  private profiles: Record<string, ScreenProfile> = {};
  private calibrationVisible = false;
  private aoes: MapAoe[] = [];
  private fogImage: HTMLImageElement | null = null;
  private fogOpacity = 1;
  private visions: MapVision[] = [];
  private walls: MapWall[] = [];
  private layoutPerf = new PerfSampler(
    "applyLayout",
    () => `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio || 1}, ${this.aoes.length} AoEs, grid ${this.config.showGrid ? "on" : "off"}`
  );
  private fogPerf = new PerfSampler(
    "recompositeFog",
    () => `${this.visions.length} visions, ${this.walls.length} walls`
  );
  private layoutPainter = createRepaintScheduler(() =>
    this.layoutPerf.sample(() => this.paintLayout())
  );

  constructor() {
    this.connect();
    window.addEventListener("resize", () => {
      this.sendClientInfo();
      this.applyLayout();
    });
    this.initFullscreenButton();
  }

  private initFullscreenButton() {
    const btn = document.getElementById("fullscreen-btn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });
    document.addEventListener("fullscreenchange", () => {
      btn.textContent = document.fullscreenElement ? "✕" : "⛶";
    });
  }

  private sendClientInfo() {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({
        type: "client-info",
        payload: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
          channel: "map",
        },
      }));
    }
  }

  // The page arrives with ?k=<token>; the server also parks it in a cookie so a
  // reload that loses the query still authenticates.
  private accessToken(): string {
    const fromQuery = new URLSearchParams(window.location.search).get("k");
    if (fromQuery) return fromQuery;
    const m = /(?:^|;\s*)dmScreenKey=([^;]+)/.exec(document.cookie);
    if (!m) return "";
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return "";
    }
  }

  private connect() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/map?k=${encodeURIComponent(this.accessToken())}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.addEventListener("open", () => {
      console.log("[Map Screen] Connected to DM");
      (window as unknown as { __wsConnected: boolean }).__wsConnected = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.hasConnectedOnce) {
        window.location.reload();
        return;
      }
      this.hasConnectedOnce = true;
      this.hideDisconnectedOverlay();
      this.sendClientInfo();
    });

    this.ws.addEventListener("message", (event) => {
      try {
        const msg: MapMessage = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (e) {
        console.error("[Map Screen] Failed to parse message:", e);
      }
    });

    this.ws.addEventListener("close", () => {
      console.log("[Map Screen] Disconnected, reconnecting in 3s...");
      (window as unknown as { __wsConnected: boolean }).__wsConnected = false;
      if (this.hasConnectedOnce) this.showDisconnectedOverlay();
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });

    this.ws.addEventListener("error", (e) => {
      console.error("[Map Screen] WebSocket error:", e);
    });
  }

  private showDisconnectedOverlay() {
    let el = document.getElementById("disconnected-overlay");
    if (!el) {
      el = document.createElement("div");
      el.id = "disconnected-overlay";
      const msg = document.createElement("div");
      msg.className = "disconnected-msg";
      const heading = document.createElement("h2");
      heading.textContent = "Disconnected";
      const body = document.createElement("p");
      body.textContent = "Lost connection to the DM. Reconnecting…";
      const dot = document.createElement("div");
      dot.className = "pulse-dot";
      msg.append(heading, body, dot);
      el.appendChild(msg);
      document.body.appendChild(el);
    }
    el.style.display = "flex";
  }

  private hideDisconnectedOverlay() {
    const el = document.getElementById("disconnected-overlay");
    if (el) el.style.display = "none";
  }

  // Payload arrays drive render loops; a non-array or a 5000-entry list from a
  // hostile client would hang the screen rather than error.
  private boundedArray<T>(value: unknown, label: string): T[] {
    if (!Array.isArray(value)) return [];
    if (value.length > MAX_PAYLOAD_ARRAY) {
      console.warn(`[Map Screen] ${label} truncated from ${value.length} to ${MAX_PAYLOAD_ARRAY}`);
      return value.slice(0, MAX_PAYLOAD_ARRAY) as T[];
    }
    return value as T[];
  }

  private handleMessage(msg: MapMessage) {
    switch (msg.type) {
      case "map-show":
        this.showMap(msg.payload as unknown as MapMediaPayload);
        break;
      case "map-view": {
        const p = msg.payload as unknown as Partial<MapView>;
        this.view = {
          mode: p.mode === "physical" ? "physical" : "fit",
          panX: finiteOr(p.panX, 0),
          panY: finiteOr(p.panY, 0),
          rotation: ([0, 90, 180, 270] as number[]).includes(p.rotation as number)
            ? (p.rotation as MapRotation)
            : 0,
        };
        this.applyLayout();
        break;
      }
      case "map-config": {
        const p = msg.payload as unknown as Partial<MapGridConfig>;
        this.config = {
          ...DEFAULT_GRID_CONFIG,
          ...p,
          pxPerSquare: finiteOr(p.pxPerSquare, DEFAULT_GRID_CONFIG.pxPerSquare),
          gridOffsetX: finiteOr(p.gridOffsetX, 0),
          gridOffsetY: finiteOr(p.gridOffsetY, 0),
          gridOpacity: Math.min(Math.max(finiteOr(p.gridOpacity, DEFAULT_GRID_CONFIG.gridOpacity), 0), 1),
        };
        this.applyLayout();
        break;
      }
      case "map-calibration":
        this.profiles = (msg.payload as { profiles?: Record<string, ScreenProfile> }).profiles ?? {};
        this.applyLayout();
        this.renderCalibrationCard();
        break;
      case "map-calibration-overlay":
        this.calibrationVisible = !!(msg.payload as { show?: boolean }).show;
        this.renderCalibrationCard();
        break;
      case "map-aoe-sync":
        this.aoes = this.boundedArray<MapAoe>((msg.payload as { aoes?: unknown }).aoes, "aoes");
        this.applyLayout();
        break;
      case "map-fog":
        this.showFog(msg.payload as { dataUrl?: string | null; opacity?: number });
        break;
      case "map-vision":
        this.visions = this.boundedArray<MapVision>((msg.payload as { visions?: unknown }).visions, "visions");
        this.recompositeFog();
        break;
      case "map-walls":
        this.walls = this.boundedArray<MapWall>((msg.payload as { walls?: unknown }).walls, "walls");
        this.recompositeFog();
        break;
      case "map-clear":
        this.clearMap();
        break;
      default:
        console.log("[Map Screen] Unknown message type:", msg.type);
    }
  }

  private currentPpi(): { ppi: number; calibrated: boolean } {
    const key = profileKey(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    const profile = this.profiles[key];
    if (!profile) return { ppi: FALLBACK_PPI, calibrated: false };
    return { ppi: cssPixelsPerInch(window.innerWidth, window.innerHeight, profile), calibrated: true };
  }

  private showMap(payload: MapMediaPayload) {
    const video = document.getElementById("map-video") as HTMLVideoElement;
    const image = document.getElementById("map-image") as HTMLImageElement;
    if (payload.mediaType === "video") {
      const safeSrc = safePlayerUrl(payload.url, "video");
      if (!safeSrc) {
        console.warn("[Map Screen] Rejected map video URL");
        return;
      }
      image.style.display = "none";
      image.src = "";
      video.loop = payload.loop ?? true;
      video.muted = payload.muted ?? true;
      video.src = safeSrc;
      video.style.display = "block";
      video.play().catch((e) => console.error("[Map Screen] Video autoplay failed:", e));
      video.addEventListener("loadedmetadata", () => this.applyLayout(), { once: true });
    } else {
      const safeSrc = safePlayerUrl(payload.url, "image");
      if (!safeSrc) {
        console.warn("[Map Screen] Rejected map image URL");
        return;
      }
      video.pause();
      video.src = "";
      video.style.display = "none";
      image.src = safeSrc;
      image.style.display = "block";
      image.onload = () => this.applyLayout();
    }
    this.media = payload;
    document.getElementById("waiting-screen")!.style.display = "none";
    this.applyLayout();
    // Fog may have loaded before the map (replay order is not guaranteed) —
    // recomposite now that naturalSize() is known so vision holes land.
    this.recompositeFog();
  }

  private showFog(payload: { dataUrl?: string | null; opacity?: number }) {
    this.fogOpacity = payload.opacity ?? 1;
    if (!payload.dataUrl) {
      this.fogImage = null;
      this.recompositeFog();
      return;
    }
    const safeSrc = safePlayerUrl(payload.dataUrl, "image");
    if (!safeSrc) {
      console.warn("[Map Screen] Rejected fog data URL");
      return;
    }
    const img = new Image();
    img.onload = () => {
      this.fogImage = img;
      this.recompositeFog();
    };
    img.src = safeSrc;
  }

  private recompositeFog() {
    this.fogPerf.sample(() => this.paintFog());
  }

  private paintFog() {
    const canvas = document.getElementById("map-fog") as HTMLCanvasElement;
    if (!this.fogImage) {
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.display = "none";
      return;
    }
    const { w: nw } = this.naturalSize();
    const fw = this.fogImage.naturalWidth;
    const fh = this.fogImage.naturalHeight;
    sizeCanvas(canvas, fw, fh);
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, fw, fh);
    ctx.drawImage(this.fogImage, 0, 0);
    if (nw > 0) {
      const scale = fw / nw;
      const { h: nh } = this.naturalSize();
      for (const v of this.visions) {
        eraseVisionWithWalls(ctx, v, scale, this.config.pxPerSquare, this.walls, nw, nh);
      }
    }
    canvas.style.opacity = String(this.fogOpacity);
    canvas.style.display = "block";
  }

  private clearMap() {
    const video = document.getElementById("map-video") as HTMLVideoElement;
    const image = document.getElementById("map-image") as HTMLImageElement;
    video.pause();
    video.src = "";
    video.style.display = "none";
    image.src = "";
    image.style.display = "none";
    this.fogImage = null;
    this.visions = [];
    this.walls = [];
    this.recompositeFog();
    this.media = null;
    this.aoes = [];
    document.getElementById("waiting-screen")!.style.display = "flex";
    this.applyLayout();
  }

  private naturalSize(): { w: number; h: number } {
    if (!this.media) return { w: 0, h: 0 };
    if (this.media.naturalWidth > 0 && this.media.naturalHeight > 0) {
      return { w: this.media.naturalWidth, h: this.media.naturalHeight };
    }
    if (this.media.mediaType === "video") {
      const video = document.getElementById("map-video") as HTMLVideoElement;
      return { w: video.videoWidth, h: video.videoHeight };
    }
    const image = document.getElementById("map-image") as HTMLImageElement;
    return { w: image.naturalWidth, h: image.naturalHeight };
  }

  private applyLayout() {
    this.layoutPainter.schedule();
  }

  private paintLayout() {
    const stage = document.getElementById("map-stage")!;
    const hint = document.getElementById("scale-hint")!;
    const canvas = document.getElementById("grid-overlay") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;

    // Only the viewport changing warrants a reallocation. map-view and
    // map-aoe-sync arrive about twelve times a second during a pan drag, and on
    // a 4K screen each unguarded assignment threw away and re-uploaded a
    // multi-megapixel texture. setTransform must still run every paint: it is
    // reset by a resize, not by a repaint.
    sizeCanvas(canvas, vw * dpr, vh * dpr);
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);

    const { w: nw, h: nh } = this.naturalSize();
    if (!this.media || !(nw > 0) || !(nh > 0)) {
      hint.style.display = "none";
      return;
    }

    const { ppi, calibrated } = this.currentPpi();
    const rotation = this.view.rotation ?? 0;
    const scale = mapScale(this.view, ppi, this.config.pxPerSquare, nw, nh, vw, vh);
    const { tx, ty } = mapTranslation(this.view, scale, nw, nh, vw, vh);

    const mediaEl = document.getElementById(
      this.media.mediaType === "video" ? "map-video" : "map-image"
    ) as HTMLElement;
    mediaEl.style.width = `${nw}px`;
    mediaEl.style.height = `${nh}px`;
    stage.style.transform = `translate(${tx}px, ${ty}px) rotate(${rotation}deg) scale(${scale})`;

    if (this.config.showGrid) {
      const axes = gridAxisOffsets(rotation, this.config.gridOffsetX, this.config.gridOffsetY);
      ctx.globalAlpha = this.config.gridOpacity;
      ctx.strokeStyle = this.config.gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const x of gridLinePositions(tx, axes.vertical, this.config.pxPerSquare, scale, vw)) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, vh);
      }
      for (const y of gridLinePositions(ty, axes.horizontal, this.config.pxPerSquare, scale, vh)) {
        ctx.moveTo(0, y);
        ctx.lineTo(vw, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (const aoe of this.aoes) {
      renderAoe(ctx, aoe, scale, tx, ty, this.config.pxPerSquare, rotation);
    }

    if (this.view.mode === "physical" && !calibrated) {
      hint.textContent = `Uncalibrated screen — assuming ${FALLBACK_PPI} px/inch`;
      hint.style.display = "block";
    } else {
      hint.style.display = "none";
    }
  }

  private renderCalibrationCard() {
    let card = document.getElementById("calibration-overlay");
    if (!card) return;
    if (!this.calibrationVisible) {
      card.style.display = "none";
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    const { ppi, calibrated } = this.currentPpi();

    card.innerHTML = "";
    card.style.display = "flex";

    const title = document.createElement("h2");
    title.textContent = "Screen calibration";
    card.appendChild(title);

    const info = document.createElement("p");
    info.textContent = `${vw}×${vh} @ ${dpr} — ${ppi.toFixed(1)} px/inch${calibrated ? "" : " (no profile yet)"}`;
    card.appendChild(info);

    const ruler = document.createElement("div");
    ruler.id = "calibration-ruler";
    ruler.style.width = `${ppi * 6}px`;
    for (let i = 0; i < 6; i++) {
      const seg = document.createElement("div");
      seg.className = `ruler-inch ${i % 2 === 0 ? "even" : "odd"}`;
      seg.style.width = `${ppi}px`;
      ruler.appendChild(seg);
    }
    card.appendChild(ruler);

    const rulerLabel = document.createElement("p");
    rulerLabel.textContent = "This bar should measure exactly 6 inches (15.24 cm) with a real ruler.";
    card.appendChild(rulerLabel);

    const square = document.createElement("div");
    square.id = "calibration-square";
    square.style.width = `${ppi}px`;
    square.style.height = `${ppi}px`;
    card.appendChild(square);

    const squareLabel = document.createElement("p");
    squareLabel.textContent = "1 inch × 1 inch — one grid square.";
    card.appendChild(squareLabel);
  }
}

// Initialize
new MapScreen();
