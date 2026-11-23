import {
  Plugin,
  Platform,
  TFile,
  Notice,
} from "obsidian";
import { DmControlPanel, DM_CONTROL_VIEW_TYPE } from "./views/DmControlPanel";
import { PlayerScreenServer, ReplayCache } from "./server";
import type { PlayerMessage } from "./server";
import { DmScreenSettingTab, DmScreenSettings, DEFAULT_SETTINGS } from "./settings";
import type { InitiativeViewState, TrackerCombatant } from "./types";
import { HydrusCache } from "./hydrus/cache";
import type { VaultAdapterLike } from "./hydrus/cache";
import { HydrusClient } from "./hydrus/client";
import { DdbImageCache } from "./dndbeyond/imageCache";
import { initDebug, debug, debugWarn, debugError } from "./debug";
import { EmbeddedTransport } from "./transport/embedded";
import { RemoteTransport } from "./transport/remote";
import type { SceneTransport } from "./transport/transport";
import { SCENE_CODE_BLOCK, type Scene } from "./scenes/format";
import { renderSceneCard } from "./scenes/codeBlock";
import { captureMapScene, capturePlayerScene, saveCapturedScene, sceneExists } from "./scenes/capture";
import { listScenes, loadScene } from "./scenes/load";
import { SaveSceneModal } from "./views/SaveSceneModal";
import { SceneSuggestModal } from "./views/SceneSuggestModal";
import { generateAccessToken } from "./auth";
import { redactUrl } from "./redact";

export default class DmScreenPlugin extends Plugin {
  settings: DmScreenSettings = DEFAULT_SETTINGS;
  server: PlayerScreenServer | null = null;
  replayCache: ReplayCache = new ReplayCache();
  transport: SceneTransport = new EmbeddedTransport(this);
  // Open Exploration modals, told when this device gains or loses control.
  exploreModals = new Set<{ applyEditable(): void }>();
  private replayCacheSaveTimer: number | null = null;
  hydrusCache: HydrusCache | null = null;
  ddbImageCache: DdbImageCache | null = null;
  private hydrusSweepInterval: number | null = null;
  private ddbImageSweepInterval: number | null = null;

  /** Returns the first DM Control Panel view that is currently open. */
  async findOpenDmControlPanel(): Promise<DmControlPanel | null> {
    const leaves = this.app.workspace.getLeavesOfType(DM_CONTROL_VIEW_TYPE);
    if (leaves.length === 0) return null;
    return leaves[0].view as DmControlPanel;
  }

  buildHydrusClient(): HydrusClient | null {
    const { hydrusEnabled, hydrusApiUrl, hydrusApiKey } = this.settings;
    if (!hydrusEnabled || !hydrusApiUrl || !hydrusApiKey) {
      debug("buildHydrusClient: skipped (enabled=", hydrusEnabled, "url=", !!hydrusApiUrl, "key=", !!hydrusApiKey, ")");
      return null;
    }
    try {
      debug("buildHydrusClient: creating client for", redactUrl(hydrusApiUrl));
      return new HydrusClient({ baseUrl: hydrusApiUrl, apiKey: hydrusApiKey });
    } catch (e) {
      debugWarn("buildHydrusClient: constructor failed:", e);
      return null;
    }
  }

