import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { PlayerMessage, Target, TargetOptions } from "../target";

export const VIEW_TOKEN = "view0123456789abcdef0123456789abcdef";
export const CONTROL_TOKEN = "ctrl0123456789abcdef0123456789abcdef";
export const DEVICE_A = "a".repeat(32);
export const DEVICE_B = "b".repeat(32);

interface ControlMessage {
  type: string;
  payload: Record<string, unknown>;
}

export class ControlClient {
  readonly messages: ControlMessage[] = [];
  closeCode: number | null = null;
  readonly ws: WebSocket;
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;

  constructor(baseUrl: string, query: Record<string, string>, headers?: Record<string, string>) {
    const qs = new URLSearchParams(query).toString();
    this.ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/control?${qs}`, { headers });
    this.ws.on("message", (data) => this.messages.push(JSON.parse(data.toString()) as ControlMessage));
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

  static connect(baseUrl: string, device: string, extra: Record<string, string> = {}, headers?: Record<string, string>): ControlClient {
    return new ControlClient(baseUrl, { k: CONTROL_TOKEN, device, name: `Device ${device[0]}`, protocol: "1", ...extra }, headers);
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  count(type: string): number {
    return this.messages.filter((m) => m.type === type).length;
  }

  async waitFor(type: string, opts: { skip?: number; timeout?: number } = {}): Promise<ControlMessage> {
    const { skip = 0, timeout = 5000 } = opts;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hit = this.messages.filter((m) => m.type === type)[skip];
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no '${type}' #${skip} within ${timeout}ms (saw: ${this.messages.map((m) => m.type).join(", ")})`);
  }

  close(): void {
    this.ws.close();
  }
}

export function api(
  baseUrl: string,
  method: string,
  path: string,
  body?: Uint8Array | string,
  token: string | null = CONTROL_TOKEN,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (typeof body === "string") headers["Content-Type"] = "application/json";
    const req = http.request(new URL(path, baseUrl), { method, agent: false, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = text;
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export async function upload(baseUrl: string, bytes: Uint8Array, ext: string): Promise<string> {
  const created = await api(baseUrl, "POST", "/api/uploads", JSON.stringify({ size: bytes.length, ext }));
  if (created.status !== 201) throw new Error(`upload create answered ${created.status}`);
  const id = created.json.id as string;
  const put = await api(baseUrl, "PUT", `/api/uploads/${id}?offset=0`, bytes);
  if (put.status !== 200) throw new Error(`upload chunk answered ${put.status}`);
  const done = await api(baseUrl, "POST", `/api/uploads/${id}/complete`);
  if (done.status !== 200) throw new Error(`upload complete answered ${done.status}`);
  return `/assets/${done.json.sha256}.${done.json.ext}`;
}

export interface RemoteServer {
  baseUrl: string;
  host: string;
  proc: ChildProcess;
  dataDir: string;
  stop(): Promise<void>;
}

export async function spawnServer(env: Record<string, string> = {}, dataDir?: string): Promise<RemoteServer> {
  const bin = process.env.DM_SCREEN_SERVER_BIN;
  if (!bin) throw new Error("DM_SCREEN_SERVER_BIN is not set");
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "dm-screen-"));
  const proc = spawn(bin, [], {
    env: {
      ...process.env,
      DM_SCREEN_VIEW_TOKEN: VIEW_TOKEN,
      DM_SCREEN_CONTROL_TOKEN: CONTROL_TOKEN,
      DM_SCREEN_PORT: "0",
      DM_SCREEN_DATA_DIR: dir,
      RUST_LOG: "warn",
      ...env,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const m = /listening on [^:\s]+:(\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    proc.once("exit", (code) => reject(new Error(`server exited with ${code} before listening`)));
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    host: `127.0.0.1:${port}`,
    proc,
    dataDir: dir,
    stop: async () => {
      const exited = new Promise((r) => proc.once("exit", r));
      proc.kill("SIGTERM");
      await exited;
      if (!dataDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function startRemote(options: TargetOptions = {}): Promise<Target> {
  const server = await spawnServer(options.maxClients ? { DM_SCREEN_MAX_CLIENTS: String(options.maxClients) } : {});
  const active = ControlClient.connect(server.baseUrl, DEVICE_A);
  await active.waitFor("control-hello");
  // A read-only observer receives a mirror of every processed relay, which is
  // how a broadcast knows the server has applied it.
  const observer = ControlClient.connect(server.baseUrl, DEVICE_B);
  await observer.waitFor("control-hello");
  let relayed = 0;

  return {
    name: "remote",
    baseUrl: server.baseUrl,
    host: server.host,
    viewToken: VIEW_TOKEN,
    broadcast: async (message: PlayerMessage) => {
      active.send({ type: "relay", payload: { message } });
      await observer.waitFor("mirror", { skip: relayed });
      relayed++;
    },
    publish: (bytes, ext) => upload(server.baseUrl, bytes, ext),
    stop: async () => {
      active.close();
      observer.close();
      await server.stop();
    },
  };
}
