// A path segment is treated as a secret when it is at least 12 characters and
// contains neither a dot nor an underscore. That collapses bot tokens, webhook
// ids, snowflakes and file hashes while leaving the things you actually want to
// read in a log: snake_case API routes ("verify_access_key", "file_metadata"),
// short camelCase routes ("sendPhoto"), and filenames ("goblin-portrait.png").
// It over-redacts a long dotless hyphen-free route name, which is the right way
// to be wrong.
const OPAQUE_SEGMENT = /^[A-Za-z0-9:-]{12,}$/;

export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "<unparseable-url>";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "<unparseable-url>";
  const userinfo = url.username.length > 0 || url.password.length > 0 ? "…@" : "";
  const segments = url.pathname.split("/").map((seg) => {
    if (seg.length === 0) return seg;
    if (/^bot./.test(seg)) return "bot…";
    return OPAQUE_SEGMENT.test(seg) ? "…" : seg;
  });
  const query = url.search.length > 0 ? "?…" : "";
  return `${url.protocol}//${userinfo}${url.host}${segments.join("/")}${query}`;
}

export function redactSecret(secret: string): string {
  if (typeof secret !== "string" || secret.length === 0) return "<unset>";
  if (secret.length < 8) return `…(len=${secret.length})`;
  return `${secret.slice(0, 4)}…(len=${secret.length})`;
}
