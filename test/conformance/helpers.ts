import http from "node:http";
import WebSocket from "ws";
import type { PlayerMessage, Target } from "./target";

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

// node:http with agent:false rather than fetch: pooled keep-alive sockets
// outlive server.stop() on some runtimes and leak between specs.
export function get(target: Target, path: string, opts: { token?: string | null; headers?: Record<string, string> } = {}): Promise<HttpResult> {
  const token = opts.token === undefined ? target.viewToken : opts.token;
  const sep = path.includes("?") ? "&" : "?";
  const url = new URL(token === null ? path : `${path}${sep}k=${encodeURIComponent(token)}`, target.baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
  });
}

export class Viewer {
  readonly messages: PlayerMessage[] = [];
  closeCode: number | null = null;
  private ws: WebSocket;
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;

  constructor(target: Target, channel: "player" | "map", opts: { token?: string | null; headers?: Record<string, string> } = {}) {
    const token = opts.token === undefined ? target.viewToken : opts.token;
    const path = channel === "map" ? "/map" : "/";
    const query = token === null ? "" : `?k=${encodeURIComponent(token)}`;
    this.ws = new WebSocket(`${target.baseUrl.replace(/^http/, "ws")}${path}${query}`, { headers: opts.headers });
    this.ws.on("message", (data) => this.messages.push(JSON.parse(data.toString()) as PlayerMessage));
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.closed = new Promise((resolve) => {
      this.ws.once("close", (code) => {
        this.closeCode = code;
        resolve(code);
      });
    });
    this.ws.on("error", () => {});
  }

  types(): string[] {
    return this.messages.map((m) => m.type);
  }

  send(raw: string): void {
    this.ws.send(raw);
  }

  async waitFor(type: string, timeout = 3000): Promise<PlayerMessage> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hit = this.messages.find((m) => m.type === type);
      if (hit) return hit;
      await sleep(20);
    }
    throw new Error(`no '${type}' within ${timeout}ms (saw: ${this.types().join(", ") || "none"})`);
  }

  // The server replays the cache synchronously on connect, so once the socket
  // is open and one event-loop turn has passed, the replay has arrived.
  async settled(): Promise<void> {
    await this.opened;
    await sleep(100);
  }

  close(): void {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function connect(target: Target, channel: "player" | "map"): Promise<Viewer> {
  const v = new Viewer(target, channel);
  await v.settled();
  return v;
}

export const msg = (type: string, payload: Record<string, unknown> = {}): PlayerMessage => ({ type, payload });

export const png = (seed: number): Uint8Array =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed & 0xff, (seed >> 8) & 0xff]);
