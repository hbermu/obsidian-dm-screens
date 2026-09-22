const TOKEN_BYTES = 16;

export function generateAccessToken(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  const bytes = new Uint8Array(TOKEN_BYTES);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Length-independent comparison. An attacker on the LAN can time the 401 and a
// byte-at-a-time early return would let them walk the token out one character
// per request. charCodeAt past the end returns NaN, and NaN | 0 is 0, so the
// loop stays in bounds for both strings while the length xor catches a
// candidate that merely shares a prefix.
export function tokenMatches(secret: string, candidate: string): boolean {
  // Guard the types too: this runs inside the HTTP handler, and a throw there
  // kills the response with ERR_EMPTY_RESPONSE instead of answering 401. A
  // missing or malformed token must fail closed, not fail loudly.
  if (typeof secret !== "string" || typeof candidate !== "string") return false;
  if (secret.length === 0 || candidate.length === 0) return false;
  let diff = secret.length ^ candidate.length;
  const len = Math.max(secret.length, candidate.length);
  for (let i = 0; i < len; i++) {
    diff |= (secret.charCodeAt(i) | 0) ^ (candidate.charCodeAt(i) | 0);
  }
  return diff === 0;
}

export function buildJoinUrl(host: string, port: number, token: string, path: string): string {
  return `http://${host}:${port}${path}?k=${encodeURIComponent(token)}`;
}
