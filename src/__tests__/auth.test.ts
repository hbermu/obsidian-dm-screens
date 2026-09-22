import { describe, expect, it } from "vitest";
import { buildJoinUrl, generateAccessToken, tokenMatches } from "../auth";

describe("generateAccessToken", () => {
  it("produces a 32-char lowercase hex token", () => {
    expect(generateAccessToken()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces a different token each call", () => {
    expect(generateAccessToken()).not.toBe(generateAccessToken());
  });
});

describe("tokenMatches", () => {
  it("accepts an exact match", () => {
    expect(tokenMatches("abc123", "abc123")).toBe(true);
  });

  it("rejects a mismatch of equal length", () => {
    expect(tokenMatches("abc123", "abc124")).toBe(false);
  });

  it("rejects a candidate that is a prefix of the secret", () => {
    expect(tokenMatches("abc123", "abc")).toBe(false);
  });

  it("rejects a candidate that extends the secret", () => {
    expect(tokenMatches("abc123", "abc1234")).toBe(false);
  });

  it("rejects an empty candidate", () => {
    expect(tokenMatches("abc123", "")).toBe(false);
  });

  // An unset token must not turn the server into an open one.
  it("rejects an empty candidate against an empty secret", () => {
    expect(tokenMatches("", "")).toBe(false);
  });

  it("rejects any candidate against an empty secret", () => {
    expect(tokenMatches("", "anything")).toBe(false);
  });

  // Called from the HTTP handler, where a throw answers ERR_EMPTY_RESPONSE
  // instead of 401.
  it.each([undefined, null, 42, {}])("returns false rather than throwing for %p", (bad) => {
    expect(tokenMatches(bad as never, "candidate")).toBe(false);
    expect(tokenMatches("secret", bad as never)).toBe(false);
  });
});

describe("buildJoinUrl", () => {
  it("appends the token as the k query parameter", () => {
    expect(buildJoinUrl("192.168.1.50", 3000, "tok", "/")).toBe(
      "http://192.168.1.50:3000/?k=tok",
    );
  });

  it("works for the map channel", () => {
    expect(buildJoinUrl("192.168.1.50", 3000, "tok", "/map")).toBe(
      "http://192.168.1.50:3000/map?k=tok",
    );
  });

  it("percent-encodes a token with reserved characters", () => {
    expect(buildJoinUrl("host", 80, "a b&c", "/")).toBe("http://host:80/?k=a%20b%26c");
  });
});
