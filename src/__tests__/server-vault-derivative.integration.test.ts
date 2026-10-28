import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "http";
import type { AddressInfo } from "net";

const encodeMedia = vi.hoisted(() => vi.fn());
vi.mock("../mediaDerivative", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mediaDerivative")>()),
  encodeMedia,
}));

import { PlayerScreenServer } from "../server";

const TEST_TOKEN = "0123456789abcdef0123456789abcdef";
const ORIGINAL = new TextEncoder().encode("ORIGINAL-JPEG").buffer;

function fetchPath(port: number, path: string): Promise<{ status: number; type: string; body: string }> {
  const sep = path.includes("?") ? "&" : "?";
  return new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${port}${path}${sep}k=${TEST_TOKEN}`, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          type: String(res.headers["content-type"]),
          body: Buffer.concat(chunks).toString(),
        })
      );
    }).on("error", reject);
  });
}

describe("PlayerScreenServer /vault/ sized derivatives", () => {
  let server: PlayerScreenServer;
  let port: number;
  let readBinary: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    encodeMedia.mockReset();
    readBinary = vi.fn(async () => ORIGINAL);
    const plugin = {
      app: { vault: { getAbstractFileByPath: () => null, adapter: { exists: async () => true, readBinary } } },
      settings: { serverPort: 0, accessToken: TEST_TOKEN },
    } as any;
    server = new PlayerScreenServer(plugin);
    server.start(0);
    const http = (server as any).httpServer;
    await new Promise<void>((r) => (http.address() ? r() : http.once("listening", () => r())));
    port = (http.address() as AddressInfo).port;
  });

  afterEach(() => server.stop());

  const showMap = (url: string, mediaType = "image") =>
    server.broadcast({ type: "map-show", payload: { url, mediaType, naturalWidth: 4900, naturalHeight: 11760 } });

  it("serves a WebP derivative at the requested width, rounded up to the step", async () => {
    encodeMedia.mockImplementation(async (_d: ArrayBuffer, w: number) => ({
      bytes: new TextEncoder().encode(`WEBP@${w}`).buffer,
      mime: "image/webp",
    }));
    showMap("/vault/maps/big.jpg");
    const res = await fetchPath(port, "/vault/maps/big.jpg?w=1600");
    expect(res).toMatchObject({ status: 200, type: "image/webp", body: "WEBP@1792" });
  });

  it("serves an MP4 derivative of a video map", async () => {
    encodeMedia.mockImplementation(async (_d: ArrayBuffer, w: number, kind: string) => ({
      bytes: new TextEncoder().encode(`${kind}@${w}`).buffer,
      mime: "video/mp4",
    }));
    showMap("/vault/maps/loop.mp4", "video");
    const res = await fetchPath(port, "/vault/maps/loop.mp4?w=1426");
    expect(res).toMatchObject({ status: 200, type: "video/mp4", body: "video@1536" });
  });

  it("serves the original when the encoder declines the width", async () => {
    encodeMedia.mockResolvedValue(null);
    showMap("/vault/maps/small.jpg");
    const res = await fetchPath(port, "/vault/maps/small.jpg?w=4096");
    expect(res).toMatchObject({ status: 200, type: "image/jpeg", body: "ORIGINAL-JPEG" });
  });

  it("ignores the width for formats it does not convert", async () => {
    showMap("/vault/maps/loop.gif");
    const res = await fetchPath(port, "/vault/maps/loop.gif?w=512");
    expect(res).toMatchObject({ status: 200, type: "image/gif", body: "ORIGINAL-JPEG" });
    expect(encodeMedia).not.toHaveBeenCalled();
  });

  it("keeps the display allowlist in front of the encoder", async () => {
    const res = await fetchPath(port, "/vault/maps/secret.jpg?w=512");
    expect(res.status).toBe(404);
    expect(encodeMedia).not.toHaveBeenCalled();
    expect(readBinary).not.toHaveBeenCalled();
  });
});
