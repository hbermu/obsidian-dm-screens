import { Notice, Platform } from "obsidian";
import type DmScreenPlugin from "../main";
import type { ClientInfo, PlayerMessage } from "../server";
import { vaultPathFromUrl } from "../server";
import { assertOutboundUrl } from "../net/urlPolicy";
import { PROTOCOL_VERSION } from "../protocol";
import { sourceFromVaultUrl } from "../scenes/format";
import { bytesDataUrl } from "../map/fog";
import { debug, debugWarn } from "../debug";
import { AssetPublisher } from "./assetUpload";
import { callApi, type RemoteEndpoint } from "./remoteApi";
import { RemoteMapData } from "./remoteMapData";
import type { JoinLink, SceneTransport } from "./transport";

export type RemoteStatus = "disconnected" | "connecting" | "active" | "readonly";

export interface Holder {
  deviceId: string;
  name: string;
}

export interface RemoteHooks {
  // The server's cache arrived (first connect, reconnect or hand-over).
  onSession(cache: Record<string, string>, active: boolean): void;
  onRole(active: boolean): void;
  onMirror(message: PlayerMessage): void;
  onScreens(clients: ClientInfo[]): void;
  onStatus(): void;
}

const DEVICE_KEY = "dm-screen-device-id";
const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
export const PROTOCOL_MISMATCH = 4001;

export function deviceName(): string {
  if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
  if (Platform.isAndroidApp) return "Android";
  return "Desktop";
}

// Stored per device on purpose: data.json may sync between devices, which
// would give two of them the same identity and let them share the lease.
export function deviceId(plugin: DmScreenPlugin): string {
  const stored = plugin.app.loadLocalStorage(DEVICE_KEY);
  if (typeof stored === "string" && /^[0-9a-f]{32}$/.test(stored)) return stored;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  plugin.app.saveLocalStorage(DEVICE_KEY, id);
  return id;
}

interface QueueEntry {
  type: string;
  rewritten: Promise<PlayerMessage>;
  dropped: boolean;
}

export class RemoteTransport implements SceneTransport {
  readonly mode = "remote";
  readonly mapData: RemoteMapData;
  readonly publisher: AssetPublisher;
  status: RemoteStatus = "disconnected";
  holder: Holder | null = null;
  clients: ClientInfo[] = [];
  private viewToken = "";
  private hydrus = false;
  private ws: WebSocket | null = null;
  private wanted = false;
  private retryMs = MIN_RETRY_MS;
  private retryTimer: number | null = null;
  private queue: QueueEntry[] = [];
  private pumping = false;

  constructor(private plugin: DmScreenPlugin, private hooks: RemoteHooks) {
    this.publisher = new AssetPublisher({
      plugin,
      endpoint: () => this.endpoint(),
      hydrusOnServer: () => this.hydrus,
      recordSource: (asset, source) => this.mapData.setSource(asset, source),
    });
    this.mapData = new RemoteMapData(() => this.endpoint(), this.publisher);
  }

  private endpoint(): RemoteEndpoint {
    return { base: this.plugin.settings.remoteServerUrl.replace(/\/+$/, ""), token: this.plugin.settings.remoteControlToken };
  }

  connect(): void {
    try {
      assertOutboundUrl(this.plugin.settings.remoteServerUrl, "remote-server");
    } catch (e) {
      new Notice(`Remote server: ${(e as Error).message}`, 8000);
      return;
    }
    this.wanted = true;
    this.retryMs = MIN_RETRY_MS;
    this.open();
  }

  disconnect(): void {
    this.wanted = false;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ws?.close(1000, "Disconnect");
    this.ws = null;
    this.setStatus("disconnected");
  }

  claim(): void {
    this.ws?.send(JSON.stringify({ type: "control-claim", payload: {} }));
  }

  private setStatus(status: RemoteStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.hooks.onStatus();
  }

