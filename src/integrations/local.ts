import { Notice } from "obsidian";
import type DmScreenPlugin from "../main";
import { HydrusClient } from "../hydrus/client";
import { ensureLocalCopy } from "../hydrus/noteRefs";
import { DdbClient } from "../dndbeyond/client";
import { DdbEncounterPoller } from "../dndbeyond/poller";
import { sendWebhookImage } from "../webhooks/client";
import { debug, debugWarn } from "../debug";
import {
  webhookTargets,
  type Capabilities,
  type DdbApi,
  type DdbState,
  type HydrusApi,
  type IntegrationGateway,
  type PublishedHydrusFile,
  type WebhooksApi,
} from "./gateway";

// Everything this plugin did before the server could hold credentials: the
// clients are built from `data.json` and talk to the services directly.
export class LocalGateway implements IntegrationGateway {
  readonly kind = "local";
  private poller: DdbEncounterPoller | null = null;

  constructor(private plugin: DmScreenPlugin) {}

  capabilities(): Capabilities {
    const s = this.plugin.settings;
    return {
      hydrus: !!(s.hydrusEnabled && s.hydrusApiUrl && s.hydrusApiKey),
      ddb: !!(s.ddbEnabled && s.ddbCobaltSession),
      webhooks: s.webhooks.map((w) => w.name),
    };
  }

  hydrus(): HydrusApi | null {
    const client = this.buildClient();
    const cache = this.plugin.hydrusCache;
    if (!client || !cache) return null;
    const plugin = this.plugin;
    return {
      verifyAccess: () => client.verifyAccess(),
      getServices: () => client.getServices(),
      searchFiles: (tags, limit) => client.searchFiles(tags, limit),
      searchTags: (prefix, opts) => client.searchTags(prefix, opts),
      getFileMetadata: (hashes, tagService) => client.getFileMetadata(hashes, tagService),
      getThumbnailBytes: (hash) => client.getThumbnailBytes(hash),
      getFileRange: (hash, start, end) => client.getFileRange(hash, start, end),
      // The vault cache is the local store, and the transport turns the
      // cached path into the URL the screens will ask for.
      publish: async (hash): Promise<PublishedHydrusFile> => {
        const entry = await ensureLocalCopy(
          { label: "", hash, mediaType: null, cached: false, available: true },
          cache,
          client
        );
        return {
          url: await plugin.transport.mediaUrl(entry.vaultPath),
          mediaType: entry.mime.toLowerCase().startsWith("video/") ? "video" : "image",
          knownTags: entry.knownTags,
        };
      },
      markUsed: (hash) => cache.markUsed(hash),
    };
  }

  private buildClient(): HydrusClient | null {
    const { hydrusEnabled, hydrusApiUrl, hydrusApiKey } = this.plugin.settings;
    if (!hydrusEnabled || !hydrusApiUrl || !hydrusApiKey) return null;
    try {
      return new HydrusClient({ baseUrl: hydrusApiUrl, apiKey: hydrusApiKey });
    } catch (e) {
      debugWarn("LocalGateway: Hydrus client constructor failed:", (e as Error).message);
      return null;
    }
  }

  ddb(): DdbApi | null {
    const { ddbEnabled, ddbCobaltSession } = this.plugin.settings;
    if (!ddbEnabled || !ddbCobaltSession) return null;
    const client = new DdbClient(ddbCobaltSession);
    const plugin = this.plugin;
    const stop = () => {
      this.poller?.stop();
      this.poller = null;
    };
    return {
      validateSession: () => client.validateSession(),
      getEncounters: async () => (await client.getEncounters()).map((e) => ({ id: e.id, name: e.name })),
      getEncounter: (id) => client.getEncounter(id),
      getMonsterImages: async (ids) => {
        const remote = await client.getMonsterImages(ids);
        const cache = plugin.ddbImageCache;
        if (!cache) return remote;
        const out = new Map<number, string>();
        for (const [id, url] of remote) {
          try {
            const vaultPath = await cache.getOrDownload(id, url, String(id));
            out.set(id, await plugin.transport.mediaUrl(vaultPath));
          } catch (e) {
            debugWarn("LocalGateway: avatar download failed for", id, (e as Error).message);
          }
        }
        return out;
      },
      track: async (encounterId, onState) => {
        stop();
        if (!encounterId) return;
        this.poller = new DdbEncounterPoller(
          client,
          encounterId,
          (state) => onState({ encounter: state.encounter, characters: Object.fromEntries(state.characters) }),
          (err) => onState({ encounter: null, characters: {}, error: err.message })
        );
        this.poller.start();
      },
    };
  }

  webhooks(): WebhooksApi {
    const plugin = this.plugin;
    return {
      targets: () => webhookTargets(plugin.settings.webhooks),
      send: async (targetId, asset, caption) => {
        const target = plugin.settings.webhooks.find((w) => w.id === targetId);
        if (!target) throw new Error("that webhook is no longer configured");
        debug("LocalGateway: webhook send to", target.name);
        await sendWebhookImage(target, asset, caption);
      },
    };
  }

  dispose(): void {
    this.poller?.stop();
    this.poller = null;
  }
}

export function noGateway(what: string): never {
  new Notice(`${what} is not configured.`, 6000);
  throw new Error(`${what} is not configured`);
}
