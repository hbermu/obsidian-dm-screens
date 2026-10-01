import type DmScreenPlugin from "../main";
import { vaultPathFromUrl } from "../server";
import { debug, debugWarn } from "../debug";

export type RecoverResult = "ok" | "recovered" | "missing";

export async function recoverVaultImage(
  plugin: DmScreenPlugin,
  url: string
): Promise<RecoverResult> {
  const vaultPath = vaultPathFromUrl(url);
  if (!vaultPath) return "ok";

  const exists = await plugin.app.vault.adapter.exists(vaultPath);
  if (exists) return "ok";

  const base = (plugin.settings.cacheBaseFolder || ".dm-screen").replace(/^\/+|\/+$/g, "") || ".dm-screen";
  const hydrusPattern = new RegExp(`^${base}/hydrus/([0-9a-f]{64})\\.(\\w+)$`);
  const match = hydrusPattern.exec(vaultPath);
  if (!match) return "missing";

  const hash = match[1];
  if (!plugin.hydrusCache || !plugin.buildHydrusClient()) {
    return "missing";
  }

  const client = plugin.buildHydrusClient();
  if (!client) return "missing";

  try {
    const files = await client.getFileMetadata([hash]);
    if (files.length === 0) {
      debugWarn("recoverVaultImage: file not found in Hydrus:", hash.slice(0, 12));
      return "missing";
    }
    const { entry } = await plugin.hydrusCache.fetchAndCache(client, files[0]);
    if (entry.vaultPath !== vaultPath) {
      debugWarn(
        "recoverVaultImage: recovered path mismatch:",
        vaultPath,
        "vs",
        entry.vaultPath
      );
      return "missing";
    }
    debug("recoverVaultImage: recovered", hash.slice(0, 12), "to", vaultPath);
    return "recovered";
  } catch (err) {
    debugWarn("recoverVaultImage: failed to recover:", (err as Error).message);
    return "missing";
  }
}
