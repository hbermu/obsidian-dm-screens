import type { PlayerMessage } from "../server";
import type { MapWall, ScreenProfile, StoredMapState } from "../map/types";

// Per-map state the DM edits and expects back next time the map is shown,
// keyed by the map's URL. Embedded mode keeps it in settings and vault
// sidecars; remote mode keeps it on the server so a hand-over carries it.
export interface MapDataStore {
  config(mapUrl: string): StoredMapState | undefined;
  setConfig(mapUrl: string, state: StoredMapState): void;
  profiles(): Record<string, ScreenProfile>;
  setProfile(key: string, profile: ScreenProfile | null): void;
  loadFog(mapUrl: string): Promise<string | null>;
  // `null` removes the stored mask: the map then shows no fog at all.
  saveFog(mapUrl: string, dataUrl: string | null): Promise<void>;
  loadWalls(mapUrl: string): Promise<MapWall[]>;
  saveWalls(mapUrl: string, walls: MapWall[]): Promise<void>;
}

export interface JoinLink {
  // Carries the token: used for the anchor and the clipboard.
  href: string;
  // Never carries the token, so a screenshot of the panel is harmless.
  text: string;
}

export interface SceneTransport {
  readonly mode: "embedded" | "remote";
  readonly mapData: MapDataStore;
  // Screens can receive messages right now: the embedded server is running,
  // or the remote control socket is connected and holds the lease.
  isLive(): boolean;
  // This device may change the session: always in embedded mode; in remote
  // mode only while connected and holding the lease.
  canEdit(): boolean;
  // A state message: recorded in the replay cache and sent when live.
  broadcast(message: PlayerMessage): void;
  // A live-only message: dropped unless live, so the caller re-sends it
  // whenever the transport goes live. When sent it is cached like any other.
  sendLive(message: PlayerMessage): void;
  // The URL a broadcast uses for a vault file: `/vault/<path>` in embedded
  // mode, the published `/assets/<sha256>.<ext>` in remote mode.
  mediaUrl(vaultPath: string): Promise<string>;
  // Makes a URL the DM side holds (a data URL, a vault URL) reachable by the
  // server; in embedded mode there is nowhere else to put it, so it is
  // returned unchanged.
  publishMedia(url: string): Promise<string>;
  // Something an <img>/<video> inside Obsidian can load for a media URL, or
  // null when this device cannot show it.
  displayUrl(url: string): string | null;
  // The scene source reference (`vault:…`, `hydrus:…`) a media URL came from.
  sourceOf(url: string): string | null;
  // Records where a published URL came from, for media the transport cannot
  // work out on its own: a `/vault/` URL carries its source in the path, but
  // an `/assets/` URL the server fetched by Hydrus hash does not, and without
  // this a scene saved from it would have nothing to resolve. A no-op in
  // embedded mode, where every URL is a vault path.
  rememberSource(url: string, source: string): void;
  joinLink(path: "/" | "/map"): JoinLink | null;
}
