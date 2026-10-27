import * as path from "node:path";
import { env } from "node:process";
import { parseObsidianVersions } from "wdio-obsidian-service";
import type { ClickOptions } from "webdriverio";

const cacheDir = path.resolve(".obsidian-cache");

// Space-separated app/installer pairs, e.g. "earliest/earliest latest/latest".
// Local default is latest/latest only: Obsidian versions before ~1.12 ship no
// linux-arm64 build, so the earliest leg runs in CI (amd64) via the matrix.
const versions = await parseObsidianVersions(
  env.OBSIDIAN_VERSIONS ?? "latest/latest",
  { cacheDir },
);

export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",
  // E2E_SPEC narrows the run to one glob, which is what makes a single failing
  // spec cheap to iterate on (a full run boots Obsidian per spec file).
  specs: [process.env.E2E_SPEC || "./test/e2e/specs/**/*.e2e.ts"],
  // One Obsidian at a time: specs bind the plugin server to fixed localhost
  // ports; parallel instances would race on them.
  maxInstances: 1,
  capabilities: versions.map(([appVersion, installerVersion]) => ({
    browserName: "obsidian",
    "wdio:obsidianOptions": {
      appVersion,
      installerVersion,
      plugins: ["."],
      vault: "test/e2e/vault",
    },
    // The container runs as root, so Electron needs --no-sandbox; the shm and
    // gpu flags harden headless Chromium under Docker.
    "goog:chromeOptions": {
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    },
  })),
  services: ["obsidian"],
  reporters: ["obsidian"],
  mochaOpts: { ui: "bdd", timeout: 60_000 },
  waitforInterval: 250,
  waitforTimeout: 10_000,
  cacheDir,
  outputDir: "wdio-logs",
  logLevel: "warn",
  injectGlobals: false,
  // webdriverio 9.31+ scrolls via a wheel action dispatched at the element's
  // centre; when the Obsidian status bar covers that point the wheel lands
  // outside the panel's scroll container and nothing moves, so click()'s
  // intercepted-click retry never uncovers the button. Native scrollIntoView
  // scrolls the right container regardless of what is painted on top.
  before(_capabilities, _specs, browser: WebdriverIO.Browser) {
    browser.overwriteCommand(
      "scrollIntoView",
      async function (this: WebdriverIO.Element, _orig, options?: ScrollIntoViewOptions | boolean) {
        await browser.execute(
          (el: HTMLElement, opts?: ScrollIntoViewOptions | boolean) => el.scrollIntoView(opts),
          this as unknown as HTMLElement,
          options,
        );
      },
      { attachToElement: true },
    );

    // webdriverio 10 dropped "element click intercepted" from the general
    // WebDriver error retry, keeping only click()'s own scroll-and-reposition
    // workaround. That workaround uncovers a button hidden behind fixed chrome,
    // but it cannot wait out an overlay that is about to disappear on its own —
    // a Notice toast, or a modal backdrop mid-transition — which the suite hits
    // constantly against a real Electron app. Retrying until the overlay clears
    // restores what the specs were written against, and only for this one error.
    browser.overwriteCommand(
      "click",
      async function (this: WebdriverIO.Element, orig, options?: Partial<ClickOptions>) {
        const deadline = Date.now() + 10_000;
        for (;;) {
          try {
            return await orig.call(this, options);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!message.includes("element click intercepted") || Date.now() > deadline) throw err;
            await browser.pause(100);
          }
        }
      },
      { attachToElement: true },
    );
  },
};
