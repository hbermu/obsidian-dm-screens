import type { PlayerMessage } from "../server";

// What screens may see of a message. A layer's `source` names a vault path or
// a Hydrus hash; it stays on the DM side so it never reaches player devices.
export function toWire(message: PlayerMessage): PlayerMessage {
  if (message.type !== "image-layers-sync") return message;
  const layers = (message.payload as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return message;
  return {
    ...message,
    payload: {
      ...message.payload,
      layers: layers.map((l) => {
        const { source: _source, ...wire } = l as Record<string, unknown>;
        return wire;
      }),
    },
  };
}

export function encodeVaultPath(vaultPath: string): string {
  return vaultPath.split("/").map(encodeURIComponent).join("/");
}
