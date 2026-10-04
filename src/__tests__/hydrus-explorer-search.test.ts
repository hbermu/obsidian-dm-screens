import { beforeAll, describe, expect, it, vi } from "vitest";
import { HydrusExplorerModal } from "../views/HydrusExplorerModal";
import type { CachedEntry } from "../hydrus/cache";

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLElement.prototype as any).empty ??= function (this: HTMLElement) { this.replaceChildren(); };
});

const entry = (hash: string, mime: string, tags: string[]): CachedEntry => ({
  hash, mime, ext: mime.split("/")[1], sizeBytes: 1, downloadedAt: 0, lastUsedAt: 0,
  knownTags: tags, vaultPath: `cache/${hash}`, thumbVaultPath: `cache/${hash}.thumb`,
});

const CACHED = [
  entry("img1", "image/jpeg", ["name:abbey prison"]),
  entry("vid1", "video/mp4", ["name:abbey prison"]),
  entry("zip1", "application/zip", ["name:abbey prison", "type:foundry module"]),
];

type Explorer = {
  runSearch(q: string): Promise<void>;
  tiles: Array<{ hash: string }>;
  mode: "online" | "offline";
  localOnly: boolean;
  filterImages: boolean;
  filterVideos: boolean;
  gridEl: HTMLElement;
  paginationEl: HTMLElement;
  renderPage(): void;
  setStatus(text: string): void;
};

function makeExplorer(opts: { online: boolean; images?: boolean; videos?: boolean }) {
  const client = {
    searchFiles: vi.fn().mockResolvedValue({ hashes: ["img1"] }),
    getFileMetadata: vi.fn().mockResolvedValue([{ hash: "img1", mime: "image/jpeg", ext: ".jpg", size: 1, knownTags: [] }]),
  };
  const plugin = {
    hydrusCache: { listCached: () => Promise.resolve(CACHED) },
    buildHydrusClient: () => client,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const modal = new HydrusExplorerModal({} as any, plugin as any) as unknown as Explorer;
  modal.mode = opts.online ? "online" : "offline";
  modal.filterImages = opts.images ?? true;
  modal.filterVideos = opts.videos ?? true;
  modal.gridEl = document.createElement("div");
  modal.paginationEl = document.createElement("div");
  modal.renderPage = vi.fn();
  modal.setStatus = vi.fn();
  return { modal, client };
}

describe("HydrusExplorerModal search — media only", () => {
  it("restricts a Hydrus search to images and videos even with both boxes checked", async () => {
    const { modal, client } = makeExplorer({ online: true });
    await modal.runSearch("name:abbey prison");
    expect(client.searchFiles).toHaveBeenCalledWith(["name:abbey prison", "system:filetype is image, video"], 1000);
  });

  it("names only the checked kind when one box is unchecked", async () => {
    const { modal, client } = makeExplorer({ online: true, videos: false });
    await modal.runSearch("name:abbey prison");
    expect(client.searchFiles).toHaveBeenCalledWith(["name:abbey prison", "system:filetype is image"], 1000);
  });

  it("makes no request when neither kind is checked", async () => {
    const { modal, client } = makeExplorer({ online: true, images: false, videos: false });
    await modal.runSearch("name:abbey prison");
    expect(client.searchFiles).not.toHaveBeenCalled();
    expect(modal.tiles).toEqual([]);
  });

  it("keeps non-media files out of a local-cache search", async () => {
    const { modal, client } = makeExplorer({ online: false });
    await modal.runSearch("name:abbey prison");
    expect(client.searchFiles).not.toHaveBeenCalled();
    expect(modal.tiles.map((t) => t.hash)).toEqual(["img1", "vid1"]);
  });

  it("filters a local-cache search by the checked kind using the file's MIME", async () => {
    const images = makeExplorer({ online: false, videos: false });
    await images.modal.runSearch("name:abbey prison");
    expect(images.modal.tiles.map((t) => t.hash)).toEqual(["img1"]);

    const videos = makeExplorer({ online: false, images: false });
    await videos.modal.runSearch("abbey");
    expect(videos.modal.tiles.map((t) => t.hash)).toEqual(["vid1"]);
  });
});
