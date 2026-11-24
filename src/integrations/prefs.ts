import type DmScreenPlugin from "../main";
import { DEFAULT_SETTINGS, type DmScreenSettings } from "../settings";
import { callApi } from "../transport/remoteApi";
import { debugWarn } from "../debug";

// The settings that describe a session rather than a device. In embedded
// mode they live in data.json; in remote mode the server holds them, so
// every device that takes over sees the same ones.
export const SESSION_PREFERENCE_KEYS = [
  "hydrusTagServices",
  "hydrusIgnoredTagPatterns",
  "hydrusDefaultSearchTags",
  "hydrusDefaultLoop",
  "hydrusDefaultMuted",
  "mapDefaultPxPerSquare",
  "mapFogTvOpacity",
  "ddbInspirationPulse",
] as const;

export type SessionPreferenceKey = (typeof SESSION_PREFERENCE_KEYS)[number];

export class SessionPreferences {
  // What the server has been told; an absent key falls back to the plugin's
  // own default, so the defaults exist in one place.
  private remote: Record<string, unknown> = {};

  constructor(private plugin: DmScreenPlugin) {}

  apply(prefs: Record<string, unknown>): void {
    this.remote = prefs ?? {};
  }

  private isRemote(): boolean {
    return this.plugin.transport.mode === "remote";
  }

  get<K extends SessionPreferenceKey>(key: K): DmScreenSettings[K] {
    if (!this.isRemote()) return this.plugin.settings[key];
    const value = this.remote[key];
    return (value === undefined ? DEFAULT_SETTINGS[key] : value) as DmScreenSettings[K];
  }

  async set<K extends SessionPreferenceKey>(key: K, value: DmScreenSettings[K]): Promise<void> {
    if (!this.isRemote()) {
      this.plugin.settings[key] = value;
      await this.plugin.saveSettings();
      return;
    }
    this.remote[key] = value;
    const endpoint = this.plugin.remote?.endpoint();
    if (!endpoint) return;
    const res = await callApi(endpoint, "PUT", `/api/prefs/${encodeURIComponent(key)}`, value);
    if (res.status !== 204) {
      debugWarn("SessionPreferences: the server refused", key, "with", res.status);
    }
  }
}