  async onload() {
    await this.loadSettings();
    initDebug(this.settings);
    debug("Plugin loading. Version:", this.manifest?.version ?? "unknown");
    this.initReplayCache();
    this.initHydrusCache();
    this.transport = this.buildTransport();

    // Register views
    this.registerView(DM_CONTROL_VIEW_TYPE, (leaf) => new DmControlPanel(leaf, this));

    // Commands
    this.addCommand({
      id: "open-dm-control-panel",
      name: "Open DM Control Panel",
      callback: () => this.activateView(DM_CONTROL_VIEW_TYPE),
    });

    this.addCommand({
      id: "save-player-scene",
      name: "Save player screen as scene",
      callback: () => void this.saveScene("player"),
    });
    this.addCommand({
      id: "save-map-scene",
      name: "Save map as scene",
      callback: () => void this.saveScene("map"),
    });
    this.addCommand({
      id: "load-player-scene",
      name: "Load player scene",
      callback: () => void this.pickScene("player"),
    });
    this.addCommand({
      id: "load-map-scene",
      name: "Load map scene",
      callback: () => void this.pickScene("map"),
    });
    this.registerMarkdownCodeBlockProcessor(SCENE_CODE_BLOCK, (source, el, ctx) =>
      renderSceneCard(this, source, el, ctx.sourcePath)
    );

    this.addCommand({
      id: "toggle-player-server",
      name: "Toggle Player Screen Server",
      callback: () => this.toggleServer(),
    });

    // Settings tab
    this.addSettingTab(new DmScreenSettingTab(this.app, this));

    if (this.settings.autoStartServer) {
      debug("Auto-starting the session in", this.settings.serverMode, "mode");
      this.startSession();
    }

    // Add ribbon icon
    this.addRibbonIcon("monitor", "DM Screen", () => {
      this.activateView(DM_CONTROL_VIEW_TYPE);
    });

    // Listen to Initiative Tracker plugin events
    this.registerEvent(
      (this.app.workspace.on as any)("initiative-tracker:save-state", (state: InitiativeViewState) => {
        this.onInitiativeStateChange(state);
      })
    );

    this.registerEvent(
      (this.app.workspace.on as any)("initiative-tracker:stop-viewing", () => {
        this.onInitiativeStop();
      })
    );

    this.registerEvent(
      (this.app.workspace.on as any)("initiative-tracker:unloaded", () => {
        this.onInitiativeStop();
      })
    );

  }

  async onunload() {
    debug("Plugin unloading");
    const dmPanels = this.app.workspace.getLeavesOfType(DM_CONTROL_VIEW_TYPE);
    for (const leaf of dmPanels) {
      const view = leaf.view;
      if (view && "saveState" in view && typeof (view as any).saveState === "function") {
        (view as any).saveState();
      }
    }
    if (this.replayCacheSaveTimer !== null) {
      window.clearTimeout(this.replayCacheSaveTimer);
      this.replayCacheSaveTimer = null;
      await this.saveSettings();
    }
    this.stopServer();
    this.remote?.disconnect();
  }

  get remote(): RemoteTransport | null {
    return this.transport instanceof RemoteTransport ? this.transport : null;
  }

  // Mobile cannot host a server, so it always runs remote. Computed rather
  // than stored: data.json may sync, and a desktop must keep its own choice.
  effectiveServerMode(): "embedded" | "remote" {
    return Platform.isDesktopApp ? this.settings.serverMode : "remote";
  }

  private buildTransport() {
    if (this.effectiveServerMode() !== "remote") return new EmbeddedTransport(this);
    return new RemoteTransport(this, {
      onSession: (cache, active) => void this.onRemoteSession(cache, active),
      onRole: (active) => this.onRemoteRole(active),
      onMirror: (message) => this.onRemoteMirror(message),
      onScreens: (clients) => this.applyScreens(clients),
      onStatus: () => this.refreshOpenDmPanels(),
    });
  }

  async setServerMode(mode: "embedded" | "remote"): Promise<void> {
    if (mode === this.settings.serverMode) return;
    this.stopServer();
    this.remote?.disconnect();
    this.settings.serverMode = mode;
    await this.saveSettings();
    this.transport = this.buildTransport();
    this.refreshOpenDmPanels();
  }

  startSession(): void {
    if (this.remote) this.remote.connect();
    else this.startServer();
  }

  private panels(): DmControlPanel[] {
    return this.app.workspace.getLeavesOfType(DM_CONTROL_VIEW_TYPE).map((leaf) => leaf.view as DmControlPanel);
  }

  // The server's cache is the session: adopt it, rebuild the panels from it,
  // and, holding the lease, re-send the live-only seeds a server start sends.
  private async onRemoteSession(cache: Record<string, string>, active: boolean): Promise<void> {
    this.replayCache.replace(cache);
    for (const panel of this.panels()) await panel.reloadFromSession?.();
    if (active) this.sendSeeds();
    this.refreshOpenDmPanels();
  }

