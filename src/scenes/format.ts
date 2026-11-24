import type { MapAoe, MapVision, MapWall } from "../map/types";
import { hydrusHashFromVaultPath } from "../hydrus/hashFromPath";

export const SCENE_FORMAT_VERSION = 1;
export const SCENE_CODE_BLOCK = "dm-scene";

export interface SceneBackground {
  source: string;
  mediaType: "image" | "video";
  loop: boolean;
  muted: boolean;
}

export interface SceneLayer {
  source: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  rotation: number;
  visible: boolean;
  bordered: boolean;
  fog: string | null;
}

export interface PlayerScene {
  version: number;
  kind: "player";
  name: string;
  background: SceneBackground | null;
  layers: SceneLayer[];
}

export interface MapScene {
  version: number;
  kind: "map";
  name: string;
  map: { source: string; mediaType: "image" | "video" };
  view: { mode: "physical" | "fit"; panX: number; panY: number; rotation: 0 | 90 | 180 | 270 };
  grid: {
    pxPerSquare: number;
    gridOffsetX: number;
    gridOffsetY: number;
    showGrid: boolean;
    gridColor: string;
    gridOpacity: number;
  };
  fog: string | null;
  walls: MapWall[];
  aoes: MapAoe[];
  visions: MapVision[];
}

export type Scene = PlayerScene | MapScene;

export type SceneSource = { kind: "vault"; path: string } | { kind: "hydrus"; hash: string };

export function parseSceneSource(source: string): SceneSource | null {
  if (source.startsWith("vault:") && source.length > 6) return { kind: "vault", path: source.slice(6) };
  const m = /^hydrus:([0-9a-f]{64})$/.exec(source);
  return m ? { kind: "hydrus", hash: m[1] } : null;
}

// A Hydrus-cached file is saved by hash so the scene still loads on a device
// whose cache was swept, or through a server that fetches from Hydrus itself.
export function sourceFromVaultPath(vaultPath: string, cacheBaseFolder: string): string {
  const hash = hydrusHashFromVaultPath(vaultPath, cacheBaseFolder);
  return hash ? `hydrus:${hash}` : `vault:${vaultPath}`;
}

export function sourceFromVaultUrl(url: string, cacheBaseFolder: string): string | null {
  if (!url.startsWith("/vault/")) return null;
  try {
    return sourceFromVaultPath(decodeURIComponent(url.slice(7)), cacheBaseFolder);
  } catch {
    return null;
  }
}

export type ParseResult = { ok: true; scene: Scene } | { ok: false; error: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isSource = (v: unknown): v is string => isStr(v) && parseSceneSource(v) !== null;
const isMedia = (v: unknown): v is "image" | "video" => v === "image" || v === "video";

function checkLayer(v: unknown, i: number): string | null {
  if (!isObj(v)) return `layers[${i}] is not a mapping`;
  if (!isSource(v.source)) return `layers[${i}].source is not a vault: or hydrus: reference`;
  if (!isStr(v.label)) return `layers[${i}].label is missing`;
  for (const k of ["x", "y", "width", "height", "zIndex", "rotation"]) {
    if (!isNum(v[k])) return `layers[${i}].${k} is not a number`;
  }
  if (typeof v.visible !== "boolean" || typeof v.bordered !== "boolean") return `layers[${i}] needs visible and bordered`;
  if (v.fog !== null && !isStr(v.fog)) return `layers[${i}].fog is not a path or null`;
  return null;
}

function checkPlayer(d: Obj): string | null {
  const bg = d.background;
  if (bg !== null) {
    if (!isObj(bg) || !isSource(bg.source) || !isMedia(bg.mediaType)) return "background needs a source and a mediaType";
    if (typeof bg.loop !== "boolean" || typeof bg.muted !== "boolean") return "background needs loop and muted";
  }
  if (!Array.isArray(d.layers)) return "layers is missing";
  for (let i = 0; i < d.layers.length; i++) {
    const err = checkLayer(d.layers[i], i);
    if (err) return err;
  }
  return null;
}

function checkMap(d: Obj): string | null {
  const map = d.map;
  if (!isObj(map) || !isSource(map.source) || !isMedia(map.mediaType)) return "map needs a source and a mediaType";
  const view = d.view;
  if (!isObj(view) || (view.mode !== "physical" && view.mode !== "fit") || !isNum(view.panX) || !isNum(view.panY)) {
    return "view needs mode, panX and panY";
  }
  if (![0, 90, 180, 270].includes(view.rotation as number)) return "view.rotation must be 0, 90, 180 or 270";
  const grid = d.grid;
  if (!isObj(grid)) return "grid is missing";
  for (const k of ["pxPerSquare", "gridOffsetX", "gridOffsetY", "gridOpacity"]) {
    if (!isNum(grid[k])) return `grid.${k} is not a number`;
  }
  if (typeof grid.showGrid !== "boolean" || !isStr(grid.gridColor)) return "grid needs showGrid and gridColor";
  if (d.fog !== null && !isStr(d.fog)) return "fog is not a path or null";
  for (const k of ["walls", "aoes", "visions"]) {
    if (!Array.isArray(d[k])) return `${k} is missing`;
  }
  return null;
}

export function parseScene(text: string, parseYaml: (text: string) => unknown): ParseResult {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (e) {
    return { ok: false, error: `not valid YAML: ${(e as Error).message}` };
  }
  if (!isObj(data)) return { ok: false, error: "the block is not a mapping" };
  if (data.version !== SCENE_FORMAT_VERSION) return { ok: false, error: `unknown version ${String(data.version)}` };
  if (!isStr(data.name) || data.name.trim() === "") return { ok: false, error: "name is missing" };
  if (data.kind !== "player" && data.kind !== "map") return { ok: false, error: `unknown kind ${String(data.kind)}` };
  const err = data.kind === "player" ? checkPlayer(data) : checkMap(data);
  return err ? { ok: false, error: err } : { ok: true, scene: data as unknown as Scene };
}

export function serializeSceneNote(scene: Scene, stringifyYaml: (data: unknown) => string): string {
  const body = stringifyYaml(scene);
  return `# ${scene.name}\n\n\`\`\`${SCENE_CODE_BLOCK}\n${body.endsWith("\n") ? body : `${body}\n`}\`\`\`\n`;
}

export function sanitizeSceneFileName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]/g, "-");
}

export function sceneNotePath(folder: string, name: string): string {
  const dir = folder.replace(/^\/+|\/+$/g, "");
  return `${dir ? `${dir}/` : ""}${sanitizeSceneFileName(name)}.md`;
}

// Fog masks live beside the note in `<basename>.fog/`, so a scene note and its
// masks move and sync together.
export function sceneFogFolder(notePath: string): string {
  return notePath.replace(/\.md$/, ".fog");
}

export function sceneSummary(scene: Scene): string {
  if (scene.kind === "player") {
    const n = scene.layers.length;
    return `${n} layer${n === 1 ? "" : "s"}${scene.background ? " + background" : ""}`;
  }
  const n = scene.walls.length;
  return `${n} wall${n === 1 ? "" : "s"}, ${scene.aoes.length} AoE, ${scene.visions.length} vision`;
}

// The body of the first `dm-scene` fenced block in a note, or null.
export function extractSceneBlock(noteText: string): string | null {
  const m = /^```dm-scene[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m.exec(noteText);
  return m ? m[1] : null;
}
