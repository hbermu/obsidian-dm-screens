import { describe, expect, it, beforeEach } from "vitest";
import { renderControlCard } from "../views/controlCard";

if (!HTMLElement.prototype.createDiv) {
  (HTMLElement.prototype as unknown as Record<string, unknown>).createDiv = function (this: HTMLElement, arg?: string | { cls?: string; text?: string; attr?: Record<string, string> }) {
    const div = document.createElement("div");
    if (typeof arg === "string") div.className = arg;
    else if (arg) {
      if (arg.cls) div.className = arg.cls;
      if (arg.text) div.textContent = arg.text;
      if (arg.attr) {
        for (const [k, v] of Object.entries(arg.attr)) {
          div.setAttribute(k, v);
        }
      }
    }
    this.appendChild(div);
    return div;
  };
}

if (!HTMLElement.prototype.createEl) {
  (HTMLElement.prototype as unknown as Record<string, unknown>).createEl = function (this: HTMLElement, tag: string, opts?: { text?: string; cls?: string; type?: string; attr?: Record<string, string> }) {
    const el = document.createElement(tag);
    if (opts?.cls) el.className = opts.cls;
    if (opts?.text) el.textContent = opts.text;
    if (opts && "type" in opts && opts.type) (el as HTMLInputElement).type = opts.type;
    if (opts?.attr) {
      for (const [k, v] of Object.entries(opts.attr)) {
        el.setAttribute(k, v);
      }
    }
    this.appendChild(el);
    return el;
  };
}

if (!HTMLElement.prototype.addClass) {
  (HTMLElement.prototype as unknown as Record<string, unknown>).addClass = function (this: HTMLElement, cls: string) {
    this.classList.add(cls);
    return this;
  };
}

