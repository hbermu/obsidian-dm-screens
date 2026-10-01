import { layerLabelFromTags } from "./views/HydrusExplorerModal";
import { hydrusHashFromVaultPath } from "./hydrus/hashFromPath";
import { vaultPathFromUrl } from "./server";
import type DmScreenPlugin from "./main";

export interface SourceLabel {
  label: string;
  title: string;
}

export interface SourceLabelInput {
  url: string;
  hydrusHash?: string;
  knownTags?: string[];
  noteBasename?: string;
  plugin?: DmScreenPlugin;
}

export function resolveSourceLabel(input: SourceLabelInput): SourceLabel {
  const { url, hydrusHash, knownTags, noteBasename, plugin } = input;

  // 1-2. Hydrus images: use layerLabelFromTags which handles name: tags and hash fallback
  if (hydrusHash) {
    const label = layerLabelFromTags(knownTags || [], hydrusHash);
    return {
      label,
      title: hydrusHash,
    };
  }

  // 3. Non-Hydrus image loaded from a note
  if (noteBasename) {
    return {
      label: noteBasename,
      title: noteBasename,
    };
  }

  // 4a. Hydrus cache path without explicit hash: extract hash and lookup tags
  if (plugin?.hydrusCache) {
    const vaultPath = vaultPathFromUrl(url);
    if (vaultPath) {
      const hash = hydrusHashFromVaultPath(vaultPath, plugin.settings.cacheBaseFolder || ".dm-screen");
      if (hash) {
        const cached = plugin.hydrusCache.getSync(hash);
        if (cached) {
          const label = layerLabelFromTags(cached.knownTags, hash);
          return {
            label,
            title: hash,
          };
        }
      }
    }
  }

  // 4b. Otherwise: the file name without its folder
  const parts = url.split("/");
  const filename = parts[parts.length - 1];
  const decoded = filename ? decodeURIComponent(filename) : url;
  return {
    label: decoded,
    title: decoded,
  };
}
