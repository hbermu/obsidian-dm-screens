import { Modal, Setting, type App } from "obsidian";
import { sanitizeSceneFileName } from "../scenes/format";

// Asks for a scene name; when a scene of that name already exists the same
// modal turns into an overwrite confirmation before calling back.
export class SaveSceneModal extends Modal {
  private name: string;

  constructor(
    app: App,
    private kindLabel: string,
    initialName: string,
    private exists: (name: string) => boolean,
    private onSave: (name: string) => void
  ) {
    super(app);
    this.name = initialName;
  }

  onOpen() {
    this.renderNamePrompt();
  }

  private renderNamePrompt() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `Save ${this.kindLabel} scene` });
    new Setting(contentEl).setName("Name").addText((text) => {
      text.setValue(this.name).onChange((value) => {
        this.name = value;
      });
      text.inputEl.addClass("dm-scene-name-input");
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.submit();
      });
      window.setTimeout(() => text.inputEl.select(), 0);
    });
    new Setting(contentEl).addButton((b) => b.setButtonText("Save").setCta().onClick(() => this.submit()));
  }

  private submit() {
    const name = this.name.trim();
    if (!name || !sanitizeSceneFileName(name)) return;
    if (this.exists(name)) this.renderOverwritePrompt(name);
    else this.finish(name);
  }

  private renderOverwritePrompt(name: string) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `Overwrite "${name}"?` });
    contentEl.createEl("p", { text: "A scene with this name already exists. Saving replaces it." });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Back").onClick(() => this.renderNamePrompt()))
      .addButton((b) => b.setButtonText("Overwrite").setWarning().onClick(() => this.finish(name)));
  }

  private finish(name: string) {
    this.close();
    this.onSave(name);
  }

  onClose() {
    this.contentEl.empty();
  }
}
