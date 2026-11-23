// Shared doubles for the remote-transport tests: a scripted requestUrl and a
// controllable WebSocket. Free of imports, so a vi.mock factory can load it.

export interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | undefined;
}

// `wait` holds the response open, so a test can prove what the code under
// test does — or does not do — while a request is still in flight.
export type Route = (call: Call) => { status: number; json?: unknown; arrayBuffer?: ArrayBuffer; wait?: Promise<void> } | undefined;

export const http = {
  calls: [] as Call[],
  routes: [] as Route[],
  reset() {
    this.calls = [];
    this.routes = [];
  },
};

export async function fakeRequestUrl(req: { url: string; method?: string; body?: unknown; headers?: Record<string, string> }) {
  const u = new URL(req.url);
  let body: unknown = req.body;
  if (typeof body === "string") body = JSON.parse(body);
  const call: Call = { method: req.method ?? "GET", path: `${u.pathname}${u.search}`, body, auth: req.headers?.Authorization };
  http.calls.push(call);
  for (const route of http.routes) {
    const res = route(call);
    if (res) {
      if (res.wait) await res.wait;
      return { status: res.status, json: res.json ?? null, text: "", arrayBuffer: res.arrayBuffer ?? new ArrayBuffer(0) };
    }
  }
  return { status: 404, json: null, text: "", arrayBuffer: new ArrayBuffer(0) };
}

export const notices: Array<{ message: string; hidden: boolean }> = [];

export class FakeNotice {
  private entry: { message: string; hidden: boolean };
  constructor(message: string) {
    this.entry = { message, hidden: false };
    notices.push(this.entry);
  }
  setMessage(message: string) {
    this.entry.message = message;
    return this;
  }
  hide() {
    this.entry.hidden = true;
  }
}

export class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: Array<{ type: string; payload: any }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(type: string, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type, payload }) });
  }
  serverClose(code: number, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