  private onRemoteRole(active: boolean): void {
    if (active) this.sendSeeds();
    this.refreshOpenDmPanels();
  }

  private mirrorTimer: number | null = null;

  // A read-only device follows the session: apply the mirrored message, then
  // rebuild the panels once the burst settles.
  private onRemoteMirror(message: PlayerMessage): void {
    this.replayCache.record(message);
    if (this.mirrorTimer !== null) window.clearTimeout(this.mirrorTimer);
    this.mirrorTimer = window.setTimeout(() => {
      this.mirrorTimer = null;
      for (const panel of this.panels()) void panel.reloadFromSession?.();
    }, 100);
  }

  private sendSeeds(): void {
    this.broadcastWaitingScreen();
    this.broadcastInspirationStyle();
    this.broadcastMapCalibration();
  }

  private applyScreens(clients: Array<{ width: number; height: number; devicePixelRatio: number; channel?: "player" | "map" }>): void {
    for (const view of this.panels()) {
      view.connectedClients = clients.filter((c) => c.channel !== "map");
      view.mapPanel.mapClients = clients.filter((c) => c.channel === "map");
      view.playerConnected = view.connectedClients.length > 0;
      view.debouncedRender?.();
    }
  }

  // Coalesces bursty state changes (drags, sliders) into one data.json write.
  // The write must not wait for the DM panel to close: quitting Obsidian does
  // not reliably unload plugins, and a Stop BG lost there comes back on restart.
  initReplayCache() {
    this.replayCache = new ReplayCache(this.settings.lastBroadcastCache);
    debug("initReplayCache: entries=", this.replayCache.entries.size);
    this.replayCache.onChange(() => {
      this.settings.lastBroadcastCache = this.replayCache.toRecord();
      if (this.replayCacheSaveTimer !== null) return;
      this.replayCacheSaveTimer = window.setTimeout(() => {
        this.replayCacheSaveTimer = null;
        debug("replay cache persisted: entries=", this.replayCache.entries.size);
        void this.saveSettings();
      }, 1000);
    });
  }

  // Every state broadcast goes through here; the transport decides whether it
  // reaches screens now or only the replay cache.
  broadcast(message: PlayerMessage) {
    this.transport.broadcast(message);
  }

