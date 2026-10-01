import { describe, expect, it } from "vitest";
import { LIGHT_SOURCES } from "../map/lightSources";

const byName = (name: string) => LIGHT_SOURCES.find((s) => s.name === name);

describe("LIGHT_SOURCES", () => {
  it("carries the 5e bright and dim radii of the common sources", () => {
    expect(byName("Torch")).toEqual({ name: "Torch", brightFt: 20, dimFt: 20 });
    expect(byName("Candle")).toEqual({ name: "Candle", brightFt: 5, dimFt: 5 });
    expect(byName("Lamp")).toEqual({ name: "Lamp", brightFt: 15, dimFt: 30 });
    expect(byName("Hooded Lantern")).toEqual({ name: "Hooded Lantern", brightFt: 30, dimFt: 30 });
    expect(byName("Light")).toEqual({ name: "Light", brightFt: 20, dimFt: 20 });
    expect(byName("Daylight")).toEqual({ name: "Daylight", brightFt: 60, dimFt: 60 });
  });

  it("models dim-only sources and darkvision with a zero bright radius", () => {
    expect(byName("Dancing Lights")).toEqual({ name: "Dancing Lights", brightFt: 0, dimFt: 10 });
    expect(byName("Darkvision 60 ft")).toEqual({ name: "Darkvision 60 ft", brightFt: 0, dimFt: 60 });
    expect(byName("Darkvision 120 ft")).toEqual({ name: "Darkvision 120 ft", brightFt: 0, dimFt: 120 });
  });

  it("is sorted case-insensitively with no duplicate names", () => {
    const names = LIGHT_SOURCES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))).toEqual(names);
  });

  it("has only non-negative radii and at least some light", () => {
    for (const s of LIGHT_SOURCES) {
      expect(s.brightFt).toBeGreaterThanOrEqual(0);
      expect(s.dimFt).toBeGreaterThanOrEqual(0);
      expect(s.brightFt + s.dimFt).toBeGreaterThan(0);
    }
  });
});
