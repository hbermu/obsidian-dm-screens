import { Notice } from "obsidian";
import type DmScreenPlugin from "../main";
import type { PlayerMessage } from "../server";
import { vaultPathFromUrl } from "../server";
import { hydrusHashFromVaultPath } from "../hydrus/hashFromPath";
import { dataUrlBuffer } from "../map/fog";
import { sourceFromVaultPath } from "../scenes/format";
import { debug } from "../debug";
import { callApi, type RemoteEndpoint } from "./remoteApi";
import { toWire } from "./wire";

export const PROGRESS_NOTICE_BYTES = 8 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export interface PublisherHost {
  plugin: DmScreenPlugin;
  endpoint(): RemoteEndpoint;
  hydrusOnServer(): boolean;
  recordSource(assetName: string, source: string): void;
}

// Turns DM-side media references into /assets/ URLs on the remote server,
// uploading only what the server does not already hold. Results are memoised
// for the session, so an unchanged layer is not looked up on every sync.
export class AssetPublisher {
  private memo = new Map<string, Promise<string>>();

  constructor(private host: PublisherHost) {}

  reset(): void {
    this.memo.clear();
  }

  private remember(key: string, work: () => Promise<string>): Promise<string> {
    let p = this.memo.get(key);
    if (!p) {
      p = work();
      p.catch(() => this.memo.delete(key));
      this.memo.set(key, p);
    }
    return p;
  }

  publishUrl(url: string): Promise<string> {
    if (!url || url.startsWith("/assets/")) return Promise.resolve(url);
    if (url.startsWith("data:")) return this.publishDataUrl(url);
    const vaultPath = vaultPathFromUrl(url);
    if (vaultPath !== null) return this.publishVaultPath(vaultPath);
    return Promise.resolve(url);
  }

  publishVaultPath(path: string): Promise<string> {
    return this.remember(`vault:${path}`, async () => {
      const url = await this.vaultAsset(path);
      this.host.recordSource(url.slice("/assets/".length), sourceFromVaultPath(path, this.host.plugin.settings.cacheBaseFolder));
      return url;
    });
  }

  publishDataUrl(dataUrl: string): Promise<string> {
    return this.remember(dataUrl, async () => {
      const mime = /^data:([^;,]+)[;,]/.exec(dataUrl)?.[1]?.toLowerCase() ?? "";
      const ext = MIME_EXT[mime];
      if (!ext) throw new Error(`unsupported media type ${mime || "(none)"}`);
      const bytes = dataUrlBuffer(dataUrl);
      const sha = await sha256Hex(bytes);
      return (await this.existing(sha)) ?? this.upload(bytes, ext, "an image");
    });
  }

  // A message as the server must receive it: every media URL an /assets/
  // URL, every layer's source recorded and stripped.
  async rewrite(message: PlayerMessage): Promise<PlayerMessage> {
    const m = JSON.parse(JSON.stringify(message)) as PlayerMessage;
    const p = m.payload as Record<string, any>;
    switch (m.type) {
      case "show-background-media":
      case "map-show":
        if (typeof p.url === "string") p.url = await this.publishUrl(p.url);
        break;
      case "map-fog":
        if (typeof p.dataUrl === "string" && p.dataUrl) p.dataUrl = await this.publishUrl(p.dataUrl);
        break;
      case "image-layers-sync":
        if (Array.isArray(p.layers)) {
          for (const layer of p.layers) {
            if (typeof layer.dataUrl === "string" && layer.dataUrl) {
              layer.dataUrl = await this.publishUrl(layer.dataUrl);
              if (typeof layer.source === "string" && layer.dataUrl.startsWith("/assets/")) {
                this.host.recordSource(layer.dataUrl.slice("/assets/".length), layer.source);
              }
            }
            if (typeof layer.fogDataUrl === "string" && layer.fogDataUrl) layer.fogDataUrl = await this.publishUrl(layer.fogDataUrl);
          }
        }
        break;
    }
    return toWire(m);
  }

  private async existing(sha: string): Promise<string | null> {
    const res = await callApi(this.host.endpoint(), "GET", `/api/assets/${sha}`);
    return res.status === 200 ? `/assets/${sha}.${res.json.ext}` : null;
  }

  private async vaultAsset(path: string): Promise<string> {
    const { plugin } = this.host;
    const name = fileName(path);
    const ep = this.host.endpoint();
    const hash = hydrusHashFromVaultPath(path, plugin.settings.cacheBaseFolder);
    if (hash) {
      const found = await this.existing(hash);
      if (found) return found;
      if (this.host.hydrusOnServer()) {
        const fetched = await callApi(ep, "POST", "/api/assets/hydrus", { hash });
        if (fetched.status === 200) return `/assets/${fetched.json.sha256}.${fetched.json.ext}`;
        debug("AssetPublisher: server-side Hydrus fetch answered", fetched.status, "— uploading instead");
      }
    }
    const stat = await plugin.app.vault.adapter.stat(path);
    if (!stat) throw new Error(`${name} is not in the vault`);
    const fingerprint = { path, size: stat.size, mtime: stat.mtime };
    const hit = await callApi(ep, "POST", "/api/assets/lookup", fingerprint);
    if (hit.status === 200) return `/assets/${hit.json.sha256}.${hit.json.ext}`;
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
    const bytes = await plugin.app.vault.adapter.readBinary(path);
    return this.upload(bytes, ext, name, fingerprint);
  }

  private async upload(bytes: ArrayBuffer, ext: string, label: string, fingerprint?: { path: string; size: number; mtime: number }): Promise<string> {
    const ep = this.host.endpoint();
    const created = await callApi(ep, "POST", "/api/uploads", { size: bytes.byteLength, ext, fingerprint });
    if (created.status !== 201) throw new Error(`uploading ${label} was refused (${created.status})`);
    const { id, chunkSize } = created.json as { id: string; chunkSize: number };
    const notice = bytes.byteLength > PROGRESS_NOTICE_BYTES ? new Notice(`Uploading ${label}… 0%`, 0) : null;
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const res = await callApi(ep, "PUT", `/api/uploads/${id}?offset=${offset}`, bytes.slice(offset, offset + chunkSize));
        if (res.status === 409) {
          offset = res.json.received;
          continue;
        }
        if (res.status !== 200) throw new Error(`uploading ${label} failed (${res.status})`);
        offset = res.json.received;
        notice?.setMessage(`Uploading ${label}… ${Math.floor((offset / bytes.byteLength) * 100)}%`);
      }
      const done = await callApi(ep, "POST", `/api/uploads/${id}/complete`);
      if (done.status !== 200) throw new Error(`uploading ${label} failed (${done.status})`);
      debug("AssetPublisher: uploaded", label, bytes.byteLength, "bytes");
      return `/assets/${done.json.sha256}.${done.json.ext}`;
    } finally {
      notice?.hide();
    }
  }
}
