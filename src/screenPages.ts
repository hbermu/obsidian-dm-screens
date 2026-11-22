// The player and map page shells, shared by the embedded server and, through
// scripts/export-screens.mjs, the remote server, so both serve identical bodies.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function waitingTitleHtml(title: string): string {
  return title ? `<h1>${escapeHtml(title)}</h1>` : "";
}

export function waitingSubtitleHtml(subtitle: string): string {
  return subtitle ? `<p>${escapeHtml(subtitle)}</p>` : "";
}

export function playerPageHtml(titleHtml: string, subtitleHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DM Screen - Player View</title>
  <link rel="stylesheet" href="/player.css">
</head>
<body>
  <div id="app">
    <div id="waiting-screen">
      ${titleHtml}
      ${subtitleHtml}
      <div class="pulse-dot"></div>
    </div>
    <video id="video-background" muted loop playsinline></video>
    <img id="image-background" alt="" />
    <div id="image-layers-container"></div>
    <div id="initiative-tracker" style="display:none;">
      <h2>Initiative</h2>
      <ul id="initiative-list"></ul>
    </div>
    <button id="fullscreen-btn" aria-label="Toggle fullscreen">⛶</button>
  </div>
  <script src="/player.js"></script>
</body>
</html>`;
}

export function mapPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DM Screen - Map View</title>
  <link rel="stylesheet" href="/map.css">
</head>
<body>
  <div id="app">
    <div id="waiting-screen">
      <h1>Map Screen</h1>
      <p>Waiting for DM to push a map...</p>
      <div class="pulse-dot"></div>
    </div>
    <div id="map-stage">
      <video id="map-video" muted loop playsinline></video>
      <img id="map-image" alt="" />
      <canvas id="map-fog"></canvas>
    </div>
    <canvas id="grid-overlay"></canvas>
    <div id="calibration-overlay"></div>
    <div id="scale-hint"></div>
    <button id="fullscreen-btn" aria-label="Toggle fullscreen">⛶</button>
  </div>
  <script src="/map.js"></script>
</body>
</html>`;
}
