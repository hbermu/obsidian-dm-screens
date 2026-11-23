import { requestUrl } from "obsidian";
import { debug, debugWarn, debugError } from "../debug";
import { parseCharacter, parseEncounter, unwrapData } from "./parse";
import { redactUrl } from "../redact";
import type {
  DdbCobaltTokenResponse,
  DdbEncounterSummary,
  DdbEncounter,
  DdbCharacterSummary,
} from "./types";

const AUTH_URL = "https://auth-service.dndbeyond.com/v1/cobalt-token";
const ENCOUNTER_URL = "https://encounter-service.dndbeyond.com/v1/encounters";
const CHARACTER_URL = "https://character-service.dndbeyond.com/character/v5/character";
const MONSTER_SERVICE_URL = "https://monster-service.dndbeyond.com/v1/Monster";

export class DdbClient {
  private token: string | null = null;
  private tokenExpiry = 0;

  constructor(private cobaltSession: string) {
    if (!cobaltSession) throw new Error("CobaltSession cookie is required");
  }

  async validateSession(): Promise<boolean> {
    debug("DDB: validateSession");
    try {
      await this.refreshToken();
      return true;
    } catch (e) {
      debugWarn("DDB: session validation failed:", (e as Error).message);
      return false;
    }
  }

  async getEncounters(): Promise<DdbEncounter[]> {
    debug("DDB: getEncounters");
    const res = await this.authedGet(`${ENCOUNTER_URL}?skip=0&take=100`);
    const body = res.json as { data?: Record<string, unknown>[] } | Record<string, unknown>[];
    const raw = Array.isArray(body) ? body : (body.data ?? []);
    debug("DDB: getEncounters returned", raw.length, "encounter(s)");
    return raw.map((e) => parseEncounter(e));
  }

  async getEncounter(id: string): Promise<DdbEncounter> {
    debug("DDB: getEncounter", id);
    const res = await this.authedGet(`${ENCOUNTER_URL}/${id}`);
    const enc = unwrapData(res.json);
    if (!enc.id) throw new Error("Invalid encounter response");
    return parseEncounter(enc);
  }

  async getMonsterImages(ids: number[]): Promise<Map<number, string>> {
    const validIds = ids.filter((id) => id > 0);
    if (validIds.length === 0) return new Map();
    debug("getMonsterImages: fetching", validIds.length, "monsters:", validIds);
    const result = new Map<number, string>();
    const settled = await Promise.allSettled(
      validIds.map(async (id) => {
        const res = await this.authedGet(`${MONSTER_SERVICE_URL}/${id}`);
        const body = res.json as { data?: Record<string, unknown> };
        const m = body.data ?? (body as unknown as Record<string, unknown>);
        const avatar = (m.largeAvatarUrl as string) || (m.avatarUrl as string) || "";
        return { id, avatar };
      })
    );
    settled.forEach((r, idx) => {
      if (r.status === "fulfilled" && r.value.avatar) {
        result.set(r.value.id, r.value.avatar);
      } else if (r.status === "rejected") {
        debug("getMonsterImages: failed for id", validIds[idx], (r.reason as Error)?.message);
      }
    });
    return result;
  }

  async getCharacter(characterId: number): Promise<DdbCharacterSummary> {
    debug("DDB: getCharacter", characterId);
    const res = await this.authedGet(`${CHARACTER_URL}/${characterId}`);
    const summary = parseCharacter(characterId, res.json);
    if (summary.inspired) debug("DDB: getCharacter", characterId, "inspired=true");
    return summary;
  }

  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry - 30000) {
      return this.token;
    }
    await this.refreshToken();
    return this.token!;
  }

  private async refreshToken(): Promise<void> {
    debug("DDB: refreshing cobalt token");
    const res = await requestUrl({
      url: AUTH_URL,
      method: "POST",
      headers: {
        Cookie: `CobaltSession=${this.cobaltSession}`,
        "Content-Type": "application/json",
      },
      body: "",
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      this.token = null;
      this.tokenExpiry = 0;
      // This is the auth endpoint: its failure body can echo the submitted
      // cookie. Report the status only.
      debugError("DDB: auth failed with status", res.status);
      throw new Error(`DDB auth failed (${res.status})`);
    }
    const data = res.json as DdbCobaltTokenResponse;
    if (!data.token) throw new Error("DDB auth response missing token");
    this.token = data.token;
    this.tokenExpiry = Date.now() + data.ttl * 1000;
    debug("DDB: token refreshed, expires in", data.ttl, "seconds");
  }

  private async authedGet(url: string) {
    const token = await this.ensureToken();
    const res = await requestUrl({
      url,
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      throw: false,
    });
    if (res.status === 401) {
      this.token = null;
      this.tokenExpiry = 0;
      debugWarn("DDB: 401 — session expired for", redactUrl(url));
      throw new Error("DDB session expired");
    }
    if (res.status < 200 || res.status >= 300) {
      debugError("DDB: HTTP", res.status, "for", redactUrl(url));
      throw new Error(`DDB request failed (${res.status}): ${redactUrl(url)}`);
    }
    return res;
  }
}
