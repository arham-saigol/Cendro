"use client";

import * as Popover from "@radix-ui/react-popover";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

function formatFull(date: Date) {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(date);
}

function sameDay(a: Date | null, b: Date) {
  return Boolean(a && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate());
}

// Free-text entry: ISO dates, today/tomorrow/yesterday, and anything
// Date.parse accepts ("Oct 5, 2026", "10/5/2026"). Inputs without a 4-digit
// year assume the current year so "Dec 25" lands on the upcoming holiday.
function parseDraft(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const iso = parseDateValue(trimmed);
  if (iso) return iso;
  const lowered = trimmed.toLowerCase();
  if (lowered === "today") return new Date();
  if (lowered === "tomorrow") return new Date(Date.now() + 86_400_000);
  if (lowered === "yesterday") return new Date(Date.now() - 86_400_000);
  // Loose ISO ("2026-10-5") is parsed as UTC by Date.parse — build it from
  // local parts so the day doesn't shift.
  const looseIso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (looseIso) return parseDateValue(`${looseIso[1]}-${looseIso[2].padStart(2, "0")}-${looseIso[3].padStart(2, "0")}`);
  const withYear = /\d{4}/.test(trimmed) ? trimmed : `${trimmed}, ${new Date().getFullYear()}`;
  const ms = Date.parse(withYear);
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

const DAY_KEY_OFFSETS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

/**
 * Date-only field with a calendar popover — the form-input counterpart of the
 * task table's inline DatePicker, emitting "YYYY-MM-DD" values. Built on
 * Popover (not DropdownMenu) so Tab and the typed-date input stay reachable —
 * menus trap focus on registered items only.
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
  const [draft, setDraft] = useState("");
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const shown = parseDateValue(value);
    setViewDate(shown ?? new Date());
    setDraft(shown ? formatDisplay(shown) : "");
  }, [open, value]);

  useEffect(() => {
    if (!open || !pendingFocus) return;
    gridRef.current?.querySelector<HTMLButtonElement>(`button[data-date="${pendingFocus}"]`)?.focus();
    setPendingFocus(null);
  }, [open, viewDate, pendingFocus]);

  const monthStart = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
  const gridStart = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1 - monthStart.getDay());
  const monthLabel = viewDate.toLocaleString(undefined, { month: "short", year: "numeric" });
  const today = new Date();
  const calendarDays = Array.from({ length: 42 }, (_, index) =>
    new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index));
  const firstDayKey = toDateValue(calendarDays[0]);
  const lastDayKey = toDateValue(calendarDays[41]);

  const pick = (date: Date) => {
    onChange(toDateValue(date));
    setOpen(false);
  };

  const commitDraft = (): boolean => {
    const parsed = parseDraft(draft);
    if (!parsed) {
      if (clearable && !draft.trim()) {
        onChange("");
        return true;
      }
      setDraft(selected ? formatDisplay(selected) : "");
      return false;
    }
    onChange(toDateValue(parsed));
    setViewDate(new Date(parsed.getFullYear(), parsed.getMonth(), 1));
    return true;
  };

  // Arrow keys move focus across the day grid; stepping off the edge swaps the
  // displayed month and focuses the target day once it renders.
  const handleGridKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const offset = DAY_KEY_OFFSETS[event.key];
    if (offset === undefined) return;
    const current = parseDateValue((event.target as HTMLElement).getAttribute("data-date") ?? "");
    if (!current) return;
    event.preventDefault();
    const next = new Date(current.getFullYear(), current.getMonth(), current.getDate() + offset);
    const nextKey = toDateValue(next);
    if (nextKey >= firstDayKey && nextKey <= lastDayKey) {
      gridRef.current?.querySelector<HTMLButtonElement>(`button[data-date="${nextKey}"]`)?.focus();
    } else {
      setViewDate(new Date(next.getFullYear(), next.getMonth(), 1));
      setPendingFocus(nextKey);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={disabled}>
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
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[268px] rounded-[10px] border border-[var(--hairline)] bg-[var(--surface)] p-2.5 shadow-[var(--shadow-popover)]"
          onClick={(event) => event.stopPropagation()}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            setPendingFocus(toDateValue(selected ?? today));
          }}
        >
          <input
            aria-label={ariaLabel ?? "Date"}
            className={cn(inputClassName, "mb-2 text-[13px]")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => commitDraft()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (commitDraft()) setOpen(false);
              }
              if (event.key === "Escape") setDraft(selected ? formatDisplay(selected) : "");
            }}
            placeholder="Jun 24, 2026"
          />
          <div className="mb-2 flex items-center gap-1.5">
            <div className="flex-1 text-[13px] font-semibold text-[var(--ink)]">{monthLabel}</div>
            <button type="button" className="rounded-md px-2 py-1 text-[12px] font-medium text-[var(--ink-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--ink)]" onClick={() => pick(today)}>Today</button>
            <button type="button" className="task-icon-btn h-7 w-7" aria-label="Previous month" onClick={() => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1))}><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" className="task-icon-btn h-7 w-7" aria-label="Next month" onClick={() => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1))}><ChevronRight className="h-4 w-4" /></button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-[var(--ink-faint)]">
            {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => <div key={day} className="py-1">{day}</div>)}
          </div>
          <div ref={gridRef} className="mt-1 grid grid-cols-7 gap-1" onKeyDown={handleGridKeyDown}>
            {calendarDays.map((date) => {
              const isSelected = sameDay(selected, date);
              const inCurrentMonth = date.getMonth() === viewDate.getMonth();
              const isToday = sameDay(today, date);
              return (
                <button
                  key={toDateValue(date)}
                  type="button"
                  data-date={toDateValue(date)}
                  aria-label={formatFull(date)}
                  aria-current={isToday ? "date" : undefined}
                  onClick={() => pick(date)}
                  className={cn(
                    "h-8 rounded-md text-[13px] transition-colors hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]",
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
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