  async loadSettings() {
    const raw = ((await this.loadData()) as Record<string, unknown> | null) ?? {};
    const migrated = migrateLegacyCacheFolder(raw);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, migrated.data) as DmScreenSettings;
    let changed = migrated.changed;
    if (this.settings.accessToken.length === 0) {
      this.settings.accessToken = generateAccessToken();
      debug("Minted a new player-screen access token");
      changed = true;
    }
    if (changed) {
      await this.saveData(this.settings);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Re-init the Hydrus/DDB caches when their settings change (folder,
  // TTL, enable toggle). Used by the settings tab; do NOT call from
  // bulk state-persistence paths like DmControlPanel.saveState — those
  // fire on every layer broadcast and we don't want to rebuild caches
  // on every drag.
  initHydrusCache() {
    const base = this.settings.cacheBaseFolder.replace(/^\/+|\/+$/g, "") || ".dm-screen";
    debug("initHydrusCache: base=", base, "ttl=", this.settings.hydrusCacheTtlDays, "days");
    this.hydrusCache = new HydrusCache(this.app, {
      folder: `${base}/hydrus`,
      ttlDays: this.settings.hydrusCacheTtlDays,
    });
    if (this.settings.hydrusEnabled) {
      void this.hydrusCache.sweep().then((n) => {
        if (n > 0) debug("Hydrus cache sweep removed", n, "stale entries");
      }).catch((e) =>
        debugError("Hydrus cache sweep failed:", e)
      );
      if (this.hydrusSweepInterval === null) {
        this.hydrusSweepInterval = this.registerInterval(window.setInterval(() => {
          void this.hydrusCache?.sweep().catch(() => {});
        }, 24 * 60 * 60 * 1000));
      }
    }

    this.ddbImageCache = new DdbImageCache(
      `${base}/beyond`,
      this.app.vault.adapter as unknown as VaultAdapterLike,
      this.settings.hydrusCacheTtlDays
    );
    void this.ddbImageCache.sweep().then((n) => {
      if (n > 0) debug("DDB image cache sweep removed", n, "stale image(s)");
    }).catch(() => {});
    if (this.ddbImageSweepInterval === null) {
      this.ddbImageSweepInterval = this.registerInterval(window.setInterval(() => {
        void this.ddbImageCache?.sweep().catch(() => {});
      }, 24 * 60 * 60 * 1000));
    }
  }

  startServer() {
    if (this.server || !Platform.isDesktopApp) return;
    debug("startServer: port=", this.settings.serverPort, "maxClients=", this.settings.maxClients);
    this.server = new PlayerScreenServer(this, this.replayCache);
    this.server.maxClients = this.settings.maxClients;
    this.server.onClientInfo = (info) => this.onPlayerClientInfo(info);
    this.server.onClientCountChanged = () => this.applyScreens(this.server?.getConnectedClients() ?? []);
    this.server.start(this.settings.serverPort);
    this.sendSeeds();
    const leaves = this.app.workspace.getLeavesOfType(DM_CONTROL_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view as DmControlPanel;
      void view.republishToServer?.();
    }
    new Notice(`Player Screen server started on port ${this.settings.serverPort}`);
  }

  broadcastWaitingScreen(): void {
    if (!this.transport.isLive()) return;
    debug("broadcastWaitingScreen: title=", this.settings.waitingTitle, "subtitle=", this.settings.waitingSubtitle);
    this.transport.sendLive({
      type: "waiting-screen",
      payload: {
        title: this.settings.waitingTitle,
        subtitle: this.settings.waitingSubtitle,
      },
    });
  }

  broadcastInspirationStyle(): void {
    if (!this.transport.isLive()) return;
    debug("broadcastInspirationStyle: pulse=", this.settings.ddbInspirationPulse);
    this.transport.sendLive({
      type: "inspiration-style",
      payload: { pulse: this.settings.ddbInspirationPulse },
    });
  }

  broadcastMapCalibration(): void {
    if (!this.transport.isLive()) return;
    const profiles = this.transport.mapData.profiles();
    debug("broadcastMapCalibration: profiles=", Object.keys(profiles).length);
    this.transport.sendLive({
      type: "map-calibration",
      payload: { profiles },
    });
  }

  refreshOpenDmPanels(): void {
    const leaves = this.app.workspace.getLeavesOfType(DM_CONTROL_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view as DmControlPanel;
      view.debouncedRender?.();
    }
    for (const modal of this.exploreModals) modal.applyEditable();
  }

  private onPlayerClientInfo(_info: { width: number; height: number; devicePixelRatio: number; channel?: "player" | "map" }) {
    const leaves = this.app.workspace.getLeavesOfType(DM_CONTROL_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view as DmControlPanel;
      if (view.onPlayerConnected) {
        view.onPlayerConnected(this.server?.getConnectedClients() ?? []);
      }
    }
  }

  stopServer() {
    if (this.server) {
      debug("stopServer");
      this.stopCombatBroadcastsInOpenPanels();
      this.server.stop();
      this.server = null;
      new Notice("Player Screen server stopped");
    }
  }

  private stopCombatBroadcastsInOpenPanels(): void {
    const leaves = this.app.workspace.getLeavesOfType(DM_CONTROL_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view as DmControlPanel;
      if (typeof view.stopAllCombatBroadcast === "function") {
        view.stopAllCombatBroadcast();
      }
    }
  }

  toggleServer() {
    const remote = this.remote;
    if (remote) {
      if (remote.status === "disconnected") remote.connect();
      else remote.disconnect();
      return;
    }
    if (this.server) {
      this.stopServer();
    } else {
      this.startServer();
    }
  }

  canEditSession(): boolean {
    return this.transport.canEdit();
  }

  async openDmControlPanel(): Promise<DmControlPanel | null> {
    await this.activateView(DM_CONTROL_VIEW_TYPE);
    return this.findOpenDmControlPanel();
  }

  async saveScene(kind: Scene["kind"]): Promise<void> {
    if (!this.canEditSession()) return;
    const panel = await this.openDmControlPanel();
    if (!panel) return;
    if (panel.restored) await panel.restored;
    const capture = (name: string) =>
      kind === "player" ? capturePlayerScene(this, panel, name) : captureMapScene(this, panel.mapPanel, name);
    const probe = capture("");
    if (!probe || (probe.scene.kind === "player" && !probe.scene.background && probe.scene.layers.length === 0 && probe.skipped.length === 0)) {
      new Notice(kind === "player" ? "Nothing on the player screen to save." : "Add a map before saving a map scene.");
      return;
    }
    const initial = kind === "player" ? "Player screen" : this.settings.lastSourceLabels?.map?.label ?? "Map";
    new SaveSceneModal(
      this.app,
      kind === "player" ? "player screen" : "map",
      initial,
      (name) => sceneExists(this.app, this.settings.scenesFolder, name),
      (name) => {
        const captured = capture(name);
        if (captured) void saveCapturedScene(this, captured);
      }
    ).open();
  }

  async pickScene(kind: Scene["kind"]): Promise<void> {
    if (!this.canEditSession()) return;
    const entries = await listScenes(this.app, this.settings.scenesFolder, kind);
    if (entries.length === 0) {
      new Notice(`No ${kind === "player" ? "player" : "map"} scenes in "${this.settings.scenesFolder}".`);
      return;
    }
    new SceneSuggestModal(this.app, entries, (entry) => void loadScene(this, entry.scene, entry.file.path)).open();
  }

  async activateView(viewType: string) {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(viewType)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({ type: viewType, active: true });
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }


  // ─── Resolve helpers (exported for use by other views) ─────────────

  resolveLink(linkStr: string, sourcePath: string): TFile | null {
    const cleanPath = linkStr.replace(/\[\[|\]\]/g, "");
    return this.app.metadataCache.getFirstLinkpathDest(cleanPath, sourcePath);
  }

  getFrontmatter(file: TFile): Record<string, unknown> | undefined {
    return this.app.metadataCache.getFileCache(file)?.frontmatter;
  }


  async imageToDataUrl(path: string): Promise<string> {
    let imgData: ArrayBuffer | null = null;

    const imgFile = this.app.vault.getAbstractFileByPath(path);
    if (imgFile instanceof TFile) {
      imgData = await this.app.vault.readBinary(imgFile);
    } else {
      // Dotfolders aren't indexed — fall back to raw adapter
      const adapter = this.app.vault.adapter as unknown as { exists(p: string): Promise<boolean>; readBinary(p: string): Promise<ArrayBuffer> };
      if (typeof adapter.exists === "function" && await adapter.exists(path)) {
        imgData = await adapter.readBinary(path);
      }
    }

    if (!imgData) {
      debug("imageToDataUrl: file not found", path);
      return "";
    }
    debug("imageToDataUrl: loaded", path, imgData.byteLength, "bytes");
    const base64 = arrayBufferToBase64(imgData);
    const ext = path.split(".").pop()?.toLowerCase() || "";
    const mime =
      ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/webp";
    return `data:${mime};base64,${base64}`;
  }

  sendInitiativeUpdate(combatants: Array<{
    name: string; hp: number; maxHp: number; initiative: number;
    active: boolean; friendly?: boolean; isPlayer?: boolean;
    hidden?: boolean; statuses?: string[]; inspired?: boolean;
  }>, round?: number) {
    if (!this.transport.isLive()) return;
    const visible = combatants.filter(c => !c.hidden);
    debug("sendInitiativeUpdate: round=", round ?? 0, "total=", combatants.length, "visible=", visible.length);
    this.transport.sendLive({
      type: "initiative-update",
      payload: { combatants: visible, round: round ?? 0 },
    });
  }

  // ─── Initiative Tracker Plugin Integration ──────────────────────────

  private onInitiativeStateChange(state: InitiativeViewState) {
    debug("onInitiativeStateChange: encounter=", state.name || "(unnamed)", "round=", state.round, "creatures=", state.creatures.length);
    const combatants: TrackerCombatant[] = state.creatures.map(c => {
      const baseName = (c.name || "").replace(/\s+\d+$/, ""); // "Goblin 1" → "Goblin"
      const statblock = this.lookupStatblock(c.display || c.name || "", baseName);

      return {
        name: c.name || "Unknown",
        displayName: c.display || c.name || "Unknown",
        initiative: c.initiative ?? 0,
        hp: c.currentHP ?? c.hp ?? 0,
        maxHp: c.currentMaxHP ?? c.hp ?? 0,
        tempHp: c.tempHP ?? 0,
        ac: c.currentAC ?? c.ac ?? 0,
        active: c.active ?? false,
        hidden: c.hidden ?? false,
        friendly: c.friendly ?? false,
        isPlayer: c.player ?? false,
        statuses: c.status ?? [],
        statblock,
        source: "tracker-plugin" as const,
      };
    });

    // Forward to DmControlPanel
    const leaves = this.app.workspace.getLeavesOfType(DM_CONTROL_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view as DmControlPanel;
      if (view.syncFromInitiativeTracker) {
        view.syncFromInitiativeTracker(combatants, state.round, state.name);
      }
    }

    // Broadcast to player screen.
    // In round 1, hide combatants whose turn hasn't happened yet so players
    // discover the encounter as it unfolds.
    const isRoundOne = state.round === 1;
    const activeIdx = combatants.findIndex(c => c.active);
    this.sendInitiativeUpdate(combatants.map((c, i) => ({
      name: c.displayName,
      hp: c.hp,
      maxHp: c.maxHp,
      initiative: c.initiative,
      active: c.active,
      friendly: c.friendly,
      isPlayer: c.isPlayer,
      hidden: c.hidden || (isRoundOne && activeIdx >= 0 && i > activeIdx),
      statuses: c.statuses,
    })), state.round);
  }

  private onInitiativeStop() {
    debug("onInitiativeStop: disconnecting from tracker");
    const leaves = this.app.workspace.getLeavesOfType(DM_CONTROL_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view as DmControlPanel;
      if (view.disconnectFromTracker) {
        view.disconnectFromTracker();
      }
    }
  }

  private statblockCache = new Map<string, import("./types").StatblockCreature | null>();

  private lookupStatblock(name: string, baseName: string): import("./types").StatblockCreature | null {
    const cacheKey = name;
    if (this.statblockCache.has(cacheKey)) {
      return this.statblockCache.get(cacheKey)!;
    }

    const fsApi = window.FantasyStatblocks;
    if (!fsApi) {
      debug("lookupStatblock: FantasyStatblocks API not available");
      this.statblockCache.set(cacheKey, null);
      return null;
    }

    let creature = fsApi.getCreatureFromBestiary(name) ?? undefined;
    if (!creature && baseName !== name) {
      debug("lookupStatblock: exact miss for", name, "→ trying baseName:", baseName);
      creature = fsApi.getCreatureFromBestiary(baseName);
    }

    const result = creature ?? null;
    debug("lookupStatblock:", name, result ? "→ found" : "→ not found");
    this.statblockCache.set(cacheKey, result);
    return result;
  }
}

export function migrateLegacyCacheFolder(raw: Record<string, unknown>): {
  data: Record<string, unknown>;
  changed: boolean;
} {
  if (!("hydrusCacheFolder" in raw)) {
    return { data: raw, changed: false };
  }
  const legacy = typeof raw.hydrusCacheFolder === "string" ? raw.hydrusCacheFolder : "";
  const next = { ...raw };
  delete next.hydrusCacheFolder;
  if (typeof next.cacheBaseFolder !== "string" || next.cacheBaseFolder.length === 0) {
    const base = legacy.replace(/^\/+|\/+$/g, "").replace(/\/(bg|hydrus)$/, "");
    next.cacheBaseFolder = base || ".dm-screen";
  }
  return { data: next, changed: true };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
