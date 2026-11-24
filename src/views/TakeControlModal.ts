import { Modal, Setting, type App } from "obsidian";

// Confirms taking the session over from another device, which then turns
// read-only and is told who took over.
export class TakeControlModal extends Modal {
  constructor(app: App, private holder: string, private onConfirm: () => void) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Take control?" });
    contentEl.createEl("p", { text: `${this.holder} controls the session now. Taking over makes it read-only.` });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Take control")
          .setCta()
          .onClick(() => {
            this.close();
            this.onConfirm();
          })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}
