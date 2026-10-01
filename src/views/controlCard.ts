export interface ControlCardOptions {
  id: string;
  color: string;
  label: string;
  summary: string;
  icon: string;
  expanded: boolean;
  onToggle(): void;
  onRemove(): void;
  renderDetails(body: HTMLElement): void;
}

export function renderControlCard(
  parent: HTMLElement,
  opts: ControlCardOptions
): HTMLElement {
  const card = parent.createDiv({ cls: "dm-control-card" });

  const header = card.createDiv({
    cls: "dm-control-card-header",
    attr: { "data-id": opts.id },
  });

  const swatch = header.createDiv({ cls: "dm-control-card-swatch" });
  swatch.style.backgroundColor = opts.color;

  header.createDiv({
    cls: "dm-control-card-label",
    text: opts.label,
  });

  header.createDiv({
    cls: "dm-control-card-icon",
    text: opts.icon,
  });

  header.createDiv({
    cls: "dm-control-card-summary",
    text: opts.summary,
  });

  const removeBtn = header.createDiv({
    cls: "dm-control-card-remove",
    text: "✕",
    attr: { "aria-label": "Remove" },
  });

  header.addEventListener("click", (e) => {
    if (e.target === removeBtn || removeBtn.contains(e.target as Node)) {
      e.stopPropagation();
      opts.onRemove();
    } else {
      opts.onToggle();
    }
  });

  if (opts.expanded) {
    card.addClass("dm-control-card-expanded");
    const body = card.createDiv({ cls: "dm-control-card-body" });
    opts.renderDetails(body);
  }

  return card;
}
