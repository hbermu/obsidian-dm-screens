import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { PlayerMessage, Target, TargetOptions } from "../target";

interface HarnessServer {
  start(port: number): void;
  stop(): void;
  broadcast(message: PlayerMessage): void;
  maxClients: number;
}

interface HarnessExports {
  PlayerScreenServer: new (plugin: unknown) => HarnessServer;
}

const TOKEN = "0123456789abcdef0123456789abcdef";

export async function startEmbedded(options: TargetOptions = {}): Promise<Target> {
  const cjsPath = process.env.HARNESS_CJS;
  if (!cjsPath) throw new Error("HARNESS_CJS not set; the global setup must build the harness first.");
  const { PlayerScreenServer } = createRequire(import.meta.url)(cjsPath) as HarnessExports;

  const files = new Map<string, Uint8Array>();
  const plugin = {
    manifest: { version: "conformance" },
    app: {
      vault: {
        getAbstractFileByPath: () => null,
        readBinary: async () => new ArrayBuffer(0),
        adapter: {
          exists: async (path: string) => files.has(path),
          readBinary: async (path: string) => {
            const bytes = files.get(path)!;
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          },
        },
      },
    },
    settings: {
      waitingTitle: "Player Screen",
      waitingSubtitle: "Waiting for DM to push content...",
      accessToken: TOKEN,
    },
  };

  const server = new PlayerScreenServer(plugin);
  server.maxClients = options.maxClients ?? 10;
  server.start(0);
  const httpServer = (server as unknown as {
    httpServer: { address(): AddressInfo | string | null; once(event: string, cb: () => void): void };
  }).httpServer;
  await new Promise<void>((resolve) => {
    if (typeof httpServer.address() === "object" && httpServer.address()) resolve();
    else httpServer.once("listening", () => resolve());
  });
  const { port } = httpServer.address() as AddressInfo;

  return {
    name: "embedded",
    baseUrl: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    viewToken: TOKEN,
    broadcast: async (message) => server.broadcast(message),
    publish: async (bytes, ext) => {
      const path = `media/${createHash("sha256").update(bytes).digest("hex")}.${ext}`;
      files.set(path, bytes);
      return `/vault/${path}`;
    },
    stop: async () => {
      server.stop();
      await new Promise((r) => setTimeout(r, 10));
    },
  };
}
