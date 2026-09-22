import * as http from "node:http";

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

// Plain node:http with agent:false — every request opens and closes its own
// socket. Global fetch (undici) pools keep-alive connections, and on the old
// Electron/Node 18 runtimes of Obsidian <=1.5.x a pooled idle socket keeps the
// previous port bound across a server stop/start (see the stop() issue).
// The token travels as the dmScreenKey cookie rather than a ?k= query so that
// callers never have to touch the request path — httpGetRaw depends on sending
// its path byte-for-byte.
function authHeaders(token?: string): http.OutgoingHttpHeaders {
  return token ? { Cookie: `dmScreenKey=${encodeURIComponent(token)}` } : {};
}

export function httpGet(url: string, token?: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false, headers: authHeaders(token) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
  });
}

// Sends the path verbatim — new URL() would collapse "../" segments before the
// server ever saw them, defeating traversal-guard asserts.
export function httpGetRaw(port: number, rawPath: string, token?: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: rawPath,
        method: "GET",
        agent: false,
        headers: authHeaders(token),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
