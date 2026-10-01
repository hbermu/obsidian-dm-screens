import { describe, it, expect, vi, beforeEach } from "vitest";
import { DmControlPanel } from "../views/DmControlPanel";

function makePlugin() {
  return {
    settings: { lastSourceLabels: {} },
    saveSettings: vi.fn(async () => {}),
    app: {
      workspace: {
        on: vi.fn(),
      },
    },
  } as any;
}

function makePanel(plugin: any) {
  const panel = new DmControlPanel({ view: null } as any, plugin);
  return panel;
}

describe("DmControlPanel.setBackgroundLabel", () => {
  let plugin: any;
  let panel: any;

  beforeEach(() => {
    plugin = makePlugin();
    panel = makePanel(plugin);
  });

  it("sets a label", () => {
    panel.setBackgroundLabel({ label: "Dragon", title: "abc123" });
    expect(plugin.settings.lastSourceLabels.background).toEqual({
      label: "Dragon",
      title: "abc123",
    });
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("clears a label with null", () => {
    plugin.settings.lastSourceLabels.background = { label: "old", title: "old" };
    panel.setBackgroundLabel(null);
    expect(plugin.settings.lastSourceLabels.background).toBeUndefined();
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it("replaces an existing label", () => {
    plugin.settings.lastSourceLabels.background = { label: "A", title: "hash-a" };
    panel.setBackgroundLabel({ label: "B", title: "hash-b" });
    expect(plugin.settings.lastSourceLabels.background).toEqual({
      label: "B",
      title: "hash-b",
    });
  });

  it("initializes lastSourceLabels if missing", () => {
    delete plugin.settings.lastSourceLabels;
    panel.setBackgroundLabel({ label: "New", title: "new-hash" });
    expect(plugin.settings.lastSourceLabels).toBeDefined();
    expect(plugin.settings.lastSourceLabels.background).toEqual({
      label: "New",
      title: "new-hash",
    });
  });
});
