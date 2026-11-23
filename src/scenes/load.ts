import { Notice, parseYaml, type App, type TFile } from "obsidian";
import type DmScreenPlugin from "../main";
import type { DmControlPanel } from "../views/DmControlPanel";
import { ensureLocalCopy } from "../hydrus/noteRefs";
import { pngDataUrl } from "../map/fog";
import type { ImageLayer } from "../types";
import { debug, debugWarn } from "../debug";
import { extractSceneBlock, parseScene, parseSceneSource, sceneFogFolder, type MapScene, type PlayerScene, type Scene } from "./format";

export interface ResolvedSource {
  vaultPath: string;
  hydrusHash?: string;
  knownTags?: string[];
}

export async function resolveSceneSource(plugin: DmScreenPlugin, source: string): Promise<ResolvedSource | null> {
  const parsed = parseSceneSource(source);
  if (!parsed) return null;
  if (parsed.kind === "vault") {
    return (await plugin.app.vault.adapter.exists(parsed.path)) ? { vaultPath: parsed.path } : null;
  }
  if (!plugin.hydrusCache) return null;
  try {
    const entry = await ensureLocalCopy(
      { label: "", hash: parsed.hash, mediaType: null, cached: false, available: true },
      plugin.hydrusCache,
      plugin.buildHydrusClient()
    );
    return { vaultPath: entry.vaultPath, hydrusHash: parsed.hash, knownTags: entry.knownTags };
  } catch (e) {
    debugWarn("resolveSceneSource: Hydrus file unavailable", parsed.hash.slice(0, 12), (e as Error).message);
    return null;
  }
}

async function readFog(plugin: DmScreenPlugin, notePath: string, name: string): Promise<string | null> {
  const path = `${sceneFogFolder(notePath)}/${name}`;
  if (!(await plugin.app.vault.adapter.exists(path))) return null;
  return pngDataUrl(new Uint8Array(await plugin.app.vault.adapter.readBinary(path)));
}

export async function loadPlayerScene(plugin: DmScreenPlugin, panel: DmControlPanel, scene: PlayerScene, notePath: string): Promise<void> {
  const skipped: string[] = [];
  let background: Parameters<DmControlPanel["applyPlayerScene"]>[0] = null;
  if (scene.background) {
    const resolved = await resolveSceneSource(plugin, scene.background.source);
    if (resolved) {
      const { mediaType, loop, muted } = scene.background;
      background = { vaultPath: resolved.vaultPath, mediaType, loop, muted, hydrusHash: resolved.hydrusHash };
    } else {
      skipped.push("background");
    }
  }

  const stamp = Date.now();
  const layers: ImageLayer[] = [];
  for (const [i, l] of scene.layers.entries()) {
    const resolved = await resolveSceneSource(plugin, l.source);
    const dataUrl = resolved ? await plugin.imageToDataUrl(resolved.vaultPath) : "";
    if (!dataUrl) {
      skipped.push(l.label);
      continue;
    }
    const fog = l.fog ? await readFog(plugin, notePath, l.fog) : null;
    layers.push({
      id: `layer-${stamp}-scene${i}`,
      label: l.label,
      dataUrl,
      x: l.x,
      y: l.y,
      width: l.width,
      height: l.height,
      zIndex: l.zIndex,
      rotation: l.rotation,
      visible: l.visible,
      fogEnabled: fog !== null,
      fogDataUrl: fog ?? "",
      bordered: l.bordered,
      source: l.source,
    });
  }

  await panel.applyPlayerScene(background, layers);
  debug("loadPlayerScene:", scene.name, "layers:", layers.length, "skipped:", skipped.length);
  if (skipped.length > 0) new Notice(`Scene "${scene.name}" loaded without: ${skipped.join(", ")} (not found).`, 8000);
}

export async function loadMapScene(plugin: DmScreenPlugin, panel: DmControlPanel, scene: MapScene, notePath: string): Promise<void> {
  const resolved = await resolveSceneSource(plugin, scene.map.source);
  if (!resolved) {
    new Notice(`Scene "${scene.name}": its map is no longer available, so nothing was loaded.`, 8000);
    return;
  }
  const fog = scene.fog ? await readFog(plugin, notePath, scene.fog) : null;
  const applied = await panel.mapPanel.applyMapScene(
    resolved.vaultPath,
    scene.map.mediaType,
    { hydrusHash: resolved.hydrusHash, knownTags: resolved.knownTags },
    { view: scene.view, grid: scene.grid, fog, walls: scene.walls, aoes: scene.aoes, visions: scene.visions }
  );
  debug("loadMapScene:", scene.name, applied ? "applied" : "map failed to apply");
  if (applied && scene.fog && !fog) new Notice(`Scene "${scene.name}" loaded without its fog (file not found).`, 8000);
}

export async function loadScene(plugin: DmScreenPlugin, scene: Scene, notePath: string): Promise<void> {
  const panel = await plugin.openDmControlPanel();
  if (!panel) {
    new Notice("Could not open the DM Control Panel.");
    return;
  }
  if (panel.restored) await panel.restored;
  if (scene.kind === "player") await loadPlayerScene(plugin, panel, scene, notePath);
  else await loadMapScene(plugin, panel, scene, notePath);
}

export interface SceneEntry {
  file: TFile;
  scene: Scene;
}

export async function listScenes(app: App, folder: string, kind: Scene["kind"]): Promise<SceneEntry[]> {
  const prefix = folder.replace(/^\/+|\/+$/g, "");
  const entries: SceneEntry[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (prefix && !file.path.startsWith(`${prefix}/`)) continue;
    const block = extractSceneBlock(await app.vault.cachedRead(file));
    if (block === null) continue;
    const parsed = parseScene(block, parseYaml);
    if (parsed.ok && parsed.scene.kind === kind) entries.push({ file, scene: parsed.scene });
  }
  return entries.sort((a, b) => a.scene.name.localeCompare(b.scene.name));
}
