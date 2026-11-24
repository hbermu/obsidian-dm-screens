// A plugin double for the remote-transport tests, with an in-memory vault.
import { vi } from "vitest";
import { ReplayCache } from "../server";

export function makeRemotePlugin(files: Record<string, Uint8Array> = {}, mtime = 1000) {
  const local = new Map<string, unknown>();
  // Sources the code under test records for published assets, so a test can
  // assert what a scene saved from them would resolve by.
  const rememberedSources = new Map<string, string>();
  return {
    rememberedSources,
    transport: {
      rememberSource: (url: string, source: string) => void rememberedSources.set(url, source),
      sourceOf: (url: string) => rememberedSources.get(url) ?? null,
    },
    settings: {
      remoteServerUrl: "https://dm.example.lan",
      remoteControlToken: "control-token",
      cacheBaseFolder: ".dm-screen",
    },
    replayCache: new ReplayCache(),
    app: {
      loadLocalStorage: (k: string) => local.get(k) ?? null,
      saveLocalStorage: (k: string, v: unknown) => void local.set(k, v),
      vault: {
        adapter: {
          stat: vi.fn(async (p: string) => (p in files ? { type: "file", size: files[p].length, mtime, ctime: mtime } : null)),
          readBinary: vi.fn(async (p: string) => files[p].slice().buffer),
          exists: async (p: string) => p in files,
          getResourcePath: (p: string) => `app://local/${p}`,
        },
      },
    },
  } as any;
}

