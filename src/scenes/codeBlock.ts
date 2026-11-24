import { parseYaml } from "obsidian";
import type DmScreenPlugin from "../main";
import { parseScene, sceneSummary } from "./format";
import { loadScene } from "./load";

export function renderSceneCard(plugin: DmScreenPlugin, source: string, el: HTMLElement, notePath: string): void {
  const parsed = parseScene(source, parseYaml);
  if (!parsed.ok) {
    el.createDiv({ cls: "dm-scene-card dm-scene-error", text: `DM Screen scene: ${parsed.error}` });
    return;
  }
  const { scene } = parsed;
  const card = el.createDiv({ cls: "dm-scene-card" });
  const info = card.createDiv({ cls: "dm-scene-info" });
  info.createDiv({ cls: "dm-scene-name", text: scene.name });
  info.createDiv({
    cls: "dm-scene-summary",
    text: `${scene.kind === "player" ? "Player screen" : "Map"} · ${sceneSummary(scene)}`,
  });
  const load = card.createEl("button", { cls: "dm-scene-card-load mod-cta", text: "Load" });
  load.disabled = !plugin.canEditSession();
  load.addEventListener("click", () => void loadScene(plugin, scene, notePath));
}
