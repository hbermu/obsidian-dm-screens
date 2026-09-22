import { describe, expect, it } from "vitest";
import { redactSecret, redactUrl } from "../redact";

describe("redactUrl", () => {
  it("collapses a telegram bot token segment", () => {
    expect(redactUrl("https://api.telegram.org/bot123456:AAEfghIJK/sendPhoto")).toBe(
      "https://api.telegram.org/bot…/sendPhoto",
    );
  });

  it("collapses discord webhook id and token", () => {
    expect(redactUrl("https://discord.com/api/webhooks/12345678901234/abcdefghijklmnop")).toBe(
      "https://discord.com/api/webhooks/…/…",
    );
  });

  it("replaces a query string with an ellipsis", () => {
    expect(redactUrl("http://localhost:45869/get_files?tags=x&key=y")).toBe(
      "http://localhost:45869/get_files?…",
    );
  });

  it("keeps a path with no query untouched", () => {
    expect(redactUrl("http://localhost:45869/verify_access_key")).toBe(
      "http://localhost:45869/verify_access_key",
    );
  });

  it("strips userinfo", () => {
    expect(redactUrl("https://u:p@example.com/a")).toBe("https://…@example.com/a");
  });

  it("keeps a readable route name", () => {
    expect(redactUrl("https://example.com/api/sendPhoto")).toBe("https://example.com/api/sendPhoto");
  });

  it("keeps a filename with an extension readable", () => {
    expect(redactUrl("https://media.dndbeyond.com/avatars/goblin-portrait.png")).toBe(
      "https://media.dndbeyond.com/avatars/goblin-portrait.png",
    );
  });

  it("collapses a long hash segment", () => {
    expect(redactUrl("https://h/files/0123456789abcdef0123456789abcdef")).toBe(
      "https://h/files/…",
    );
  });

  it.each(["not a url", "", "javascript:alert(1)//"])(
    "returns a fixed marker for unparseable %j",
    (raw) => {
      expect(redactUrl(raw)).toBe("<unparseable-url>");
    },
  );

  it("never leaks the original query or userinfo", () => {
    const out = redactUrl("https://user:hunter2@api.example.com/bot9999:SECRET/x?token=abc");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("abc");
  });
});

describe("redactSecret", () => {
  it("keeps a 4-char prefix and the length", () => {
    expect(redactSecret("abcdef123456")).toBe("abcd…(len=12)");
  });

  it("fully masks a short secret", () => {
    expect(redactSecret("abc")).toBe("…(len=3)");
  });

  it("reports an empty secret as unset", () => {
    expect(redactSecret("")).toBe("<unset>");
  });

  it.each([undefined, null, 42])("reports non-string %p as unset", (bad) => {
    expect(redactSecret(bad as never)).toBe("<unset>");
  });
});
