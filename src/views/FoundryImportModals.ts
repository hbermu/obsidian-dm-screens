import { App, FuzzySuggestModal, Modal } from "obsidian";
import type { FoundryScene } from "../map/foundry";

export class FoundryImportConfirmModal extends Modal {
  private decided = false;

  constructor(app: App, private mapLabel: string, private existingWalls: number, private onDecide: (accepted: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("dm-foundry-confirm-modal");
    this.titleEl.setText("Foundry module found");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: `Hydrus has a Foundry module for "${this.mapLabel}". Import its walls and grid?` });
    if (this.existingWalls > 0) {
      contentEl.createEl("p", { text: `This replaces the ${this.existingWalls} walls this map has.`, cls: "dm-status-detail" });
    }
    const buttons = contentEl.createDiv({ cls: "dm-rename-modal-buttons" });
    buttons.createEl("button", { text: "Skip" }).addEventListener("click", () => this.decide(false));
    buttons.createEl("button", { text: "Import", cls: "mod-cta" }).addEventListener("click", () => this.decide(true));
  }

  onClose(): void {
    if (!this.decided) this.onDecide(false);
  }

  private decide(accepted: boolean): void {
    this.decided = true;
    this.onDecide(accepted);
    this.close();
  }
}

export class FoundrySceneModal extends FuzzySuggestModal<FoundryScene> {
  constructor(app: App, private scenes: FoundryScene[], private onPick: (scene: FoundryScene | null) => void) {
    super(app);
    this.setPlaceholder("Several scenes match this map — pick the one whose walls to import");
  }

  getItems(): FoundryScene[] {
    return this.scenes;
  }

  getItemText(scene: FoundryScene): string {
    return `${scene.name || "Unnamed scene"} — ${scene.walls.length} walls, ${scene.width}×${scene.height}`;
  }

  onChooseItem(scene: FoundryScene): void {
    this.onPick(scene);
  }

  // Obsidian closes a suggest modal before it delivers the choice, so a
  // dismissal is only reported once the choice had its chance to land.
  onClose(): void {
    window.setTimeout(() => this.onPick(null), 0);
  }
}
