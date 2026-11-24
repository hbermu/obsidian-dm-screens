// Writes the player and map screens into server/assets/ for the remote server
// to embed at build time: the same minified bundles and page shells the
// embedded server inlines, so the two serve identical bodies. The player page
// carries slots the server fills with the cached waiting-screen text.
import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { buildPlayerBundle, buildMapBundle } from "./build-player.mjs";

export const TITLE_SLOT = "{{DM_SCREEN_TITLE_HTML}}";
export const SUBTITLE_SLOT = "{{DM_SCREEN_SUBTITLE_HTML}}";

const outDir = process.argv[2] ?? "server/assets";

const pages = await esbuild.build({
  entryPoints: ["src/screenPages.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
});
const mod = { exports: {} };
new Function("module", "exports", pages.outputFiles[0].text)(mod, mod.exports);
const { playerPageHtml, mapPageHtml } = mod.exports;

const player = await buildPlayerBundle({ minify: true });
const map = await buildMapBundle({ minify: true });
const version = JSON.parse(fs.readFileSync("manifest.json", "utf-8")).version;

fs.mkdirSync(outDir, { recursive: true });
const files = {
  "player.html": playerPageHtml(TITLE_SLOT, SUBTITLE_SLOT),
  "player.js": player.js,
  "player.css": player.css,
  "map.html": mapPageHtml(),
  "map.js": map.js,
  "map.css": map.css,
  "version.txt": version,
};
for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(outDir, name), body);
console.log(`export-screens: wrote ${Object.keys(files).length} files to ${outDir} (version ${version})`);
