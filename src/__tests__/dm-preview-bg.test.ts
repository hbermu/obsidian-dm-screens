import { describe, expect, it } from "vitest";
import { isVideoBackgroundUrl } from "../views/DmControlPanel";

describe("isVideoBackgroundUrl", () => {
  it("recognises common video extensions", () => {
    expect(isVideoBackgroundUrl("foo.mp4")).toBe(true);
    expect(isVideoBackgroundUrl("foo.webm")).toBe(true);
    expect(isVideoBackgroundUrl("foo.mov")).toBe(true);
    expect(isVideoBackgroundUrl("foo.ogv")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isVideoBackgroundUrl("FOO.MP4")).toBe(true);
    expect(isVideoBackgroundUrl("foo.WebM")).toBe(true);
  });

  it("tolerates a trailing query string", () => {
    expect(isVideoBackgroundUrl("app://res/foo.mp4?t=123")).toBe(true);
  });

  it("returns false for image extensions and unrelated suffixes", () => {
    expect(isVideoBackgroundUrl("foo.png")).toBe(false);
    expect(isVideoBackgroundUrl("foo.jpg")).toBe(false);
    expect(isVideoBackgroundUrl("foo.webp")).toBe(false);
    expect(isVideoBackgroundUrl("foo.gif")).toBe(false);
    expect(isVideoBackgroundUrl("foo.mp4.txt")).toBe(false);
  });
});
