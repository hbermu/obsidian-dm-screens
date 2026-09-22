import { describe, expect, it } from "vitest";
import { assertOutboundUrl, sameOrigin } from "../net/urlPolicy";

describe("assertOutboundUrl", () => {
  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "ftp://h/f"])(
    "rejects %j for every destination",
    (url) => {
      expect(() => assertOutboundUrl(url, "webhook")).toThrow();
      expect(() => assertOutboundUrl(url, "hydrus")).toThrow();
      expect(() => assertOutboundUrl(url, "ddb-image")).toThrow();
    },
  );

  it.each(["", "not a url", "example.com/x", "//example.com/x"])(
    "rejects unparseable value %j",
    (url) => {
      expect(() => assertOutboundUrl(url, "webhook")).toThrow(/valid URL/i);
    },
  );

  it("rejects embedded credentials", () => {
    expect(() => assertOutboundUrl("https://u:p@example.com/x", "webhook")).toThrow(/credential/i);
    expect(() => assertOutboundUrl("https://u@example.com/x", "hydrus")).toThrow(/credential/i);
  });

  it("requires https for a webhook on a public host", () => {
    expect(() => assertOutboundUrl("http://example.com/hook", "webhook")).toThrow(/https/i);
    expect(assertOutboundUrl("https://example.com/hook", "webhook").host).toBe("example.com");
  });

  // A webhook pointed at a service on your own LAN is a legitimate case, and it
  // is what the e2e suite exercises against a loopback receiver.
  it.each(["http://127.0.0.1:8099/hook", "http://localhost:8099/hook", "http://nas.local/hook"])(
    "allows a plaintext webhook to private host %j",
    (url) => {
      expect(() => assertOutboundUrl(url, "webhook")).not.toThrow();
    },
  );

  // DDB image URLs come from their API and are always public, so there is no
  // private-host case to allow.
  it.each([
    "http://media.dndbeyond.com/a.png",
    "http://127.0.0.1/a.png",
    "http://192.168.1.5/a.png",
  ])("requires https for ddb image %j", (url) => {
    expect(() => assertOutboundUrl(url, "ddb-image")).toThrow(/https/i);
  });

  it("accepts an https ddb image", () => {
    expect(assertOutboundUrl("https://media.dndbeyond.com/a.png", "ddb-image").host).toBe(
      "media.dndbeyond.com",
    );
  });

  // A self-hosted Hydrus on plain http is the normal deployment; forcing https
  // would break the integration for everyone to protect a loopback hop.
  it.each([
    "http://localhost:45869/",
    "http://127.0.0.1:45869/",
    "http://192.168.1.50:45869/",
    "http://10.0.0.5/",
    "http://172.16.3.4/",
    "http://172.31.255.255/",
    "http://nas.local:45869/",
  ])("allows plaintext hydrus on private host %j", (url) => {
    expect(() => assertOutboundUrl(url, "hydrus")).not.toThrow();
  });

  it.each([
    "http://hydrus.example.com/",
    "http://8.8.8.8/",
    "http://172.32.0.1/",
    "http://172.15.0.1/",
  ])("rejects plaintext hydrus on public host %j", (url) => {
    expect(() => assertOutboundUrl(url, "hydrus")).toThrow(/https/i);
  });

  it("rejects a multi-label .local-ish public name over plaintext", () => {
    expect(() => assertOutboundUrl("http://evil.local.example.com/", "hydrus")).toThrow(/https/i);
  });

  it("allows https hydrus anywhere", () => {
    expect(assertOutboundUrl("https://hydrus.example.com/", "hydrus").protocol).toBe("https:");
  });

  it("returns the parsed URL so callers can read host and port", () => {
    const url = assertOutboundUrl("http://192.168.1.50:45869/get_files", "hydrus");
    expect(url.hostname).toBe("192.168.1.50");
    expect(url.port).toBe("45869");
    expect(url.pathname).toBe("/get_files");
  });
});

describe("sameOrigin", () => {
  it("matches identical scheme, host and port", () => {
    expect(sameOrigin("http://h:45869/a", "http://h:45869/b")).toBe(true);
  });

  it("rejects a different host", () => {
    expect(sameOrigin("http://h:45869/a", "http://other:45869/a")).toBe(false);
  });

  it("rejects a different port", () => {
    expect(sameOrigin("http://h:45869/a", "http://h:45870/a")).toBe(false);
  });

  it("rejects a different scheme", () => {
    expect(sameOrigin("http://h/a", "https://h/a")).toBe(false);
  });

  it("rejects when either side is unparseable", () => {
    expect(sameOrigin("http://h/a", "")).toBe(false);
    expect(sameOrigin("", "http://h/a")).toBe(false);
  });
});
