export type OutboundKind = "webhook" | "hydrus" | "ddb-image";

// Loopback, RFC1918 and mDNS. Plaintext is tolerable only for a service on the
// same trusted network; 172.16/12 is spelled out so 172.15.x and 172.32.x stay
// public.
const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.local)$/i;

export function assertOutboundUrl(raw: string, kind: OutboundKind): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${String(raw).slice(0, 60)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https URLs are allowed, got ${url.protocol}`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("URLs with embedded credentials are not allowed");
  }
  // One rule, not a per-destination exception: plaintext is tolerable only when
  // the host is on the network you already trust. That keeps a Telegram bot token
  // or a DDB session cookie off the plaintext internet — the actual exposure —
  // while leaving the legitimate local cases working: a self-hosted Hydrus on
  // http://localhost:45869, or a webhook pointed at a service on your own LAN.
  // D&D Beyond image URLs come from their API and are always public, so there is
  // no private-host case to allow for them.
  if (url.protocol === "http:" && (kind === "ddb-image" || !PRIVATE_HOST.test(url.hostname))) {
    throw new Error(`${kind} URLs must use https (got plaintext http for ${url.hostname})`);
  }
  return url;
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return false;
  }
}