describe("renderControlCard", () => {
  let parent: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "<div id=\"test-container\"></div>";
    parent = document.getElementById("test-container")!;
  });

  it("renders collapsed card with summary elements", () => {
    renderControlCard(parent, {
      id: "test-1",
      color: "#ff0000",
      label: "Test Label",
      summary: "20 ft",
      icon: "○",
      expanded: false,
      onToggle: () => {},
      onRemove: () => {},
      renderDetails: () => {},
    });

    const card = parent.querySelector(".dm-control-card");
    expect(card).toBeTruthy();
    expect(card?.classList.contains("dm-control-card-expanded")).toBe(false);

    const swatch = card?.querySelector(".dm-control-card-swatch") as HTMLElement;
    expect(swatch).toBeTruthy();
    expect(swatch.style.backgroundColor).toBe("#ff0000");

    const label = card?.querySelector(".dm-control-card-label");
    expect(label?.textContent).toBe("Test Label");

    const icon = card?.querySelector(".dm-control-card-icon");
    expect(icon?.textContent).toBe("○");

    const summary = card?.querySelector(".dm-control-card-summary");
    expect(summary?.textContent).toBe("20 ft");

    const remove = card?.querySelector(".dm-control-card-remove");
    expect(remove?.textContent).toBe("✕");

    const body = card?.querySelector(".dm-control-card-body");
    expect(body).toBeFalsy();
  });

  it("renders expanded card with details body", () => {
    let detailsRendered = false;

    renderControlCard(parent, {
      id: "test-2",
      color: "#00ff00",
      label: "Expanded",
      summary: "30 ft",
      icon: "□",
      expanded: true,
      onToggle: () => {},
      onRemove: () => {},
      renderDetails: (body) => {
        body.createDiv({ cls: "test-detail", text: "Detail content" });
        detailsRendered = true;
      },
    });

    const card = parent.querySelector(".dm-control-card");
    expect(card?.classList.contains("dm-control-card-expanded")).toBe(true);

    const body = card?.querySelector(".dm-control-card-body");
    expect(body).toBeTruthy();

    const detail = body?.querySelector(".test-detail");
    expect(detail?.textContent).toBe("Detail content");
    expect(detailsRendered).toBe(true);
  });

  it("calls onToggle when header is clicked", () => {
    let toggleCalled = false;

    renderControlCard(parent, {
      id: "test-3",
      color: "#0000ff",
      label: "Toggle Test",
      summary: "40 ft",
      icon: "△",
      expanded: false,
      onToggle: () => {
        toggleCalled = true;
      },
      onRemove: () => {},
      renderDetails: () => {},
    });

    const header = parent.querySelector(".dm-control-card-header") as HTMLElement;
    header.click();

    expect(toggleCalled).toBe(true);
  });

  it("calls onRemove when remove button is clicked", () => {
    let removeCalled = false;

    renderControlCard(parent, {
      id: "test-4",
      color: "#ffff00",
      label: "Remove Test",
      summary: "50 ft",
      icon: "―",
      expanded: false,
      onToggle: () => {},
      onRemove: () => {
        removeCalled = true;
      },
      renderDetails: () => {},
    });

    const remove = parent.querySelector(".dm-control-card-remove") as HTMLElement;
    remove.click();

    expect(removeCalled).toBe(true);
  });

  it("has no inline fixed widths in collapsed state", () => {
    renderControlCard(parent, {
      id: "test-5",
      color: "#ff00ff",
      label: "Width Test",
      summary: "60 ft",
      icon: "◯",
      expanded: false,
      onToggle: () => {},
      onRemove: () => {},
      renderDetails: () => {},
    });

    const card = parent.querySelector(".dm-control-card") as HTMLElement;
    const header = card.querySelector(".dm-control-card-header") as HTMLElement;

    expect(card.style.width).toBe("");
    expect(header.style.width).toBe("");

    const label = header.querySelector(".dm-control-card-label") as HTMLElement;
    expect(label.style.width).toBe("");

    const summary = header.querySelector(".dm-control-card-summary") as HTMLElement;
    expect(summary.style.width).toBe("");
  });

  it("survives expanded id when re-rendered", () => {
    let expandedId: string | null = "test-6";

    const render = () => {
      parent.innerHTML = "";
      renderControlCard(parent, {
        id: "test-6",
        color: "#00ffff",
        label: "Persistence Test",
        summary: "70 ft",
        icon: "○",
        expanded: expandedId === "test-6",
        onToggle: () => {
          expandedId = expandedId === "test-6" ? null : "test-6";
          render();
        },
        onRemove: () => {},
        renderDetails: (body) => {
          body.createDiv({ text: "Details" });
        },
      });
    };

    render();
    let card = parent.querySelector(".dm-control-card");
    expect(card?.classList.contains("dm-control-card-expanded")).toBe(true);

    const header = parent.querySelector(".dm-control-card-header") as HTMLElement;
    header.click();

    card = parent.querySelector(".dm-control-card");
    expect(card?.classList.contains("dm-control-card-expanded")).toBe(false);

    header.click();
    card = parent.querySelector(".dm-control-card");
    expect(card?.classList.contains("dm-control-card-expanded")).toBe(true);
  });

  it("only one card expanded at a time per list", () => {
    let expandedId: string | null = null;

    const render = () => {
      parent.innerHTML = "";

      ["card-1", "card-2", "card-3"].forEach((id, idx) => {
        renderControlCard(parent, {
          id,
          color: "#ffffff",
          label: `Card ${idx + 1}`,
          summary: `${(idx + 1) * 10} ft`,
          icon: "○",
          expanded: expandedId === id,
          onToggle: () => {
            expandedId = expandedId === id ? null : id;
            render();
          },
          onRemove: () => {},
          renderDetails: (body) => {
            body.createDiv({ text: `Details ${idx + 1}` });
          },
        });
      });
    };

    render();

    let expandedCards = parent.querySelectorAll(".dm-control-card-expanded");
    expect(expandedCards.length).toBe(0);

    const headers = parent.querySelectorAll(".dm-control-card-header");
    (headers[0] as HTMLElement).click();

    expandedCards = parent.querySelectorAll(".dm-control-card-expanded");
    expect(expandedCards.length).toBe(1);

    (headers[1] as HTMLElement).click();
    expandedCards = parent.querySelectorAll(".dm-control-card-expanded");
    expect(expandedCards.length).toBe(1);
    expect((expandedCards[0] as HTMLElement).querySelector(".dm-control-card-label")?.textContent).toBe("Card 2");
  });
});
