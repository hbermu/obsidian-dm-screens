import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapScreenPanel, type ActiveMap } from "../views/MapScreenPanel";

const RESOURCE = "app://local/vault/big.png";

function makePanel() {
  const plugin = {
    settings: {
      mapConfigs: {} as Record<string, unknown>,
      mapDefaultPxPerSquare: 140,
      mapScreenProfiles: {},
      tvWidth: 1920,
      tvHeight: 1080,
      hydrusDefaultLoop: true,
      hydrusDefaultMuted: true,
      mapFogTvOpacity: 1,
    },
    server: {},
    broadcast: vi.fn(),
    replayCache: { forget: () => {} },
    saveSettings: () => Promise.resolve(),
    broadcastMapCalibration: () => {},
    app: { vault: { adapter: { exists: () => Promise.resolve(false) } } },
  };
  const host = { render: vi.fn(), beginDrag: vi.fn(() => vi.fn()) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const panel = new MapScreenPanel(plugin as any, host as any);
  return { panel, host };
}

function aMap(naturalWidth: number, naturalHeight: number, mediaType: "image" | "video" = "image"): ActiveMap {
  return { url: "/vault/big.png", mediaType, naturalWidth, naturalHeight };
}

// Loading and encoding never happen in this DOM, so both are driven by hand:
// the Image resolves on demand and toBlob yields a stub blob synchronously.
let loadLastImage: (() => void) | null = null;
let createdObjectUrls: string[] = [];
let revokedObjectUrls: string[] = [];
let objectUrlSeq = 0;

beforeEach(() => {
  loadLastImage = null;
  createdObjectUrls = [];
  revokedObjectUrls = [];
  objectUrlSeq = 0;

  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 4480;
    naturalHeight = 7000;
    set src(_value: string) {
      loadLastImage = () => this.onload?.();
    }
  }
  vi.stubGlobal("Image", FakeImage);

  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as never;
  HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
    callback(new Blob([""], { type: "image/png" }));
  } as never;

  URL.createObjectURL = vi.fn(() => {
    const url = `blob:thumb-${++objectUrlSeq}`;
    createdObjectUrls.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revokedObjectUrls.push(url);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preview thumbnail", () => {
  it("leaves a video on its original source", () => {
    const { panel } = makePanel();
    const map = aMap(4480, 7000, "video");
    panel.activeMap = map;

    expect(panel.previewMediaSrc(map, RESOURCE)).toBe(RESOURCE);
    expect(loadLastImage).toBeNull();
  });

  it("uses the original for a map already under the cap, without encoding one", () => {
    const { panel } = makePanel();
    const map = aMap(1600, 1200);
    panel.activeMap = map;

    expect(panel.previewMediaSrc(map, RESOURCE)).toBe(RESOURCE);
    expect(loadLastImage).toBeNull();
    expect(createdObjectUrls).toHaveLength(0);
  });

  it("serves the original until the downscaled copy is ready, then the copy", () => {
    const { panel, host } = makePanel();
    const map = aMap(4480, 7000);
    panel.activeMap = map;

    expect(panel.previewMediaSrc(map, RESOURCE)).toBe(RESOURCE);
    expect(loadLastImage).not.toBeNull();

    loadLastImage!();
    expect(createdObjectUrls).toHaveLength(1);
    expect(host.render).toHaveBeenCalledTimes(1);
    expect(panel.previewMediaSrc(map, RESOURCE)).toBe(createdObjectUrls[0]);
  });

  it("caps the longest side at 2048 and keeps the map's aspect", () => {
    const { panel } = makePanel();
    const map = aMap(4480, 7000);
    panel.activeMap = map;
    let encoded: { width: number; height: number } | null = null;
    HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, callback: BlobCallback) {
      encoded = { width: this.width, height: this.height };
      callback(new Blob([""], { type: "image/png" }));
    } as never;

    panel.previewMediaSrc(map, RESOURCE);
    loadLastImage!();

    expect(encoded).toEqual({ width: 1311, height: 2048 });
  });

  it("encodes once per map however many previews ask for it", () => {
    const { panel } = makePanel();
    const map = aMap(4480, 7000);
    panel.activeMap = map;

    panel.previewMediaSrc(map, RESOURCE);
    panel.previewMediaSrc(map, RESOURCE);
    panel.previewMediaSrc(map, RESOURCE);
    loadLastImage!();

    expect(createdObjectUrls).toHaveLength(1);

    panel.previewMediaSrc(map, RESOURCE);
    panel.previewMediaSrc(map, RESOURCE);
    expect(createdObjectUrls).toHaveLength(1);
  });

  it("drops a copy that finished after the map was swapped away", () => {
    const { panel, host } = makePanel();
    const map = aMap(4480, 7000);
    panel.activeMap = map;

    panel.previewMediaSrc(map, RESOURCE);
    panel.activeMap = { ...map, url: "/vault/other.png" };
    loadLastImage!();

    expect(createdObjectUrls).toHaveLength(0);
    expect(host.render).not.toHaveBeenCalled();
  });

  it("revokes the copy when the map is stopped", () => {
    const { panel } = makePanel();
    const map = aMap(4480, 7000);
    panel.activeMap = map;

    panel.previewMediaSrc(map, RESOURCE);
    loadLastImage!();
    const thumb = createdObjectUrls[0];

    panel.stopMap();
    expect(revokedObjectUrls).toContain(thumb);
  });
});
