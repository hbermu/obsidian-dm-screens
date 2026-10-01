import { layerLabelFromTags } from "./views/HydrusExplorerModal";

export interface SourceLabel {
  label: string;
  title: string;
}

export interface SourceLabelInput {
  url: string;
  hydrusHash?: string;
  knownTags?: string[];
  noteBasename?: string;
}

export function resolveSourceLabel(input: SourceLabelInput): SourceLabel {
  const { url, hydrusHash, knownTags, noteBasename } = input;

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

  // 4. Otherwise: the file name without its folder
  const parts = url.split("/");
  const filename = parts[parts.length - 1];
  const decoded = filename ? decodeURIComponent(filename) : url;
  return {
    label: decoded,
    title: decoded,
  };
}
