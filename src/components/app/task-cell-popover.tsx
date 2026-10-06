"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cellPopoverTop } from "@/lib/cell-popover-position";
import { cn } from "@/lib/utils";

const VIEWPORT_MARGIN = 8;

export function TaskCellPopover({
  open,
  onOpenChange,
  disabled = false,
  pending = false,
  ariaLabel,
  header,
  children,
  panelClassName,
  preferredWidth,
  showHeader = true,
  hideTriggerOnOpen = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  pending?: boolean;
  ariaLabel: string;
  header: React.ReactNode;
  children: React.ReactNode;
  panelClassName?: string;
  preferredWidth?: number;
  showHeader?: boolean;
  hideTriggerOnOpen?: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ top: number; bottom: number; left: number; width: number } | null>(null);
  const [top, setTop] = useState<number | null>(null);

  const measure = useCallback(() => {
    const bounds = triggerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    // A popover with preferredWidth renders wider than its trigger; the left
    // clamp must use that same width so right-edge cells can't overflow.
    const width = Math.min(Math.max(bounds.width + 28, preferredWidth ?? 220), window.innerWidth - 16);
    const left = Math.min(Math.max(8, bounds.left - 14), Math.max(8, window.innerWidth - width - 8));
    setRect({ top: bounds.top, bottom: bounds.bottom, left, width });
  }, [preferredWidth]);

  useEffect(() => {
    if (!open) return;
    measure();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onOpenChange(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [measure, onOpenChange, open]);

  // The panel is position:fixed, so nothing clips it except the viewport. Keep
  // every item reachable: if it would extend past the bottom edge, slide it up
  // (or open above the trigger when there is no header) inside the viewport,
  // then clamp into the margins. Runs before paint and on later resizes so
  // async option lists can't push it back off-screen.
  useLayoutEffect(() => {
    if (!open || !rect) return;
    const panel = panelRef.current;
    if (!panel) return;
    const anchor = rect;
    function update() {
      if (!panel) return;
      const height = panel.offsetHeight;
      const desired = showHeader ? anchor.top : anchor.bottom + 4;
      const flipped = showHeader ? window.innerHeight - VIEWPORT_MARGIN - height : anchor.top - 4 - height;
      setTop(cellPopoverTop({ desired, flipped, panelHeight: height, viewportHeight: window.innerHeight, margin: VIEWPORT_MARGIN }));
    }
    update();
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open, rect, showHeader]);

  return (
    <span className="task-cell-popover-root">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || pending}
        data-interactive="true"
        data-cell-popover-open={open && hideTriggerOnOpen ? "true" : undefined}
        onClick={(event) => { event.stopPropagation(); if (!open) measure(); onOpenChange(!open); }}
        className={cn("task-cell-control", pending && "opacity-60")}
        aria-label={ariaLabel}
        aria-expanded={open}
      >
        {header}
      </button>
      {open && rect && (
        <>
          <button type="button" aria-label="Close menu" className="task-cell-popover-backdrop" onClick={(event) => { event.stopPropagation(); onOpenChange(false); }} />
          <div ref={panelRef} className={cn("task-cell-popover", panelClassName)} style={{ top: top ?? (showHeader ? rect.top : rect.bottom + 4), left: rect.left, width: rect.width }} data-interactive="true" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            {showHeader && <div className="task-cell-popover-header">{header}</div>}
            <div className="task-cell-popover-body">{children}</div>
          </div>
        </>
      )}
    </span>
  );
}
