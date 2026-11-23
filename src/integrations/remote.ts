import type DmScreenPlugin from "../main";
import type { HydrusFile, HydrusService, HydrusTagSuggestion } from "../hydrus/client";
import { extFromMime, mediaTypeOf } from "../hydrus/client";
import { callApi, type RemoteEndpoint } from "../transport/remoteApi";
import { debug } from "../debug";
import {
  type Capabilities,
  type DdbApi,
  type DdbState,
  type HydrusApi,
  type IntegrationGateway,
  type PublishedHydrusFile,
  type WebhooksApi,
} from "./gateway";

interface HydrusMetadataRow {
  hash: string;
  mime?: string;
  ext?: string;
  width?: number;
  height?: number;
  size?: number;
  tags?: Record<string, { display_tags?: Record<string, string[]> }>;
}

function fail(op: string, status: number): never {
  throw new Error(`${op} failed on the server (${status})`);
}

// The same surfaces as the local gateway, served by the remote server, which
// holds the credentials. Nothing here ever sees one.
export class RemoteGateway implements IntegrationGateway {
  readonly kind = "remote";

  constructor(
    private plugin: DmScreenPlugin,
    private caps: Capabilities,
    private endpoint: () => RemoteEndpoint
  ) {}

  update(caps: Capabilities): void {
    this.caps = caps;
  }

  capabilities(): Capabilities {
    return this.caps;
  }

  private async call(op: string, method: string, path: string, body?: unknown): Promise<any> {
    const res = await callApi(this.endpoint(), method, path, body);
    if (res.status < 200 || res.status >= 300) fail(op, res.status);
    return res.json;
  }

  hydrus(): HydrusApi | null {
    if (!this.caps.hydrus) return null;
    const call = this.call.bind(this);
    const endpoint = this.endpoint;
    return {
      verifyAccess: () => call("Hydrus verify", "GET", "/api/hydrus/verify"),
      getServices: async (): Promise<HydrusService[]> => {
        const body = await call("Hydrus services", "GET", "/api/hydrus/services");
        const list = Array.isArray(body?.services_v2) ? body.services_v2 : [];
        return list
          .filter((s: any) => s?.name && s?.service_key)
          .map((s: any) => ({ name: s.name, service_key: s.service_key, type: typeof s.type === "number" ? s.type : -1 }));
      },
      searchFiles: async (tags, limit) => {
        const body = await call("Hydrus search", "POST", "/api/hydrus/search", { tags, limit });
        return { hashes: Array.isArray(body?.hashes) ? body.hashes : [] };
      },
      searchTags: async (prefix, opts): Promise<HydrusTagSuggestion[]> => {
        const qs = new URLSearchParams({ search: prefix });
        if (opts?.tagServiceKey) qs.set("service", opts.tagServiceKey);
        const body = await call("Hydrus tags", "GET", `/api/hydrus/tags?${qs.toString()}`);
        const list: HydrusTagSuggestion[] = Array.isArray(body?.tags) ? body.tags : [];
        const limit = opts?.limit ?? 50;
        return limit > 0 ? list.slice(0, limit) : list;
      },
      getFileMetadata: async (hashes, tagService): Promise<HydrusFile[]> => {
        if (hashes.length === 0) return [];
        const body = await call("Hydrus metadata", "POST", "/api/hydrus/metadata", { hashes });
        const rows: HydrusMetadataRow[] = Array.isArray(body?.metadata) ? body.metadata : [];
        return rows.map((row) => ({
          hash: row.hash,
          mime: row.mime ?? "application/octet-stream",
          ext: row.ext?.replace(/^\./, "") || extFromMime(row.mime ?? ""),
          width: row.width ?? undefined,
          height: row.height ?? undefined,
          size: row.size ?? 0,
          knownTags: knownTagsOf(row, tagService),
        }));
      },
      getFileBytes: async (hash) => {
        const res = await callApi(endpoint(), "GET", `/api/hydrus/file/${hash}`);
        if (res.status !== 200) fail("Hydrus file", res.status);
        return res.arrayBuffer;
      },
      getThumbnailBytes: async (hash) => {
        const res = await callApi(endpoint(), "GET", `/api/hydrus/thumbnail/${hash}`);
        if (res.status !== 200) fail("Hydrus thumbnail", res.status);
        return res.arrayBuffer;
      },
      getFileRange: async (hash, start, end) => {
        const res = await callApi(endpoint(), "GET", `/api/hydrus/file/${hash}`, undefined, {
          Range: `bytes=${start}-${end}`,
        });
        if (res.status !== 200 && res.status !== 206) fail("Hydrus file", res.status);
        return { bytes: new Uint8Array(res.arrayBuffer), partial: res.status === 206 };
      },
      // The server fetches the file by hash and keeps it; the device never
      // downloads it.
      publish: async (hash): Promise<PublishedHydrusFile> => {
        const stored = await call("Hydrus fetch", "POST", "/api/assets/hydrus", { hash });
        const [meta] = await this.hydrus()!.getFileMetadata([hash]);
        const url = `/assets/${stored.sha256}.${stored.ext}`;
        // The asset store knows the bytes, not where they came from, so the
        // Hydrus reference is recorded here — a scene saved from this file has
        // nothing else to resolve it by.
        this.plugin.transport.rememberSource(url, `hydrus:${hash}`);
        debug("RemoteGateway: published Hydrus", hash.slice(0, 12), "as", stored.ext);
        return {
          url,
          mediaType: meta ? mediaTypeOf(meta.mime) : "image",
          knownTags: meta?.knownTags ?? [],
        };
      },
      // The server's retention is what governs an asset's life.
      markUsed: async () => {},
    };
  }

