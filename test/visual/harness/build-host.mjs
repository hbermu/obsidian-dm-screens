import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlayerBundle, buildMapBundle } from "../../../scripts/build-player.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const harnessOutDir = path.join(repoRoot, "test/visual/.harness");
const cjsOut = path.join(harnessOutDir, "server-host.cjs");

// The touch page carries the plugin's real stylesheet, so `touch-action` and
// the coarse-pointer hit sizes are the ones that ship.
async function buildTouchPage() {
  const bundle = await esbuild.build({
    entryPoints: [path.join(repoRoot, "test/visual/harness/touch-entry.ts")],
    bundle: true,
    format: "iife",
    target: "es2020",
    write: false,
    logLevel: "warning",
  });
  const css = fs.readFileSync(path.join(repoRoot, "styles.css"), "utf8");
  const page = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>${css}</style>
<style>
html, body { margin: 0; height: 100%; background: #1e1e1e; color: #ddd; }
.dm-explore-content { height: 100vh; }
.dm-explore-inner { width: 600px; height: 400px; background: #40506a; }
.dm-explore-overlay { background: rgba(0,0,0,0.25); }
.dm-floating-window { left: 12px; top: 12px; width: 220px; }
.dm-floating-window-body { max-height: 120px; }
.dm-floating-window-body p { margin: 0 0 240px; }
.dm-control-panel { position: fixed; right: 0; bottom: 0; width: 320px; background: #262626; padding: 8px; }
.dm-layer-preview { position: relative; height: 120px; }
.dm-layer-rect { left: 20%; top: 20%; width: 80px; height: 60px; }
</style>

</head><body>
<div class="dm-explore-content"><div class="dm-explore-body"><div class="dm-explore-stage">
  <div class="dm-explore-inner">
    <canvas class="dm-explore-overlay" width="600" height="400"></canvas>
    <div class="dm-explore-markers"><div class="dm-map-aoe-dot" style="left: 25%; top: 25%; background: #ff4400;"></div></div>
  </div>
  <div class="dm-floating-window">
    <div class="dm-floating-window-header"><div class="dm-floating-window-title">AoEs</div></div>
    <div class="dm-floating-window-body"><p>scrollable</p><p>bottom</p></div>
  </div>
</div></div></div>
<div class="dm-control-panel">
  <div class="dm-layer-preview"><div class="dm-layer-preview-inner">
    <div class="dm-layer-rect"><div class="dm-layer-rect-frame"><canvas class="dm-fog-draw-canvas-inline" width="80" height="60"></canvas></div></div>
  </div></div>
  <div class="dm-layer-row">
    <div class="dm-layer-left-col"><button class="dm-layer-btn dm-layer-vis-toggle">eye</button></div>
    <input type="range" min="0" max="100" value="50">
  </div>
  <div class="dm-fog-toolbar"><button>Brush</button></div>
</div>
<script>${bundle.outputFiles[0].text}</script>
</body></html>`;
  const out = path.join(harnessOutDir, "touch.html");
  fs.writeFileSync(out, page);
  return out;
}

export default async function globalSetup() {
  const cwd = process.cwd();
  process.chdir(repoRoot);
  try {
    fs.mkdirSync(harnessOutDir, { recursive: true });
    const { js, css, html } = await buildPlayerBundle({ minify: true });
    const { js: mapJs, css: mapCss } = await buildMapBundle({ minify: true });

    await esbuild.build({
      entryPoints: [path.join(repoRoot, "test/visual/harness/server-entry.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      outfile: cjsOut,
      external: ["ws"],
      alias: {
        obsidian: path.join(repoRoot, "test/stubs/obsidian.ts"),
      },
      define: {
        PLAYER_HTML: JSON.stringify(html),
        PLAYER_CSS: JSON.stringify(css),
        MAP_CSS: JSON.stringify(mapCss),
      },
      plugins: [
        {
          name: "player-screen-inline",
          setup(build) {
            build.onResolve({ filter: /^player-screen-bundle$/ }, () => ({
              path: "player-screen-bundle",
              namespace: "player-inline",
            }));
            build.onLoad({ filter: /.*/, namespace: "player-inline" }, () => ({
              contents: `module.exports = ${JSON.stringify(js)};`,
              loader: "js",
            }));
          },
        },
        {
          name: "map-screen-inline",
          setup(build) {
            build.onResolve({ filter: /^map-screen-bundle$/ }, () => ({
              path: "map-screen-bundle",
              namespace: "map-inline",
            }));
            build.onLoad({ filter: /.*/, namespace: "map-inline" }, () => ({
              contents: `module.exports = ${JSON.stringify(mapJs)};`,
              loader: "js",
            }));
          },
        },
      ],
      logLevel: "warning",
    });

    process.env.HARNESS_CJS = cjsOut;
    process.env.HARNESS_TOUCH_PAGE = await buildTouchPage();
  } finally {
    process.chdir(cwd);
  }
}
