import {
  ALL_FORMATS,
  BufferSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
} from "mediabunny";
import { debug, debugWarn } from "./debug";
import { MEDIA_WIDTH_STEP, videoTargetSize } from "./map/transform";

const MAX_DERIVATIVE_WIDTH = 16384;
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm"]);

export type MediaKind = "image" | "video";

export interface Derivative {
  bytes: ArrayBuffer;
  mime: string;
}

export type MediaEncoder = (data: ArrayBuffer, width: number, kind: MediaKind) => Promise<Derivative | null>;

export function derivativeKind(vaultPath: string): MediaKind | null {
  const ext = vaultPath.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}

// Rounding up to a step keeps the cache keys a requester can mint bounded.
export function parseDerivativeWidth(rawUrl: string): number | null {
  const w = Number(new URL(rawUrl, "http://localhost").searchParams.get("w"));
  if (!Number.isInteger(w) || w <= 0) return null;
  return Math.min(Math.ceil(w / MEDIA_WIDTH_STEP) * MEDIA_WIDTH_STEP, MAX_DERIVATIVE_WIDTH);
}

// The plugin runs in Obsidian's renderer, so Chromium decodes, resizes and
// encodes off the main thread without any native dependency.
async function encodeWebp(data: ArrayBuffer, width: number): Promise<Derivative | null> {
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
  return { bytes: await blob.arrayBuffer(), mime: "image/webp" };
}

// Hardware only: Chromium's software encoders crash the whole renderer, and
// with it Obsidian, on GPU-less Linux. H.264 first because every TV decodes it.
const HARDWARE_VIDEO_CODECS = [
  { codec: "avc", config: "avc1.640028" },
  { codec: "vp9", config: "vp09.00.40.08" },
] as const;

async function hardwareVideoCodec(size: { width: number; height: number }): Promise<"avc" | "vp9" | null> {
  for (const { codec, config } of HARDWARE_VIDEO_CODECS) {
    const { supported } = await VideoEncoder.isConfigSupported({
      codec: config,
      ...size,
      bitrate: 8_000_000,
      hardwareAcceleration: "prefer-hardware",
    });
    if (supported) return codec;
  }
  return null;
}

async function encodeVideo(data: ArrayBuffer, width: number): Promise<Derivative | null> {
  const input = new Input({ source: new BufferSource(data), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) return null;
  const target = videoTargetSize(track.displayWidth, track.displayHeight, width);
  if (!target) return null;
  const codec = await hardwareVideoCodec(target);
  if (!codec) {
    debugWarn("no hardware video encoder for", `${target.width}x${target.height}`, "— serving the original");
    return null;
  }
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const conversion = await Conversion.init({
    input,
    output,
    tracks: "primary",
    video: {
      width: target.width,
      height: target.height,
      fit: "contain",
      codec,
      quality: QUALITY_HIGH,
      hardwareAcceleration: "prefer-hardware",
    },
    audio: { discard: true },
  });
  if (!conversion.isValid) {
    debugWarn("video conversion invalid:", conversion.discardedTracks.map((t) => t.reason).join(", "));
    return null;
  }
  await conversion.execute();
  const bytes = output.target.buffer;
  if (!bytes) return null;
  debug("video derivative:", `${track.displayWidth}x${track.displayHeight} → ${target.width}x${target.height} ${codec}`);
  return { bytes, mime: "video/mp4" };
}

export const encodeMedia: MediaEncoder = (data, width, kind) =>
  kind === "image" ? encodeWebp(data, width) : encodeVideo(data, width);

export class DerivativeCache {
  private entries = new Map<string, Promise<Derivative | null>>();

  constructor(private encode: MediaEncoder, private maxEntries = 6) {}

  get(
    vaultPath: string,
    width: number,
    kind: MediaKind,
    load: () => Promise<ArrayBuffer | null>
  ): Promise<Derivative | null> {
    const key = `${width}|${vaultPath}`;
    const hit = this.entries.get(key);
    if (hit) {
      debug("derivative cache hit:", vaultPath, width);
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    debug("derivative cache miss:", vaultPath, width);
    const pending = this.build(vaultPath, width, kind, load);
    this.entries.set(key, pending);
    pending.then((result) => {
      if (result === null) this.entries.delete(key);
    });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    return pending;
  }

  private async build(
    vaultPath: string,
    width: number,
    kind: MediaKind,
    load: () => Promise<ArrayBuffer | null>
  ): Promise<Derivative | null> {
    const data = await load();
    if (!data) return null;
    try {
      const out = await this.encode(data, width, kind);
      if (out) debug("derivative built:", vaultPath, `${data.byteLength} → ${out.bytes.byteLength} bytes at ${width}px`);
      return out;
    } catch (e) {
      debugWarn("derivative encode failed, serving the original:", vaultPath, e);
      return null;
    }
  }
}
