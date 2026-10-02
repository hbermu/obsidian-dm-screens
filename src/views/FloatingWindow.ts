export interface WindowState {
  x: number;
  y: number;
  minimized: boolean;
}

export interface FloatingWindowOptions {
  id: string;
  title: string;
  width?: number;
  initial: WindowState;
  onChange(state: WindowState): void;
}

export class FloatingWindow {
  public readonly body: HTMLElement;
  private el: HTMLElement;
  private header: HTMLElement;
  private titleExtra: HTMLElement;
  private minimizeBtn: HTMLElement;
  private state: WindowState;
  private isDragging = false;
  private dragStart: { x: number; y: number; pointerId: number } | null = null;

  constructor(
    private host: HTMLElement,
    private opts: FloatingWindowOptions
  ) {
    this.state = { ...opts.initial };
    this.el = document.createElement("div");
    this.el.className = "dm-floating-window";
    this.el.style.width = `${opts.width ?? 260}px`;

    this.header = this.el.createDiv("dm-floating-window-header");
    this.header.createDiv({ cls: "dm-floating-window-title", text: opts.title });
    this.titleExtra = this.header.createDiv("dm-floating-window-extra");
    this.minimizeBtn = this.header.createDiv({
      cls: "dm-floating-window-minimize",
      text: this.state.minimized ? "▢" : "–",
      attr: { "aria-label": this.state.minimized ? "Restore" : "Minimize" },
    });

    this.body = this.el.createDiv("dm-floating-window-body");

    this.header.addEventListener("pointerdown", this.onPointerDown);
    this.minimizeBtn.addEventListener("click", this.onMinimizeClick);

    if (this.state.minimized) {
      this.el.addClass("dm-floating-window-minimized");
    }

    this.updatePosition();
    this.host.appendChild(this.el);
  }

  setTitleExtra(el: HTMLElement): void {
    this.titleExtra.empty();
    this.titleExtra.appendChild(el);
  }

  clamp(): void {
    const hostRect = this.host.getBoundingClientRect();
    if (hostRect.width <= 0 || hostRect.height <= 0) return;

    const windowWidth = this.el.offsetWidth;
    const headerHeight = this.header.offsetHeight;

    const maxX = (hostRect.width - windowWidth) / hostRect.width;
    const maxY = (hostRect.height - headerHeight) / hostRect.height;

    this.state.x = Math.max(0, Math.min(this.state.x, maxX));
    this.state.y = Math.max(0, Math.min(this.state.y, maxY));

    this.updatePosition();
  }

  destroy(): void {
    this.header.removeEventListener("pointerdown", this.onPointerDown);
    this.minimizeBtn.removeEventListener("click", this.onMinimizeClick);
    if (this.isDragging) {
      document.removeEventListener("pointermove", this.onPointerMove);
      document.removeEventListener("pointerup", this.onPointerUp);
      this.header.releasePointerCapture(this.dragStart!.pointerId);
    }
    this.el.remove();
  }

  private updatePosition(): void {
    const hostRect = this.host.getBoundingClientRect();
    if (hostRect.width <= 0 || hostRect.height <= 0) return;

    this.el.style.left = `${this.state.x * hostRect.width}px`;
    this.el.style.top = `${this.state.y * hostRect.height}px`;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.target !== this.header && !this.header.contains(e.target as Node)) return;
    if (e.target === this.minimizeBtn || this.minimizeBtn.contains(e.target as Node)) return;
    if (this.titleExtra.contains(e.target as Node)) return;

    e.preventDefault();
    this.isDragging = true;
    this.header.setPointerCapture(e.pointerId);
    this.dragStart = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };

    document.addEventListener("pointermove", this.onPointerMove);
    document.addEventListener("pointerup", this.onPointerUp);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.isDragging || !this.dragStart) return;

    const hostRect = this.host.getBoundingClientRect();
    if (hostRect.width <= 0 || hostRect.height <= 0) return;

    const dx = e.clientX - this.dragStart.x;
    const dy = e.clientY - this.dragStart.y;

    this.state.x += dx / hostRect.width;
    this.state.y += dy / hostRect.height;

    this.dragStart = { ...this.dragStart, x: e.clientX, y: e.clientY };
    this.clamp();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.isDragging) return;

    document.removeEventListener("pointermove", this.onPointerMove);
    document.removeEventListener("pointerup", this.onPointerUp);
    this.header.releasePointerCapture(e.pointerId);
    this.isDragging = false;
    this.dragStart = null;

    this.opts.onChange({ ...this.state });
  };

  private onMinimizeClick = (e: Event): void => {
    e.stopPropagation();
    this.state.minimized = !this.state.minimized;

    this.el.toggleClass("dm-floating-window-minimized", this.state.minimized);
    this.minimizeBtn.textContent = this.state.minimized ? "▢" : "–";
    this.minimizeBtn.setAttribute("aria-label", this.state.minimized ? "Restore" : "Minimize");

    this.opts.onChange({ ...this.state });
  };
}
