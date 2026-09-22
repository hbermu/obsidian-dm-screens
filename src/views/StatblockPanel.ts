// Compact 5e statblock renderer for the DM sidebar
import type { StatblockCreature } from "../types";

const ABILITY_NAMES = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];

function mod(score: number): string {
  const m = Math.floor((score - 10) / 2);
  return m >= 0 ? `+${m}` : `${m}`;
}

// Every value below originates outside the plugin (a D&D Beyond response, a
// Fantasy Statblocks note, a hand-written vault note), so it goes in as a text
// node. Building `<strong>Label</strong> value` as a string would let a crafted
// speed or action description run script inside Obsidian.
function labelledRow(parent: HTMLElement, cls: string, label: string, value: string) {
  const row = parent.createDiv({ cls });
  row.createEl("strong", { text: label });
  row.appendChild(document.createTextNode(` ${value}`));
}

export function renderStatblock(container: HTMLElement, creature: StatblockCreature) {
  container.addClass("dm-statblock-panel");

  // Header
  const header = container.createDiv("dm-sb-header");
  header.createEl("h4", { text: creature.name, cls: "dm-sb-name" });

  const subtitle: string[] = [];
  if (creature.size) subtitle.push(creature.size);
  if (creature.type) {
    let typeStr = creature.type;
    if (creature.subtype) typeStr += ` (${creature.subtype})`;
    subtitle.push(typeStr);
  }
  if (creature.alignment) subtitle.push(creature.alignment);
  if (subtitle.length > 0) {
    header.createDiv({ text: subtitle.join(", "), cls: "dm-sb-subtitle" });
  }

  // Divider
  container.createDiv("dm-sb-divider");

  // Core stats
  const coreStats = container.createDiv("dm-sb-core");
  if (creature.ac != null) {
    labelledRow(coreStats, "dm-sb-stat", "AC", `${creature.ac}`);
  }
  if (creature.hp != null) {
    let hpText = `${creature.hp}`;
    if (creature.hit_dice) hpText += ` (${creature.hit_dice})`;
    labelledRow(coreStats, "dm-sb-stat", "HP", hpText);
  }
  if (creature.speed) {
    labelledRow(coreStats, "dm-sb-stat", "Speed", creature.speed);
  }

  // Ability scores
  if (creature.stats && creature.stats.length === 6) {
    container.createDiv("dm-sb-divider");
    const abilityRow = container.createDiv("dm-sb-abilities");
    creature.stats.forEach((score, i) => {
      const cell = abilityRow.createDiv("dm-sb-ability");
      cell.createDiv({ text: ABILITY_NAMES[i], cls: "dm-sb-ability-label" });
      cell.createDiv({ text: `${score} (${mod(score)})`, cls: "dm-sb-ability-score" });
    });
  }

  container.createDiv("dm-sb-divider");

  // Properties section
  const props = container.createDiv("dm-sb-props");

  if (creature.saves && (Array.isArray(creature.saves) ? creature.saves.length > 0 : Object.keys(creature.saves).length > 0)) {
    labelledRow(props, "dm-sb-prop", "Saving Throws", formatKeyValueList(creature.saves));
  }

  if (creature.skillsaves && (Array.isArray(creature.skillsaves) ? creature.skillsaves.length > 0 : Object.keys(creature.skillsaves).length > 0)) {
    labelledRow(props, "dm-sb-prop", "Skills", formatKeyValueList(creature.skillsaves));
  }

  if (creature.damage_vulnerabilities) {
    labelledRow(props, "dm-sb-prop", "Vulnerabilities", creature.damage_vulnerabilities);
  }
  if (creature.damage_resistances) {
    labelledRow(props, "dm-sb-prop", "Resistances", creature.damage_resistances);
  }
  if (creature.damage_immunities) {
    labelledRow(props, "dm-sb-prop", "Damage Immunities", creature.damage_immunities);
  }
  if (creature.condition_immunities) {
    labelledRow(props, "dm-sb-prop", "Condition Immunities", creature.condition_immunities);
  }
  if (creature.senses) {
    labelledRow(props, "dm-sb-prop", "Senses", creature.senses);
  }
  if (creature.languages) {
    labelledRow(props, "dm-sb-prop", "Languages", creature.languages);
  }
  if (creature.cr != null) {
    labelledRow(props, "dm-sb-prop", "CR", `${creature.cr}`);
  }

  // Traits
  if (creature.traits && creature.traits.length > 0) {
    container.createDiv("dm-sb-divider");
    renderActionBlock(container, "Traits", creature.traits);
  }

  // Actions
  if (creature.actions && creature.actions.length > 0) {
    container.createDiv("dm-sb-divider");
    renderActionBlock(container, "Actions", creature.actions);
  }

  // Bonus Actions
  if (creature.bonus_actions && creature.bonus_actions.length > 0) {
    container.createDiv("dm-sb-divider");
    renderActionBlock(container, "Bonus Actions", creature.bonus_actions);
  }

  // Reactions
  if (creature.reactions && creature.reactions.length > 0) {
    container.createDiv("dm-sb-divider");
    renderActionBlock(container, "Reactions", creature.reactions);
  }

  // Legendary Actions
  if (creature.legendary_actions && creature.legendary_actions.length > 0) {
    container.createDiv("dm-sb-divider");
    renderActionBlock(container, "Legendary Actions", creature.legendary_actions);
  }
}

// Handles both formats: [{Str: 6}, {Con: 4}] (array) and {Str: 6, Con: 4} (object)
function formatKeyValueList(data: unknown): string {
  const entries: [string, number][] = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === "object" && item !== null) {
        for (const [k, v] of Object.entries(item)) {
          entries.push([k, v as number]);
        }
      }
    }
  } else if (typeof data === "object" && data !== null) {
    for (const [k, v] of Object.entries(data)) {
      entries.push([k, v as number]);
    }
  }

  return entries
    .map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${v}`)
    .join(", ");
}

function renderActionBlock(
  container: HTMLElement,
  title: string,
  actions: { name: string; desc: string }[]
) {
  const section = container.createDiv("dm-sb-action-section");
  section.createEl("h5", { text: title, cls: "dm-sb-section-title" });

  for (const action of actions) {
    const el = section.createDiv("dm-sb-action");
    el.createEl("strong").createEl("em", { text: `${action.name}.` });
    el.appendChild(document.createTextNode(` ${action.desc}`));
  }
}
