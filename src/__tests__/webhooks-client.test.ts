import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { sendWebhookImage } from "../webhooks/client";
import type { WebhookConfig } from "../webhooks/types";

interface CapturedCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}

function mockRequestUrl(
  handler: (call: CapturedCall) => { status?: number; text?: string },
) {
  return vi
    .spyOn(obsidian, "requestUrl")
    .mockImplementation(((param: unknown) => {
      const p =
        typeof param === "string" ? { url: param } : (param as CapturedCall);
      const out = handler({
        url: p.url,
        method: p.method,
        headers: p.headers,
        body: p.body,
      });
      return Promise.resolve({
        status: out.status ?? 200,
        json: {},
        text: out.text ?? "",
        arrayBuffer: new ArrayBuffer(0),
        headers: {},
      });
    }) as unknown as typeof obsidian.requestUrl);
}

const tinyJpeg = "data:image/jpeg;base64," + btoa("FAKEBYTES");

const baseWebhook: WebhookConfig = {
  id: "wh1",
  name: "Telegram",
  url: "https://api.telegram.test/botX/sendPhoto",
  imageField: "photo",
  captionField: "caption",
  extraFields: [{ key: "chat_id", value: "-100" }],
};

afterEach(() => vi.restoreAllMocks());

describe("sendWebhookImage", () => {
  it("POSTs multipart/form-data with extras, caption, and the image binary", async () => {
    let captured: CapturedCall | undefined;
    mockRequestUrl((call) => {
      captured = call;
      return { status: 200 };
    });
    await sendWebhookImage(baseWebhook, tinyJpeg, "Hello map");
    expect(captured?.url).toBe(baseWebhook.url);
    expect(captured?.method).toBe("POST");
    expect(captured?.headers?.["Content-Type"]).toMatch(
      /^multipart\/form-data; boundary=----DmScreenBoundary/,
    );
    const body = captured?.body as ArrayBuffer;
    expect(body).toBeInstanceOf(ArrayBuffer);
    const text = new TextDecoder("latin1").decode(new Uint8Array(body));
    expect(text).toContain('name="chat_id"');
    expect(text).toContain("-100");
    expect(text).toContain('name="caption"');
    expect(text).toContain("Hello map");
    expect(text).toMatch(
      /name="photo"; filename="image\.jpg"\r\nContent-Type: image\/jpeg/,
    );
  });

  // The message reaches a Notice the DM may screenshot, and providers echo the
  // request back on failure — which for Telegram and Discord means the token.
  it("throws on non-2xx with the webhook name and status but not the response body", async () => {
    mockRequestUrl(() => ({ status: 400, text: "Bad request: bot123456:SECRET" }));
    const send = sendWebhookImage(baseWebhook, tinyJpeg, "x");
    await expect(send).rejects.toThrow(/Telegram.*400/);
    await expect(send).rejects.not.toThrow(/SECRET/);
    await expect(send).rejects.not.toThrow(/Bad request/);
  });

  it("skips extras with empty key", async () => {
    let captured: CapturedCall | undefined;
    mockRequestUrl((call) => {
      captured = call;
      return { status: 200 };
    });
    await sendWebhookImage(
      {
        ...baseWebhook,
        extraFields: [
          { key: "", value: "ignored" },
          { key: "kept", value: "v" },
        ],
      },
      tinyJpeg,
      "c",
    );
    const text = new TextDecoder("latin1").decode(
      new Uint8Array(captured!.body as ArrayBuffer),
    );
    expect(text).not.toContain("ignored");
    expect(text).toContain('name="kept"');
  });

  it("omits the caption field when captionField is empty", async () => {
    let captured: CapturedCall | undefined;
    mockRequestUrl((call) => {
      captured = call;
      return { status: 200 };
    });
    await sendWebhookImage(
      { ...baseWebhook, captionField: "" },
      tinyJpeg,
      "x",
    );
    const text = new TextDecoder("latin1").decode(
      new Uint8Array(captured!.body as ArrayBuffer),
    );
    expect(text).not.toContain('name="caption"');
  });
});


describe("sendWebhookImage outbound URL policy", () => {
  const PNG = "data:image/png;base64," + btoa("X");

  function wh(url: string): WebhookConfig {
    return { id: "w1", name: "T", url, imageField: "photo", captionField: "caption", extraFields: [] };
  }

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "ftp://example.com/h",
    "not a url",
    "",
  ])("refuses to send to %j", async (url) => {
    const spy = mockRequestUrl(() => ({ status: 200 }));
    await expect(sendWebhookImage(wh(url), PNG, "c")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  // A plaintext webhook would put the bot token on the wire.
  it("refuses a plaintext http webhook", async () => {
    const spy = mockRequestUrl(() => ({ status: 200 }));
    await expect(sendWebhookImage(wh("http://example.com/hook"), PNG, "c")).rejects.toThrow(/https/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a URL carrying credentials", async () => {
    const spy = mockRequestUrl(() => ({ status: 200 }));
    await expect(sendWebhookImage(wh("https://u:p@example.com/h"), PNG, "c")).rejects.toThrow(
      /credential/i,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends to an https webhook", async () => {
    const spy = mockRequestUrl(() => ({ status: 200 }));
    await sendWebhookImage(wh("https://api.telegram.org/bot123/sendPhoto"), PNG, "c");
    expect(spy).toHaveBeenCalled();
  });
});
