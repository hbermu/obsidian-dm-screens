import { App, FuzzySuggestModal } from "obsidian";
import { LIGHT_SOURCES, type LightSource } from "../map/lightSources";

export class LightSourceModal extends FuzzySuggestModal<LightSource> {
  constructor(app: App, private onPick: (source: LightSource) => void) {
    super(app);
    this.setPlaceholder("Search a light source or darkvision…");
  }

  getItems(): LightSource[] {
    return LIGHT_SOURCES;
  }

  getItemText(source: LightSource): string {
    return `${source.name} — ${source.brightFt} ft bright, +${source.dimFt} ft dim`;
  }

  onChooseItem(source: LightSource): void {
    this.onPick(source);
  }
}
