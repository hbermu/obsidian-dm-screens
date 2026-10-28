import { debug, debugWarn } from "./debug";
import { MEDIA_WIDTH_STEP } from "./map/transform";

const MAX_DERIVATIVE_WIDTH = 16384;
const RESIZABLE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

export type WebpEncoder = (data: ArrayBuffer, width: number) => Promise<ArrayBuffer | null>;

export function isResizable(vaultPath: string): boolean {
  return RESIZABLE_EXTENSIONS.has(vaultPath.split(".").pop()?.toLowerCase() ?? "");
}

// Rounding up to a step keeps the cache keys a requester can mint bounded.
export function parseDerivativeWidth(rawUrl: string): number | null {
  const w = Number(new URL(rawUrl, "http://localhost").searchParams.get("w"));
  if (!Number.isInteger(w) || w <= 0) return null;
  return Math.min(Math.ceil(w / MEDIA_WIDTH_STEP) * MEDIA_WIDTH_STEP, MAX_DERIVATIVE_WIDTH);
}

// The plugin runs in Obsidian's renderer, so Chromium decodes, resizes and
// encodes off the main thread without any native dependency.
export const encodeWebp: WebpEncoder = async (data, width) => {
  const probe = await createImageBitmap(new Blob([data]));
  const { width: nw, height: nh } = probe;
  probe.close();
  if (nw <= width) return null;
  const height = Math.max(1, Math.round((nh * width) / nw));
  const bitmap = await createImageBitmap(new Blob([data]), {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: "high",
  });
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
  return blob.arrayBuffer();
};

export class DerivativeCache {
  private entries = new Map<string, Promise<ArrayBuffer | null>>();

  constructor(private encode: WebpEncoder, private maxEntries = 6) {}

  get(vaultPath: string, width: number, load: () => Promise<ArrayBuffer | null>): Promise<ArrayBuffer | null> {
    const key = `${width}|${vaultPath}`;
    const hit = this.entries.get(key);
    if (hit) {
      debug("derivative cache hit:", vaultPath, width);
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    debug("derivative cache miss:", vaultPath, width);
    const pending = this.build(vaultPath, width, load);
    this.entries.set(key, pending);
    pending.then((result) => {
      if (result === null) this.entries.delete(key);
    });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    return pending;
  }

  private async build(vaultPath: string, width: number, load: () => Promise<ArrayBuffer | null>): Promise<ArrayBuffer | null> {
    const data = await load();
    if (!data) return null;
    try {
      const out = await this.encode(data, width);
      if (out) debug("derivative built:", vaultPath, `${data.byteLength} → ${out.byteLength} bytes at ${width}px`);
      return out;
    } catch (e) {
      debugWarn("derivative encode failed, serving the original:", vaultPath, e);
      return null;
    }
  }
}
