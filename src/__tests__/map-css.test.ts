import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// calibration.md requirement 6a: on Android WebView an overflowing map stage widens the
// layout viewport, so innerWidth stops matching the calibrated profile key.
describe("map screen stylesheet", () => {
  const css = readFileSync(join(__dirname, "..", "map", "map.css"), "utf8");
  const app = /#app\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

  it("pins #app to the viewport and clips the map stage inside it", () => {
    expect(app).toMatch(/position:\s*fixed/);
    expect(app).toMatch(/inset:\s*0/);
    expect(app).toMatch(/overflow:\s*hidden/);
  });
});
