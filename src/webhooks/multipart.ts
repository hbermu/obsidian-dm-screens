// Multipart/form-data builder for outbound webhook POSTs.
// Pure functions, no network — tested in isolation.

export interface ParsedDataUrl {
  mime: string;
  bytes: Uint8Array;
  ext: string;
}

export interface MultipartTextField {
  name: string;
  value: string;
}

export interface MultipartFileField {
  name: string;
  filename: string;
  mime: string;
  bytes: Uint8Array;
}

export interface MultipartBody {
  contentType: string;
  body: ArrayBuffer;
}

const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/;

const MAX_MULTIPART_BYTES = 32 * 1024 * 1024;

// RFC 7578 field names and filenames sit inside a quoted-string in a header
// line. CR, LF, quote, backslash, whitespace and control characters would either
// terminate the header or smuggle a new one. Written as three alternatives on
// purpose: a class like [\r\n"\\ -] silently becomes a 0x20-0x2D *range*, which
// rejects "(" and "+" while letting every control character through.
const UNSAFE_HEADER_VALUE = /[\r\n"\\]|\s|\p{Cc}/u;

const PLAIN_MEDIA_TYPE = /^[a-z]+\/[a-z0-9+.-]+$/;

function assertHeaderSafe(kind: "field name" | "filename", value: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Webhook ${kind} must not be empty`);
  }
  if (value.length > 256) {
    throw new Error(`Webhook ${kind} is too long (over 256 characters)`);
  }
  if (UNSAFE_HEADER_VALUE.test(value)) {
    throw new Error(`Webhook ${kind} contains characters that are not allowed in a header`);
  }
}

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

export function dataUrlToBytes(dataUrl: string): ParsedDataUrl {
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) {
    throw new Error("Unsupported data URL: only image/* base64 data URLs are accepted");
  }
  const mime = m[1].toLowerCase();
  const b64 = m[2];
  // Check before decoding: base64 is 4/3 the size of the bytes it carries, so a
  // length test on the encoded string bounds the allocation below.
  if (b64.length > MAX_MULTIPART_BYTES * (4 / 3)) {
    throw new Error("Webhook image is too large (over 32 MiB)");
  }
  const bin = atob(b64);
  if (bin.length > MAX_MULTIPART_BYTES) {
    throw new Error("Webhook image is too large (over 32 MiB)");
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ext = MIME_TO_EXT[mime] ?? "bin";
  return { mime, bytes, ext };
}

export function generateBoundary(): string {
  const r1 = Math.random().toString(16).slice(2, 10).padStart(8, "0");
  const r2 = Math.random().toString(16).slice(2, 10).padStart(8, "0");
  return `----DmScreenBoundary${r1}${r2}`;
}

export function buildMultipart(
  textFields: MultipartTextField[],
  file: MultipartFileField,
  boundary: string = generateBoundary(),
): MultipartBody {
  for (const f of textFields) assertHeaderSafe("field name", f.name);
  assertHeaderSafe("field name", file.name);
  assertHeaderSafe("filename", file.filename);
  if (!PLAIN_MEDIA_TYPE.test(file.mime)) {
    throw new Error(`Webhook file MIME type is not a plain media type: ${file.mime}`);
  }
  if (file.bytes.byteLength > MAX_MULTIPART_BYTES) {
    throw new Error("Webhook image is too large (over 32 MiB)");
  }

  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const f of textFields) {
    chunks.push(enc.encode(`--${boundary}\r\n`));
    chunks.push(enc.encode(`Content-Disposition: form-data; name="${f.name}"\r\n\r\n`));
    chunks.push(enc.encode(`${f.value}\r\n`));
  }
  chunks.push(enc.encode(`--${boundary}\r\n`));
  chunks.push(
    enc.encode(
      `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`,
    ),
  );
  chunks.push(enc.encode(`Content-Type: ${file.mime}\r\n\r\n`));
  chunks.push(file.bytes);
  chunks.push(enc.encode(`\r\n--${boundary}--\r\n`));

  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: out.buffer,
  };
}