  ddb(): DdbApi | null {
    if (!this.caps.ddb) return null;
    const call = this.call.bind(this);
    const plugin = this.plugin;
    return {
      validateSession: async () => {
        const body = await call("D&D Beyond validate", "GET", "/api/ddb/validate");
        return body?.valid === true;
      },
      getEncounters: async () => {
        const body = await call("D&D Beyond encounters", "GET", "/api/ddb/encounters");
        const list = Array.isArray(body?.data) ? body.data : [];
        return list.map((e: any) => ({
          id: String(e?.id ?? ""),
          name: String(e?.name ?? ""),
          inProgress: e?.inProgress === true,
        }));
      },
      getEncounter: (id) => call("D&D Beyond encounter", "GET", `/api/ddb/encounters/${encodeURIComponent(id)}`),
      getMonsterImages: async (ids) => {
        const body = await call("D&D Beyond avatars", "POST", "/api/ddb/monster-images", { ids });
        const out = new Map<number, string>();
        for (const [id, url] of Object.entries(body ?? {})) {
          if (typeof url === "string") out.set(Number(id), url);
        }
        return out;
      },
      // The loop runs on the server; the panel receives its states over the
      // control channel and maps them as it maps a local poll.
      track: async (encounterId, onState) => {
        plugin.remote?.onDdbState(encounterId ? (state) => onState(state as DdbState) : null);
        await call("D&D Beyond tracking", "POST", "/api/ddb/track", { encounterId });
      },
    };
  }

  webhooks(): WebhooksApi {
    const call = this.call.bind(this);
    const names = this.caps.webhooks;
    return {
      targets: () => names.map((name) => ({ id: name, name })),
      send: async (targetId, asset, caption) => {
        if (!asset.startsWith("/assets/")) {
          throw new Error("the image has not reached the server yet");
        }
        await call("Webhook send", "POST", `/api/webhooks/${encodeURIComponent(targetId)}/send`, { asset, caption });
      },
    };
  }
}

function knownTagsOf(row: HydrusMetadataRow, tagService?: string): string[] {
  const services = row.tags ?? {};
  const keys = tagService && services[tagService] ? [tagService] : Object.keys(services);
  const out = new Set<string>();
  for (const key of keys) {
    const display = services[key]?.display_tags ?? {};
    for (const list of Object.values(display)) {
      if (Array.isArray(list)) for (const tag of list) out.add(tag);
    }
  }
  return [...out];
}

export function remoteCapabilities(payload: unknown): Capabilities {
  const i = (payload ?? {}) as { hydrus?: unknown; ddb?: unknown; webhooks?: unknown };
  const names = Array.isArray(i.webhooks) ? i.webhooks.filter((n): n is string => typeof n === "string") : [];
  return { hydrus: i.hydrus === true, ddb: i.ddb === true, webhooks: names };
}
