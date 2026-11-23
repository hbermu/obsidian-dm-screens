import type { HydrusAccessInfo, HydrusFile, HydrusService, HydrusTagSuggestion } from "../hydrus/client";
import type { WebhookConfig } from "../webhooks/types";

export interface Capabilities {
  hydrus: boolean;
  ddb: boolean;
  webhooks: string[];
}

// What a Hydrus file becomes once it can reach the screens: the URL to
// broadcast, plus what the DM side needs to label and measure it.
export interface PublishedHydrusFile {
  url: string;
  mediaType: "image" | "video";
  knownTags: string[];
}

// The read surface of `HydrusClient`, plus the two operations that differ
// between a device that keeps a vault cache and a server that keeps assets.
export interface HydrusApi {
  verifyAccess(): Promise<HydrusAccessInfo>;
  getServices(): Promise<HydrusService[]>;
  searchFiles(tags: string[], limit?: number): Promise<{ hashes: string[] }>;
  searchTags(prefix: string, opts?: { tagServiceKey?: string; limit?: number }): Promise<HydrusTagSuggestion[]>;
  getFileMetadata(hashes: string[], tagService?: string): Promise<HydrusFile[]>;
  getThumbnailBytes(hash: string): Promise<ArrayBuffer>;
  getFileRange(hash: string, start: number, end: number): Promise<{ bytes: Uint8Array; partial: boolean }>;
  publish(hash: string): Promise<PublishedHydrusFile>;
  markUsed(hash: string): Promise<void>;
}

export interface DdbEncounterSummary {
  id: string;
  name: string;
}

// The raw state a poll produced. The panel maps it; nothing here decides what
// the players see.
export interface DdbState {
  encounter: unknown;
  characters: Record<string, unknown>;
  error?: string;
}

export interface DdbApi {
  validateSession(): Promise<boolean>;
  getEncounters(): Promise<DdbEncounterSummary[]>;
  getEncounter(id: string): Promise<unknown>;
  // Monster avatars as URLs the screens can load.
  getMonsterImages(ids: number[]): Promise<Map<number, string>>;
  // Starts or stops the poll loop; the callback receives every state.
  track(encounterId: string | null, onState: (state: DdbState) => void): Promise<void>;
}

export interface WebhooksApi {
  targets(): Array<{ id: string; name: string }>;
  // `asset` is the layer's published URL in remote mode and its data URL in
  // embedded mode; each implementation sends what its transport understands.
  send(targetId: string, asset: string, caption: string): Promise<void>;
}

export interface IntegrationGateway {
  readonly kind: "local" | "remote";
  capabilities(): Capabilities;
  hydrus(): HydrusApi | null;
  ddb(): DdbApi | null;
  webhooks(): WebhooksApi;
}

export const webhookTargets = (configs: WebhookConfig[]) => configs.map((w) => ({ id: w.id, name: w.name }));
