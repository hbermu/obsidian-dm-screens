import { describe, it, expect, vi } from "vitest";
import { resolveSourceLabel } from "../sourceLabel";
import type DmScreenPlugin from "../main";
import type { HydrusCache, CachedEntry } from "../hydrus/cache";

describe("resolveSourceLabel", () => {
  it("should use the first name: tag when present", () => {
    const result = resolveSourceLabel({
      url: "/vault/hydrus/abc123.png",
      hydrusHash: "abc123def456",
      knownTags: ["creator:artist", "name:Dragon Portrait", "character:smaug"],
    });
    expect(result.label).toBe("Dragon Portrait");
    expect(result.title).toBe("abc123def456");
  });

  it("should strip the name: prefix and trim whitespace", () => {
    const result = resolveSourceLabel({
      url: "/vault/hydrus/abc123.png",
      hydrusHash: "abc123def456",
      knownTags: ["name:  Goblin Camp  "],
    });
    expect(result.label).toBe("Goblin Camp");
    expect(result.title).toBe("abc123def456");
  });

  it("should use Hydrus prefix with first 8 hex chars when no name: tag", () => {
    const result = resolveSourceLabel({
      url: "/vault/hydrus/abc123def456.png",
      hydrusHash: "abc123def456789012345678901234567890123456789012345678901234",
      knownTags: ["creator:unknown", "character:orc"],
    });
    expect(result.label).toBe("Hydrus abc123de");
    expect(result.title).toBe("abc123def456789012345678901234567890123456789012345678901234");
  });

  it("should use note basename for non-Hydrus images from notes", () => {
    const result = resolveSourceLabel({
      url: "/vault/attachments/dragon.png",
      noteBasename: "Session 42 - Dragon Fight",
    });
    expect(result.label).toBe("Session 42 - Dragon Fight");
    expect(result.title).toBe("Session 42 - Dragon Fight");
  });

  it("should use filename as fallback", () => {
    const result = resolveSourceLabel({
      url: "/vault/maps/dungeon%20level%201.png",
    });
    expect(result.label).toBe("dungeon level 1.png");
    expect(result.title).toBe("dungeon level 1.png");
  });

  it("should decode URL-encoded filenames", () => {
    const result = resolveSourceLabel({
      url: "/vault/images/castle%20%26%20moat.jpg",
    });
    expect(result.label).toBe("castle & moat.jpg");
    expect(result.title).toBe("castle & moat.jpg");
  });

  it("should extract filename from data URLs", () => {
    const result = resolveSourceLabel({
      url: "data:image/png;base64,iVBORw0K...",
    });
    // For data URLs, split("/") gives the base64 part as the last component
    expect(result.label).toBe("png;base64,iVBORw0K...");
    expect(result.title).toBe("png;base64,iVBORw0K...");
  });

  it("should ignore empty name: tags and use Hydrus prefix", () => {
    const result = resolveSourceLabel({
      url: "/vault/hydrus/abc123.png",
      hydrusHash: "abc123def456",
      knownTags: ["name:", "name:   ", "creator:artist"],
    });
    expect(result.label).toBe("Hydrus abc123de");
    expect(result.title).toBe("abc123def456");
  });

  it("should handle case-insensitive name: prefix", () => {
    const result = resolveSourceLabel({
      url: "/vault/hydrus/abc123.png",
      hydrusHash: "abc123def456",
      knownTags: ["NAME:Portrait", "creator:artist"],
    });
    expect(result.label).toBe("Portrait");
    expect(result.title).toBe("abc123def456");
  });

  it("should extract hash from Hydrus cache URL and lookup tags when no explicit hash provided", () => {
    const hash = "a".repeat(64);
    const mockCache = {
      getSync: vi.fn().mockReturnValue({
        hash,
        knownTags: ["name:Tower Battle", "creator:artist"],
      } as CachedEntry),
    } as unknown as HydrusCache;

    const mockPlugin = {
      hydrusCache: mockCache,
      settings: { cacheBaseFolder: ".dm-screen" },
    } as unknown as DmScreenPlugin;

    const result = resolveSourceLabel({
      url: `/vault/.dm-screen/hydrus/${hash}.png`,
      plugin: mockPlugin,
    });

    expect(mockCache.getSync).toHaveBeenCalledWith(hash);
    expect(result.label).toBe("Tower Battle");
    expect(result.title).toBe(hash);
  });

  it("should use Hydrus prefix when cache lookup succeeds but no name tag", () => {
    const hash = "b".repeat(64);
    const mockCache = {
      getSync: vi.fn().mockReturnValue({
        hash,
        knownTags: ["creator:artist", "series:dnd"],
      } as CachedEntry),
    } as unknown as HydrusCache;

    const mockPlugin = {
      hydrusCache: mockCache,
      settings: { cacheBaseFolder: ".dm-screen" },
    } as unknown as DmScreenPlugin;

    const result = resolveSourceLabel({
      url: `/vault/.dm-screen/hydrus/${hash}.png`,
      plugin: mockPlugin,
    });

    expect(result.label).toBe(`Hydrus ${hash.slice(0, 8)}`);
    expect(result.title).toBe(hash);
  });

  it("should fall back to filename when cache lookup returns nothing", () => {
    const hash = "c".repeat(64);
    const mockCache = {
      getSync: vi.fn().mockReturnValue(undefined),
    } as unknown as HydrusCache;

    const mockPlugin = {
      hydrusCache: mockCache,
      settings: { cacheBaseFolder: ".dm-screen" },
    } as unknown as DmScreenPlugin;

    const result = resolveSourceLabel({
      url: `/vault/.dm-screen/hydrus/${hash}.png`,
      plugin: mockPlugin,
    });

    expect(mockCache.getSync).toHaveBeenCalledWith(hash);
    expect(result.label).toBe(`${hash}.png`);
    expect(result.title).toBe(`${hash}.png`);
  });

  it("should work with custom cache folder", () => {
    const hash = "d".repeat(64);
    const mockCache = {
      getSync: vi.fn().mockReturnValue({
        hash,
        knownTags: ["name:Custom Folder Test"],
      } as CachedEntry),
    } as unknown as HydrusCache;

    const mockPlugin = {
      hydrusCache: mockCache,
      settings: { cacheBaseFolder: "my/custom/cache" },
    } as unknown as DmScreenPlugin;

    const result = resolveSourceLabel({
      url: `/vault/my/custom/cache/hydrus/${hash}.jpg`,
      plugin: mockPlugin,
    });

    expect(mockCache.getSync).toHaveBeenCalledWith(hash);
    expect(result.label).toBe("Custom Folder Test");
  });

  it("should skip cache lookup when plugin is not provided", () => {
    const hash = "e".repeat(64);
    const result = resolveSourceLabel({
      url: `/vault/.dm-screen/hydrus/${hash}.png`,
    });

    expect(result.label).toBe(`${hash}.png`);
    expect(result.title).toBe(`${hash}.png`);
  });

  it("should skip cache lookup when hydrusCache is null", () => {
    const hash = "f".repeat(64);
    const mockPlugin = {
      hydrusCache: null,
      settings: { cacheBaseFolder: ".dm-screen" },
    } as unknown as DmScreenPlugin;

    const result = resolveSourceLabel({
      url: `/vault/.dm-screen/hydrus/${hash}.png`,
      plugin: mockPlugin,
    });

    expect(result.label).toBe(`${hash}.png`);
    expect(result.title).toBe(`${hash}.png`);
  });
});
