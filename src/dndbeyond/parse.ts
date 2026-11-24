import { ddbConditionsToStatuses } from "../conditions";
import type { DdbCharacterSummary, DdbEncounter } from "./types";

// Turning D&D Beyond's responses into the shapes the panel works with. It
// lives apart from the client because the same mapping has to happen to a
// state the remote server polled and pushed over the control channel: a raw
// upstream body reaching the panel shows an encounter with no name, no round
// and no combatants.

// Every D&D Beyond service wraps its answer in `data`, except when it does
// not; both shapes are accepted.
export function unwrapData(body: unknown): Record<string, unknown> {
  const obj = (body ?? {}) as Record<string, unknown>;
  const data = obj.data;
  return (data && typeof data === "object" ? data : obj) as Record<string, unknown>;
}

export function parseEncounter(raw: Record<string, unknown>): DdbEncounter {
  const monsters = Array.isArray(raw.monsters) ? raw.monsters : [];
  const players = Array.isArray(raw.players) ? raw.players : [];
  const manualEntries = Array.isArray(raw.manualEntries) ? raw.manualEntries : [];
  return {
    id: raw.id as string,
    name: (raw.name as string) ?? "Unnamed",
    inProgress: (raw.inProgress as boolean) ?? false,
    roundNum: (raw.roundNum as number) ?? 0,
    turnNum: (raw.turnNum as number) ?? 0,
    monsters: monsters.map((m: Record<string, unknown>) => ({
      id: (m.id as number) ?? 0,
      name: (m.name as string) ?? "Unknown",
      initiative: (m.initiative as number) ?? 0,
      currentHitPoints: (m.currentHitPoints as number) ?? 0,
      maximumHitPoints: (m.maximumHitPoints as number) ?? 0,
      uniqueId: (m.uniqueId as string) ?? "",
      avatarUrl: "",
    })),
    players: players
      .filter((p: Record<string, unknown>) => p.type !== "CHARACTER_TYPE_ABSTRACT")
      .filter((p: Record<string, unknown>) => p.hidden !== true)
      .map((p: Record<string, unknown>) => ({
        id: parsePlayerId(p.id),
        name: (p.name as string) ?? (p.userName as string) ?? "Unknown",
        initiative: (p.initiative as number) ?? 0,
      })),
    manualEntries: manualEntries.map((e: Record<string, unknown>) => ({
      id: (e.id as string) ?? "",
      name: (e.name as string) ?? "Unknown",
      initiative: (e.initiative as number) ?? 0,
      currentHitPoints: (e.currentHitPoints as number) ?? 0,
      maximumHitPoints: (e.maximumHitPoints as number) ?? 0,
    })),
  };
}

function parsePlayerId(id: unknown): number {
  if (typeof id === "number") return id;
  if (typeof id === "string") {
    const n = parseInt(id, 10);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}


// The character service reports hit points as a sum the client has to work
// out: base, bonus, the constitution modifier per level, per-level modifiers
// from items and feats, and an override that replaces the lot.
export function parseCharacter(characterId: number, body: unknown): DdbCharacterSummary {
  const data = unwrapData(body);
  const baseHp = (data.baseHitPoints as number) ?? 0;
  const bonusHp = (data.bonusHitPoints as number) ?? 0;
  const removedHp = (data.removedHitPoints as number) ?? 0;
  const tempHp = (data.temporaryHitPoints as number) ?? 0;
  const overrideHp = data.overrideHitPoints as number | null;

  const maxHp = overrideHp != null ? overrideHp : baseHp + bonusHp + computeHpBonuses(data);
  const currentHp = Math.max(0, maxHp - removedHp);

  return {
    id: characterId,
    name: (data.name as string) ?? "Unknown",
    currentHitPoints: currentHp,
    maxHitPoints: maxHp,
    temporaryHitPoints: tempHp,
    statuses: ddbConditionsToStatuses(
      Array.isArray(data.conditions) ? (data.conditions as Array<{ id: number; level: number | null }>) : []
    ),
    inspired: (data.inspiration as boolean) ?? false,
  };
}

function computeHpBonuses(data: Record<string, unknown>): number {
  const totalLevel = getTotalLevel(data);
  const conMod = getConModifier(data);
  const hpPerLevel = getHpPerLevelBonuses(data);
  return (conMod * totalLevel) + (hpPerLevel * totalLevel);
}

function getTotalLevel(data: Record<string, unknown>): number {
  const classes = data.classes as Array<{ level?: number }> | undefined;
  if (!Array.isArray(classes)) return 0;
  return classes.reduce((sum, c) => sum + (c.level ?? 0), 0);
}

function getConModifier(data: Record<string, unknown>): number {
  const stats = data.stats as Array<{ id: number; value?: number }> | undefined;
  const overrideStats = data.overrideStats as Array<{ id: number; value?: number | null }> | undefined;
  const bonusStats = data.bonusStats as Array<{ id: number; value?: number | null }> | undefined;

  // Check override first
  const conOverride = overrideStats?.find((s) => s.id === 3)?.value;
  if (conOverride != null) return Math.floor((conOverride - 10) / 2);

  // Base + bonus
  const conBase = stats?.find((s) => s.id === 3)?.value ?? 10;
  const conBonus = bonusStats?.find((s) => s.id === 3)?.value ?? 0;

  // Check modifiers for CON set/bonus (items like Amulet of Health)
  let modBonus = 0;
  let modSet: number | null = null;
  const modifiers = data.modifiers as Record<string, Array<Record<string, unknown>>> | undefined;
  if (modifiers) {
    for (const modList of Object.values(modifiers)) {
      for (const m of modList ?? []) {
        if ((m.subType as string) !== "constitution-score") continue;
        if (m.type === "set") {
          const val = (m.fixedValue as number) ?? (m.value as number) ?? 0;
          if (modSet === null || val > modSet) modSet = val;
        } else if (m.type === "bonus") {
          modBonus += (m.value as number) ?? (m.fixedValue as number) ?? 0;
        }
      }
    }
  }

  const totalCon = modSet != null ? Math.max(modSet, conBase + conBonus + modBonus) : conBase + conBonus + modBonus;
  return Math.floor((totalCon - 10) / 2);
}

function getHpPerLevelBonuses(data: Record<string, unknown>): number {
  const modifiers = data.modifiers as Record<string, Array<Record<string, unknown>>> | undefined;
  if (!modifiers) return 0;
  let total = 0;
  for (const modList of Object.values(modifiers)) {
    for (const m of modList ?? []) {
      if ((m.subType as string) === "hit-points-per-level") {
        total += (m.fixedValue as number) ?? (m.value as number) ?? 0;
      }
    }
  }
  return total;
}
