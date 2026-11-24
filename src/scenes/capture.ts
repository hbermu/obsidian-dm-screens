import { Notice, stringifyYaml, TFile, type App } from "obsidian";
import type DmScreenPlugin from "../main";
import type { DmControlPanel } from "../views/DmControlPanel";
import { isVideoBackgroundUrl } from "../views/DmControlPanel";
import type { MapScreenPanel } from "../views/MapScreenPanel";
import { dataUrlBuffer } from "../map/fog";
import { debug } from "../debug";
import {
  SCENE_FORMAT_VERSION,
  sceneFogFolder,
  sceneNotePath,
  serializeSceneNote,
  type MapScene,
  type PlayerScene,
  type Scene,
} from "./format";

export interface CapturedScene {
  scene: Scene;
  // Fog file name (inside the scene's fog folder) → PNG data URL.
  fogs: Record<string, string>;
  // Labels of layers that could not be saved by reference.
  skipped: string[];
}

export function capturePlayerScene(plugin: DmScreenPlugin, panel: DmControlPanel, name: string): CapturedScene {
  const fogs: Record<string, string> = {};
  const skipped: string[] = [];

  let background: PlayerScene["background"] = null;
  const bgUrl = panel.activeBackgroundUrl;
  const bgSource = bgUrl ? plugin.transport.sourceOf(bgUrl) : null;
  if (bgUrl && bgSource) {
    const cached = plugin.replayCache.entries.get("show-background-media");
    const payload = cached ? (JSON.parse(cached) as { payload?: { loop?: unknown; muted?: unknown } }).payload : undefined;
    background = {
      source: bgSource,
      mediaType: isVideoBackgroundUrl(bgUrl) ? "video" : "image",
      loop: typeof payload?.loop === "boolean" ? payload.loop : plugin.settings.hydrusDefaultLoop,
      muted: typeof payload?.muted === "boolean" ? payload.muted : plugin.settings.hydrusDefaultMuted,
    };
  } else if (bgUrl) {
    skipped.push("background");
  }

  const layers: PlayerScene["layers"] = [];
  for (const layer of panel.imageLayers) {
    if (!layer.source) {
      skipped.push(layer.label);
      continue;
    }
    const fog = layer.fogEnabled && layer.fogDataUrl ? `${layer.id}.png` : null;
    if (fog) fogs[fog] = layer.fogDataUrl;
    layers.push({
      source: layer.source,
      label: layer.label,
      x: layer.x,
      y: layer.y,
      width: layer.width,
      height: layer.height,
      zIndex: layer.zIndex,
      rotation: layer.rotation,
      visible: layer.visible,
      bordered: layer.bordered !== false,
      fog,
    });
  }

  return { scene: { version: SCENE_FORMAT_VERSION, kind: "player", name, background, layers }, fogs, skipped };
}

export function captureMapScene(plugin: DmScreenPlugin, mapPanel: MapScreenPanel, name: string): CapturedScene | null {
  const map = mapPanel.activeMap;
  const source = map ? plugin.transport.sourceOf(map.url) : null;
  if (!map || !source) return null;
  const s = mapPanel.state;
  const scene: MapScene = {
    version: SCENE_FORMAT_VERSION,
    kind: "map",
    name,
    map: { source, mediaType: map.mediaType },
    view: { mode: s.mode, panX: s.panX, panY: s.panY, rotation: s.rotation ?? 0 },
    grid: {
      pxPerSquare: s.pxPerSquare,
      gridOffsetX: s.gridOffsetX,
      gridOffsetY: s.gridOffsetY,
      showGrid: s.showGrid,
      gridColor: s.gridColor,
      gridOpacity: s.gridOpacity,
    },
    fog: mapPanel.fogDataUrl ? "map.png" : null,
    walls: mapPanel.walls.map((w) => ({ ...w })),
    aoes: mapPanel.aoes.map((a) => ({ ...a })),
    visions: mapPanel.visions.map((v) => ({ ...v })),
  };
  return { scene, fogs: mapPanel.fogDataUrl ? { "map.png": mapPanel.fogDataUrl } : {}, skipped: [] };
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  let path = "";
  for (const part of folder.split("/").filter(Boolean)) {
    path = path ? `${path}/${part}` : part;
    if (!(await app.vault.adapter.exists(path))) await app.vault.adapter.mkdir(path);
  }
}

// Writes the note and its fog masks; masks the new scene no longer uses are
// deleted so an overwrite never leaves stale files beside the note.
export async function writeScene(app: App, folder: string, captured: CapturedScene): Promise<string> {
  const notePath = sceneNotePath(folder, captured.scene.name);
  const dir = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
  if (dir) await ensureFolder(app, dir);

  const text = serializeSceneNote(captured.scene, stringifyYaml);
  const existing = app.vault.getAbstractFileByPath(notePath);
  if (existing instanceof TFile) await app.vault.modify(existing, text);
  else await app.vault.create(notePath, text);

  const adapter = app.vault.adapter;
  const fogDir = sceneFogFolder(notePath);
  const names = Object.keys(captured.fogs);
  if (names.length > 0) await ensureFolder(app, fogDir);
  for (const name of names) await adapter.writeBinary(`${fogDir}/${name}`, dataUrlBuffer(captured.fogs[name]));
  if (await adapter.exists(fogDir)) {
    const { files } = await adapter.list(fogDir);
    for (const file of files) {
      if (!names.includes(file.slice(file.lastIndexOf("/") + 1))) await adapter.remove(file);
    }
    if (names.length === 0) await adapter.rmdir(fogDir, false);
  }
  debug("writeScene:", captured.scene.kind, "fogs:", names.length, "skipped:", captured.skipped.length);
  return notePath;
}

export function sceneExists(app: App, folder: string, name: string): boolean {
  return app.vault.getAbstractFileByPath(sceneNotePath(folder, name)) !== null;
}

export async function saveCapturedScene(plugin: DmScreenPlugin, captured: CapturedScene): Promise<void> {
  const notePath = await writeScene(plugin.app, plugin.settings.scenesFolder, captured);
  if (captured.skipped.length > 0) {
    new Notice(`Scene saved without ${captured.skipped.join(", ")}: added before layers recorded their source.`, 8000);
  } else {
    new Notice(`Scene saved: ${notePath}`);
  }
}
