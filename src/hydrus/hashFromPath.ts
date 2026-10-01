export function hydrusHashFromVaultPath(
  vaultPath: string,
  cacheBaseFolder: string
): string | null {
  const base = (cacheBaseFolder || ".dm-screen").replace(/^\/+|\/+$/g, "") || ".dm-screen";
  const pattern = new RegExp(`^${base}/hydrus/([0-9a-f]{64})\\.(\\w+)$`);
  const match = pattern.exec(vaultPath);
  return match ? match[1] : null;
}
