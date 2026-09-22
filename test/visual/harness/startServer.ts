import type { AddressInfo } from "node:net";

interface HarnessExports {
  PlayerScreenServer: new (plugin: unknown) => HarnessServer;
}

interface HarnessServer {
  start(port: number): void;
  stop(): void;
  broadcast(msg: { type: string; payload: Record<string, unknown> }): void;
  clientCount: number;
}

interface FakeSettings {
  serverPort?: number;
  waitingTitle?: string;
  waitingSubtitle?: string;
  ddbInspirationPulse?: boolean;
  maxClients?: number;
  accessToken?: string;
}

const HARNESS_TOKEN = "0123456789abcdef0123456789abcdef";

let cachedExports: HarnessExports | null = null;

function loadHarness(): HarnessExports {
  if (cachedExports) return cachedExports;
  const cjsPath = process.env.HARNESS_CJS;
  if (!cjsPath) {
    throw new Error("HARNESS_CJS not set; globalSetup must run before tests.");
  }
  cachedExports = require(cjsPath) as HarnessExports;
  return cachedExports;
}

export interface StartedServer {
  url: string;
  // The server requires an access token on every route, so specs navigate via
  // join() rather than building URLs from `url` by hand.
  join: (path?: string) => string;
  server: HarnessServer;
  stop: () => Promise<void>;
}

export async function startTestServer(settings: FakeSettings = {}): Promise<StartedServer> {
  const { PlayerScreenServer } = loadHarness();

  const plugin = {
    app: {
      vault: {
        getAbstractFileByPath: () => null,
        readBinary: async () => new ArrayBuffer(0),
        adapter: {},
      },
    },
    settings: {
      serverPort: 0,
      waitingTitle: "Player Screen",
      waitingSubtitle: "Waiting for DM to push content...",
      ddbInspirationPulse: true,
      maxClients: 10,
      accessToken: HARNESS_TOKEN,
      ...settings,
    },
  };

  const server = new PlayerScreenServer(plugin);
  server.start(0);

  const httpServer = (server as unknown as { httpServer: {
    address(): AddressInfo | string | null;
    once(event: string, cb: () => void): void;
  } }).httpServer;

  await new Promise<void>((resolve) => {
    const addr = httpServer.address();
    if (addr && typeof addr === "object") resolve();
    else httpServer.once("listening", () => resolve());
  });

  const addr = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  const token = plugin.settings.accessToken;

  return {
    url,
    join: (path = "/") => `${url}${path}?k=${encodeURIComponent(token)}`,
    server,
    stop: async () => {
      server.stop();
      await new Promise((r) => setTimeout(r, 10));
    },
  };
}
