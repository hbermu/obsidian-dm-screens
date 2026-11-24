import type { MapGridConfig } from "./types";

export const FOG_RESOLUTION = 1024;

export interface FogAdapter {
  exists(path: string): Promise<boolean>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function fogCanvasSize(naturalWidth: number, naturalHeight: number): { width: number; height: number } {
  return {
    width: FOG_RESOLUTION,
    height: Math.max(1, Math.round(FOG_RESOLUTION * (naturalHeight / naturalWidth))),
  };
}

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Readable tail + content hash: the tail aids manual cleanup in the vault,
// the hash guarantees distinct maps never share a sidecar.
export function fogSidecarPath(mapUrl: string): string {
  const raw = mapUrl.startsWith("/vault/") ? decodeURIComponent(mapUrl.slice("/vault/".length)) : mapUrl;
  const tail = raw.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-60).replace(/^[._]+/, "") || "x";
  return `.dm-screen/fog/${tail}-${fnv1a(mapUrl)}.png`;
}

export function gridCellRectAt(
  mapX: number,
  mapY: number,
  cfg: Pick<MapGridConfig, "pxPerSquare" | "gridOffsetX" | "gridOffsetY">
): CellRect {
  const s = cfg.pxPerSquare;
  const ix = Math.floor((mapX - cfg.gridOffsetX) / s);
  const iy = Math.floor((mapY - cfg.gridOffsetY) / s);
  return { x: cfg.gridOffsetX + ix * s, y: cfg.gridOffsetY + iy * s, w: s, h: s };
}

export async function loadFogSidecar(adapter: FogAdapter, mapUrl: string): Promise<string | null> {
  const path = fogSidecarPath(mapUrl);
  if (!(await adapter.exists(path))) return null;
  return pngDataUrl(new Uint8Array(await adapter.readBinary(path)));
}

export async function saveFogSidecar(adapter: FogAdapter, mapUrl: string, dataUrl: string): Promise<void> {
  for (const dir of [".dm-screen", ".dm-screen/fog"]) {
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
  }
  await adapter.writeBinary(fogSidecarPath(mapUrl), dataUrlBuffer(dataUrl));
}

export function bytesDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

export function pngDataUrl(bytes: Uint8Array): string {
  return bytesDataUrl(bytes, "image/png");
}

export function dataUrlBuffer(dataUrl: string): ArrayBuffer {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const buf = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return buf;
}
