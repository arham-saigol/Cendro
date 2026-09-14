"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ConvexError } from "convex/values";
import { useQuery_experimental } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { PageHeader } from "./page-header";
import { useCompany } from "./company-context";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { canViewDashboard } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { DashboardTrendChart, type DashboardTrendMode } from "./dashboard-charts";

export type DashboardRangeArg =
  | { preset: "this_week" | "this_month" | "last_3_months" | "this_year" }
  | { preset: "custom"; startDate: string; endDate: string };

type DashboardFilters = FunctionReturnType<typeof api.analytics.dashboardFilters>;
type DashboardData = FunctionReturnType<typeof api.analytics.dashboard>;
type EmployeeRow = DashboardData["rankings"]["employees"][number];
type GroupRow = { id: string; name: string; completionRate: number };

const numberFormat = new Intl.NumberFormat("en-US");

const filterTriggerClass =
  "h-8 min-w-[132px] rounded-md border-[var(--hairline)] bg-[var(--surface)] px-2.5 text-[13px] font-normal text-[var(--ink-secondary)] shadow-none hover:bg-[var(--surface-muted)] data-[state=open]:bg-[var(--surface-muted)]";

function Frame({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-2", className)}>{children}</div>;
}

function Inset({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-lg border border-[var(--hairline)] bg-[var(--surface-muted)]", className)}>{children}</div>;
}

const cardTitleClass = "px-1.5 pb-2 pt-1";

function useRoundedNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 300_000) * 300_000);
  useEffect(() => {
    const interval = setInterval(() => {
      setNow((previous) => {
        const next = Math.floor(Date.now() / 300_000) * 300_000;
        return previous === next ? previous : next;
      });
    }, 60_000);
    return () => clearInterval(interval);
  }, []);
  return now;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Frame>
      <div className="px-1.5 pb-1.5 pt-0.5 text-[12px] font-medium text-[var(--ink-muted)]">{label}</div>
      <Inset className="rounded-md px-3 py-2.5">
        <div className="text-[24px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-[var(--ink)]">{value}</div>
      </Inset>
    </Frame>
  );
}

function StatRow({ heading, cards, className }: { heading: string; cards: { label: string; value: string }[]; className?: string }) {
  return (
    <section className={className}>
      <h2 className="mb-2.5 text-[12px] font-medium text-[var(--ink-muted)]">{heading}</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map((card) => <StatCard key={card.label} label={card.label} value={card.value} />)}
      </div>
    </section>
  );
}

