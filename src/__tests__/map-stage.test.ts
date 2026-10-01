import { describe, expect, it } from "vitest";
import { finiteScale, fitScale } from "../views/mapStage";

describe("fitScale", () => {
  it("letterboxes against whichever axis runs out first", () => {
    expect(fitScale(600, 340, 1200, 340)).toBe(0.5);
    expect(fitScale(600, 340, 600, 680)).toBe(0.5);
  });

  it("returns null for a container that cannot be measured", () => {
    expect(fitScale(0, 340, 1200, 800)).toBeNull();
    expect(fitScale(600, 0, 1200, 800)).toBeNull();
  });

  it("returns null for a degenerate map box", () => {
    expect(fitScale(600, 340, 0, 800)).toBeNull();
    expect(fitScale(600, 340, 1200, 0)).toBeNull();
  });

  it("returns null for non-finite input", () => {
    expect(fitScale(Number.NaN, 340, 1200, 800)).toBeNull();
    expect(fitScale(600, 340, Number.POSITIVE_INFINITY, 800)).toBeNull();
  });
});

describe("finiteScale", () => {
  it("passes a finite positive scale through", () => {
    expect(finiteScale(0.25)).toBe(0.25);
  });

  it("refuses zero, negative and non-finite scales", () => {
    expect(finiteScale(0)).toBeNull();
    expect(finiteScale(-1)).toBeNull();
    expect(finiteScale(Number.NaN)).toBeNull();
    expect(finiteScale(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
