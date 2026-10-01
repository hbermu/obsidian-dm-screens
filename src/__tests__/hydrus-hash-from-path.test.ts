import { describe, it, expect } from "vitest";
import { hydrusHashFromVaultPath } from "../hydrus/hashFromPath";

describe("hydrusHashFromVaultPath", () => {
  it("extracts hash from default cache folder", () => {
    const hash = "a".repeat(64);
    const result = hydrusHashFromVaultPath(`.dm-screen/hydrus/${hash}.png`, ".dm-screen");
    expect(result).toBe(hash);
  });

  it("extracts hash with custom cache folder", () => {
    const hash = "b".repeat(64);
    const result = hydrusHashFromVaultPath(`custom/cache/hydrus/${hash}.jpg`, "custom/cache");
    expect(result).toBe(hash);
  });

  it("returns null for non-Hydrus path", () => {
    const result = hydrusHashFromVaultPath("some/other/path.png", ".dm-screen");
    expect(result).toBeNull();
  });

  it("returns null for wrong folder", () => {
    const hash = "c".repeat(64);
    const result = hydrusHashFromVaultPath(`wrong/hydrus/${hash}.png`, ".dm-screen");
    expect(result).toBeNull();
  });

  it("returns null for invalid hash length", () => {
    const result = hydrusHashFromVaultPath(".dm-screen/hydrus/tooshort.png", ".dm-screen");
    expect(result).toBeNull();
  });

  it("handles cache folder with trailing slash", () => {
    const hash = "d".repeat(64);
    const result = hydrusHashFromVaultPath(`.dm-screen/hydrus/${hash}.png`, ".dm-screen/");
    expect(result).toBe(hash);
  });

  it("returns null when vaultPath has leading slash that doesn't match pattern", () => {
    const hash = "e".repeat(64);
    const result = hydrusHashFromVaultPath(`/.dm-screen/hydrus/${hash}.png`, "/.dm-screen");
    expect(result).toBeNull();
  });

  it("works with different file extensions", () => {
    const hash = "f".repeat(64);
    expect(hydrusHashFromVaultPath(`.dm-screen/hydrus/${hash}.webp`, ".dm-screen")).toBe(hash);
    expect(hydrusHashFromVaultPath(`.dm-screen/hydrus/${hash}.gif`, ".dm-screen")).toBe(hash);
    expect(hydrusHashFromVaultPath(`.dm-screen/hydrus/${hash}.mp4`, ".dm-screen")).toBe(hash);
  });
});
