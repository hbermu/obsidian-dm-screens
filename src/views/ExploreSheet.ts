import type { CombatMirror } from "./DmControlPanel";

// The AoEs, Vision and Combat panels on a stage too narrow for floating
// windows. Three 260–320 px windows cannot sit side by side on a phone: they
// land on top of each other and bury the map, which is the one thing the DM
// is looking at. Here they become a tab bar along the bottom of the stage and
// a sheet that slides over its lower part, closed until a tab is tapped, so
// the map keeps the whole screen until the DM asks for a control.
//
// Each tab's body exists from the start and only the open one is shown, so the
// panels can be filled whether or not they are visible and the Combat mirror
// keeps one stable element to write into.

export interface SheetTab {
  id: string;
  title: string;
}

export interface SheetPanel extends CombatMirror {
  body: HTMLElement;
  setTitleExtra(el: HTMLElement): void;
}

export class ExploreSheet {
  private el: HTMLElement;
  private tabRow: HTMLElement;
  private sheet: HTMLElement;
  private titleEl: HTMLElement;
  private extraEl: HTMLElement;
  private tabs = new Map<string, { button: HTMLButtonElement; body: HTMLElement; title: string; extra: HTMLElement }>();
  private open: string | null = null;

  constructor(host: HTMLElement, tabs: SheetTab[]) {
    this.el = host.createDiv("dm-explore-sheet-host");

    this.sheet = this.el.createDiv("dm-explore-sheet");
    const header = this.sheet.createDiv("dm-explore-sheet-header");
    this.titleEl = header.createDiv("dm-explore-sheet-title");
    this.extraEl = header.createDiv("dm-explore-sheet-extra");
    const closeBtn = header.createEl("button", { text: "✕", cls: "dm-explore-sheet-close" });
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", () => this.show(null));
    const bodies = this.sheet.createDiv("dm-explore-sheet-bodies");

    this.tabRow = this.el.createDiv("dm-explore-tabs");
    for (const tab of tabs) {
      const button = this.tabRow.createEl("button", { text: tab.title });
      button.addEventListener("click", () => this.show(this.open === tab.id ? null : tab.id));
      const body = bodies.createDiv("dm-explore-sheet-body");
      const extra = document.createElement("div");
      this.tabs.set(tab.id, { button, body, title: tab.title, extra });
    }
    this.show(null);
  }

  // Satisfies what the modal and the Combat mirror need of a floating window.
  panel(id: string): SheetPanel {
    const tab = this.tabs.get(id)!;
    return {
      body: tab.body,
      setTitleExtra: (el: HTMLElement) => {
        tab.extra.empty();
        tab.extra.appendChild(el);
        if (this.open === id) this.syncExtra();
      },
    };
  }

  show(id: string | null): void {
    this.open = id;
    for (const [tabId, tab] of this.tabs) {
      const active = tabId === id;
      tab.button.toggleClass("dm-fog-active", active);
      tab.body.toggleClass("dm-explore-sheet-body-open", active);
    }
    this.el.toggleClass("dm-explore-sheet-open", id !== null);
    this.titleEl.textContent = id ? this.tabs.get(id)!.title : "";
    this.syncExtra();
  }

  // Nothing to keep inside the stage: the sheet is pinned to it.
  clamp(): void {}

  destroy(): void {
    this.el.remove();
  }

  private syncExtra(): void {
    this.extraEl.empty();
    if (!this.open) return;
    this.extraEl.appendChild(this.tabs.get(this.open)!.extra);
  }
}
