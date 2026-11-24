import { describe, expect, it } from "vitest";
import { finiteScale, fitScale, handleDistance, MIN_HANDLE_GAP_PX } from "../views/mapStage";

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

describe("handleDistance", () => {
  // A 15 ft cone on a map shrunk to a phone puts its tip a few screen pixels
  // from the anchor dot, inside the same touch target.
  it("pushes the handle out to a finger's distance on a reduced map", () => {
    expect(handleDistance(30, 0.2)).toBe(MIN_HANDLE_GAP_PX / 0.2);
  });

  it("leaves a shape that is already far enough alone", () => {
    expect(handleDistance(600, 0.2)).toBe(600);
  });

  it("keeps the shape's own distance when the stage cannot be measured", () => {
    expect(handleDistance(30, null)).toBe(30);
    expect(handleDistance(30, 0)).toBe(30);
  });
});
