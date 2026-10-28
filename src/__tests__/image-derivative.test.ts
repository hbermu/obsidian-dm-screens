import { describe, expect, it, vi } from "vitest";
import { DerivativeCache, isResizable, parseDerivativeWidth } from "../imageDerivative";

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const text = (b: ArrayBuffer | null) => (b ? new TextDecoder().decode(b) : null);

describe("parseDerivativeWidth", () => {
  it("rounds the requested width up to the derivative step", () => {
    expect(parseDerivativeWidth("/vault/m.jpg?w=1000")).toBe(1024);
    expect(parseDerivativeWidth("/vault/m.jpg?w=1024")).toBe(1024);
    expect(parseDerivativeWidth("/vault/m.jpg?k=abc&w=1")).toBe(256);
  });

  it("caps the width so a requester cannot mint unbounded sizes", () => {
    expect(parseDerivativeWidth("/vault/m.jpg?w=999999")).toBe(16384);
  });

  it("returns null for a missing, non-integer or non-positive width", () => {
    expect(parseDerivativeWidth("/vault/m.jpg")).toBeNull();
    expect(parseDerivativeWidth("/vault/m.jpg?w=abc")).toBeNull();
    expect(parseDerivativeWidth("/vault/m.jpg?w=12.5")).toBeNull();
    expect(parseDerivativeWidth("/vault/m.jpg?w=0")).toBeNull();
    expect(parseDerivativeWidth("/vault/m.jpg?w=-512")).toBeNull();
  });
});

describe("isResizable", () => {
  it("accepts still raster formats only", () => {
    expect(isResizable("maps/a.JPG")).toBe(true);
    expect(isResizable("maps/a.jpeg")).toBe(true);
    expect(isResizable("maps/a.png")).toBe(true);
    expect(isResizable("maps/a.webp")).toBe(true);
    expect(isResizable("maps/a.gif")).toBe(false);
    expect(isResizable("maps/a.mp4")).toBe(false);
    expect(isResizable("maps/noext")).toBe(false);
  });
});

describe("DerivativeCache", () => {
  it("encodes once for concurrent and repeated requests of the same size", async () => {
    const encode = vi.fn(async (_d: ArrayBuffer, w: number) => bytes(`webp@${w}`));
    const load = vi.fn(async () => bytes("original"));
    const cache = new DerivativeCache(encode);
    const [a, b] = await Promise.all([cache.get("m.jpg", 512, load), cache.get("m.jpg", 512, load)]);
    const c = await cache.get("m.jpg", 512, load);
    expect([text(a), text(b), text(c)]).toEqual(["webp@512", "webp@512", "webp@512"]);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keys entries by size, so another width encodes again", async () => {
    const encode = vi.fn(async (_d: ArrayBuffer, w: number) => bytes(`webp@${w}`));
    const cache = new DerivativeCache(encode);
    await cache.get("m.jpg", 512, async () => bytes("o"));
    expect(text(await cache.get("m.jpg", 768, async () => bytes("o")))).toBe("webp@768");
    expect(encode).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used entry beyond its capacity", async () => {
    const encode = vi.fn(async (_d: ArrayBuffer, w: number) => bytes(`webp@${w}`));
    const cache = new DerivativeCache(encode, 2);
    const load = async () => bytes("o");
    await cache.get("a.jpg", 256, load);
    await cache.get("b.jpg", 256, load);
    await cache.get("a.jpg", 256, load);
    await cache.get("c.jpg", 256, load);
    await cache.get("a.jpg", 256, load);
    expect(encode).toHaveBeenCalledTimes(3);
    await cache.get("b.jpg", 256, load);
    expect(encode).toHaveBeenCalledTimes(4);
  });

  it("does not cache a null result, so the original is served and retried", async () => {
    const encode = vi.fn(async () => null);
    const cache = new DerivativeCache(encode);
    expect(await cache.get("m.jpg", 512, async () => bytes("o"))).toBeNull();
    await Promise.resolve();
    expect(await cache.get("m.jpg", 512, async () => bytes("o"))).toBeNull();
    expect(encode).toHaveBeenCalledTimes(2);
  });

  it("returns null instead of throwing when encoding fails", async () => {
    const cache = new DerivativeCache(async () => {
      throw new Error("decode failed");
    });
    expect(await cache.get("m.jpg", 512, async () => bytes("o"))).toBeNull();
  });

  it("returns null without encoding when the file cannot be read", async () => {
    const encode = vi.fn(async () => bytes("x"));
    const cache = new DerivativeCache(encode);
    expect(await cache.get("gone.jpg", 512, async () => null)).toBeNull();
    expect(encode).not.toHaveBeenCalled();
  });
});
