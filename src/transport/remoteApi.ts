import { requestUrl } from "obsidian";

export interface RemoteEndpoint {
  base: string;
  token: string;
}

export interface ApiResult {
  status: number;
  json: any;
  arrayBuffer: ArrayBuffer;
}

// requestUrl, not fetch: it bypasses CORS on desktop and mobile alike, and the
// token travels in a header so it never lands in a URL a log could keep.
export async function callApi(
  ep: RemoteEndpoint,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<ApiResult> {
  const binary = body instanceof ArrayBuffer;
  const res = await requestUrl({
    url: `${ep.base}${path}`,
    method,
    headers: { Authorization: `Bearer ${ep.token}`, ...extraHeaders },
    body: body === undefined ? undefined : binary ? (body as ArrayBuffer) : JSON.stringify(body),
    contentType: body === undefined ? undefined : binary ? "application/octet-stream" : "application/json",
    throw: false,
  });
  let json: unknown = null;
  try {
    json = res.json;
  } catch {
    json = null;
  }
  return { status: res.status, json, arrayBuffer: res.arrayBuffer };
}
