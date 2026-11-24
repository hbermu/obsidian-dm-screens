import { ItemView, Menu, WorkspaceLeaf, Notice, TFile } from "obsidian";
import type DmScreenPlugin from "../main";
import type { TrackerCombatant, ImageLayer, LayerGeometry } from "../types";
import { renderStatblock } from "./StatblockPanel";
import { DnDBeyondPanel } from "./DnDBeyondPanel";
import { MapScreenPanel } from "./MapScreenPanel";
import type { ClientInfo } from "../server";
import { vaultPathFromUrl } from "../server";
import { SendToWebhookModal } from "./SendToWebhookModal";
import { TakeControlModal } from "./TakeControlModal";
import { buildLayerContextMenu } from "./layerContextMenu";
import { parseHydrusRefs, resolveHydrusRefs, ensureLocalCopy, type ResolvedHydrusRef } from "../hydrus/noteRefs";
import { recoverVaultImage } from "../hydrus/recoverImage";
import { sortByInitiative, clampTrackerScale, advanceTurn, applyRound1Reveal } from "../combat/tracker";
import { uniqueLayerLabel, layerLabelFromTags } from "./HydrusExplorerModal";
import { resolveSourceLabel, type SourceLabel } from "../sourceLabel";
import { debug, debugWarn, debugError } from "../debug";
import { CONDITIONS, decodeStatus, encodeExhaustion } from "../conditions";
import { onLongPress, trackPointerDrag, trackTapOrDrag } from "./pointerDrag";

export const DM_CONTROL_VIEW_TYPE = "dm-control-panel";

// A second surface (the Explore modal's Combat window) that mirrors the COMBAT
// section. `FloatingWindow` satisfies it structurally.
export interface CombatMirror {
  body: HTMLElement;
  setTitleExtra(el: HTMLElement): void;
}

interface ManualCombatant {
  name: string;
  hp: number;
  maxHp: number;
  initiative: number;
  active: boolean;
  statuses: string[];
}

export class DmControlPanel extends ItemView {
  plugin: DmScreenPlugin;

  // Manual initiative state
  manualCombatants: ManualCombatant[] = [];
  currentTurn = 0;
  manualRound = 1;

  // render() empties the container, so the Add row's inputs — and the values
  // the DM has typed into them — are destroyed and rebuilt. Holding the draft
  // here instead of only in the DOM is what survives a render, and it is what
  // the + button reads: the input nodes its handler closed over may already
  // have been replaced by the time the click arrives.
  private addCombatantDraft = { name: "", initiative: "", hp: "" };

  // Plugin-synced initiative state
  trackerSource: "manual" | "plugin" = "manual";
  pluginCombatants: TrackerCombatant[] = [];
  pluginRound = 0;
  encounterName = "";

  // Image layers state
  imageLayers: ImageLayer[] = [];
  private nextZIndex = 1;
  private nextLayerSeq = 1;
  private activeVideoPath: string | null = null;
  activeBackgroundUrl: string | null = null;
  private static LAYER_COLORS = [
    "#e74c3c", "#3498db", "#2ecc71", "#f39c12",
    "#9b59b6", "#1abc9c", "#e67e22", "#34495e",
  ];

  // Per-layer fog drawing state
  private fogEditLayerId: string | null = null;
  // The layer whose controls are open while the panel is narrow enough to
  // show them one at a time.
  private expandedLayerId: string | null = null;
  private fogTool: "reveal-circle" | "reveal-rect" | "reveal-eraser" | "fog-circle" | "fog-rect" | "fog-pen" = "reveal-rect";
  private fogCanvases = new Map<string, HTMLCanvasElement>(); // layer id → offscreen fog canvas
  private static FOG_RESOLUTION = 1024; // fog canvas width (height scales with aspect)

  // Player viewport (what players see) — synced to player screen
  private playerPanX = 0; // percentage
  private playerPanY = 0;
  private playerZoom = 1;

  // DM preview zoom (local only, not sent to players)
  private dmZoom = 1;
  private dmPanX = 0;
  private dmPanY = 0;

  // Connected player screens info
  connectedClients: ClientInfo[] = [];
  playerConnected = false;
  private selectedResolution: { width: number; height: number } | null = null;

  // Map screen (second endpoint) state + rendering
  mapPanel: MapScreenPanel;

  get playerScreenWidth(): number {
    return this.connectedClients.length > 0 ? this.connectedClients[0].width : 0;
  }

  get playerScreenHeight(): number {
    return this.connectedClients.length > 0 ? this.connectedClients[0].height : 0;
  }

  private getEffectiveResolution(): { width: number; height: number } {
    if (this.selectedResolution) {
      const hasMatch = this.connectedClients.some(
        c => c.width === this.selectedResolution!.width && c.height === this.selectedResolution!.height
      );
      if (hasMatch) return this.selectedResolution;
      this.selectedResolution = null;
    }
    if (this.connectedClients.length > 0) {
      return { width: this.connectedClients[0].width, height: this.connectedClients[0].height };
    }
    return { width: this.plugin.settings.tvWidth || 1920, height: this.plugin.settings.tvHeight || 1080 };
  }

  // D&D Beyond integration
  private combatTab: "initiative" | "dndbeyond" = "initiative";
  private ddbPanel: DnDBeyondPanel | null = null;

