"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { inputClassName } from "@/components/ui/input";

// Values are "YYYY-MM-DD" calendar dates, not instants: they parse into local
// Date parts (never `new Date(value)`, which anchors at UTC midnight and can
// shift the shown day in negative-UTC timezones).
function parseDateValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function toDateValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDisplay(date: Date) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function sameDay(a: Date | null, b: Date) {
  return Boolean(a && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate());
}

/**
 * Date-only field with a calendar popover — the form-input counterpart of the
 * task table's inline DatePicker, emitting "YYYY-MM-DD" values.
 */
export function DateField({
  value,
  onChange,
  placeholder = "Pick a date",
  "aria-label": ariaLabel,
  disabled = false,
  clearable = false,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  "aria-label"?: string;
  disabled?: boolean;
  clearable?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = parseDateValue(value);
  const [viewDate, setViewDate] = useState<Date>(() => selected ?? new Date());

  useEffect(() => {
    if (!open) return;
    setViewDate(parseDateValue(value) ?? new Date());
  }, [open, value]);

  const monthStart = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
  const gridStart = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1 - monthStart.getDay());
  const monthLabel = viewDate.toLocaleString(undefined, { month: "short", year: "numeric" });
  const today = new Date();
  const calendarDays = Array.from({ length: 42 }, (_, index) =>
    new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index));

  const pick = (date: Date) => {
    onChange(toDateValue(date));
    setOpen(false);
  };

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(inputClassName, "flex items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60", !value && "text-[var(--ink-faint)]", className)}
        >
          <CalendarDays className="h-3.5 w-3.5 shrink-0 text-[var(--ink-faint)]" />
          <span className="min-w-0 flex-1 truncate">{selected ? formatDisplay(selected) : placeholder}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--ink-faint)]" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[268px] rounded-[10px] border border-[var(--hairline)] bg-[var(--surface)] p-2.5 shadow-[var(--shadow-popover)]"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-2 flex items-center gap-1.5">
            <div className="flex-1 text-[13px] font-semibold text-[var(--ink)]">{monthLabel}</div>
            <button type="button" className="rounded-md px-2 py-1 text-[12px] font-medium text-[var(--ink-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--ink)]" onClick={() => pick(today)}>Today</button>
            <button type="button" className="task-icon-btn h-7 w-7" aria-label="Previous month" onClick={() => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1))}><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" className="task-icon-btn h-7 w-7" aria-label="Next month" onClick={() => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1))}><ChevronRight className="h-4 w-4" /></button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-[var(--ink-faint)]">
            {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => <div key={day} className="py-1">{day}</div>)}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {calendarDays.map((date) => {
              const isSelected = sameDay(selected, date);
              const inCurrentMonth = date.getMonth() === viewDate.getMonth();
              const isToday = sameDay(today, date);
              return (
                <button
                  key={toDateValue(date)}
                  type="button"
                  onClick={() => pick(date)}
                  className={cn(
                    "h-8 rounded-md text-[13px] transition-colors hover:bg-[var(--surface-muted)]",
                    inCurrentMonth ? "text-[var(--ink-secondary)]" : "text-[var(--ink-faint)]",
                    isToday && "font-semibold text-[var(--primary)]",
                    isSelected && "bg-[var(--primary)] !text-[var(--on-primary)] hover:!bg-[var(--primary-hover)]",
                  )}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
          {clearable && value && (
            <div className="mt-1 border-t border-[var(--hairline)] pt-1">
              <button type="button" className="w-full rounded-md py-1.5 text-left text-[13px] text-[var(--ink-secondary)] hover:text-[var(--ink)]" onClick={() => { onChange(""); setOpen(false); }}>Clear</button>
            </div>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
