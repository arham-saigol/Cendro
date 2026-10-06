// Vertical placement for the fixed-position cell popover. `desired` is the top
// the panel would sit at with no collision handling (the trigger's top when the
// panel covers the trigger, or below the trigger when it does not); `flipped`
// is the top that puts the panel above the trigger instead.
export function cellPopoverTop({
  desired,
  flipped,
  panelHeight,
  viewportHeight,
  margin,
}: {
  desired: number;
  flipped: number;
  panelHeight: number;
  viewportHeight: number;
  margin: number;
}): number {
  const fits = desired + panelHeight <= viewportHeight - margin;
  const top = fits ? desired : flipped;
  return Math.max(margin, Math.min(top, viewportHeight - margin - panelHeight));
}