  // UI state
  expandedCreature: string | null = null;
  private renderDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private saveStateTimer: ReturnType<typeof setTimeout> | null = null;
  private layerGeometryTimer: ReturnType<typeof setTimeout> | null = null;
  private panZoomAbort: AbortController | null = null;
  restored: Promise<void> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: DmScreenPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.mapPanel = new MapScreenPanel(plugin, this);
  }

  getViewType(): string {
    return DM_CONTROL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "DM Control Panel";
  }

  getIcon(): string {
    return "monitor";
  }

  setBackgroundLabel(label: SourceLabel | null) {
    const labels = this.plugin.sourceLabels();
    if (label) {
      labels.background = label;
    } else {
      delete labels.background;
    }
    void this.plugin.saveSettings();
  }

  private escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.fogEditLayerId) {
      this.fogEditLayerId = null;
      this.render();
    }
  };

  async onOpen() {
    debug("DmControlPanel: onOpen");
    document.addEventListener("keydown", this.escHandler);
    // Survives render() (which only empties children, not contentEl's listeners).
    this.contentEl.addEventListener("focusout", this.flushPendingRender);
    // DM-side viewport is session-scoped: reset to 100% / 0,0 on every open,
    // even if the same view instance is reopened (see
    // .agent/features/image-layers/persistence.md → Non-goals).
    this.dmZoom = 1;
    this.dmPanX = 0;
    this.dmPanY = 0;
    this.restored = this.restoreState();
    this.render();
    await this.restored;
  }

  async onClose() {
    debug("DmControlPanel: onClose");
    document.removeEventListener("keydown", this.escHandler);
    this.panZoomAbort?.abort();
    this.panZoomAbort = null;
    this.mapPanel.disconnectPreviewObserver();
    if (this.layerGeometryTimer) {
      clearTimeout(this.layerGeometryTimer);
      this.layerGeometryTimer = null;
    }
    if (this.ddbPanel) {
      this.ddbPanel.destroy();
      this.ddbPanel = null;
    }
    this.saveState();
  }

  private getPlayerViewport(): { vpW: number; vpH: number; vpX: number; vpY: number } | null {
    const eff = this.getEffectiveResolution();
    if (eff.width <= 0 || eff.height <= 0) return null;
    const tvW = eff.width;
    const tvH = eff.height;
    const browserW = this.playerScreenWidth || tvW;
    const browserH = this.playerScreenHeight || tvH;
    const browserAspect = browserW / browserH;
    const previewAspect = tvW / tvH;
    let vpW: number, vpH: number;
    if (browserAspect > previewAspect) {
      vpW = 100 / this.playerZoom;
      vpH = (100 / this.playerZoom) * (previewAspect / browserAspect);
    } else {
      vpW = (100 / this.playerZoom) * (browserAspect / previewAspect);
      vpH = 100 / this.playerZoom;
    }
    const vpX = -this.playerPanX + (100 - vpW) / 2;
    const vpY = -this.playerPanY + (100 - vpH) / 2;
    return { vpW, vpH, vpX, vpY };
  }

  private async restoreState() {
    const s = this.plugin.settings;
    if (s.lastPlayerScreenWidth > 0) {
      this.connectedClients = [{ width: s.lastPlayerScreenWidth, height: s.lastPlayerScreenHeight, devicePixelRatio: 1 }];
      this.playerConnected = true;
    }
    if (!this.plugin.sessionIsLocal()) {
      // The server's hello rebuilds this panel; data.json holds the last
      // embedded session and must not be shown over the remote one.
      debug("DmControlPanel: restoreState skipped — the server owns the session");
      return;
    }
    try {
      const layers = JSON.parse(s.lastImageLayers);
      if (Array.isArray(layers) && layers.length > 0) {
        this.imageLayers = layers;
        this.nextZIndex = Math.max(...layers.map((l: ImageLayer) => l.zIndex)) + 1;
      }
    } catch { /* ignore */ }

    const bgCache = s.lastBroadcastCache?.["show-background-media"];
    if (bgCache) {
      try {
        const msg = JSON.parse(bgCache);
        this.activeBackgroundUrl = msg.payload?.url ?? null;
      } catch { /* ignore */ }
    }

    await this.checkAndRecoverBackground();
    await this.mapPanel.restoreFromCache(s.lastBroadcastCache ?? {});

    debug(
      "DmControlPanel: restoreState — layers:", this.imageLayers.length,
      "cache entries:", Object.keys(s.lastBroadcastCache ?? {}).length,
      "bg:", this.activeBackgroundUrl ?? "(none)"
    );
    if (this.plugin.transport.isLive() && this.imageLayers.length > 0) {
      this.broadcastImageLayers();
    }
  }

  private async checkAndRecoverBackground() {
    if (!this.activeBackgroundUrl) return;

    const result = await recoverVaultImage(this.plugin, this.activeBackgroundUrl);

    if (result === "ok") return;

    if (result === "recovered") {
      debug("DmControlPanel: recovered missing background");
      this.render();
      return;
    }

    const savedLabel = this.plugin.sourceLabels().background;
    const label = savedLabel ? savedLabel.label : resolveSourceLabel({ url: this.activeBackgroundUrl, plugin: this.plugin }).label;
    new Notice(`Background "${label}" is no longer available`);
    this.activeBackgroundUrl = null;
    this.activeVideoPath = null;
    this.setBackgroundLabel(null);

    this.plugin.replayCache.forget(["show-background-media"]);
    this.render();
  }

  async republishToServer() {
    if (!this.plugin.transport.isLive()) return;
    if (this.restored) await this.restored;
    if (this.imageLayers.length > 0) {
      debug("DmControlPanel: republishToServer — layers:", this.imageLayers.length);
      this.broadcastImageLayers();
    }
    if (this.activeBackgroundUrl) {
      debug("DmControlPanel: republishToServer — background:", this.activeBackgroundUrl);
      const mediaType = isVideoBackgroundUrl(this.activeBackgroundUrl) ? "video" : "image";
      this.plugin.broadcast({
        type: "show-background-media",
        payload: { url: this.activeBackgroundUrl, mediaType },
      });
    }
    await this.mapPanel.republish();
  }

  saveState() {
    if (this.saveStateTimer) {
      clearTimeout(this.saveStateTimer);
      this.saveStateTimer = null;
    }
    const s = this.plugin.settings;
    // Last known, not current: an offline session previews at the size of the
    // screen that was last seen, so a disconnect must not reset it.
    if (this.connectedClients[0]) {
      s.lastPlayerScreenWidth = this.connectedClients[0].width;
      s.lastPlayerScreenHeight = this.connectedClients[0].height;
    }
    const map = this.mapPanel.mapClients[0];
    if (map) s.lastMapScreenClient = { width: map.width, height: map.height, devicePixelRatio: map.devicePixelRatio };
    if (this.plugin.sessionIsLocal()) s.lastImageLayers = JSON.stringify(this.imageLayers);
    this.plugin.saveSettings();
  }

  // Coalesces bursty broadcasts (drag, fog draw, scale slider…) into a
  // single write. Without this, each broadcastImageLayers fires saveState
  // synchronously, JSON-stringifying ~1 MB of layer data and writing it to
  // disk every frame.
  scheduleSaveState() {
    if (this.saveStateTimer) return;
    this.saveStateTimer = setTimeout(() => {
      this.saveStateTimer = null;
      this.saveState();
    }, 1000);
  }

  // Called from main.ts when a player or map screen browser connects or resizes
  onPlayerConnected(clients: ClientInfo[]) {
    const wasConnected = this.playerConnected;
    const players = clients.filter((c) => c.channel !== "map");
    const maps = clients.filter((c) => c.channel === "map");
    const mapCountChanged = maps.length !== this.mapPanel.mapClients.length;
    this.connectedClients = players;
    this.mapPanel.mapClients = maps;
    this.playerConnected = players.length > 0;
    debug("DmControlPanel: onPlayerConnected — players:", players.length, "maps:", maps.length, "was:", wasConnected);
    if (clients.length > 0) this.scheduleSaveState();
    if ((!wasConnected && this.playerConnected) || mapCountChanged) {
      this.debouncedRender();
    } else {
      this.updateViewportRect();
    }
  }

  private updateViewportRect() {
    const existing = this.contentEl.querySelector(".dm-player-viewport-rect") as HTMLElement;
    if (existing) {
      // Recalculate rect based on player screen vs preview aspect ratios
      // For now just trigger a lightweight re-render of the rect
      this.debouncedRender();
    }
  }

  // Called from main.ts when Initiative Tracker fires save-state
  syncFromInitiativeTracker(combatants: TrackerCombatant[], round: number, encounterName: string) {
    this.trackerSource = "plugin";
    this.pluginCombatants = combatants;
    this.pluginRound = round;
    this.encounterName = encounterName;

    // Preserve expanded creature if still present
    if (this.expandedCreature) {
      const stillExists = combatants.some(c => c.name === this.expandedCreature);
      if (!stillExists) this.expandedCreature = null;
    }

    this.debouncedRender();
  }

  // Called from main.ts when Initiative Tracker stops
  disconnectFromTracker() {
    this.trackerSource = "manual";
    this.pluginCombatants = [];
    this.pluginRound = 0;
    this.encounterName = "";
    this.expandedCreature = null;
    this.render();
  }

  private pendingBackgroundRender = false;

  debouncedRender() {
    if (this.renderDebounceTimer) clearTimeout(this.renderDebounceTimer);
    this.renderDebounceTimer = setTimeout(() => this.renderFromBackground(), 100);
  }

  private dragDepth = 0;

  // A preview drag holds its stage in closures bound to the document. render()
  // empties the container, so a background render landing mid-drag detaches
  // that stage; a detached stage measures zero, and the conversion helpers
  // cannot tell that apart from a legitimate scale.
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

  // A background-triggered render (a client connecting/disconnecting) must not
  // wipe the DOM out from under a field the DM is typing in, or out from under
  // a drag in progress. Defer it until the field loses focus or the drag ends;
  // the client-count state is already updated on the view, so the deferred
  // render still shows the current count.
  renderFromBackground() {
    if (this.dragDepth > 0 || this.isEditingPanelField()) {
      this.pendingBackgroundRender = true;
      return;
    }
    this.render();
  }

  private isEditingPanelField(): boolean {
    const active = this.contentEl.ownerDocument.activeElement;
    return (
      active instanceof HTMLElement &&
      (this.contentEl.contains(active) || [...this.combatMirrors].some((m) => m.body.contains(active))) &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
    );
  }

  // focusout names the element about to take focus. While that is another
  // control the DM is still working in this panel, and rendering now would
  // reflow it out from under a click that is only half delivered: pressing a
  // button blurs the field first, so the render lands between the blur and the
  // handler, the control moves, and the click arrives where it used to be.
  // Keep deferring; the next focusout out of the panel flushes it.
  private flushPendingRender = (event?: Event) => {
    const next = (event as FocusEvent | undefined)?.relatedTarget;
    if (next instanceof Node && this.contentEl.contains(next)) return;
    // Focus may hop straight to another panel field; re-check on the next tick.
    setTimeout(() => {
      if (this.pendingBackgroundRender && this.dragDepth === 0 && !this.isEditingPanelField()) {
        this.pendingBackgroundRender = false;
        this.render();
      }
    }, 0);
  };

  render() {
    const container = this.contentEl;
    const scrollTop = container.scrollTop;
    container.empty();
    container.addClass("dm-control-panel");
    const readonly = !this.plugin.canEditSession();
    container.classList.toggle("dm-readonly", readonly);

    this.renderServerSection(container);
    if (readonly) this.renderReadonlyBanner(container);
    // Inert while read-only: nothing below can broadcast or persist, and it
    // cannot take focus either, so the keyboard cannot reach it.
    const session = container.createDiv("dm-session");
    session.inert = readonly;
    this.renderHydrusBar(session);
    this.renderPlayerScreenSection(session);
    this.mapPanel.renderSection(session);
    this.renderInitiativeSection(session);
    for (const mirror of this.combatMirrors) this.renderCombatMirror(mirror);

    this.renderSectionNav(container);

    this.broadcastInitialScale();
    container.scrollTop = scrollTop;
    // The map pan preview sizes itself on the next frame, which can shift
    // content after the synchronous restore — re-apply once it has settled.
    requestAnimationFrame(() => {
      container.scrollTop = scrollTop;
    });
  }

  private navAbort: AbortController | null = null;
  // One word per chip: "Player Screen Server" and "Player Screen" are the same
  // word until the third, and a bar of truncated titles navigates nothing.
  private static readonly NAV_LABELS: Record<string, string> = {
    server: "Server",
    "player-screen": "Player",
    "map-screen": "Map",
    combat: "Combat",
  };

  // A phone shows one section at a time and the panel is a long column, so it
  // gets what a long column needs: a fixed way to jump. The bar is outside the
  // session wrapper, so it still works while the session is read-only — it
  // navigates, it does not edit.
  private renderSectionNav(container: HTMLElement) {
    this.navAbort?.abort();
    const sections = Array.from(container.querySelectorAll<HTMLElement>(".dm-section"));
    if (sections.length < 2) return;

    this.navAbort = new AbortController();
    const { signal } = this.navAbort;
    const nav = container.createDiv("dm-section-nav");
    const chips = sections.map((section) => {
      const title = section.querySelector("h3")?.textContent ?? "Section";
      const key = section.dataset.sectionKey ?? "";
      const label = DmControlPanel.NAV_LABELS[key] ?? title;
      const chip = nav.createEl("button", { cls: "dm-section-chip" });
      // Both labels are in the DOM and the stylesheet picks one: a panel too
      // narrow for four words shows four letters instead of four fragments.
      chip.createSpan({ text: label, cls: "dm-section-chip-full" });
      chip.createSpan({ text: label.slice(0, 1), cls: "dm-section-chip-initial" });
      chip.setAttribute("aria-label", title);
      chip.addEventListener("click", () => {
        // A folded section cannot be read, so jumping to it unfolds it.
        if (this.collapsedSections.delete(key)) section.classList.remove("dm-section-collapsed");
        section.scrollIntoView({ block: "start" });
        markActive(section);
      });
      return { section, chip };
    });
    container.insertBefore(nav, container.firstChild);

    const markActive = (active: HTMLElement) => {
      for (const { section, chip } of chips) chip.toggleClass("dm-section-chip-active", section === active);
    };

    // Read straight from the scroll event rather than through
    // `requestAnimationFrame`: Electron does not run animation frames for a
    // window that is not on screen, and a queued one that never arrived left
    // the bar stuck on whatever it last marked. Four rect reads per scroll
    // cost nothing.
    // Whichever ancestor actually scrolls — the panel on a desktop, something
    // Obsidian owns on mobile.
    const scroller = () => {
      let el: HTMLElement | null = container;
      while (el) {
        if (el.scrollHeight - el.clientHeight > 2) return el;
        el = el.parentElement;
      }
      return null;
    };

    const sync = () => {
      // Nothing to track while the bar is hidden (a panel wide enough to show
      // every section at once).
      if (nav.offsetParent === null) return;
      // The last sections may never reach the top of a panel that runs out of
      // scroll before them, and pressing Combat only to watch Server stay lit
      // says the bar is broken. At the end of the scroll, the end is where
      // you are.
      const sc = scroller();
      if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 2) {
        markActive(chips[chips.length - 1].section);
        return;
      }
      // Measured, not computed from scrollTop and offsetTop: on mobile the
      // element that scrolls is not always the panel, and neither is the
      // sections' offset parent, which left every chip unmarked.
      const line = nav.getBoundingClientRect().bottom;
      let active = chips[0].section;
      for (const { section } of chips) {
        if (section.getBoundingClientRect().top <= line + 8) active = section;
      }
      markActive(active);
    };
    // Captured on the document: a scroll event does not bubble, and the
    // scrolling element here is whichever ancestor Obsidian gave the view.
    document.addEventListener("scroll", sync, { signal, passive: true, capture: true });
    // The panel opens at the top, so the first section is the one being read
    // until a scroll says otherwise.
    markActive(chips[0].section);
  }

  private hasBroadcastInitialScale = false;

  private broadcastInitialScale() {
    if (this.hasBroadcastInitialScale) return;
    this.plugin.broadcast({
      type: "combat-scale",
      payload: { scale: this.plugin.settings.combatTrackerScale },
    });
    this.hasBroadcastInitialScale = true;
  }

  private collapsedSections = new Set<string>();

  // Save and Load sit in the section header, beside the collapsible title, so
  // they work while the section is folded and never toggle it.
  renderSceneButtons(header: HTMLElement, kind: "player" | "map", hasContent: boolean): HTMLElement {
    const actions = header.createDiv("dm-section-actions");
    const editable = this.plugin.canEditSession();
    const save = actions.createEl("button", { text: "Save scene", cls: "dm-scene-save-btn" });
    save.disabled = !editable || !hasContent;
    save.addEventListener("click", () => void this.plugin.saveScene(kind));
    const load = actions.createEl("button", { text: "Load scene", cls: "dm-scene-load-btn" });
    load.disabled = !editable;
    load.addEventListener("click", () => void this.plugin.pickScene(kind));
    return actions;
  }

  makeCollapsible(section: HTMLElement, title: HTMLElement, key: string) {
    title.classList.add("dm-section-toggle");
    section.dataset.sectionKey = key;
    if (this.collapsedSections.has(key)) section.classList.add("dm-section-collapsed");
    title.addEventListener("click", () => {
      const collapsed = !this.collapsedSections.delete(key);
      if (collapsed) this.collapsedSections.add(key);
      section.classList.toggle("dm-section-collapsed", collapsed);
    });
  }

  // ─── Server Section ─────────────────────────────────────────────────

  private renderReadonlyBanner(container: HTMLElement) {
    const remote = this.plugin.remote;
    if (!remote) return;
    const banner = container.createDiv("dm-readonly-banner");
    if (remote.status === "readonly") {
      const holder = remote.holder?.name ?? "another device";
      banner.createSpan({ text: `Read-only — ${holder} has control` });
      const take = banner.createEl("button", { text: "Take control", cls: "dm-take-control-btn mod-cta" });
      take.addEventListener("click", () => new TakeControlModal(this.app, holder, () => remote.claim()).open());
    } else {
      banner.createSpan({ text: remote.status === "connecting" ? "Reconnecting…" : "Disconnected — press Connect to control the session" });
    }
  }

  private renderRemoteServerSection(section: HTMLElement) {
    const remote = this.plugin.remote!;
    const statusEl = section.createDiv("dm-server-status");
    const label: Record<string, string> = {
      active: "Connected — this device has control",
      readonly: "Connected — read-only",
      connecting: "Connecting…",
      disconnected: "Disconnected",
    };
    const on = remote.status === "active" || remote.status === "readonly";
    statusEl.createSpan({ text: label[remote.status], cls: on ? "dm-status-on" : "dm-status-off" });
    statusEl.createSpan({ text: ` · ${this.plugin.settings.remoteServerUrl || "no server URL set"}`, cls: "dm-status-detail" });
    const btn = section.createEl("button", { text: remote.status === "disconnected" ? "Connect" : "Disconnect", cls: "mod-cta" });
    btn.addEventListener("click", () => {
      this.plugin.toggleServer();
      this.render();
    });
  }

  // Remote mode: rebuild every section from the session cache the server
  // handed over. Layer images and fog come back as data URLs, as in embedded
  // mode, so the editing tools and webhooks keep working on them.
  // The mirror of reloadFromSession for the local session: used when the DM
  // leaves remote mode, so nothing of the server's scene lingers.
  async reloadFromLocal(): Promise<void> {
    this.imageLayers = [];
    this.activeBackgroundUrl = null;
    this.activeVideoPath = null;
    this.mapPanel.resetForSession();
    this.restored = this.restoreState();
    await this.restored;
    this.render();
  }

  async reloadFromSession(): Promise<void> {
    const remote = this.plugin.remote;
    if (!remote) return;
    const cache = this.plugin.replayCache.toRecord();
    const payload = (type: string): any => {
      try {
        return cache[type] ? JSON.parse(cache[type]).payload : undefined;
      } catch {
        return undefined;
      }
    };
    try {
      const geometry = new Map<string, Record<string, unknown>>(
        ((payload("image-layers-geometry")?.layers ?? []) as Array<Record<string, unknown>>).map((g) => [String(g.id), g])
      );
      const raw = (payload("image-layers-sync")?.layers ?? []) as ImageLayer[];
      this.imageLayers = await Promise.all(
        raw.map(async (l) => ({
          ...l,
          ...(geometry.get(l.id) ?? {}),
          source: remote.sourceOf(l.dataUrl) ?? undefined,
          dataUrl: await remote.fetchDataUrl(l.dataUrl),
          fogDataUrl: l.fogDataUrl ? await remote.fetchDataUrl(l.fogDataUrl) : "",
        }))
      );
    } catch (e) {
      new Notice(`Could not load the session's layers: ${(e as Error).message}`, 8000);
      this.imageLayers = [];
    }
    if (this.imageLayers.length > 0) this.nextZIndex = Math.max(...this.imageLayers.map((l) => l.zIndex)) + 1;
    this.activeBackgroundUrl = payload("show-background-media")?.url ?? null;
    this.activeVideoPath = null;
    this.mapPanel.resetForSession();
    await this.mapPanel.restoreFromCache(cache);
    if (this.mapPanel.fogDataUrl?.startsWith("/assets/")) {
      try {
        this.mapPanel.fogDataUrl = await remote.fetchDataUrl(this.mapPanel.fogDataUrl);
      } catch {
        this.mapPanel.fogDataUrl = null;
      }
    }
    debug("DmControlPanel: reloadFromSession — layers:", this.imageLayers.length, "bg:", this.activeBackgroundUrl ?? "(none)");
    this.render();
  }

  private renderServerSection(container: HTMLElement) {
    const section = container.createDiv("dm-section");
    const title = section.createEl("h3", { text: this.plugin.remote ? "Remote Server" : "Player Screen Server" });
    this.makeCollapsible(section, title, "server");
    if (this.plugin.remote) {
      this.renderRemoteServerSection(section);
      return;
    }

    const isRunning = !!this.plugin.server;
    const statusEl = section.createDiv("dm-server-status");
    statusEl.createSpan({
      text: isRunning ? "Running" : "Stopped",
      cls: isRunning ? "dm-status-on" : "dm-status-off",
    });

    if (isRunning) {
      statusEl.createSpan({
        text: ` on port ${this.plugin.settings.serverPort}`,
        cls: "dm-status-detail",
      });
    }

    const serverBtn = section.createEl("button", {
      text: isRunning ? "Stop Server" : "Start Server",
      cls: "mod-cta",
    });
    serverBtn.addEventListener("click", () => {
      this.plugin.toggleServer();
      this.render();
    });
  }

  // Standalone bar between sections: always visible, never collapsible.
  private renderHydrusBar(container: HTMLElement) {
    // Whoever provides Hydrus decides: this device's settings in embedded
    // mode, the server's in remote mode.
    if (!this.plugin.gateway.capabilities().hydrus) return;
    const bar = container.createDiv("dm-hydrus-bar");
    const hydrusBtn = bar.createEl("button", { text: "Media from Hydrus" });
    hydrusBtn.addEventListener("click", async () => {
      try {
        const { HydrusExplorerModal } = await import("./HydrusExplorerModal");
        new HydrusExplorerModal(this.plugin.app, this.plugin).open();
      } catch (err) {
        debugError("Hydrus modal failed:", err);
      }
    });
  }

  // ─── Player Screen Section ──────────────────────────────────────────

  private renderPlayerScreenSection(container: HTMLElement) {
    const section = container.createDiv("dm-section");
    const header = section.createDiv("dm-section-header");
    const title = header.createEl("h3", { text: "Player Screen" });
    this.makeCollapsible(section, title, "player-screen");
    this.renderSceneButtons(header, "player", !!this.activeBackgroundUrl || this.imageLayers.length > 0);

    const join = this.plugin.transport.joinLink("/");
    if (join) {
      const joinUrl = join.href;
      const urlRow = section.createDiv("dm-server-url");
      const link = urlRow.createEl("a", {
        text: `Player: ${join.text}`,
        href: joinUrl,
        cls: "dm-server-url-link",
      });
      link.setAttr("target", "_blank");
      const copyBtn = urlRow.createEl("button", { text: "Copy", cls: "dm-copy-url-btn" });
      copyBtn.addEventListener("click", () => {
        void navigator.clipboard.writeText(joinUrl);
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
      });

      if (this.connectedClients.length > 0) {
        const clientInfo = section.createDiv("dm-client-info");
        clientInfo.createSpan({
          text: `${this.connectedClients.length} screen${this.connectedClients.length > 1 ? "s" : ""} connected`,
          cls: "dm-status-detail",
        });

        const resMap = new Map<string, { width: number; height: number; count: number }>();
        for (const c of this.connectedClients) {
          const key = `${c.width}×${c.height}`;
          const existing = resMap.get(key);
          if (existing) existing.count++;
          else resMap.set(key, { width: c.width, height: c.height, count: 1 });
        }

        const eff = this.getEffectiveResolution();
        for (const [key, info] of resMap) {
          const label = info.count > 1 ? `${key} ×${info.count}` : key;
          const badge = clientInfo.createSpan({ text: label, cls: "dm-client-resolution" });
          if (info.width === eff.width && info.height === eff.height) {
            badge.addClass("dm-client-resolution-active");
          }
          badge.addEventListener("click", () => {
            this.selectedResolution = { width: info.width, height: info.height };
            this.render();
          });
        }
      }
    }

    // Button row
    const btnRow = section.createDiv("dm-layer-btn-row");

    const addLayerBtn = btnRow.createEl("button", {
      text: "Add Image",
      cls: "mod-cta",
    });
    addLayerBtn.addEventListener("click", (evt: MouseEvent) => void this.showImagePicker(evt));

    const addBgBtnLabel = this.activeBackgroundUrl ? "Stop BG" : "Add BG";
    const addBgBtn = btnRow.createEl("button", {
      text: addBgBtnLabel,
      cls: this.activeBackgroundUrl ? "" : "mod-cta",
    });
    addBgBtn.addEventListener("click", (evt: MouseEvent) => {
      if (this.activeBackgroundUrl) {
        this.activeBackgroundUrl = null;
        this.activeVideoPath = null;
        this.setBackgroundLabel(null);
        this.plugin.broadcast({ type: "hide-background-media", payload: {} });
        this.render();
      } else {
        void this.showBackgroundPicker(evt);
      }
    });

    // Preview area with pan/zoom — always use configured TV size for stable layout
    const { width: tvW, height: tvH } = this.getEffectiveResolution();
    const previewArea = section.createDiv("dm-layer-preview");
    previewArea.style.aspectRatio = `${tvW} / ${tvH}`;

    // Inner container for pan/zoom transform (DM local view)
    const previewInner = previewArea.createDiv("dm-layer-preview-inner");
    previewInner.style.transform = `translate(${this.dmPanX}%, ${this.dmPanY}%) scale(${this.dmZoom})`;

    // Background media preview — same geometry as the green viewport rect.
    // With no screen ever seen it previews at the configured TV size, so a
    // background can be set up before the server or the TV is on.
    const effForBg = this.getEffectiveResolution();
    const activeClient = this.connectedClients.length === 0
      ? effForBg
      : this.connectedClients.find(c => c.width === effForBg.width && c.height === effForBg.height);
    if (this.activeBackgroundUrl && activeClient && activeClient.width > 0 && activeClient.height > 0) {
      const bgUrl = this.plugin.transport.displayUrl(this.activeBackgroundUrl);
      if (bgUrl) {
        const browserAspect = activeClient.width / activeClient.height;
        const previewAspect = tvW / tvH;
        let bgW: number, bgH: number;
        if (browserAspect > previewAspect) {
          bgW = 100 / this.playerZoom;
          bgH = (100 / this.playerZoom) * (previewAspect / browserAspect);
        } else {
          bgW = (100 / this.playerZoom) * (browserAspect / previewAspect);
          bgH = 100 / this.playerZoom;
        }
        const bgX = -this.playerPanX + (100 - bgW) / 2;
        const bgY = -this.playerPanY + (100 - bgH) / 2;
        const bgWrap = previewInner.createDiv("dm-preview-bg");
        bgWrap.style.left = `${bgX}%`;
        bgWrap.style.top = `${bgY}%`;
        bgWrap.style.width = `${bgW}%`;
        bgWrap.style.height = `${bgH}%`;
        if (isVideoBackgroundUrl(bgUrl)) {
          const v = bgWrap.createEl("video");
          v.src = bgUrl;
          v.muted = true;
          v.loop = true;
          v.autoplay = true;
          v.playsInline = true;
          v.addEventListener("error", () => {
            bgWrap.empty();
            const placeholder = bgWrap.createDiv("dm-image-unavailable");
            placeholder.textContent = "Image unavailable";
          });
          v.play().catch(() => {});
        } else {
          const img = bgWrap.createEl("img");
          img.src = bgUrl;
          img.alt = "";
          img.addEventListener("error", () => {
            bgWrap.empty();
            const placeholder = bgWrap.createDiv("dm-image-unavailable");
            placeholder.textContent = "Image unavailable";
          });
        }

        const savedLabel = this.plugin.sourceLabels().background;
        const sourceLabel = savedLabel || resolveSourceLabel({ url: this.activeBackgroundUrl, plugin: this.plugin });
        const labelChip = bgWrap.createDiv("dm-source-label");
        labelChip.textContent = sourceLabel.label;
        labelChip.title = sourceLabel.title;
      }
    }

    // Draw image layer rectangles (sorted by zIndex ascending)
    const sorted = [...this.imageLayers].sort((a, b) => a.zIndex - b.zIndex);
    for (const layer of sorted) {
      const colorIdx = this.imageLayers.indexOf(layer) % DmControlPanel.LAYER_COLORS.length;
      const color = DmControlPanel.LAYER_COLORS[colorIdx];
      const rect = previewInner.createDiv("dm-layer-rect");
      rect.setAttribute("data-id", layer.id);
      rect.style.left = `${layer.x}%`;
      rect.style.top = `${layer.y}%`;
      rect.style.width = `${layer.width}%`;
      rect.style.height = `${layer.height}%`;
      rect.style.zIndex = String(layer.zIndex);
      if (layer.rotation) {
        rect.style.transform = `rotate(${layer.rotation}deg)`;
      }
      rect.title = layer.label;
      if (!layer.visible) rect.style.opacity = "0.25";

      // Frame: holds the colored border, image, fog overlay, and fog-edit
      // canvas. Sized at image-load time to the visible image rect inside
      // the broadcast wrapper (mirrors the player-side .image-layer-frame)
      // so the border hugs the visible content instead of the wrapper.
      const frame = rect.createDiv("dm-layer-rect-frame");
      frame.style.backgroundImage = `url(${layer.dataUrl})`;
      frame.style.backgroundSize = "100% 100%";
      frame.style.backgroundPosition = "center";
      frame.style.backgroundRepeat = "no-repeat";
      frame.style.borderColor = color;
      if (!layer.visible) frame.style.borderStyle = "dashed";

      const sizeFrame = () => {
        const bounds = rect.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        if (!frameImg.naturalWidth || !frameImg.naturalHeight) return;
        const imgAspect = frameImg.naturalWidth / frameImg.naturalHeight;
        const rectAspect = bounds.width / bounds.height;
        if (imgAspect >= rectAspect) {
          frame.style.width = "100%";
          frame.style.height = `${(rectAspect / imgAspect) * 100}%`;
        } else {
          frame.style.height = "100%";
          frame.style.width = `${(imgAspect / rectAspect) * 100}%`;
        }
      };
      const frameImg = new Image();
      frameImg.onload = () => requestAnimationFrame(sizeFrame);
      frameImg.src = layer.dataUrl;
      requestAnimationFrame(sizeFrame);

      // Fog overlay (inside frame so it aligns with the image)
      if (layer.fogEnabled && layer.fogDataUrl) {
        const fogOverlay = frame.createDiv("dm-layer-fog-overlay");
        fogOverlay.style.backgroundImage = `url(${layer.fogDataUrl})`;
      }

      // Fog drawing canvas (inside frame, sized to the visible image)
      if (this.fogEditLayerId === layer.id) {
        rect.addClass("dm-fog-editing");
        const fogDrawCanvas = frame.createEl("canvas", { cls: "dm-fog-draw-canvas-inline" });
        setTimeout(() => this.initInlineFogCanvas(fogDrawCanvas, layer, frame), 0);
      }

      rect.createSpan({ cls: "dm-layer-rect-label", text: layer.label });

      if (this.fogEditLayerId !== layer.id) {
        this.makeDraggable(rect, layer, previewInner);
      }
    }

    // Player viewport indicator (green rectangle): only shown when exactly one
    // client is connected — multi-client viewports are ambiguous.
    const singleClient = this.connectedClients.length === 1 ? this.connectedClients[0] : null;
    const vp = singleClient && singleClient.width > 0 && singleClient.height > 0
      ? this.getPlayerViewport()
      : null;
    if (vp) {
      const vpRect = previewInner.createDiv("dm-player-viewport-rect");
      vpRect.style.left = `${vp.vpX}%`;
      vpRect.style.top = `${vp.vpY}%`;
      vpRect.style.width = `${vp.vpW}%`;
      vpRect.style.height = `${vp.vpH}%`;

      // Scale visibility with zoom — more prominent when zoomed out further.
      // Divide by dmZoom to compensate for the CSS transform scale on previewInner.
      const zoomFactor = Math.max(0, Math.min(1, 1 - this.dmZoom));
      const baseBorder = 2 + zoomFactor * 4;
      const borderWidth = baseBorder / this.dmZoom;
      const fillOpacity = 0.02 + zoomFactor * 0.2;
      vpRect.style.borderWidth = `${borderWidth}px`;
      vpRect.style.backgroundColor = `rgba(0, 255, 0, ${fillOpacity})`;
    }

    // Pan via middle-click drag on preview
    this.setupPreviewPanZoom(previewArea, previewInner);

    // Zoom controls inside the preview (overlay, top-right — mirrors the map panel)
    const zoomControls = previewArea.createDiv("dm-preview-zoom-controls");
    zoomControls.addEventListener("pointerdown", (e: PointerEvent) => e.stopPropagation());

    const zoomSlider = zoomControls.createEl("input", { type: "range", cls: "dm-zoom-slider" });
    zoomSlider.min = "67";
    zoomSlider.max = "100";
    zoomSlider.step = "1";
    zoomSlider.value = String(Math.round(this.dmZoom * 100));
    zoomSlider.title = "Preview zoom — max: player view, min: zoomed out with surroundings";
    zoomSlider.addEventListener("input", () => {
      this.dmZoom = parseInt(zoomSlider.value, 10) / 100;
      previewInner.style.transform = `translate(${this.dmPanX}%, ${this.dmPanY}%) scale(${this.dmZoom})`;
    });

    const resetBtn = zoomControls.createEl("button", { text: "Reset View", cls: "dm-preview-reset-btn" });
    resetBtn.addEventListener("click", () => this.resetDmView());

    // ── Layer list ──
    if (this.imageLayers.length > 0) {
      const list = section.createDiv("dm-layer-list");

      const byZ = [...this.imageLayers].sort((a, b) => b.zIndex - a.zIndex);
      for (const layer of byZ) {
        const colorIdx = this.imageLayers.indexOf(layer) % DmControlPanel.LAYER_COLORS.length;
        const color = DmControlPanel.LAYER_COLORS[colorIdx];
        const row = list.createDiv("dm-layer-row");
        if (!layer.visible) row.addClass("dm-layer-hidden");
        // A narrow panel shows one line per layer and reveals its controls on
        // demand (the stylesheet decides; a wide panel shows everything, as
        // before). One layer is open at a time, so the list stays scannable.
        if (this.expandedLayerId === layer.id) row.addClass("dm-layer-expanded");

        row.addEventListener("contextmenu", (evt: MouseEvent) => {
          evt.preventDefault();
          this.openLayerContextMenu(evt, layer);
        });
        // The same menu for a finger, which has no second button. A
        // `PointerEvent` is a `MouseEvent`, so Obsidian places the menu at the
        // press like it does for a right-click.
        onLongPress(row, (evt) => this.openLayerContextMenu(evt, layer));

        // Left column: eye on top (full width), fog + border side-by-side below
        const leftCol = row.createDiv("dm-layer-left-col");

        const visBtn = leftCol.createEl("button", {
          text: layer.visible ? "\u{1F441}" : "\u{1F441}\u200D\u{1F5E8}",
          cls: `dm-layer-btn dm-layer-vis-toggle ${layer.visible ? "dm-layer-vis-on" : "dm-layer-vis-off"}`,
        });
        visBtn.addEventListener("click", () => {
          layer.visible = !layer.visible;
          this.broadcastAndRender();
        });

        const bottomRow = leftCol.createDiv("dm-layer-left-bottom");

        const fogBtn = bottomRow.createEl("button", {
          cls: `dm-layer-btn dm-fog-toggle ${layer.fogEnabled ? "dm-fog-active" : ""}`,
        });
        fogBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="${layer.fogEnabled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`;
        fogBtn.title = layer.fogEnabled ? "Fog of War ON" : "Fog of War OFF";
        fogBtn.addEventListener("click", () => {
          layer.fogEnabled = !layer.fogEnabled;
          if (layer.fogEnabled && !layer.fogDataUrl) {
            this.initFogCanvas(layer);
          }
          if (layer.fogEnabled) {
            this.fogEditLayerId = layer.id;
          } else {
            if (this.fogEditLayerId === layer.id) this.fogEditLayerId = null;
            layer.fogDataUrl = "";
          }
          this.broadcastAndRender();
        });

        const bordered = layer.bordered !== false;
        const borderBtn = bottomRow.createEl("button", {
          cls: `dm-layer-btn dm-border-toggle ${bordered ? "dm-border-active" : ""}`,
        });
        borderBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${bordered ? "2.5" : "1.5"}"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`;
        borderBtn.title = bordered ? "Border ON" : "Border OFF";
        borderBtn.addEventListener("click", () => {
          layer.bordered = !bordered;
          this.broadcastAndRender();
        });

        // Middle column: name row + slider row
        const midCol = row.createDiv("dm-layer-mid-col");

        const nameRow = midCol.createDiv("dm-layer-name-row");
        const swatch = nameRow.createDiv("dm-layer-swatch");
        swatch.style.backgroundColor = color;
        nameRow.createSpan({ text: layer.label, cls: "dm-layer-label" });
        const expanded = this.expandedLayerId === layer.id;
        const expandBtn = nameRow.createEl("button", {
          text: expanded ? "\u2304" : "\u203A",
          cls: "dm-layer-expand",
        });
        expandBtn.setAttribute("aria-expanded", String(expanded));
        expandBtn.title = expanded ? "Hide this layer's controls" : "Show this layer's controls";
        // The whole name row is the target: a chevron alone is a small one for
        // a finger, and the row carries nothing else to press.
        nameRow.addEventListener("click", () => {
          this.expandedLayerId = expanded ? null : layer.id;
          this.render();
        });

        const sliderRow = midCol.createDiv("dm-layer-slider-row");
        const scaleLabel = sliderRow.createSpan({ text: `${Math.round(layer.width)}%`, cls: "dm-layer-scale-label" });
        const scaleSlider = sliderRow.createEl("input", {
          type: "range",
          cls: "dm-layer-scale-slider",
        });
        scaleSlider.min = "10";
        scaleSlider.max = "500";
        scaleSlider.value = String(Math.round(layer.width));
        scaleSlider.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            e.preventDefault();
            const current = parseInt(scaleSlider.value, 10);
            let newVal: number;
            if (e.key === "ArrowLeft") {
              newVal = Math.floor((current - 1) / 10) * 10;
            } else {
              newVal = Math.ceil((current + 1) / 10) * 10;
            }
            newVal = Math.max(10, Math.min(500, newVal));
            scaleSlider.value = String(newVal);
            scaleSlider.dispatchEvent(new Event("input"));
          }
        });
        scaleSlider.addEventListener("input", () => {
          const scale = parseInt(scaleSlider.value, 10);
          const centerX = layer.x + layer.width / 2;
          const centerY = layer.y + layer.height / 2;
          const aspectRatio = layer.height / layer.width;
          layer.width = scale;
          layer.height = scale * aspectRatio;
          layer.x = centerX - layer.width / 2;
          layer.y = centerY - layer.height / 2;
          scaleLabel.textContent = `${scale}%`;
          this.broadcastLayerGeometry();
          const previewRect = this.contentEl.querySelector(`.dm-layer-rect[data-id="${layer.id}"]`) as HTMLElement;
          if (previewRect) {
            previewRect.style.left = `${layer.x}%`;
            previewRect.style.top = `${layer.y}%`;
            previewRect.style.width = `${layer.width}%`;
            previewRect.style.height = `${layer.height}%`;
          }
        });
        scaleSlider.addEventListener("change", () => this.broadcastImageLayers());

        // Right column: two button rows
        const rightCol = row.createDiv("dm-layer-right-col");

        const controls = rightCol.createDiv("dm-layer-controls");

        const rotLeftBtn = controls.createEl("button", { text: "\u21BA", cls: "dm-layer-btn" });
        rotLeftBtn.addEventListener("click", () => {
          layer.rotation = (layer.rotation - 15) % 360;
          this.broadcastAndRender();
        });

        const rotRightBtn = controls.createEl("button", { text: "\u21BB", cls: "dm-layer-btn" });
        rotRightBtn.addEventListener("click", () => {
          layer.rotation = (layer.rotation + 15) % 360;
          this.broadcastAndRender();
        });

        const upBtn = controls.createEl("button", { text: "\u25B2", cls: "dm-layer-btn" });
        upBtn.addEventListener("click", () => {
          this.moveLayerUp(layer);
        });

        const downBtn = controls.createEl("button", { text: "\u25BC", cls: "dm-layer-btn" });
        downBtn.addEventListener("click", () => {
          this.moveLayerDown(layer);
        });

        const removeBtn = controls.createEl("button", { text: "\u2715", cls: "dm-layer-btn dm-layer-remove" });
        removeBtn.addEventListener("click", () => {
          this.fogCanvases.delete(layer.id);
          if (this.fogEditLayerId === layer.id) this.fogEditLayerId = null;
          this.imageLayers = this.imageLayers.filter(l => l.id !== layer.id);
          this.broadcastAndRender();
        });

        const posRow = rightCol.createDiv("dm-layer-position-row");

        const fitWBtn = posRow.createEl("button", { text: "W", cls: "dm-layer-btn" });
        fitWBtn.title = "Fit to player width";
        fitWBtn.addEventListener("click", () => {
          const vp = this.getPlayerViewport();
          if (!vp) { new Notice("No player connected"); return; }
          const aspectRatio = layer.height / layer.width;
          layer.width = vp.vpW;
          layer.height = vp.vpW * aspectRatio;
          layer.x = vp.vpX;
          layer.y = vp.vpY + (vp.vpH - layer.height) / 2;
          this.broadcastAndRender();
        });

        const fitHBtn = posRow.createEl("button", { text: "H", cls: "dm-layer-btn" });
        fitHBtn.title = "Fit to player height";
        fitHBtn.addEventListener("click", () => {
          const vp = this.getPlayerViewport();
          if (!vp) { new Notice("No player connected"); return; }
          const aspectRatio = layer.width / layer.height;
          layer.height = vp.vpH;
          layer.width = vp.vpH * aspectRatio;
          layer.y = vp.vpY;
          layer.x = vp.vpX + (vp.vpW - layer.width) / 2;
          this.broadcastAndRender();
        });

        const alignLeftBtn = posRow.createEl("button", { text: "\u25c0", cls: "dm-layer-btn" });
        alignLeftBtn.title = "Align to left edge, centre vertically";
        alignLeftBtn.addEventListener("click", () => {
          const vp = this.getPlayerViewport();
          if (!vp) { new Notice("No player connected"); return; }
          layer.x = vp.vpX;
          layer.y = vp.vpY + (vp.vpH - layer.height) / 2;
          this.broadcastAndRender();
        });

        const centerBtn = posRow.createEl("button", { text: "\u25c6", cls: "dm-layer-btn" });
        centerBtn.title = "Centre in viewport";
        centerBtn.addEventListener("click", () => {
          const vp = this.getPlayerViewport();
          if (!vp) { new Notice("No player connected"); return; }
          layer.x = vp.vpX + (vp.vpW - layer.width) / 2;
          layer.y = vp.vpY + (vp.vpH - layer.height) / 2;
          this.broadcastAndRender();
        });

        const alignRightBtn = posRow.createEl("button", { text: "\u25b6", cls: "dm-layer-btn" });
        alignRightBtn.title = "Align to right edge, centre vertically";
        alignRightBtn.addEventListener("click", () => {
          const vp = this.getPlayerViewport();
          if (!vp) { new Notice("No player connected"); return; }
          layer.x = vp.vpX + vp.vpW - layer.width;
          layer.y = vp.vpY + (vp.vpH - layer.height) / 2;
          this.broadcastAndRender();
        });

        // Fog tool selector (always visible when fog is enabled)
        if (layer.fogEnabled) {
          const fogEditor = list.createDiv("dm-fog-editor");

          const editLabel = fogEditor.createDiv("dm-fog-edit-label");
          editLabel.createSpan({ text: "Fog Drawing Tools", cls: "dm-fog-edit-title" });

          // Reveal row (outlined icons)
          const revealRow = fogEditor.createDiv("dm-fog-toolbar");
          revealRow.createSpan({ text: "Reveal:", cls: "dm-fog-tool-label" });

          this.createFogToolBtn(revealRow, "reveal-circle",
            `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>`, layer.id);
          this.createFogToolBtn(revealRow, "reveal-rect",
            `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`, layer.id);
          this.createFogToolBtn(revealRow, "reveal-eraser",
            `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 20H7L3 16l9-9 8 8-4 4z"/><path d="M6.5 13.5L15 5"/></svg>`, layer.id);

          // Fog row (filled icons)
          const fogRow = fogEditor.createDiv("dm-fog-toolbar");
          fogRow.createSpan({ text: "Fog:", cls: "dm-fog-tool-label" });

          this.createFogToolBtn(fogRow, "fog-circle",
            `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>`, layer.id);
          this.createFogToolBtn(fogRow, "fog-rect",
            `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`, layer.id);
          this.createFogToolBtn(fogRow, "fog-pen",
            `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`, layer.id);

          if (this.fogEditLayerId === layer.id) {
            fogEditor.createDiv({ text: "Hold Shift to keep drawing after release.", cls: "dm-fog-hint" });
          }
        }
      }
    }

    // ── Clear all ──
    if (this.imageLayers.length > 0) {
      const clearRow = section.createDiv("dm-layer-btn-row");
      const clearLayersBtn = clearRow.createEl("button", { text: "Clear All Layers" });
      clearLayersBtn.addEventListener("click", () => {
        this.imageLayers = [];
        this.nextZIndex = 1;
        this.broadcastAndRender();
      });
      const clearAllBtn = clearRow.createEl("button", { text: "Clear Player Screen" });
      clearAllBtn.addEventListener("click", () => {
        this.plugin.broadcast({ type: "clear", payload: {} });
        this.imageLayers = [];
        this.nextZIndex = 1;
        this.activeBackgroundUrl = null;
        this.activeVideoPath = null;
        this.setBackgroundLabel(null);
        new Notice("Player screen cleared");
        this.render();
      });
    }
  }

  // ─── Initiative Section ────────────────────────────────────────────

  private renderInitiativeSection(container: HTMLElement) {
    const section = container.createDiv("dm-section");

    // Header: COMBAT title + emit toggle
    const header = section.createDiv("dm-section-header");
    const title = header.createEl("h3", { text: "COMBAT" });
    this.makeCollapsible(section, title, "combat");
    this.renderLiveToggle(header);
    this.renderCombatBody(section, this.combatMirrors.size === 0);
  }

  private combatMirrors = new Set<CombatMirror>();

  // render() repaints every mirror after the panel itself, so a D&D Beyond
  // poll, an Initiative Tracker sync or a turn change reaches both surfaces.
  // While a mirror is registered it owns the single DnDBeyondPanel; the
  // render that follows its disposal (closing the modal refreshes the panel)
  // hands it back to the section.
  registerCombatMirror(mirror: CombatMirror): () => void {
    debug("DmControlPanel: combat mirror registered");
    this.combatMirrors.add(mirror);
    this.render();
    return () => {
      debug("DmControlPanel: combat mirror disposed");
      this.combatMirrors.delete(mirror);
    };
  }

  private renderCombatMirror(mirror: CombatMirror) {
    mirror.body.empty();
    const extra = document.createElement("div");
    this.renderLiveToggle(extra);
    mirror.setTitleExtra(extra);
    this.renderCombatBody(mirror.body, true);
  }

  private renderLiveToggle(parent: HTMLElement) {
    const broadcasting = this.isCombatBroadcasting();
    const emitToggle = parent.createEl("button", {
      cls: broadcasting ? "dm-emit-toggle dm-emit-active" : "dm-emit-toggle",
      attr: {
        "aria-label": broadcasting ? "Stop broadcasting combat" : "No combat being broadcast",
        title: broadcasting ? "Stop broadcasting combat" : "No combat being broadcast",
      },
    });
    emitToggle.createSpan({ cls: "dm-emit-dot", text: "●" });
    emitToggle.createSpan({ cls: "dm-emit-label", text: "Live" });
    if (!broadcasting) {
      (emitToggle as HTMLButtonElement).disabled = true;
    }
    emitToggle.addEventListener("click", () => this.stopAllCombatBroadcast());
  }

  private renderCombatBody(section: HTMLElement, ownsDdbPanel: boolean) {
    // Tabs: Local Track + (optionally) D&D Beyond, full-width
    const ddbActive = this.plugin.gateway.capabilities().ddb;
    const tabBar = section.createDiv("dm-combat-tabs");

    const initTab = tabBar.createEl("button", {
      text: "Local Track",
      cls: !ddbActive || this.combatTab === "initiative" ? "dm-tab-active" : "dm-tab",
    });
    initTab.addEventListener("click", () => {
      this.combatTab = "initiative";
      this.render();
    });

    if (ddbActive) {
      const ddbTab = tabBar.createEl("button", {
        text: "D&D Beyond",
        cls: this.combatTab === "dndbeyond" ? "dm-tab-active" : "dm-tab",
      });
      ddbTab.addEventListener("click", () => {
        this.combatTab = "dndbeyond";
        this.render();
      });
    }

    // Active combat name + scale controls row
    const nameRow = section.createDiv("dm-combat-name-row");
    const combatLabel = this.getActiveCombatLabel();
    if (combatLabel.ddbId) {
      const url = `https://www.dndbeyond.com/encounters/${combatLabel.ddbId}`;
      const link = nameRow.createEl("a", {
        cls: "dm-combat-name dm-combat-name-link",
        text: combatLabel.text,
        attr: { href: url, target: "_blank", rel: "noopener" },
      });
      link.addEventListener("click", (evt) => {
        evt.preventDefault();
        try {
          require("electron").shell.openExternal(url);
        } catch {
          window.open(url, "_blank");
        }
      });
    } else {
      nameRow.createDiv({ cls: "dm-combat-name", text: combatLabel.text });
    }
    const scaleButtons = nameRow.createDiv("dm-tracker-scale-buttons");
    const decBtn = scaleButtons.createEl("button", { text: "−", attr: { title: "Smaller tracker" } });
    decBtn.addEventListener("click", () => this.adjustCombatTrackerScale(-0.1));
    const resetBtn = scaleButtons.createEl("button", { text: "1×", attr: { title: "Reset tracker scale" } });
    resetBtn.addEventListener("click", () => this.setCombatTrackerScale(1));
    const incBtn = scaleButtons.createEl("button", { text: "+", attr: { title: "Larger tracker" } });
    incBtn.addEventListener("click", () => this.adjustCombatTrackerScale(0.1));

    if (ddbActive && this.combatTab === "dndbeyond") {
      if (!ownsDdbPanel) {
        section.createDiv({ cls: "dm-status-detail", text: "D&D Beyond is shown in the Explore window." });
        return;
      }
      const ddbContainer = section.createDiv("dm-ddb-panel");
      if (this.plugin.settings.ddbInspirationPulse) {
        ddbContainer.addClass("dm-inspired-pulse-on");
      }
      if (!this.ddbPanel) {
        this.ddbPanel = new DnDBeyondPanel(this.plugin, ddbContainer);
        this.ddbPanel.onTrackingChange = () => this.debouncedRender();
        this.ddbPanel.initialize();
      } else {
        this.ddbPanel.setContainer(ddbContainer);
      }
    } else {
      if (this.trackerSource === "plugin") {
        this.renderPluginTracker(section);
      } else {
        this.renderManualTracker(section);
      }
    }
  }

  // ─── Combat Broadcasting Helpers ───────────────────────────────────

  isCombatBroadcasting(): boolean {
    if (this.trackerSource === "plugin" && this.pluginCombatants.length > 0) return true;
    if (this.manualCombatants.length > 0) return true;
    if (this.ddbPanel && this.ddbPanel.isTracking()) return true;
    return false;
  }

  stopAllCombatBroadcast(): void {
    debug("DmControlPanel: stopAllCombatBroadcast");
    if (this.ddbPanel) this.ddbPanel.stopTracking();
    this.manualCombatants = [];
    this.currentTurn = 0;
    this.manualRound = 1;
    this.trackerSource = "manual";
    this.pluginCombatants = [];
    this.pluginRound = 0;
    this.encounterName = "";
    this.plugin.sendInitiativeUpdate([], 0);
    this.render();
  }

  private async adjustCombatTrackerScale(delta: number) {
    const current = this.plugin.settings.combatTrackerScale ?? 1;
    const next = Math.round((current + delta) * 10) / 10;
    await this.setCombatTrackerScale(next);
  }

  private async setCombatTrackerScale(value: number) {
    const clamped = clampTrackerScale(value);
    if (clamped === (this.plugin.settings.combatTrackerScale ?? 1)) return;
    this.plugin.settings.combatTrackerScale = clamped;
    await this.plugin.saveSettings();
    this.plugin.broadcast({
      type: "combat-scale",
      payload: { scale: clamped },
    });
  }

  private getActiveCombatLabel(): { text: string; ddbId: string | null } {
    if (this.combatTab === "dndbeyond" && this.ddbPanel) {
      const status = this.ddbPanel.getActiveEncounterStatus();
      if (status) return { text: `${status.name} — Round ${status.roundNum}`, ddbId: status.id };
    }
    if (this.trackerSource === "plugin" && this.encounterName) {
      return { text: `${this.encounterName} — Round ${this.pluginRound}`, ddbId: null };
    }
    return { text: "", ddbId: null };
  }

  // ─── Plugin-Synced Tracker ─────────────────────────────────────────

  private renderPluginTracker(section: HTMLElement) {
    // Header with sync indicator
    const headerRow = section.createDiv("dm-tracker-header");
    const titleCol = headerRow.createDiv("dm-tracker-title-col");
    titleCol.createEl("h3", { text: "Initiative Tracker" });

    const syncBadge = titleCol.createDiv("dm-tracker-sync-badge");
    syncBadge.createSpan({ text: "Synced", cls: "dm-sync-indicator" });
    if (this.encounterName) {
      syncBadge.createSpan({ text: ` — ${this.encounterName}`, cls: "dm-status-detail" });
    }

    const roundBadge = headerRow.createDiv("dm-round-badge");
    roundBadge.textContent = `Round ${this.pluginRound}`;

    // Disconnect button
    const disconnectBtn = section.createEl("button", {
      text: "Disconnect",
      cls: "dm-disconnect-btn",
    });
    disconnectBtn.addEventListener("click", () => {
      this.disconnectFromTracker();
    });

    // Combatant list
    const listEl = section.createDiv("dm-initiative-list");

    if (this.pluginCombatants.length === 0) {
      listEl.createDiv({ text: "No combatants", cls: "dm-empty-tracker" });
      return;
    }

    for (const c of this.pluginCombatants) {
      this.renderPluginCombatantRow(listEl, c);
    }
  }

  private renderPluginCombatantRow(listEl: HTMLElement, c: TrackerCombatant) {
    const rowClasses = ["dm-combatant-row"];
    if (c.active) rowClasses.push("dm-active-turn");
    if (c.hidden) rowClasses.push("dm-combatant-hidden");
    if (c.friendly || c.isPlayer) rowClasses.push("dm-combatant-friendly");

    const wrapper = listEl.createDiv("dm-combatant-wrapper");
    const row = wrapper.createDiv({ cls: rowClasses.join(" ") });

    // Initiative number
    row.createSpan({ text: `${c.initiative}`, cls: "dm-init-num" });

    // Name
    const nameEl = row.createSpan({ text: c.displayName, cls: "dm-combatant-name" });
    if (c.isPlayer) {
      nameEl.createSpan({ text: " (PC)", cls: "dm-pc-badge" });
    }
    if (c.hidden) {
      nameEl.createSpan({ text: " [hidden]", cls: "dm-hidden-badge" });
    }

    this.appendStatusIcons(row, c.statuses);

    // HP display (read-only)
    const hpPercent = c.maxHp > 0 ? Math.max(0, Math.min(100, (c.hp / c.maxHp) * 100)) : 100;
    const hpColor = hpPercent > 50 ? "#4caf50" : hpPercent > 25 ? "#ff9800" : "#f44336";

    const hpContainer = row.createDiv("dm-hp-display");
    const hpBar = hpContainer.createDiv("dm-hp-bar-inline");
    const hpFill = hpBar.createDiv("dm-hp-fill-inline");
    hpFill.style.width = `${hpPercent}%`;
    hpFill.style.background = hpColor;

    hpContainer.createSpan({
      text: `${c.hp}/${c.maxHp}${c.tempHp > 0 ? ` +${c.tempHp}` : ""}`,
      cls: "dm-hp-text",
    });

    // AC
    row.createSpan({ text: `AC ${c.ac}`, cls: "dm-ac-display" });

    // Expand button for statblock
    const expandBtn = row.createEl("button", {
      text: this.expandedCreature === c.name ? "▼" : "▶",
      cls: "dm-expand-btn",
    });
    expandBtn.addEventListener("click", () => {
      this.expandedCreature = this.expandedCreature === c.name ? null : c.name;
      this.render();
    });

    // Expanded statblock panel
    if (this.expandedCreature === c.name) {
      const statblockContainer = wrapper.createDiv("dm-statblock-container");
      if (c.statblock) {
        renderStatblock(statblockContainer, c.statblock);
      } else {
        statblockContainer.createDiv({
          text: "Statblock not found in bestiary",
          cls: "dm-statblock-not-found",
        });
      }
    }
  }

  // ─── Manual Tracker ────────────────────────────────────────────────

  private renderManualTracker(section: HTMLElement) {
    section.createEl("h3", { text: "Initiative Tracker" });

    // Hint about auto-sync
    const hasInitiativeTracker = !!(this.plugin.app as any).plugins?.getPlugin?.("initiative-tracker");
    if (hasInitiativeTracker) {
      const hint = section.createDiv("dm-tracker-hint");
      hint.textContent = "Start an encounter in Initiative Tracker to auto-sync";
    }

    // Add combatant form
    const addRow = section.createDiv("dm-add-combatant");
    const draft = this.addCombatantDraft;
    const nameInput = addRow.createEl("input", { type: "text", placeholder: "Name" });
    nameInput.value = draft.name;
    const initInput = addRow.createEl("input", { type: "number", placeholder: "Init" });
    initInput.value = draft.initiative;
    initInput.style.width = "60px";
    const hpInput = addRow.createEl("input", { type: "number", placeholder: "HP" });
    hpInput.value = draft.hp;
    hpInput.style.width = "60px";

    nameInput.addEventListener("input", () => (draft.name = nameInput.value));
    initInput.addEventListener("input", () => (draft.initiative = initInput.value));
    hpInput.addEventListener("input", () => (draft.hp = hpInput.value));

    const addBtn = addRow.createEl("button", { text: "+", cls: "mod-cta" });
    addBtn.addEventListener("click", () => {
      const name = draft.name.trim();
      const initiative = parseInt(draft.initiative, 10) || 0;
      const hp = parseInt(draft.hp, 10) || 0;
      if (name) {
        this.manualCombatants.push({ name, initiative, hp, maxHp: hp, active: false, statuses: [] });
        this.sortManualCombatants();
        this.broadcastManualInitiative();
        draft.name = "";
        draft.initiative = "";
        draft.hp = "";
        this.render();
      }
    });

    // Combatant list
    const listEl = section.createDiv("dm-initiative-list");
    this.manualCombatants.forEach((c, i) => {
      const row = listEl.createDiv({
        cls: `dm-combatant-row ${c.active ? "dm-active-turn" : ""}`,
      });

      row.createSpan({ text: `${c.initiative}`, cls: "dm-init-num" });
      const nameEl = row.createSpan({ text: c.name, cls: "dm-combatant-name" });
      nameEl.style.cursor = "pointer";
      nameEl.addEventListener("click", (evt) => this.openManualConditionMenu(c, evt));
      this.appendStatusIcons(row, c.statuses);

      const hpEl = row.createEl("input", { type: "number", cls: "dm-hp-input" });
      hpEl.value = String(c.hp);
      hpEl.style.width = "60px";
      hpEl.addEventListener("change", () => {
        c.hp = parseInt(hpEl.value, 10) || 0;
        this.broadcastManualInitiative();
      });

      row.createSpan({ text: `/ ${c.maxHp}`, cls: "dm-hp-max" });

      const removeBtn = row.createEl("button", { text: "x", cls: "dm-remove-btn" });
      removeBtn.addEventListener("click", () => {
        this.manualCombatants.splice(i, 1);
        this.broadcastManualInitiative();
        this.render();
      });
    });

    // Turn controls
    if (this.manualCombatants.length > 0) {
      const turnRow = section.createDiv("dm-turn-controls");

      const nextBtn = turnRow.createEl("button", { text: "Next Turn", cls: "mod-cta" });
      nextBtn.addEventListener("click", () => this.advanceManualTurn());

      const resetBtn = turnRow.createEl("button", { text: "Reset Round" });
      resetBtn.addEventListener("click", () => {
        this.currentTurn = 0;
        this.manualRound = 1;
        this.manualCombatants.forEach(c => (c.active = false));
        if (this.manualCombatants.length > 0) this.manualCombatants[0].active = true;
        this.broadcastManualInitiative();
        this.render();
      });

      const clearAllBtn = turnRow.createEl("button", { text: "Clear All" });
      clearAllBtn.addEventListener("click", () => {
        this.manualCombatants = [];
        this.currentTurn = 0;
        this.manualRound = 1;
        this.broadcastManualInitiative();
        this.render();
      });
    }
  }

  addImageLayer(label: string, dataUrl: string, noteType?: string, visible = true, source?: string) {
    const exists = this.imageLayers.some(
      (l) => l.label.toLowerCase() === label.toLowerCase()
    );
    if (exists) return;

    // Load image to get natural dimensions, then size correctly
    const img = new Image();
    img.onload = () => {
      const { width: tvW, height: tvH } = this.getEffectiveResolution();
      const isPortrait = noteType === "person" || noteType === "monster";

      let x = 0, y = 0, width: number, height: number;

      if (isPortrait) {
        width = 30;
        height = 60;
        x = 35;
        y = 20;
      } else {
        width = (img.naturalWidth / tvW) * 100;
        height = (img.naturalHeight / tvH) * 100;

        if (width > 100 || height > 100) {
          const scale = Math.max(width, height) / 100;
          width /= scale;
          height /= scale;
        }

        x = (100 - width) / 2;
        y = (100 - height) / 2;
      }

      const layer: ImageLayer = {
        id: `layer-${Date.now()}-${this.nextLayerSeq++}`,
        label,
        dataUrl,
        x,
        y,
        width,
        height,
        zIndex: this.nextZIndex++,
        rotation: 0,
        visible,
        fogEnabled: false,
        fogDataUrl: "",
        bordered: true,
        ...(source ? { source } : {}),
      };

      this.imageLayers.push(layer);
      debug(
        "DmControlPanel: addImageLayer pushed", layer.id,
        "label:", layer.label,
        "noteType:", noteType ?? "(none)",
        "visible:", visible,
        "total:", this.imageLayers.length
      );
      this.broadcastAndRender();
    };
    img.src = dataUrl;
  }

  // ─── Per-Layer Fog of War ─────────────────────────────────────────

  private createFogToolBtn(
    container: HTMLElement,
    tool: typeof DmControlPanel.prototype.fogTool,
    svgHtml: string,
    layerId?: string
  ) {
    const isActive = this.fogTool === tool && this.fogEditLayerId === layerId;
    const btn = container.createEl("button", {
      cls: `dm-fog-tool-btn ${isActive ? "dm-fog-tool-active" : ""}`,
    });
    btn.innerHTML = svgHtml;
    btn.title = tool;
    btn.addEventListener("click", () => {
      this.fogTool = tool;
      if (layerId) this.fogEditLayerId = layerId;
      this.render();
    });
  }

  private initFogCanvas(layer: ImageLayer) {
    // Load image to get natural dimensions, then create matching fog canvas
    const img = new Image();
    img.onload = () => {
      const res = DmControlPanel.FOG_RESOLUTION;
      const aspect = img.naturalHeight / img.naturalWidth;
      const canvas = document.createElement("canvas");
      canvas.width = res;
      canvas.height = Math.round(res * aspect);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      this.fogCanvases.set(layer.id, canvas);
      layer.fogDataUrl = canvas.toDataURL("image/png");
      this.broadcastImageLayers();
    };
    img.src = layer.dataUrl;
  }

  private getFogCanvas(layer: ImageLayer): HTMLCanvasElement {
    let canvas = this.fogCanvases.get(layer.id);
    if (!canvas) {
      canvas = document.createElement("canvas");
      const res = DmControlPanel.FOG_RESOLUTION;
      canvas.width = res;
      canvas.height = res; // temporary, will be corrected

      // Restore from existing fogDataUrl if present
      if (layer.fogDataUrl) {
        const img = new Image();
        img.onload = () => {
          canvas!.width = img.naturalWidth;
          canvas!.height = img.naturalHeight;
          const ctx = canvas!.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
        };
        img.src = layer.fogDataUrl;
      } else {
        // Load source image to get aspect
        const srcImg = new Image();
        srcImg.onload = () => {
          const aspect = srcImg.naturalHeight / srcImg.naturalWidth;
          canvas!.height = Math.round(res * aspect);
          const ctx = canvas!.getContext("2d")!;
          ctx.fillStyle = "black";
          ctx.fillRect(0, 0, canvas!.width, canvas!.height);
        };
        srcImg.src = layer.dataUrl;
      }
      this.fogCanvases.set(layer.id, canvas);
    }
    return canvas;
  }

  private syncFogToLayer(layer: ImageLayer) {
    const canvas = this.fogCanvases.get(layer.id);
    if (canvas) {
      layer.fogDataUrl = canvas.toDataURL("image/png");
      this.broadcastImageLayers();
    }
  }

  private initInlineFogCanvas(canvas: HTMLCanvasElement, layer: ImageLayer, rect: HTMLElement) {
    // Size canvas to match the host element's rendered size. `rect` here is
    // actually the .dm-layer-rect-frame (renamed `frame` upstream so the fog
    // overlay aligns with the visible image, not the broadcast wrapper).
    const rectBounds = rect.getBoundingClientRect();
    if (rectBounds.width < 1 || rectBounds.height < 1) {
      debugWarn(
        "initInlineFogCanvas: host element has zero-size bounds",
        "(width=", rectBounds.width.toFixed(2),
        "height=", rectBounds.height.toFixed(2),
        ") — fog canvas init skipped"
      );
      return;
    }
    canvas.width = rectBounds.width;
    canvas.height = rectBounds.height;
    debug(
      "initInlineFogCanvas: layer", layer.id,
      "canvas=", canvas.width.toFixed(0), "x", canvas.height.toFixed(0),
      "tool=", this.fogTool
    );

    // Draw semi-transparent fog preview
    const fogCanvas = this.getFogCanvas(layer);
    const ctx = canvas.getContext("2d")!;
    ctx.globalAlpha = 0.6;
    ctx.drawImage(fogCanvas, 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1.0;

    // Set up drawing interaction
    this.setupInlineFogDrawing(canvas, layer, rect);
  }

  private setupInlineFogDrawing(canvas: HTMLCanvasElement, layer: ImageLayer, rect: HTMLElement) {
    let drawing = false;
    let startX = 0;
    let startY = 0;
    const fogCanvas = this.getFogCanvas(layer);
    const fogCtx = fogCanvas.getContext("2d")!;

    const toFogCoord = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * fogCanvas.width;
      const y = ((e.clientY - r.top) / r.height) * fogCanvas.height;
      return { x, y };
    };

    const isReveal = () => this.fogTool.startsWith("reveal");
    const isFreehand = () => this.fogTool === "reveal-eraser" || this.fogTool === "fog-pen";
    const brushSize = fogCanvas.width * 0.05;

    const applyFreehand = (cx: number, cy: number) => {
      fogCtx.globalCompositeOperation = isReveal() ? "destination-out" : "source-over";
      fogCtx.fillStyle = isReveal() ? "rgba(0,0,0,1)" : "black";
      fogCtx.beginPath();
      fogCtx.arc(cx, cy, brushSize, 0, Math.PI * 2);
      fogCtx.fill();
      fogCtx.globalCompositeOperation = "source-over";
    };

    const applyShape = (x1: number, y1: number, x2: number, y2: number) => {
      fogCtx.globalCompositeOperation = isReveal() ? "destination-out" : "source-over";
      fogCtx.fillStyle = isReveal() ? "rgba(0,0,0,1)" : "black";
      const isCircle = this.fogTool === "reveal-circle" || this.fogTool === "fog-circle";
      if (isCircle) {
        const cx = (x1 + x2) / 2;
        const cy = (y1 + y2) / 2;
        const rx = Math.abs(x2 - x1) / 2;
        const ry = Math.abs(y2 - y1) / 2;
        fogCtx.beginPath();
        fogCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        fogCtx.fill();
      } else {
        fogCtx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      }
      fogCtx.globalCompositeOperation = "source-over";
    };

    const refreshOverlay = () => {
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 0.6;
      ctx.drawImage(fogCanvas, 0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1.0;
    };

    canvas.addEventListener("pointerdown", (e: PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const { x, y } = toFogCoord(e);
      startX = x;
      startY = y;
      debug(
        "fog: press layer", layer.id,
        "tool=", this.fogTool,
        "start=", x.toFixed(0), ",", y.toFixed(0)
      );
      // A finger's stroke starts once the gesture is unambiguous, so the first
      // finger of a pinch paints nothing (`pointerDrag.ts`).
      trackTapOrDrag(e, {
        intent: "stroke",
        act: () => {
          drawing = true;
          if (isFreehand()) {
            applyFreehand(startX, startY);
            refreshOverlay();
          }
        },
        onMove: drawMove,
        onEnd: finishDraw,
      });
    });

    const drawMove = (e: PointerEvent) => {
      if (!drawing) return;
      const { x, y } = toFogCoord(e);
      if (isFreehand()) {
        applyFreehand(x, y);
        refreshOverlay();
      } else {
        refreshOverlay();
        const ctx = canvas.getContext("2d")!;
        const cw = canvas.width;
        const ch = canvas.height;
        const sx1 = (startX / fogCanvas.width) * cw;
        const sy1 = (startY / fogCanvas.height) * ch;
        const sx2 = (x / fogCanvas.width) * cw;
        const sy2 = (y / fogCanvas.height) * ch;
        ctx.strokeStyle = isReveal() ? "rgba(0, 255, 0, 0.8)" : "rgba(255, 0, 0, 0.8)";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        const isCircleTool = this.fogTool === "reveal-circle" || this.fogTool === "fog-circle";
        if (isCircleTool) {
          const cx = (sx1 + sx2) / 2;
          const cy = (sy1 + sy2) / 2;
          const rx = Math.abs(sx2 - sx1) / 2;
          const ry = Math.abs(sy2 - sy1) / 2;
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.strokeRect(sx1, sy1, sx2 - sx1, sy2 - sy1);
        }
        ctx.setLineDash([]);
      }
    };

    const finishDraw = (e: PointerEvent) => {
      if (!drawing) return;
      drawing = false;
      let endX = startX;
      let endY = startY;
      if (!isFreehand()) {
        const { x, y } = toFogCoord(e);
        endX = x;
        endY = y;
        if (Math.abs(x - startX) > 3 || Math.abs(y - startY) > 3) {
          applyShape(startX, startY, x, y);
        }
      }
      debug(
        "fog: release layer", layer.id,
        "tool=", this.fogTool,
        "end=", endX.toFixed(0), ",", endY.toFixed(0),
        "shiftHeld=", e.shiftKey,
        "type=", e.type
      );
      this.syncFogToLayer(layer);

      // Update fog overlay in preview
      const fogOverlay = rect.querySelector(".dm-layer-fog-overlay") as HTMLElement;
      if (fogOverlay) {
        fogOverlay.style.backgroundImage = `url(${layer.fogDataUrl})`;
      }

      // Shift held = stay in edit mode, otherwise exit
      if (!e.shiftKey) {
        debug("fog: exiting edit mode for layer", layer.id);
        this.fogEditLayerId = null;
        this.render();
      } else {
        refreshOverlay();
      }
    };

    canvas.addEventListener("pointerleave", (e: PointerEvent) => {
      if (drawing && isFreehand()) finishDraw(e);
    });
  }

  private setupPreviewPanZoom(previewArea: HTMLElement, previewInner: HTMLElement) {
    // render() runs frequently and re-binds this listener. The previewArea it
    // sits on is GC'd with the old DOM, but the abort controller makes that
    // explicit — and a gesture in flight keeps its own document listeners only
    // until the pointer is released.
    this.panZoomAbort?.abort();
    this.panZoomAbort = new AbortController();
    const { signal } = this.panZoomAbort;

    // Wheel-to-zoom is intentionally NOT bound: it would swallow page scroll
    // whenever the cursor was over the preview. Zoom is driven exclusively
    // by the `.dm-zoom-slider` + reset button rendered above the preview.

    // Middle button only, for a cursor. A finger has no middle button, and
    // claiming its drags here would cost the panel its scrolling — the preview
    // is a tall area in a long column, and look-around only matters while
    // zoomed out. The layer rectangles keep their own touch drags.
    previewArea.addEventListener("pointerdown", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      const startPanX = this.dmPanX;
      const startPanY = this.dmPanY;
      trackPointerDrag(e, {
        onMove: (m) => {
          const bounds = previewArea.getBoundingClientRect();
          this.dmPanX = startPanX + ((m.clientX - e.clientX) / bounds.width) * 100;
          this.dmPanY = startPanY + ((m.clientY - e.clientY) / bounds.height) * 100;
          previewInner.style.transform = `translate(${this.dmPanX}%, ${this.dmPanY}%) scale(${this.dmZoom})`;
        },
      });
    }, { signal });
  }

  private resetDmView() {
    this.dmZoom = 1;
    this.dmPanX = 0;
    this.dmPanY = 0;
    this.render();
  }

  private broadcastPlayerViewport() {
    const { width: tvW, height: tvH } = this.getEffectiveResolution();
    this.plugin.broadcast({
      type: "viewport-update",
      payload: {
        panX: (this.playerPanX / 100) * tvW,
        panY: (this.playerPanY / 100) * tvH,
        zoom: this.playerZoom,
      },
    });
  }

  async collectHydrusRefEntries(file: TFile): Promise<ResolvedHydrusRef[]> {
    if (!this.plugin.hydrusApi()) return [];
    const body = await this.plugin.app.vault.cachedRead(file);
    const refs = parseHydrusRefs(body);
    if (refs.length === 0) return [];
    return resolveHydrusRefs(refs, this.plugin.hydrusCache, this.plugin.hydrusApi());
  }

  private async applyHydrusRef(ref: ResolvedHydrusRef, asBackground: boolean): Promise<void> {
    try {
      const api = this.plugin.hydrusApi();
      if (!api) throw new Error("Hydrus is not configured");
      const file = await api.publish(ref.hash);
      if (asBackground) {
        const url = file.url;
        debug("DmControlPanel: applyHydrusRef background", ref.hash.slice(0, 12), file.mediaType);
        this.activeBackgroundUrl = url;
        this.activeVideoPath = null;

        const sourceLabel = resolveSourceLabel({
          url,
          hydrusHash: ref.hash,
          knownTags: file.knownTags,
          plugin: this.plugin,
        });
        this.setBackgroundLabel(sourceLabel);

        this.plugin.broadcast({
          type: "show-background-media",
          payload: {
            url,
            mediaType: file.mediaType,
            loop: this.plugin.prefs.get("hydrusDefaultLoop"),
            muted: this.plugin.prefs.get("hydrusDefaultMuted"),
          },
        });
        this.render();
      } else {
        const dataUrl = await this.plugin.dataUrlFor(file.url);
        if (dataUrl) {
          this.addImageLayer(uniqueLayerLabel(this.imageLayers, ref.label), dataUrl, "hydrus", false, `hydrus:${ref.hash}`);
        }
      }
      await api.markUsed(ref.hash);
    } catch (err) {
      new Notice(`Hydrus: ${(err as Error).message}`, 6000);
    }
  }

  private async showImagePicker(evt: MouseEvent) {
    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("No active file");
      return;
    }

    const cache = this.plugin.app.metadataCache.getFileCache(activeFile);
    const fm = cache?.frontmatter;

    // Collect images from frontmatter fields
    const images: { label: string; path: string; source: string }[] = [];
    if (fm) {
      if (fm["image"]) {
        const resolved = this.plugin.app.metadataCache.getFirstLinkpathDest(fm["image"], activeFile.path);
        if (resolved) {
          images.push({ label: `image: ${resolved.name}`, path: resolved.path, source: "image" });
        }
      }
      // Portrait field (wiki-link format)
      if (fm["portrait"]) {
        const portraitStr = String(fm["portrait"]).replace(/^\[\[/, "").replace(/\]\]$/, "");
        const resolved = this.plugin.app.metadataCache.getFirstLinkpathDest(portraitStr, activeFile.path);
        if (resolved) {
          images.push({ label: `portrait: ${resolved.name}`, path: resolved.path, source: "portrait" });
        }
      }
    }

    // Collect embedded images from note body (![[image.ext]])
    if (cache?.embeds) {
      for (const embed of cache.embeds) {
        if (/\.(png|jpg|jpeg|webp|gif)$/i.test(embed.link)) {
          const resolved = this.plugin.app.metadataCache.getFirstLinkpathDest(embed.link, activeFile.path);
          if (resolved && !images.some(i => i.path === resolved.path)) {
            images.push({ label: `embed: ${resolved.name}`, path: resolved.path, source: "embed" });
          }
        }
      }
    }

    const noteType = fm?.["type"] as string | undefined;

    const refs = await this.collectHydrusRefEntries(activeFile);
    const hydrus = refs.filter((r) => !r.available || r.mediaType === "image");

    const hydrusActionable = hydrus.filter((r) => r.available);
    const disabled = hydrus.filter((r) => !r.available);

    if (images.length === 0 && hydrusActionable.length === 0 && disabled.length === 0) {
      new Notice("No images found in this note");
      return;
    }

    // Apply directly only when there is exactly one actionable entry and nothing disabled.
    if (images.length + hydrusActionable.length === 1 && disabled.length === 0) {
      if (images.length === 1) {
        const img = images[0];
        const dataUrl = await this.plugin.imageToDataUrl(img.path);
        if (dataUrl) {
          this.addImageLayer(`${activeFile.basename} (${img.source})`, dataUrl, noteType, false, `vault:${img.path}`);
          new Notice(`Added: ${img.label} (hidden)`);
        }
      } else {
        void this.applyHydrusRef(hydrusActionable[0], false);
      }
      return;
    }

    const menu = new Menu();

    for (const img of images) {
      menu.addItem((item: any) => {
        item.setTitle(img.label);
        item.onClick(async () => {
          const dataUrl = await this.plugin.imageToDataUrl(img.path);
          if (dataUrl) {
            this.addImageLayer(`${activeFile.basename} (${img.source})`, dataUrl, noteType, false, `vault:${img.path}`);
            new Notice(`Added: ${img.label} (hidden)`);
          }
        });
      });
    }

    for (const ref of hydrus) {
      menu.addItem((item: any) => {
        item.setTitle(`Hydrus: ${ref.label}${ref.available ? "" : " (offline, not cached)"}`).setIcon("link");
        if (!ref.available) {
          item.setDisabled(true);
          return;
        }
        item.onClick(() => void this.applyHydrusRef(ref, false));
      });
    }

    // Add all at once option
    if (images.length > 1) {
      menu.addSeparator();
      menu.addItem((item: any) => {
        item.setTitle(`Add all ${images.length} images`);
        item.onClick(async () => {
          const dataUrls = await Promise.all(
            images.map((img) => this.plugin.imageToDataUrl(img.path))
          );
          let added = 0;
          dataUrls.forEach((dataUrl, i) => {
            if (dataUrl) {
              const img = images[i];
              this.addImageLayer(`${activeFile.basename} (${img.source})`, dataUrl, noteType, false, `vault:${img.path}`);
              added++;
            }
          });
          new Notice(`Added ${added} image${added > 1 ? "s" : ""} (hidden)`);
        });
      });
    }

    menu.showAtMouseEvent(evt);
  }

  private async showBackgroundPicker(evt: MouseEvent): Promise<void> {
    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("No active note");
      return;
    }

    const images = this.getImagesFromNote(activeFile);
    const refs = await this.collectHydrusRefEntries(activeFile);
    const hydrus = refs.filter((r) => !r.available || r.mediaType === "image" || r.mediaType === "video");

    const hydrusActionable = hydrus.filter((r) => r.available);
    const disabled = hydrus.filter((r) => !r.available);

    if (images.length === 0 && hydrusActionable.length === 0 && disabled.length === 0) {
      new Notice("No images found in note");
      return;
    }

    if (images.length + hydrusActionable.length === 1 && disabled.length === 0) {
      if (images.length === 1) {
        void this.setImageAsBackground(images[0]);
      } else {
        void this.applyHydrusRef(hydrusActionable[0], true);
      }
      return;
    }

    const menu = new Menu();
    for (const img of images) {
      menu.addItem((item: any) => {
        item.setTitle(img.label);
        item.onClick(() => void this.setImageAsBackground(img));
      });
    }
    for (const ref of hydrus) {
      menu.addItem((item: any) => {
        item.setTitle(`Hydrus: ${ref.label}${ref.available ? "" : " (offline, not cached)"}`).setIcon("link");
        if (!ref.available) {
          item.setDisabled(true);
          return;
        }
        item.onClick(() => void this.applyHydrusRef(ref, true));
      });
    }
    menu.showAtMouseEvent(evt);
  }

  private async setImageAsBackground(img: { path: string; label: string }): Promise<void> {
    let url: string;
    try {
      url = await this.plugin.transport.mediaUrl(img.path);
    } catch (e) {
      new Notice(`Could not publish the background: ${(e as Error).message}`, 8000);
      return;
    }
    debug("DmControlPanel: setImageAsBackground", img.path);
    this.activeBackgroundUrl = url;
    this.activeVideoPath = null;

    const activeFile = this.plugin.app.workspace.getActiveFile();
    const sourceLabel = resolveSourceLabel({
      url,
      noteBasename: activeFile?.basename,
      plugin: this.plugin,
    });
    this.setBackgroundLabel(sourceLabel);

    this.plugin.broadcast({
      type: "show-background-media",
      payload: { url, mediaType: "image" },
    });
    this.render();
  }

  // The scene loader's entry point: replaces the background and every layer
  // in one step, through the same broadcasts the DM's own actions use.
  async applyPlayerScene(
    background: { vaultPath: string; mediaType: "image" | "video"; loop: boolean; muted: boolean; hydrusHash?: string } | null,
    layers: ImageLayer[]
  ): Promise<void> {
    this.imageLayers = layers;
    if (layers.length > 0) {
      this.nextZIndex = Math.max(this.nextZIndex, ...layers.map((l) => l.zIndex + 1));
    }
    let url: string | null = null;
    if (background) {
      try {
        url = await this.plugin.transport.mediaUrl(background.vaultPath);
      } catch (e) {
        new Notice(`Could not publish the background: ${(e as Error).message}`, 8000);
      }
    }
    if (background && url) {
      this.activeBackgroundUrl = url;
      this.activeVideoPath = background.mediaType === "video" ? background.vaultPath : null;
      this.setBackgroundLabel(resolveSourceLabel({ url, hydrusHash: background.hydrusHash, plugin: this.plugin }));
      this.plugin.broadcast({
        type: "show-background-media",
        payload: { url, mediaType: background.mediaType, loop: background.loop, muted: background.muted },
      });
    } else if (this.activeBackgroundUrl) {
      this.activeBackgroundUrl = null;
      this.activeVideoPath = null;
      this.setBackgroundLabel(null);
      this.plugin.broadcast({ type: "hide-background-media", payload: {} });
    }
    debug("DmControlPanel: applyPlayerScene — layers:", layers.length, "background:", background ? background.vaultPath : "(none)");
    this.broadcastAndRender();
  }

  getImagesFromNote(file: TFile): Array<{ path: string; label: string }> {
    const imageExts = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
    const results: Array<{ path: string; label: string }> = [];

    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;

    if (fm) {
      if (fm["image"]) {
        const resolved = this.plugin.app.metadataCache.getFirstLinkpathDest(fm["image"], file.path);
        if (resolved && imageExts.some(ext => resolved.path.toLowerCase().endsWith(ext))) {
          results.push({ path: resolved.path, label: `image: ${resolved.name}` });
        }
      }
      if (fm["portrait"]) {
        const portraitStr = String(fm["portrait"]).replace(/^\[\[/, "").replace(/\]\]$/, "");
        const resolved = this.plugin.app.metadataCache.getFirstLinkpathDest(portraitStr, file.path);
        if (resolved && imageExts.some(ext => resolved.path.toLowerCase().endsWith(ext))) {
          results.push({ path: resolved.path, label: `portrait: ${resolved.name}` });
        }
      }
    }

    if (cache?.embeds) {
      for (const embed of cache.embeds) {
        if (/\.(png|jpg|jpeg|webp|gif)$/i.test(embed.link)) {
          const resolved = this.plugin.app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
          if (resolved && !results.some(r => r.path === resolved.path)) {
            results.push({ path: resolved.path, label: resolved.name });
          }
        }
      }
    }

    return results;
  }

  private makeDraggable(rect: HTMLElement, layer: ImageLayer, preview: HTMLElement) {
    rect.addEventListener("pointerdown", (e: PointerEvent) => {
      e.preventDefault();
      // Stops the preview's own look-around pan from starting under the finger
      // that is moving this layer.
      e.stopPropagation();
      const startLeft = layer.x;
      const startTop = layer.y;
      // Cached at the press so a mid-drag re-render that detaches `preview`
      // can't poison the math: a detached element returns width/height = 0,
      // which would otherwise produce Infinity for dx/dy and corrupt layer.x/y.
      const startBounds = preview.getBoundingClientRect();
      debug(
        "makeDraggable: press layer", layer.id,
        "startLeft=", startLeft.toFixed(2),
        "startTop=", startTop.toFixed(2),
        "bounds=", startBounds.width.toFixed(0), "x", startBounds.height.toFixed(0)
      );
      if (!Number.isFinite(startLeft) || !Number.isFinite(startTop)) {
        debugWarn("makeDraggable: layer has non-finite coords at press — drag will be a no-op until reset");
      }
      if (startBounds.width === 0 || startBounds.height === 0) {
        debugWarn("makeDraggable: preview has zero-size bounds at press — drag will be a no-op");
        return;
      }
      trackPointerDrag(e, {
        onMove: (m) => {
          layer.x = startLeft + ((m.clientX - e.clientX) / startBounds.width) * 100;
          layer.y = startTop + ((m.clientY - e.clientY) / startBounds.height) * 100;
          rect.style.left = `${layer.x}%`;
          rect.style.top = `${layer.y}%`;
          this.broadcastLayerGeometry();
        },
        onEnd: () => {
          debug(
            "makeDraggable: release layer", layer.id,
            "x=", layer.x.toFixed(2),
            "y=", layer.y.toFixed(2),
            "finite=", Number.isFinite(layer.x) && Number.isFinite(layer.y)
          );
          this.broadcastImageLayers();
        },
      });
    });
  }

  private moveLayerUp(layer: ImageLayer) {
    const sorted = [...this.imageLayers].sort((a, b) => b.zIndex - a.zIndex);
    const idx = sorted.indexOf(layer);
    if (idx > 0) {
      const other = sorted[idx - 1];
      const tmp = layer.zIndex;
      layer.zIndex = other.zIndex;
      other.zIndex = tmp;
      this.broadcastAndRender();
    }
  }

  private moveLayerDown(layer: ImageLayer) {
    const sorted = [...this.imageLayers].sort((a, b) => b.zIndex - a.zIndex);
    const idx = sorted.indexOf(layer);
    if (idx < sorted.length - 1) {
      const other = sorted[idx + 1];
      const tmp = layer.zIndex;
      layer.zIndex = other.zIndex;
      other.zIndex = tmp;
      this.broadcastAndRender();
    }
  }

  broadcastImageLayers() {
    debug("DmControlPanel: broadcastImageLayers —", this.imageLayers.length, "layer(s)");
    this.plugin.broadcast({
      type: "image-layers-sync",
      payload: { layers: this.imageLayers },
    });
    // A fresh geometry snapshot always follows the full sync so the cached
    // image-layers-geometry can never be staler than the cached sync —
    // late-joiner replay applies them in that order.
    this.broadcastLayerGeometry(true);
    this.scheduleSaveState();
  }

  // Continuous gestures (drag, scale slider) broadcast this instead of the
  // full sync: geometry only, no base64 payloads, trailing-throttled. The
  // gesture's end still emits the full broadcastImageLayers().
  broadcastLayerGeometry(immediate = false) {
    const send = () => {
      this.plugin.broadcast({
        type: "image-layers-geometry",
        payload: {
          layers: this.imageLayers.map<LayerGeometry>((l) => ({
            id: l.id,
            x: l.x,
            y: l.y,
            width: l.width,
            height: l.height,
            zIndex: l.zIndex,
            rotation: l.rotation,
            visible: l.visible,
            bordered: l.bordered !== false,
          })),
        },
      });
    };
    if (immediate) {
      if (this.layerGeometryTimer) {
        clearTimeout(this.layerGeometryTimer);
        this.layerGeometryTimer = null;
      }
      send();
      return;
    }
    if (this.layerGeometryTimer) return;
    this.layerGeometryTimer = setTimeout(() => {
      this.layerGeometryTimer = null;
      send();
    }, 50);
  }

  private broadcastAndRender() {
    this.broadcastImageLayers();
    this.render();
  }

  // ─── Manual Tracker Helpers ────────────────────────────────────────

  private sortManualCombatants() {
    sortByInitiative(this.manualCombatants);
  }

  private advanceManualTurn() {
    if (this.manualCombatants.length === 0) return;
    this.manualCombatants.forEach(c => (c.active = false));
    const advanced = advanceTurn(this.currentTurn, this.manualRound, this.manualCombatants.length);
    this.currentTurn = advanced.currentTurn;
    this.manualRound = advanced.round;
    this.manualCombatants[this.currentTurn].active = true;
    this.broadcastManualInitiative();
    this.render();
  }

  private openManualConditionMenu(c: ManualCombatant, evt: MouseEvent): void {
    debug("DmControlPanel: open manual condition menu for", c.name);
    const current = new Set(c.statuses);
    const menu = new Menu();

    for (const cond of Object.values(CONDITIONS)) {
      const active = current.has(cond.id);
      menu.addItem((item) => {
        item.setTitle(cond.name).setChecked(active).onClick(() => {
          if (active) c.statuses = c.statuses.filter((s) => s !== cond.id);
          else c.statuses = [...c.statuses, cond.id];
          this.broadcastManualInitiative();
          this.render();
        });
      });
    }

    menu.addSeparator();

    let currentExhaustion = 0;
    for (const s of current) {
      if (s.startsWith("exhaustion:")) {
        const n = parseInt(s.slice("exhaustion:".length), 10);
        if (Number.isFinite(n) && n >= 1 && n <= 6) currentExhaustion = n;
      }
    }
    menu.addItem((item) => {
      item.setTitle(currentExhaustion === 0 ? "Exhaustion — None" : `Exhaustion — Level ${currentExhaustion}`).setDisabled(true);
    });
    const setExhaustion = (level: number): void => {
      c.statuses = c.statuses.filter((s) => !s.startsWith("exhaustion:"));
      const enc = encodeExhaustion(level);
      if (enc) c.statuses = [...c.statuses, enc];
      this.broadcastManualInitiative();
      this.render();
    };
    menu.addItem((item) => {
      item.setTitle("  Remove exhaustion").setChecked(currentExhaustion === 0).onClick(() => setExhaustion(0));
    });
    for (let n = 1; n <= 6; n++) {
      menu.addItem((item) => {
        item.setTitle(`  Exhaustion ${n}`).setChecked(currentExhaustion === n).onClick(() => setExhaustion(n));
      });
    }

    menu.showAtMouseEvent(evt);
  }

  private appendStatusIcons(parent: HTMLElement, statuses: string[]) {
    if (!statuses || statuses.length === 0) return;
    const wrap = parent.createSpan({ cls: "dm-statuses" });
    for (const status of statuses) {
      const d = decodeStatus(status);
      if (d.kind === "condition") {
        const icon = wrap.createSpan({ cls: "dm-status-icon" });
        icon.title = d.def.name;
        icon.innerHTML = d.def.iconSvg;
      } else if (d.kind === "exhaustion") {
        const icon = wrap.createSpan({ cls: "dm-status-icon dm-status-exhaustion" });
        icon.title = `Exhaustion (Level ${d.level})`;
        icon.innerHTML = d.iconSvg;
        const level = icon.createSpan({ cls: "dm-status-level" });
        level.textContent = String(d.level);
      } else {
        wrap.createSpan({ cls: "dm-status-badge", text: d.text });
      }
    }
  }

  private broadcastManualInitiative() {
    const out = applyRound1Reveal(this.manualCombatants, this.manualRound);
    this.plugin.sendInitiativeUpdate(out, this.manualRound);
  }

  private openLayerContextMenu(evt: MouseEvent, layer: ImageLayer): void {
    const menu = new Menu();
    buildLayerContextMenu(menu, layer, this.plugin.settings.webhooks, {
      openSendModal: (l) =>
        new SendToWebhookModal(this.app, this.plugin, l).open(),
      openWebhookSettings: () => this.openPluginSettings(),
    });
    menu.showAtMouseEvent(evt);
  }

  private openPluginSettings(): void {
    const setting = (
      this.app as {
        setting?: { open: () => void; openTabById: (id: string) => void };
      }
    ).setting;
    if (!setting) {
      new Notice("Open Obsidian Settings → DM Screen → Webhooks", 5000);
      return;
    }
    setting.open();
    setting.openTabById("dm-screen");
  }
}

export function isVideoBackgroundUrl(url: string): boolean {
  return /\.(mp4|webm|mov|ogv)(\?|$)/i.test(url);
}
