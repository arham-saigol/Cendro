"use client";

import * as React from "react";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export type CheckboxProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "onClick"> & {
  checked: boolean;
  indeterminate?: boolean;
  onCheckedChange: (next: boolean) => void;
};

export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ className, checked, indeterminate = false, onCheckedChange, disabled, "aria-label": ariaLabel, ...props }, ref) => {
    const isOn = checked || indeterminate;
    return (
      <button
        ref={ref}
        type="button"
        role="checkbox"
        aria-checked={indeterminate ? "mixed" : checked}
        aria-label={ariaLabel ?? (checked ? "Unselect" : "Select")}
        disabled={disabled}
        onClick={(event) => { event.stopPropagation(); if (!disabled) onCheckedChange(!checked); }}
        className={cn(
          "inline-grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--canvas)] disabled:cursor-not-allowed disabled:opacity-60",
          isOn
            ? "border-[var(--primary)] bg-[var(--primary)] text-[var(--on-primary)]"
            : "border-[var(--hairline-strong)] bg-[var(--surface)] text-transparent hover:border-[var(--ink-faint)]",
          className,
        )}
        {...props}
      >
        {indeterminate ? <Minus className="h-3 w-3" strokeWidth={3} /> : isOn ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
      </button>
    );
  },
);
Checkbox.displayName = "Checkbox";
