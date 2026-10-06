import { describe, expect, it } from "vitest";
import { cellPopoverTop } from "./cell-popover-position";

const MARGIN = 8;

// Regression: a bottom-row trigger on a short window used to leave the menu
// anchored below the viewport, clipping options (e.g. Completed unreachable).
describe("cellPopoverTop", () => {
  it("keeps the desired top when the panel fits below the trigger", () => {
    expect(cellPopoverTop({ desired: 200, flipped: 50, panelHeight: 120, viewportHeight: 800, margin: MARGIN })).toBe(200);
  });

  it("slides the panel up into the viewport when it would overflow the bottom edge", () => {
    // Trigger at 340px on a 420px window with a 110px panel (the clipped bug).
    expect(cellPopoverTop({ desired: 340, flipped: 302, panelHeight: 110, viewportHeight: 420, margin: MARGIN })).toBe(302);
  });

  it("clamps to the bottom margin when a flipped top would still overflow", () => {
    // Headerless menu whose flipped top lands lower than a full-viewport fit.
    expect(cellPopoverTop({ desired: 400, flipped: 360, panelHeight: 120, viewportHeight: 420, margin: MARGIN })).toBe(292);
  });

  it("pins a taller-than-viewport panel to the top margin so its start stays reachable", () => {
    expect(cellPopoverTop({ desired: 200, flipped: -500, panelHeight: 600, viewportHeight: 420, margin: MARGIN })).toBe(MARGIN);
  });
});
