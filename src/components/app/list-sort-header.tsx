"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ListSortHeader({
  label,
  icon,
  direction,
  nextDirection,
  disabled,
  className,
  onSelect,
}: {
  label: string;
  icon: ReactNode;
  direction: "asc" | "desc" | null;
  nextDirection: "asc" | "desc";
  disabled: boolean;
  className?: string;
  onSelect: () => void;
}) {
  const nextDirectionLabel = nextDirection === "desc" ? "descending" : "ascending";
  return (
    <th
      scope="col"
      aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}
      className={cn("task-sort-header", className)}
    >
      <button
        type="button"
        className="task-sort-header-button"
        data-active={direction ? "true" : undefined}
        disabled={disabled}
        onClick={onSelect}
        aria-label={direction
          ? `Sort by ${label}, currently ${direction === "asc" ? "ascending" : "descending"}. Activate to sort ${nextDirectionLabel}.`
          : `Sort by ${label} ${nextDirectionLabel}.`}
      >
        <span className="inline-flex min-w-0 items-center gap-1.5">{icon}{label}</span>
        <span className="task-sort-icon" aria-hidden="true">
          {direction === "desc" ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
        </span>
      </button>
    </th>
  );
}