  private open(): void {
    const { base, token } = this.endpoint();
    const query = new URLSearchParams({ k: token, device: deviceId(this.plugin), name: deviceName(), protocol: String(PROTOCOL_VERSION) });
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/control?${query.toString()}`);
    this.ws = ws;
    this.setStatus("connecting");
    debug("RemoteTransport: connecting to", base);
    ws.onopen = () => {
      this.retryMs = MIN_RETRY_MS;
    };
    ws.onmessage = (ev) => void this.handle(String(ev.data));
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      debug("RemoteTransport: closed", ev.code);
      if (ev.code === PROTOCOL_MISMATCH) {
        this.wanted = false;
        const server = String(ev.reason).split(":")[1] ?? "?";
        new Notice(`Remote server speaks protocol ${server}, this plugin ${PROTOCOL_VERSION}. Update the plugin or the server so they match.`, 0);
      } else if (ev.code === 1008) {
        this.wanted = false;
        new Notice("Remote server rejected the control token", 8000);
      }
      this.setStatus(this.wanted ? "connecting" : "disconnected");
      if (this.wanted) {
        this.retryTimer = window.setTimeout(() => {
          this.retryTimer = null;
          if (this.wanted) this.open();
        }, this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
      }
    };
  }

  private async handle(raw: string): Promise<void> {
    let msg: { type?: string; payload?: any };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const p = msg.payload ?? {};
    switch (msg.type) {
      case "control-hello": {
        this.viewToken = p.viewToken ?? "";
        this.hydrus = p.hydrus === true;
        this.holder = p.holder ?? null;
        this.clients = Array.isArray(p.clients) ? p.clients : [];
        this.publisher.reset();
        await this.mapData.load();
        const active = p.role === "active";
        this.setStatus(active ? "active" : "readonly");
        this.hooks.onSession(p.cache ?? {}, active);
        this.hooks.onScreens(this.clients);
        return;
      }
      case "control-role": {
        this.holder = p.holder ?? null;
        const active = p.role === "active";
        this.setStatus(active ? "active" : "readonly");
        this.hooks.onRole(active);
        return;
      }
      case "mirror":
        if (p.message) this.hooks.onMirror(p.message as PlayerMessage);
        return;
      case "screens":
        this.clients = Array.isArray(p.clients) ? p.clients : [];
        this.hooks.onScreens(this.clients);
        return;
      case "control-error":
        debugWarn("RemoteTransport: server refused a message:", p.code);
        return;
    }
  }

  isLive(): boolean {
    return this.status === "active";
  }

  canEdit(): boolean {
    return this.status === "active";
  }

  broadcast(message: PlayerMessage): void {
    if (!this.isLive()) {
      debug("RemoteTransport: not active, not relaying", message.type);
      return;
    }
    // The local cache keeps the original URLs so DM-side previews resolve.
    this.plugin.replayCache.record(message);
    this.enqueue(message);
  }

  sendLive(message: PlayerMessage): void {
    this.broadcast(message);
  }

  // FIFO across types; a newer message of a type replaces one still waiting,
  // and nothing overtakes a message whose media are still uploading, so a
  // geometry patch never lands before the sync queued ahead of it.
  private enqueue(message: PlayerMessage): void {
    for (const e of this.queue) if (e.type === message.type) e.dropped = true;
    const entry: QueueEntry = { type: message.type, rewritten: this.publisher.rewrite(message), dropped: false };
    entry.rewritten.catch(() => {});
    this.queue.push(entry);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue[0];
        try {
          const message = await entry.rewritten;
          if (!entry.dropped && this.ws?.readyState === WebSocket.OPEN && this.isLive()) {
            this.ws.send(JSON.stringify({ type: "relay", payload: { message } }));
          }
        } catch (e) {
          new Notice(`Not sent to the screens: ${(e as Error).message}`, 8000);
        }
        this.queue.shift();
      }
    } finally {
      this.pumping = false;
    }
  }

  // Layers and fog live on the DM side as data URLs, as in embedded mode, so
  // the editing tools work unchanged; this brings a server copy back.
  async fetchDataUrl(url: string): Promise<string> {
    if (!url.startsWith("/assets/")) return url;
    const res = await callApi(this.endpoint(), "GET", url);
    if (res.status !== 200) throw new Error(`the server answered ${res.status} for an image`);
    const ext = url.slice(url.lastIndexOf(".") + 1);
    const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[ext] ?? "image/png";
    return bytesDataUrl(new Uint8Array(res.arrayBuffer), mime);
  }

  mediaUrl(vaultPath: string): Promise<string> {
    return this.publisher.publishVaultPath(vaultPath);
  }

  displayUrl(url: string): string | null {
    if (url.startsWith("/assets/")) {
      const { base, token } = this.endpoint();
      return `${base}${url}?k=${encodeURIComponent(token)}`;
    }
    const vaultPath = vaultPathFromUrl(url);
    if (vaultPath === null) return url;
    const adapter = this.plugin.app.vault.adapter as { getResourcePath?: (p: string) => string };
    return adapter.getResourcePath?.(vaultPath) ?? null;
  }

  sourceOf(url: string): string | null {
    if (url.startsWith("/assets/")) return this.mapData.source(url.slice("/assets/".length));
    return sourceFromVaultUrl(url, this.plugin.settings.cacheBaseFolder);
  }

  joinLink(path: "/" | "/map"): JoinLink | null {
    if (!this.viewToken || this.status === "disconnected") return null;
    const { base } = this.endpoint();
    return { href: `${base}${path}?k=${encodeURIComponent(this.viewToken)}`, text: `${base}${path === "/" ? "" : path}` };
  }
}
