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
  saveFog(mapUrl: string, dataUrl: string): Promise<void>;
  loadWalls(mapUrl: string): Promise<MapWall[]>;
  saveWalls(mapUrl: string, walls: MapWall[]): Promise<void>;
}

export interface SceneTransport {
  readonly mode: "embedded" | "remote";
  readonly mapData: MapDataStore;
  // Screens can receive messages right now: the embedded server is running,
  // or the remote control socket is connected and holds the lease.
  isLive(): boolean;
  // A state message: recorded in the replay cache and sent when live.
  broadcast(message: PlayerMessage): void;
  // A live-only message: dropped unless live, so the caller re-sends it
  // whenever the transport goes live. When sent it is cached like any other.
  sendLive(message: PlayerMessage): void;
}
