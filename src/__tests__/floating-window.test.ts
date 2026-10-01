import { describe, it, expect, vi, beforeEach } from "vitest";
import { FloatingWindow, type WindowState } from "../views/FloatingWindow";

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

if (!HTMLElement.prototype.addClass) {
  (HTMLElement.prototype as unknown as Record<string, unknown>).addClass = function (this: HTMLElement, cls: string) {
    this.classList.add(cls);
    return this;
  };
}

if (!HTMLElement.prototype.toggleClass) {
  (HTMLElement.prototype as unknown as Record<string, unknown>).toggleClass = function (this: HTMLElement, cls: string, value: boolean) {
    this.classList.toggle(cls, value);
  };
}

if (!HTMLElement.prototype.empty) {
  (HTMLElement.prototype as unknown as Record<string, unknown>).empty = function (this: HTMLElement) {
    this.innerHTML = "";
  };
}

describe("FloatingWindow", () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "<div id=\"test-host\"></div>";
    host = document.getElementById("test-host")!;
    host.style.width = "1000px";
    host.style.height = "800px";
    Object.defineProperty(host, "clientWidth", { value: 1000, configurable: true });
    Object.defineProperty(host, "clientHeight", { value: 800, configurable: true });
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
      configurable: true,
    });
  });

  it("creates a window with correct initial state", () => {
    const onChange = vi.fn();
    const initial: WindowState = { x: 0.5, y: 0.5, minimized: false };
    const win = new FloatingWindow(host, {
      id: "test",
      title: "Test Window",
      initial,
      onChange,
    });

    expect(host.querySelector(".dm-floating-window")).toBeTruthy();
    expect(host.querySelector(".dm-floating-window-title")?.textContent).toBe("Test Window");
    expect(win.body).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();

    win.destroy();
  });

  it("toggles minimize state", () => {
    const onChange = vi.fn();
    const win = new FloatingWindow(host, {
      id: "test",
      title: "Test",
      initial: { x: 0, y: 0, minimized: false },
      onChange,
    });

    const minimizeBtn = host.querySelector(".dm-floating-window-minimize") as HTMLElement;
    expect(minimizeBtn.textContent).toBe("–");
    expect(host.querySelector(".dm-floating-window-minimized")).toBeFalsy();

    minimizeBtn.click();
    expect(minimizeBtn.textContent).toBe("▢");
    expect(host.querySelector(".dm-floating-window-minimized")).toBeTruthy();
    expect(onChange).toHaveBeenCalledWith({ x: 0, y: 0, minimized: true });

    minimizeBtn.click();
    expect(minimizeBtn.textContent).toBe("–");
    expect(host.querySelector(".dm-floating-window-minimized")).toBeFalsy();
    expect(onChange).toHaveBeenCalledWith({ x: 0, y: 0, minimized: false });

    win.destroy();
  });

  it("starts minimized when initial state has minimized: true", () => {
    const win = new FloatingWindow(host, {
      id: "test",
      title: "Test",
      initial: { x: 0, y: 0, minimized: true },
      onChange: vi.fn(),
    });

    expect(host.querySelector(".dm-floating-window-minimized")).toBeTruthy();
    expect(host.querySelector(".dm-floating-window-minimize")?.textContent).toBe("▢");

    win.destroy();
  });

  it("clamps position to host bounds", () => {
    const onChange = vi.fn();
    const win = new FloatingWindow(host, {
      id: "test",
      title: "Test",
      initial: { x: 0.5, y: 0.5, minimized: false },
      onChange,
    });

    const el = host.querySelector(".dm-floating-window") as HTMLElement;
    const header = el.querySelector(".dm-floating-window-header") as HTMLElement;
    Object.defineProperty(el, "offsetWidth", { value: 260, writable: true, configurable: true });
    Object.defineProperty(header, "offsetHeight", { value: 40, writable: true, configurable: true });

    expect(() => win.clamp()).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();

    win.destroy();
  });

  it("clamps position after host resize", () => {
    const onChange = vi.fn();
    const win = new FloatingWindow(host, {
      id: "test",
      title: "Test",
      initial: { x: 0.9, y: 0.9, minimized: false },
      onChange,
    });

    const el = host.querySelector(".dm-floating-window") as HTMLElement;
    const header = el.querySelector(".dm-floating-window-header") as HTMLElement;
    Object.defineProperty(el, "offsetWidth", { value: 260, writable: true, configurable: true });
    Object.defineProperty(header, "offsetHeight", { value: 40, writable: true, configurable: true });

    Object.defineProperty(host, "clientWidth", { value: 500, writable: true, configurable: true });
    Object.defineProperty(host, "clientHeight", { value: 400, writable: true, configurable: true });
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 500, height: 400 }),
      configurable: true,
    });

    win.clamp();

    const maxX = (500 - 260) / 500;
    const maxY = (400 - 40) / 400;
    const leftPx = parseFloat(el.style.left);
    const topPx = parseFloat(el.style.top);
    expect(leftPx).toBeLessThanOrEqual(maxX * 500 + 1);
    expect(topPx).toBeLessThanOrEqual(maxY * 400 + 1);

    win.destroy();
  });

  it("persists fractional position", () => {
    const onChange = vi.fn();
    const win = new FloatingWindow(host, {
      id: "test",
      title: "Test",
      initial: { x: 0.25, y: 0.75, minimized: false },
      onChange,
    });

    const el = host.querySelector(".dm-floating-window") as HTMLElement;
    expect(el.style.left).toBe("250px");
    expect(el.style.top).toBe("600px");

    win.destroy();
  });

  it("fires onChange on drag end", () => {
    const onChange = vi.fn();
    const win = new FloatingWindow(host, {
      id: "test",
      title: "Test",
      initial: { x: 0.5, y: 0.5, minimized: false },
      onChange,
    });

    const header = host.querySelector(".dm-floating-window-header") as HTMLElement;
    const el = host.querySelector(".dm-floating-window") as HTMLElement;
    Object.defineProperty(el, "offsetWidth", { value: 260, configurable: true });
    Object.defineProperty(el.querySelector(".dm-floating-window-header"), "offsetHeight", {
      value: 40,
      configurable: true,
    });

    header.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: 500,
        clientY: 400,
        pointerId: 1,
      })
    );

    document.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: 550,
        clientY: 450,
      })
    );

    document.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: 550,
        clientY: 450,
        pointerId: 1,
      })
    );

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
        minimized: false,
      })
    );

    win.destroy();
  });

  it("does not drag from minimize button", () => {
    const onChange = vi.fn();
    const win = new FloatingWindow(host, {
      id: "test",
      title: "Test",
      initial: { x: 0.5, y: 0.5, minimized: false },
      onChange,
    });

    const minimizeBtn = host.querySelector(".dm-floating-window-minimize") as HTMLElement;

    minimizeBtn.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: 500,
        clientY: 400,
        pointerId: 1,
      })
    );

    document.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: 550,
        clientY: 450,
      })
    );

    document.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: 550,
        clientY: 450,
        pointerId: 1,
      })
    );

    expect(onChange).not.toHaveBeenCalledWith(
      expect.objectContaining({
        x: expect.any(Number),
      })
    );

    win.destroy();
  });

  it("setTitleExtra adds elements to header", () => {
    const win = new FloatingWindow(host, {
      id: "test",
      title: "Test",
      initial: { x: 0, y: 0, minimized: false },
      onChange: vi.fn(),
    });

    const extra = document.createElement("button");
    extra.textContent = "Extra";
    win.setTitleExtra(extra);

    expect(host.querySelector(".dm-floating-window-extra button")?.textContent).toBe("Extra");

    win.destroy();
  });

  it("cleans up on destroy", () => {
    const win = new FloatingWindow(host, {
      id: "test",
      title: "Test",
      initial: { x: 0, y: 0, minimized: false },
      onChange: vi.fn(),
    });

    expect(host.querySelector(".dm-floating-window")).toBeTruthy();

    win.destroy();

    expect(host.querySelector(".dm-floating-window")).toBeFalsy();
  });

  it("does not crash when clamp is called with zero-dimension host", () => {
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 0, height: 0 }),
      configurable: true,
    });

    const win = new FloatingWindow(host, {
      id: "test",
      title: "Test",
      initial: { x: 0.5, y: 0.5, minimized: false },
      onChange: vi.fn(),
    });

    expect(() => win.clamp()).not.toThrow();

    win.destroy();
  });
});
