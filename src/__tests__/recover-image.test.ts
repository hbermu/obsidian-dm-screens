import { describe, expect, it, vi } from "vitest";
import { recoverVaultImage } from "../hydrus/recoverImage";

describe("recoverVaultImage", () => {
  it("returns ok when file exists", async () => {
    const plugin = {
      app: { vault: { adapter: { exists: async () => true } } },
      settings: { cacheBaseFolder: ".dm-screen" },
    } as any;
    const result = await recoverVaultImage(plugin, "/vault/test.jpg");
    expect(result).toBe("ok");
  });

  it("returns missing for non-Hydrus paths", async () => {
    const plugin = {
      app: { vault: { adapter: { exists: async () => false } } },
      settings: { cacheBaseFolder: ".dm-screen" },
    } as any;
    const result = await recoverVaultImage(plugin, "/vault/test.jpg");
    expect(result).toBe("missing");
  });

  it("returns missing when Hydrus is unavailable", async () => {
    const plugin = {
      app: { vault: { adapter: { exists: async () => false } } },
      settings: { cacheBaseFolder: ".dm-screen" },
      hydrusCache: null,
    } as any;
    const hash = "a".repeat(64);
    const result = await recoverVaultImage(plugin, `/vault/.dm-screen/hydrus/${hash}.jpg`);
    expect(result).toBe("missing");
  });

  it("returns recovered when Hydrus re-download succeeds", async () => {
    const hash = "b".repeat(64);
    const vaultPath = `.dm-screen/hydrus/${hash}.jpg`;
    const plugin = {
      app: { vault: { adapter: { exists: async () => false } } },
      settings: { cacheBaseFolder: ".dm-screen" },
      hydrusCache: {
        fetchAndCache: vi.fn(async () => ({
          entry: { hash, vaultPath },
        })),
      },
      buildHydrusClient: vi.fn(() => ({
        getFileMetadata: vi.fn(async () => [{ hash, mime: "image/jpeg", ext: "jpg" }]),
      })),
    } as any;
    const result = await recoverVaultImage(plugin, `/vault/${vaultPath}`);
    expect(result).toBe("recovered");
  });

  it("returns missing when file not found in Hydrus", async () => {
    const hash = "c".repeat(64);
    const vaultPath = `.dm-screen/hydrus/${hash}.jpg`;
    const plugin = {
      app: { vault: { adapter: { exists: async () => false } } },
      settings: { cacheBaseFolder: ".dm-screen" },
      hydrusCache: { fetchAndCache: vi.fn() },
      buildHydrusClient: vi.fn(() => ({
        getFileMetadata: vi.fn(async () => []),
      })),
    } as any;
    const result = await recoverVaultImage(plugin, `/vault/${vaultPath}`);
    expect(result).toBe("missing");
  });

  it("respects custom cacheBaseFolder setting", async () => {
    const hash = "d".repeat(64);
    const vaultPath = `custom/hydrus/${hash}.jpg`;
    const plugin = {
      app: { vault: { adapter: { exists: async () => false } } },
      settings: { cacheBaseFolder: "custom" },
      hydrusCache: {
        fetchAndCache: vi.fn(async () => ({
          entry: { hash, vaultPath },
        })),
      },
      buildHydrusClient: vi.fn(() => ({
        getFileMetadata: vi.fn(async () => [{ hash, mime: "image/jpeg", ext: "jpg" }]),
      })),
    } as any;
    const result = await recoverVaultImage(plugin, `/vault/${vaultPath}`);
    expect(result).toBe("recovered");
  });
});