function toDateField(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function fromDateField(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date : null;
}

const shortDayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const fullDayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function formatRangeLabel(startDate: string, endDate: string) {
  const start = fromDateField(startDate);
  const end = fromDateField(endDate);
  if (!start || !end) return "Custom";
  const sameYear = start.getFullYear() === end.getFullYear();
  return `${sameYear ? shortDayFormat.format(start) : fullDayFormat.format(start)} – ${fullDayFormat.format(end)}`;
}

function sameCalendarDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

const rangePresets = [
  { preset: "this_week", label: "This week" },
  { preset: "this_month", label: "This month" },
  { preset: "last_3_months", label: "Last 3 months" },
  { preset: "this_year", label: "This year" },
] as const;

function DateRangeControl({
  value,
  onChange,
  resolvedRange,
}: {
  value: DashboardRangeArg;
  onChange: (range: DashboardRangeArg) => void;
  resolvedRange: { startDate: string; endDate: string };
}) {
  const [open, setOpen] = useState(false);
  const appliedStart = value.preset === "custom" ? fromDateField(value.startDate) : null;
  const appliedEnd = value.preset === "custom" ? fromDateField(value.endDate) : null;
  const [monthDate, setMonthDate] = useState(() => startOfDay(appliedStart ?? new Date()));
  const [draftStart, setDraftStart] = useState<Date | null>(null);
  const [hoverDate, setHoverDate] = useState<Date | null>(null);

  const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const calendarStart = new Date(monthStart);
  calendarStart.setDate(1 - ((monthStart.getDay() + 6) % 7));
  const calendarDays: Date[] = [];
  for (let index = 0; index < 42; index++) {
    calendarDays.push(new Date(calendarStart));
    calendarStart.setDate(calendarStart.getDate() + 1);
  }

  const today = new Date();
  const todayStart = startOfDay(today);
  const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const canGoNext = monthStart < currentMonthStart;
  const monthLabel = monthDate.toLocaleString("en-US", { month: "long", year: "numeric" });

  let rangeStart: Date | null = null;
  let rangeEnd: Date | null = null;
  if (draftStart) {
    const previewEnd = hoverDate ?? draftStart;
    rangeStart = startOfDay(previewEnd < draftStart ? previewEnd : draftStart);
    rangeEnd = startOfDay(previewEnd < draftStart ? draftStart : previewEnd);
  } else if (appliedStart && appliedEnd) {
    rangeStart = startOfDay(appliedStart);
    rangeEnd = startOfDay(appliedEnd);
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) {
      setDraftStart(null);
      setHoverDate(null);
      setMonthDate(startOfDay(appliedStart ?? new Date()));
    }
  }

  function pick(date: Date) {
    if (startOfDay(date) > todayStart) return;
    if (!draftStart) {
      setDraftStart(date);
      setHoverDate(date);
      return;
    }
    const start = date < draftStart ? date : draftStart;
    const end = date < draftStart ? draftStart : date;
    setDraftStart(null);
    setHoverDate(null);
    setOpen(false);
    onChange({ preset: "custom", startDate: toDateField(start), endDate: toDateField(end) });
  }

  const triggerLabel = formatRangeLabel(resolvedRange.startDate, resolvedRange.endDate);
  const statusText = draftStart
    ? "Pick an end date"
    : formatRangeLabel(resolvedRange.startDate, resolvedRange.endDate);

  return (
    <DropdownMenu.Root open={open} onOpenChange={handleOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center justify-between gap-2 whitespace-nowrap outline-none focus:border-[var(--focus-ring)]",
            filterTriggerClass,
            value.preset === "custom" && "text-[var(--ink)]",
          )}
        >
          <span className="min-w-0 truncate">{triggerLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--ink-faint)]" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className="task-menu p-0">
          <div className="flex flex-col sm:flex-row">
            <div className="border-b border-[var(--hairline)] p-1.5 sm:w-[150px] sm:border-b-0 sm:border-r">
              {rangePresets.map((entry) => (
                <button
                  key={entry.preset}
                  type="button"
                  className={cn(
                    "task-menu-item w-full text-left",
                    value.preset === entry.preset && "bg-[var(--surface-muted)] text-[var(--ink)]",
                  )}
                  onClick={() => {
                    onChange({ preset: entry.preset });
                    handleOpenChange(false);
                  }}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <div className="w-[260px] p-3">
              <div className="mb-2 flex items-center gap-1.5">
                <div className="flex-1 text-[13px] font-medium text-[var(--ink)]">{monthLabel}</div>
                <button
                  type="button"
                  className="task-icon-btn h-7 w-7"
                  aria-label="Previous month"
                  onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="task-icon-btn h-7 w-7"
                  aria-label="Next month"
                  disabled={!canGoNext}
                  onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1))}
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
              <div className="grid grid-cols-7 text-center text-[11px] font-medium text-[var(--ink-faint)]">
                {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((day) => <div key={day} className="py-1">{day}</div>)}
              </div>
              <div className="mt-1 grid grid-cols-7 gap-0.5">
                {calendarDays.map((date) => {
                  const day = startOfDay(date);
                  const inMonth = date.getMonth() === monthDate.getMonth();
                  const isToday = sameCalendarDay(today, date);
                  const isFuture = day > todayStart;
                  const isEnd = Boolean((rangeStart && sameCalendarDay(rangeStart, day)) || (rangeEnd && sameCalendarDay(rangeEnd, day)));
                  const isBetween = Boolean(rangeStart && rangeEnd && day > rangeStart && day < rangeEnd);
                  return (
                    <button
                      key={date.toISOString()}
                      type="button"
                      disabled={isFuture}
                      onClick={() => pick(date)}
                      onMouseEnter={() => { if (draftStart && !isFuture) setHoverDate(date); }}
                      onFocus={() => { if (draftStart && !isFuture) setHoverDate(date); }}
                      className={cn(
                        "h-8 rounded-md text-[13px] transition-colors",
                        inMonth ? "text-[var(--ink-secondary)] hover:bg-[var(--surface-muted)]" : "text-[var(--ink-faint)]",
                        isToday && "font-semibold text-[var(--ink)]",
                        isBetween && "bg-[var(--surface-muted)]",
                        isEnd && "bg-[var(--ink)] text-[var(--canvas)] hover:bg-[var(--ink)]",
                        isFuture && "opacity-40 hover:bg-transparent",
                      )}
                    >
                      {date.getDate()}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2.5 text-[12px] text-[var(--ink-muted)]">{statusText}</p>
            </div>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function FilterRow({
  filters,
  branchId,
  departmentId,
  membershipId,
  range,
  resolvedRange,
  onBranchChange,
  onDepartmentChange,
  onMembershipChange,
  onRangeChange,
}: {
  filters: DashboardFilters;
  branchId: string;
  departmentId: string;
  membershipId: string;
  range: DashboardRangeArg;
  resolvedRange: { startDate: string; endDate: string };
  onBranchChange: (value: string) => void;
  onDepartmentChange: (value: string) => void;
  onMembershipChange: (value: string) => void;
  onRangeChange: (range: DashboardRangeArg) => void;
}) {
  const departments = branchId === "all" ? filters.departments : filters.departments.filter((department) => department.branchId === branchId);
  const users = filters.users.filter(
    (user) =>
      (branchId === "all" || user.branchIds.includes(branchId as Id<"branches">)) &&
      (departmentId === "all" || user.departmentIds.includes(departmentId as Id<"departments">)),
  );
  return (
    <div className="mb-7 flex flex-wrap items-center gap-2">
      {filters.branches.length >= 2 && (
        <Select value={branchId} onValueChange={onBranchChange}>
          <SelectTrigger className={cn(filterTriggerClass, branchId !== "all" && "text-[var(--ink)]")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-[13px]">All branches</SelectItem>
            {filters.branches.map((branch) => (
              <SelectItem key={branch._id} value={branch._id} className="text-[13px]">{branch.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {filters.departments.length >= 2 && (
        <Select value={departmentId} onValueChange={onDepartmentChange}>
          <SelectTrigger className={cn(filterTriggerClass, departmentId !== "all" && "text-[var(--ink)]")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-[13px]">All departments</SelectItem>
            {departments.map((department) => (
              <SelectItem key={department._id} value={department._id} className="text-[13px]">{department.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {filters.users.length >= 2 && (
        <Select value={membershipId} onValueChange={onMembershipChange}>
          <SelectTrigger className={cn(filterTriggerClass, membershipId !== "all" && "text-[var(--ink)]")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-[13px]">All users</SelectItem>
            {users.map((user) => (
              <SelectItem key={user._id} value={user._id} className="text-[13px]">{user.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <DateRangeControl value={range} onChange={onRangeChange} resolvedRange={resolvedRange} />
    </div>
  );
}

function ChartCard({ data, mode, onModeChange }: { data: DashboardData; mode: DashboardTrendMode; onModeChange: (mode: DashboardTrendMode) => void }) {
  const empty = data.trend.every((bucket) => (mode === "jd" ? bucket.jdDue === 0 : bucket.tasksAssigned === 0));
  return (
    <Frame className="mt-6">
      <div className={cn(cardTitleClass, "flex items-center justify-between gap-3")}>
        <div className="flex items-center gap-4 text-[12px] text-[var(--ink-muted)]">
          <span className="flex items-center gap-1.5">
            <span className="w-4 border-t-2 border-[var(--badge-blue-fg)]" />
            Completed
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-4 border-t-2 border-[var(--ink-secondary)]" />
            {mode === "jd" ? "Due" : "Assigned"}
          </span>
        </div>
        <Tabs value={mode} onValueChange={(value) => onModeChange(value as DashboardTrendMode)}>
          <TabsList>
            <TabsTrigger value="jd" className="px-2.5 py-1 text-[12.5px]">Job Description</TabsTrigger>
            <TabsTrigger value="tasks" className="px-2.5 py-1 text-[12.5px]">Tasks</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <Inset className="p-4 sm:p-6">
        {empty ? (
          <div className="grid h-[260px] place-items-center">
            <p className="text-[12.5px] text-[var(--ink-faint)]">No activity in this period</p>
          </div>
        ) : (
          <DashboardTrendChart points={data.trend} mode={mode} height={260} />
        )}
      </Inset>
    </Frame>
  );
}

const emptyRankings = <p className="py-6 text-center text-[12.5px] text-[var(--ink-faint)]">No work recorded in this period.</p>;

function RankingList({ title, rows }: { title: string; rows: GroupRow[] }) {
  return (
    <Frame>
      <div className={cn(cardTitleClass, "text-[13px] font-medium text-[var(--ink)]")}>{title}</div>
      <Inset className="px-3.5 py-1.5">
        {rows.length === 0 ? (
          emptyRankings
        ) : (
          <div className="divide-y divide-[var(--hairline)]">
            {rows.map((row, index) => (
              <div key={row.id} className="flex items-center gap-3 py-2.5 text-[13px]">
                <span className="w-4 text-[12px] tabular-nums text-[var(--ink-faint)]">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[var(--ink)]">{row.name}</span>
                <span className="tabular-nums text-[var(--ink-secondary)]">{row.completionRate}%</span>
              </div>
            ))}
          </div>
        )}
      </Inset>
    </Frame>
  );
}

function EmployeeTable({ title, rows }: { title: string; rows: EmployeeRow[] }) {
  const gridClass = "grid grid-cols-[minmax(0,1fr)_88px] sm:grid-cols-[minmax(0,1fr)_120px_120px_96px]";
  return (
    <Frame>
      <div className={cn(cardTitleClass, "text-[13px] font-medium text-[var(--ink)]")}>{title}</div>
      <Inset className="px-3.5 py-2">
        {rows.length === 0 ? (
          emptyRankings
        ) : (
          <div>
            <div className={cn(gridClass, "border-b border-[var(--hairline)] pb-2 text-[11.5px] font-medium text-[var(--ink-faint)]")}>
              <div>Employee</div>
              <div className="hidden text-right sm:block">Job Description</div>
              <div className="hidden text-right sm:block">Tasks</div>
              <div className="text-right">Completion</div>
            </div>
            {rows.map((row) => (
              <div key={row.id} className={cn(gridClass, "items-center border-b border-[var(--hairline)] py-2.5 text-[13px] tabular-nums last:border-0")}>
                <div className="min-w-0 truncate text-[var(--ink)]">{row.name}</div>
                <div className="hidden text-right text-[var(--ink-secondary)] sm:block">{row.jdCompleted}/{row.jdDue}</div>
                <div className="hidden text-right text-[var(--ink-secondary)] sm:block">{row.tasksCompleted}/{row.tasksAssigned}</div>
                <div className="text-right text-[var(--ink)]">{row.completionRate}%</div>
              </div>
            ))}
          </div>
        )}
      </Inset>
    </Frame>
  );
}

function RankingsSection({ data }: { data: DashboardData }) {
  const groups = data.rankings.groups;
  if (data.level === "user") return null;
  if (data.level === "department") {
    return (
      <div className="mt-6">
        <EmployeeTable title="Top performing employees" rows={data.rankings.employees} />
      </div>
    );
  }
  return (
    <div className="mt-6 grid gap-4 md:grid-cols-2">
      <RankingList title="Top performing employees" rows={data.rankings.employees} />
      {groups && (
        <RankingList title={groups.kind === "branch" ? "Top performing branches" : "Top departments"} rows={groups.rows} />
      )}
    </div>
  );
}

export function DashboardView({
  filters,
  data,
  pending = false,
  branchId,
  departmentId,
  membershipId,
  range,
  chartMode,
  onBranchChange,
  onDepartmentChange,
  onMembershipChange,
  onRangeChange,
  onChartModeChange,
}: {
  filters: DashboardFilters;
  data: DashboardData;
  pending?: boolean;
  branchId: string;
  departmentId: string;
  membershipId: string;
  range: DashboardRangeArg;
  chartMode: DashboardTrendMode;
  onBranchChange: (value: string) => void;
  onDepartmentChange: (value: string) => void;
  onMembershipChange: (value: string) => void;
  onRangeChange: (range: DashboardRangeArg) => void;
  onChartModeChange: (mode: DashboardTrendMode) => void;
}) {
  return (
    <div className="app-page">
      <PageHeader title="Dashboard" />
      <div className={cn("transition-opacity", pending && "opacity-60")} aria-busy={pending || undefined}>
        <FilterRow
          filters={filters}
          branchId={branchId}
          departmentId={departmentId}
          membershipId={membershipId}
          range={range}
          resolvedRange={data.range}
          onBranchChange={onBranchChange}
          onDepartmentChange={onDepartmentChange}
          onMembershipChange={onMembershipChange}
          onRangeChange={onRangeChange}
        />
        {data.isTruncated && (
          <p className="mb-5 text-[12.5px] text-[var(--ink-muted)]">Some records were omitted because this workspace exceeds the reporting limit.</p>
        )}
        <StatRow
          heading="Job Description"
          cards={[
            { label: "Due", value: numberFormat.format(data.jd.due) },
            { label: "Completed", value: numberFormat.format(data.jd.completed) },
            { label: "Overdue", value: numberFormat.format(data.jd.overdue) },
            { label: "Completion", value: data.jd.due === 0 ? "—" : `${data.jd.completionRate}%` },
          ]}
        />
        <StatRow
          heading="Tasks"
          className="mt-6"
          cards={[
            { label: "Assigned", value: numberFormat.format(data.tasks.assigned) },
            { label: "Completed", value: numberFormat.format(data.tasks.completed) },
            { label: "Overdue", value: numberFormat.format(data.tasks.overdue) },
            { label: "Completion", value: data.tasks.assigned === 0 ? "—" : `${data.tasks.completionRate}%` },
          ]}
        />
        <ChartCard data={data} mode={chartMode} onModeChange={onChartModeChange} />
        <RankingsSection data={data} />
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  const block = "animate-pulse rounded-xl bg-[var(--surface-muted)]";
  return (
    <div className="app-page">
      <div className={cn(block, "mb-7 h-7 w-40")} />
      <div className="mb-7 flex flex-wrap gap-2">
        {[0, 1, 2].map((index) => <div key={index} className={cn(block, "h-8 w-[132px]")} />)}
      </div>
      {[0, 1].map((row) => (
        <div key={row} className={cn("grid grid-cols-2 gap-3 md:grid-cols-4", row === 1 && "mt-6")}>
          {[0, 1, 2, 3].map((cell) => <div key={cell} className={cn(block, "h-[80px]")} />)}
        </div>
      ))}
      <div className={cn(block, "mt-6 h-[356px]")} />
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {[0, 1].map((index) => <div key={index} className={cn(block, "h-[220px]")} />)}
      </div>
    </div>
  );
}

function errorMessage(error: unknown) {
  if (error instanceof ConvexError && typeof error.data === "string") return error.data;
  if (error instanceof Error) return error.message;
  return "Could not load the dashboard.";
}

export function DashboardPage() {
  const { activeCompanyId, active } = useCompany();
  const now = useRoundedNow();
  const [branchId, setBranchId] = useState<Id<"branches"> | "all">("all");
  const [departmentId, setDepartmentId] = useState<Id<"departments"> | "all">("all");
  const [membershipId, setMembershipId] = useState<Id<"companyMemberships"> | "all">("all");
  const [range, setRange] = useState<DashboardRangeArg>({ preset: "this_month" });
  const [chartMode, setChartMode] = useState<DashboardTrendMode>("jd");
  const [cachedData, setCachedData] = useState<DashboardData | null>(null);
  const [cachedFilters, setCachedFilters] = useState<DashboardFilters | null>(null);

  useEffect(() => {
    setBranchId("all");
    setDepartmentId("all");
    setMembershipId("all");
    setRange({ preset: "this_month" });
    setChartMode("jd");
    setCachedData(null);
    setCachedFilters(null);
  }, [activeCompanyId]);

  const filtersResult = useQuery_experimental({
    query: api.analytics.dashboardFilters,
    args: activeCompanyId ? { companyId: activeCompanyId } : "skip",
  });
  const filtersData = filtersResult.status === "success" ? filtersResult.data : null;

  const validBranchId = branchId !== "all" && filtersData?.branches.some((branch) => branch._id === branchId) ? branchId : undefined;
  const validDepartmentId =
    departmentId !== "all" &&
    filtersData?.departments.some((department) => department._id === departmentId && (!validBranchId || department.branchId === validBranchId))
      ? departmentId
      : undefined;
  const validMembershipId =
    membershipId !== "all" &&
    filtersData?.users.some(
      (user) =>
        user._id === membershipId &&
        (!validBranchId || user.branchIds.includes(validBranchId)) &&
        (!validDepartmentId || user.departmentIds.includes(validDepartmentId)),
    )
      ? membershipId
      : undefined;

  const result = useQuery_experimental({
    query: api.analytics.dashboard,
    args:
      activeCompanyId && filtersResult.status === "success"
        ? {
            companyId: activeCompanyId,
            now,
            range,
            branchId: validBranchId,
            departmentId: validDepartmentId,
            membershipId: validMembershipId,
          }
        : "skip",
  });

  const liveData = result.status === "success" ? result.data : null;
  useEffect(() => {
    if (liveData) setCachedData(liveData);
  }, [liveData]);
  useEffect(() => {
    if (filtersData) setCachedFilters(filtersData);
  }, [filtersData]);

  const queryError =
    filtersResult.status === "error" ? filtersResult.error : result.status === "error" ? result.error : null;

  if (active && !canViewDashboard(active.capabilities)) {
    return (
      <div className="app-page">
        <PageHeader title="Dashboard" description="Dashboard access is disabled for your account." />
      </div>
    );
  }
  if (queryError) {
    return (
      <div className="app-page">
        <PageHeader title="Dashboard" />
        <div className="alert-error rounded-md p-3 text-sm">{errorMessage(queryError)}</div>
      </div>
    );
  }

  const viewFilters = filtersData ?? cachedFilters;
  const viewData = liveData ?? cachedData;
  if (!viewFilters || !viewData) return <DashboardSkeleton />;

  function handleBranchChange(next: string) {
    const nextBranch = next === "all" ? "all" : (next as Id<"branches">);
    setBranchId(nextBranch);
    if (nextBranch !== "all" && filtersData) {
      if (departmentId !== "all" && !filtersData.departments.some((department) => department._id === departmentId && department.branchId === nextBranch)) {
        setDepartmentId("all");
      }
      if (membershipId !== "all") {
        const user = filtersData.users.find((entry) => entry._id === membershipId);
        if (user && !user.branchIds.includes(nextBranch)) setMembershipId("all");
      }
    }
  }

  function handleDepartmentChange(next: string) {
    const nextDepartment = next === "all" ? "all" : (next as Id<"departments">);
    setDepartmentId(nextDepartment);
    if (nextDepartment !== "all" && membershipId !== "all" && filtersData) {
      const user = filtersData.users.find((entry) => entry._id === membershipId);
      if (user && !user.departmentIds.includes(nextDepartment)) setMembershipId("all");
    }
  }

  return (
    <DashboardView
      filters={viewFilters}
      data={viewData}
      pending={filtersResult.status !== "success" || result.status !== "success"}
      branchId={branchId}
      departmentId={departmentId}
      membershipId={membershipId}
      range={range}
      chartMode={chartMode}
      onBranchChange={handleBranchChange}
      onDepartmentChange={handleDepartmentChange}
      onMembershipChange={(value) => setMembershipId(value === "all" ? "all" : (value as Id<"companyMemberships">))}
      onRangeChange={setRange}
      onChartModeChange={setChartMode}
    />
  );
}
