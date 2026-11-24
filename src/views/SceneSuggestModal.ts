import { FuzzySuggestModal, type App } from "obsidian";
import { sceneSummary } from "../scenes/format";
import type { SceneEntry } from "../scenes/load";

export class SceneSuggestModal extends FuzzySuggestModal<SceneEntry> {
  constructor(app: App, private entries: SceneEntry[], private onPick: (entry: SceneEntry) => void) {
    super(app);
    this.setPlaceholder("Load a scene…");
  }

  getItems(): SceneEntry[] {
    return this.entries;
  }

  getItemText(entry: SceneEntry): string {
    return `${entry.scene.name} — ${sceneSummary(entry.scene)}`;
  }

  onChooseItem(entry: SceneEntry): void {
    this.onPick(entry);
  }
}
