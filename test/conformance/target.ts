export interface PlayerMessage {
  type: string;
  payload: Record<string, unknown>;
}

export interface TargetOptions {
  maxClients?: number;
}

// One running server under test. Specs never know which implementation they
// talk to; the few cases only one server implements check `name`.
export interface Target {
  name: "embedded" | "remote";
  baseUrl: string;
  host: string;
  viewToken: string;
  // Resolves once the server has processed the message, so a spec can assert
  // on the cache or the allowlist right after awaiting it.
  broadcast(message: PlayerMessage): Promise<void>;
  // Makes bytes servable once a broadcast references them and returns the URL
  // to put in that broadcast: `/vault/...` on the embedded server,
  // `/assets/<sha256>.<ext>` on the remote one.
  publish(bytes: Uint8Array, ext: string): Promise<string>;
  stop(): Promise<void>;
}

export async function startTarget(options?: TargetOptions): Promise<Target> {
  const which = process.env.CONFORMANCE_TARGET ?? "embedded";
  if (which === "embedded") return (await import("./drivers/embedded")).startEmbedded(options);
  if (which === "remote") return (await import("./drivers/remote")).startRemote(options);
  throw new Error(`unknown CONFORMANCE_TARGET ${which}`);
}

export const onlyOn = (target: Target["name"]): boolean =>
  (process.env.CONFORMANCE_TARGET ?? "embedded") === target;
