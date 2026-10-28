import { describe, expect, it, vi } from "vitest";
import { DerivativeCache, derivativeKind, parseDerivativeWidth } from "../mediaDerivative";

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const text = (d: { bytes: ArrayBuffer } | null) => (d ? new TextDecoder().decode(d.bytes) : null);
const webp = (s: string) => ({ bytes: bytes(s), mime: "image/webp" });

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

describe("derivativeKind", () => {
  it("classifies still images and videos, and nothing else", () => {
    expect(derivativeKind("maps/a.JPG")).toBe("image");
    expect(derivativeKind("maps/a.jpeg")).toBe("image");
    expect(derivativeKind("maps/a.png")).toBe("image");
    expect(derivativeKind("maps/a.webp")).toBe("image");
    expect(derivativeKind("maps/a.mp4")).toBe("video");
    expect(derivativeKind("maps/a.WEBM")).toBe("video");
    expect(derivativeKind("maps/a.gif")).toBeNull();
    expect(derivativeKind("maps/a.mov")).toBeNull();
    expect(derivativeKind("maps/noext")).toBeNull();
  });
});

describe("DerivativeCache", () => {
  it("encodes once for concurrent and repeated requests of the same size", async () => {
    const encode = vi.fn(async (_d: ArrayBuffer, w: number) => webp(`webp@${w}`));
    const load = vi.fn(async () => bytes("original"));
    const cache = new DerivativeCache(encode);
    const [a, b] = await Promise.all([cache.get("m.jpg", 512, "image", load), cache.get("m.jpg", 512, "image", load)]);
    const c = await cache.get("m.jpg", 512, "image", load);
    expect([text(a), text(b), text(c)]).toEqual(["webp@512", "webp@512", "webp@512"]);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keys entries by size, so another width encodes again", async () => {
    const encode = vi.fn(async (_d: ArrayBuffer, w: number) => webp(`webp@${w}`));
    const cache = new DerivativeCache(encode);
    await cache.get("m.jpg", 512, "image", async () => bytes("o"));
    expect(text(await cache.get("m.jpg", 768, "image", async () => bytes("o")))).toBe("webp@768");
    expect(encode).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used entry beyond its capacity", async () => {
    const encode = vi.fn(async (_d: ArrayBuffer, w: number) => webp(`webp@${w}`));
    const cache = new DerivativeCache(encode, 2);
    const load = async () => bytes("o");
    await cache.get("a.jpg", 256, "image", load);
    await cache.get("b.jpg", 256, "image", load);
    await cache.get("a.jpg", 256, "image", load);
    await cache.get("c.jpg", 256, "image", load);
    await cache.get("a.jpg", 256, "image", load);
    expect(encode).toHaveBeenCalledTimes(3);
    await cache.get("b.jpg", 256, "image", load);
    expect(encode).toHaveBeenCalledTimes(4);
  });

  it("does not cache a null result, so the original is served and retried", async () => {
    const encode = vi.fn(async () => null);
    const cache = new DerivativeCache(encode);
    expect(await cache.get("m.jpg", 512, "image", async () => bytes("o"))).toBeNull();
    await Promise.resolve();
    expect(await cache.get("m.jpg", 512, "image", async () => bytes("o"))).toBeNull();
    expect(encode).toHaveBeenCalledTimes(2);
  });

  it("returns null instead of throwing when encoding fails", async () => {
    const cache = new DerivativeCache(async () => {
      throw new Error("decode failed");
    });
    expect(await cache.get("m.jpg", 512, "image", async () => bytes("o"))).toBeNull();
  });

  it("passes the media kind to the encoder", async () => {
    const encode = vi.fn(async () => ({ bytes: bytes("mp4"), mime: "video/mp4" }));
    const cache = new DerivativeCache(encode);
    const out = await cache.get("loop.mp4", 1536, "video", async () => bytes("o"));
    expect(out?.mime).toBe("video/mp4");
    expect(encode).toHaveBeenCalledWith(expect.any(ArrayBuffer), 1536, "video");
  });

  it("returns null without encoding when the file cannot be read", async () => {
    const encode = vi.fn(async () => webp("x"));
    const cache = new DerivativeCache(encode);
    expect(await cache.get("gone.jpg", 512, "image", async () => null)).toBeNull();
    expect(encode).not.toHaveBeenCalled();
  });
});
