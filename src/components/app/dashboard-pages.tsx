"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useQuery_experimental } from "convex/react";
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  FileText,
  Inbox,
  Info,
  Layers,
  ListChecks,
  RotateCcw,
  SlidersHorizontal,
  Target,
  Timer,
  TrendingUp,
  Trophy,
  Users,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { PageHeader } from "./page-header";
import { useCompany } from "./company-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { canViewDashboard } from "@/lib/permissions";
import { cn } from "@/lib/utils";

type DashboardRole = "Admin" | "Manager" | "Employee";
type DatePreset = "7d" | "30d" | "90d" | "365d";
type TaskTypeFilter = "all" | "jd" | "one_time";
type StatusFilter = "all" | "due" | "in_progress" | "completed" | "overdue";
type PriorityFilter = "all" | "low" | "medium" | "high";
type FrequencyFilter = "all" | "daily" | "every_other_day" | "weekly" | "monthly" | "semiannually" | "annually";

type BreakdownItem = { key: string; label: string; value: number };
type TrendMetric = "completed" | "overdue" | "workload";
type TrendPoint = { bucketStart: number; label: string; completed: number; overdue: number; workload: number };
type PerformanceRow = {
  id: string;
  name: string;
  firstName?: string;
  role?: string;
  parentId?: string | null;
  assigned: number;
  completed: number;
  overdue: number;
  completionRate: number;
};
type DashboardData = {
  role: DashboardRole;
  viewer: { membershipId: string; role: string; name: string; firstName: string };
  company: { _id: string; name: string; timeZone: string | null };
  generatedAt: number;
  range: { preset: DatePreset; start: number; end: number; label: string };
  appliedFilters: {
    branchId: string | null;
    departmentId: string | null;
    membershipId: string | null;
    taskType: TaskTypeFilter;
    status: StatusFilter;
    priority: PriorityFilter;
    frequency: FrequencyFilter;
  };
  filterOptions: {
    branches: { _id: string; name: string }[];
    departments: { _id: string; branchId: string; name: string; branchName: string }[];
    employees: { _id: string; name: string; firstName: string; role: string; branchIds: string[]; departmentIds: string[] }[];
  };
  scope: { people: number; branches: number; departments: number };
  metrics: {
    totalTasks: number;
    completedTasks: number;
    completionRate: number;
    openTasks: number;
    periodCompletions: number;
    notStartedTasks: number;
    inProgressTasks: number;
    overdueTasks: number;
    oneTimeTasks: number;
    recurringTasks: number;
    lateCompletions: number;
    lateCompletionRate: number;
  };
  breakdowns: { status: BreakdownItem[]; priority: BreakdownItem[]; frequency: BreakdownItem[]; type: BreakdownItem[] };
  jdCycleHealth: { completedCycles: number; missedCycles: number; healthyRate: number };
  sopStats: { visible: number; byScope: BreakdownItem[] };
  trends: TrendPoint[];
  comparisons: {
    branches: PerformanceRow[];
    departments: PerformanceRow[];
    employees: PerformanceRow[];
    topPerformers: PerformanceRow[];
    needsAttention: PerformanceRow[];
  };
  recent: {
    completions: { id: string; kind: "jd" | "one_time"; title: string; completedAt: number; actorName: string | null }[];
    audit: { id: string; action: string; targetType: string; createdAt: number }[];
  };
  limitations: { sopCompliance: boolean; lateJdCompletionRate: boolean };
};

const dateOptions: { value: DatePreset; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "365d", label: "12 months" },
];
const taskTypeOptions: { value: TaskTypeFilter; label: string }[] = [
  { value: "all", label: "All tasks" },
  { value: "one_time", label: "One-time" },
  { value: "jd", label: "JD / recurring" },
];
const statusOptions: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "due", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "overdue", label: "Overdue" },
];
const priorityOptions: { value: PriorityFilter; label: string }[] = [
  { value: "all", label: "All priorities" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];
const frequencyOptions: { value: FrequencyFilter; label: string }[] = [
  { value: "all", label: "All frequencies" },
  { value: "daily", label: "Daily" },
  { value: "every_other_day", label: "Alternate days" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "semiannually", label: "Bi-yearly" },
  { value: "annually", label: "Yearly" },
];

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatPercent(value: number) {
  return `${Math.round(value)}%`;
}

function safePercent(part: number, total: number) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function openTaskCount(data: DashboardData) {
  return Math.max(0, data.metrics.openTasks);
}

function cssColorFor(key: string) {
  if (key === "completed" || key === "low") return "var(--badge-green-fg)";
  if (key === "overdue" || key === "high") return "var(--danger)";
  if (key === "in_progress" || key === "one_time" || key === "jd" || key === "medium") return "var(--primary)";
  return "color-mix(in srgb, var(--ink-faint) 70%, transparent)";
}

function toneClass(tone: "neutral" | "accent" | "success" | "danger") {
  if (tone === "success") return "text-[var(--badge-green-fg)]";
  if (tone === "danger") return "text-[var(--danger)]";
  if (tone === "accent") return "text-[var(--primary)]";
  return "text-[var(--ink)]";
}

// ------------------------------------------------------------------
// Layout primitives
// ------------------------------------------------------------------

function DashboardCard({
  children,
  className,
  hover = false,
}: {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-[var(--hairline)] bg-[var(--surface)]",
        hover && "transition-colors duration-200 hover:border-[var(--hairline-strong)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

function Section({
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-8", className)}>
      {actions && <div className="mb-4 flex justify-end">{actions}</div>}
      {children}
    </section>
  );
}

function PanelHeader({
  title,
  description,
  icon,
  actions,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
      <div className="flex items-start gap-2.5">
        {icon && <span className="mt-0.5 text-[var(--ink-faint)]">{icon}</span>}
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-[var(--ink)]">{title}</h3>
          {description && <p className="mt-0.5 truncate text-[12px] text-[var(--ink-faint)]">{description}</p>}
        </div>
      </div>
      {actions}
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  helper,
  tone = "neutral",
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
  helper?: React.ReactNode;
  tone?: "neutral" | "accent" | "success" | "danger";
}) {
  return (
    <DashboardCard hover className="p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="text-[12px] font-medium text-[var(--ink-muted)]">{label}</span>
        {icon && (
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--surface-muted)] text-[var(--ink-faint)]">
            {icon}
          </span>
        )}
      </div>
      <div className={cn("mt-3 text-[32px] font-semibold leading-none tracking-[-0.04em] tabular-nums", toneClass(tone))}>
        {value}
      </div>
      {helper && <div className="mt-2 text-[12px] text-[var(--ink-faint)]">{helper}</div>}
    </DashboardCard>
  );
}

function MiniMetric({
  label,
  value,
  helper,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  helper?: React.ReactNode;
  tone?: "neutral" | "accent" | "success" | "danger";
}) {
  return (
    <div className="rounded-xl border border-[var(--hairline)] bg-[var(--surface-muted)]/40 p-4">
      <div className="text-[12px] font-medium text-[var(--ink-muted)]">{label}</div>
      <div className={cn("mt-2 text-[22px] font-semibold leading-none tracking-[-0.03em] tabular-nums", toneClass(tone))}>
        {value}
      </div>
      {helper && <div className="mt-1.5 text-[11px] text-[var(--ink-faint)]">{helper}</div>}
    </div>
  );
}

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-[180px] flex-col items-center justify-center px-5 py-10 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-faint)]">
        <Inbox className="h-4 w-4" />
      </span>
      <div className="mt-3 text-[13px] font-medium text-[var(--ink)]">{title}</div>
      <p className="mt-1 max-w-[280px] text-[12px] leading-snug text-[var(--ink-faint)]">{description}</p>
    </div>
  );
}

// ------------------------------------------------------------------
// Filters
// ------------------------------------------------------------------

function DashboardSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
      <SelectTrigger
        aria-label={label}
        className={cn(
          "h-9 rounded-lg border-[var(--hairline)] bg-[var(--surface)] text-[13px] shadow-none transition-colors hover:border-[var(--hairline-strong)]",
          className,
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function DashFilterSubmenu<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="task-menu-item">
        <span className="flex-1">{label}</span>
        <ChevronRight className="h-3.5 w-3.5" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent sideOffset={7} alignOffset={-5} className="task-menu min-w-52">
          {options.map((option) => (
            <DropdownMenu.Item
              key={option.value}
              onSelect={() => onChange(option.value)}
              className="task-menu-item"
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {value === option.value && <Check className="h-3.5 w-3.5 text-[var(--primary)]" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

function DashFilterMenu({
  taskType,
  status,
  priority,
  frequency,
  onTaskType,
  onStatus,
  onPriority,
  onFrequency,
  activeCount,
}: {
  taskType: TaskTypeFilter;
  status: StatusFilter;
  priority: PriorityFilter;
  frequency: FrequencyFilter;
  onTaskType: (value: TaskTypeFilter) => void;
  onStatus: (value: StatusFilter) => void;
  onPriority: (value: PriorityFilter) => void;
  onFrequency: (value: FrequencyFilter) => void;
  activeCount: number;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="task-toolbar-icon"
          data-active={activeCount > 0}
          aria-label="More dashboard filters"
        >
          <SlidersHorizontal className="h-4 w-4" />
          {activeCount > 0 && <span className="task-toolbar-badge">{activeCount}</span>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="task-menu min-w-48" aria-label="Dashboard filters">
          <DashFilterSubmenu label="Task type" value={taskType} options={taskTypeOptions} onChange={onTaskType} />
          <DashFilterSubmenu label="Status" value={status} options={statusOptions} onChange={onStatus} />
          <DashFilterSubmenu label="Priority" value={priority} options={priorityOptions} onChange={onPriority} />
          <DashFilterSubmenu label="Frequency" value={frequency} options={frequencyOptions} onChange={onFrequency} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function FilterBar({
  data,
  datePreset,
  taskType,
  status,
  priority,
  frequency,
  branchId,
  departmentId,
  membershipId,
  onDatePreset,
  onTaskType,
  onStatus,
  onPriority,
  onFrequency,
  onBranch,
  onDepartment,
  onMembership,
  onReset,
}: {
  data: DashboardData | null;
  datePreset: DatePreset;
  taskType: TaskTypeFilter;
  status: StatusFilter;
  priority: PriorityFilter;
  frequency: FrequencyFilter;
  branchId: string;
  departmentId: string;
  membershipId: string;
  onDatePreset: (value: DatePreset) => void;
  onTaskType: (value: TaskTypeFilter) => void;
  onStatus: (value: StatusFilter) => void;
  onPriority: (value: PriorityFilter) => void;
  onFrequency: (value: FrequencyFilter) => void;
  onBranch: (value: string) => void;
  onDepartment: (value: string) => void;
  onMembership: (value: string) => void;
  onReset: () => void;
}) {
  const showScopeFilters = data?.role === "Admin" || data?.role === "Manager";
  const branchOptions = useMemo(
    () => [{ value: "all", label: "All branches" }, ...(data?.filterOptions.branches ?? []).map((b) => ({ value: b._id, label: b.name }))],
    [data],
  );
  const departmentOptions = useMemo(() => {
    const departments = (data?.filterOptions.departments ?? []).filter((d) => branchId === "all" || d.branchId === branchId);
    return [{ value: "all", label: "All departments" }, ...departments.map((d) => ({ value: d._id, label: d.name }))];
  }, [branchId, data]);
  const employeeOptions = useMemo(() => {
    const employees = (data?.filterOptions.employees ?? []).filter((e) => {
      if (branchId !== "all" && !e.branchIds.includes(branchId)) return false;
      if (departmentId !== "all" && !e.departmentIds.includes(departmentId)) return false;
      return true;
    });
    return [{ value: "all", label: "All people" }, ...employees.map((e) => ({ value: e._id, label: e.name }))];
  }, [branchId, data, departmentId]);

  const secondaryActive = [taskType !== "all", status !== "all", priority !== "all", frequency !== "all"].filter(Boolean).length;
  const activeFilterCount = [
    datePreset !== "30d",
    taskType !== "all",
    status !== "all",
    priority !== "all",
    frequency !== "all",
    branchId !== "all",
    departmentId !== "all",
    membershipId !== "all",
  ].filter(Boolean).length;

  return (
    <DashboardCard className="mb-6 border-0 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <DashboardSelect label="Date range" value={datePreset} options={dateOptions} onChange={onDatePreset} className="w-[120px]" />
        {showScopeFilters && (
          <>
            <DashboardSelect
              label="Branch"
              value={branchId}
              options={branchOptions}
              onChange={(value) => {
                onBranch(value);
                onDepartment("all");
                onMembership("all");
              }}
              className="w-[150px]"
            />
            <DashboardSelect
              label="Department"
              value={departmentId}
              options={departmentOptions}
              onChange={(value) => {
                onDepartment(value);
                onMembership("all");
              }}
              className="w-[170px]"
              disabled={departmentOptions.length <= 1}
            />
            <DashboardSelect
              label="People"
              value={membershipId}
              options={employeeOptions}
              onChange={onMembership}
              className="w-[170px]"
              disabled={employeeOptions.length <= 1}
            />
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <DashFilterMenu
            taskType={taskType}
            status={status}
            priority={priority}
            frequency={frequency}
            onTaskType={onTaskType}
            onStatus={onStatus}
            onPriority={onPriority}
            onFrequency={onFrequency}
            activeCount={secondaryActive}
          />
          <Button variant="ghost" className="h-9 text-[13px]" onClick={onReset} disabled={activeFilterCount === 0}>
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
            {activeFilterCount > 0 && (
              <span className="ml-1.5 rounded-md bg-[var(--surface-muted)] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-[var(--ink-faint)]">
                {activeFilterCount}
              </span>
            )}
          </Button>
        </div>
      </div>
    </DashboardCard>
  );
}

// ------------------------------------------------------------------
// Charts & breakdowns
// ------------------------------------------------------------------

function SegmentBar({ items }: { items: BreakdownItem[] }) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) return <div className="h-2 rounded-full bg-[var(--surface-muted)]" />;
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-[var(--surface-muted)]" aria-hidden="true">
      {items
        .filter((item) => item.value > 0)
        .map((item) => (
          <span
            key={item.key}
            style={{ width: `${Math.max(4, (item.value / total) * 100)}%`, background: cssColorFor(item.key) }}
          />
        ))}
    </div>
  );
}

function BreakdownCard({
  title,
  description,
  items,
  icon,
}: {
  title: string;
  description?: string;
  items: BreakdownItem[];
  icon: React.ReactNode;
}) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return (
    <DashboardCard>
      <PanelHeader title={title} description={description} icon={icon} />
      <div className="px-5 pb-5">
        <SegmentBar items={items} />
        <div className="mt-4 space-y-1">
          {items.map((item) => (
            <div
              key={item.key}
              className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-[13px] transition-colors hover:bg-[var(--surface-muted)]"
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: cssColorFor(item.key) }} />
              <span className="min-w-0 flex-1 truncate text-[var(--ink-secondary)]">{item.label}</span>
              <span className="font-medium tabular-nums text-[var(--ink)]">{formatNumber(item.value)}</span>
              <span className="w-9 text-right text-[12px] tabular-nums text-[var(--ink-faint)]">
                {total ? formatPercent(safePercent(item.value, total)) : "0%"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </DashboardCard>
  );
}

function TrendChart({ data }: { data: TrendPoint[] }) {
  const width = 720;
  const height = 260;
  const padding = { top: 18, right: 18, bottom: 34, left: 40 };
  const max = Math.max(1, ...data.flatMap((point) => [point.completed, point.overdue, point.workload]));
  const baselineY = height - padding.bottom;
  const x = (index: number) => padding.left + (index / Math.max(1, data.length - 1)) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + (1 - value / max) * (height - padding.top - padding.bottom);
  const line = (key: TrendMetric) => data.map((point, index) => `${x(index)},${y(point[key])}`).join(" ");
  const isEmpty = data.every((point) => point.completed === 0 && point.overdue === 0 && point.workload === 0);

  if (isEmpty) {
    return <EmptyPanel title="No trend data yet" description="Completions, overdue work, and new workload will appear as matching tasks change." />;
  }

  const completedArea =
    data.length > 0
      ? `M ${x(0)},${baselineY} ` + data.map((point, index) => `L ${x(index)},${y(point.completed)}`).join(" ") + ` L ${x(data.length - 1)},${baselineY} Z`
      : "";
  const labelSkip = data.length > 12 ? Math.ceil(data.length / 12) : 1;

  return (
    <div className="px-5 pb-5 pt-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[240px] w-full" role="img" aria-label="Task completion, overdue, and workload trend chart">
        <defs>
          <linearGradient id="completedGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--badge-green-fg)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--badge-green-fg)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((tick) => (
          <g key={tick}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={y(max * tick)}
              y2={y(max * tick)}
              stroke="var(--hairline)"
              strokeWidth={tick === 0 ? 1.5 : 1}
            />
            <text x={padding.left - 10} y={y(max * tick) + 3} textAnchor="end" fill="var(--ink-faint)" fontSize="10">
              {formatNumber(Math.round(max * tick))}
            </text>
          </g>
        ))}
        {completedArea && <path d={completedArea} fill="url(#completedGradient)" />}
        <polyline
          points={line("workload")}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="1.7"
          strokeOpacity="0.78"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polyline points={line("overdue")} fill="none" stroke="var(--danger)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points={line("completed")} fill="none" stroke="var(--badge-green-fg)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        {data.map((point, index) => (
          <g key={`trend-point-${point.bucketStart}`}>
            <circle cx={x(index)} cy={y(point.overdue)} r="2.5" fill="var(--danger)">
              <title>{`${point.label} · ${point.overdue} overdue`}</title>
            </circle>
            <circle cx={x(index)} cy={y(point.workload)} r="2.2" fill="var(--primary)">
              <title>{`${point.label} · ${point.workload} new workload`}</title>
            </circle>
            <circle cx={x(index)} cy={y(point.completed)} r="3" fill="var(--badge-green-fg)">
              <title>{`${point.label} · ${point.completed} completed`}</title>
            </circle>
          </g>
        ))}
        {data.map(
          (point, index) =>
            index % labelSkip === 0 && (
              <text key={`trend-label-${point.bucketStart}`} x={x(index)} y={height - 11} textAnchor="middle" fill="var(--ink-faint)" fontSize="10">
                {point.label}
              </text>
            ),
        )}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-[var(--ink-muted)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[var(--badge-green-fg)]" />Completed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[var(--danger)]" />Overdue
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[var(--primary)]" />New workload
        </span>
      </div>
    </div>
  );
}

function BarMeter({ value, max, tone = "accent" }: { value: number; max: number; tone?: "accent" | "success" | "danger" }) {
  const background = tone === "success" ? "var(--badge-green-fg)" : tone === "danger" ? "var(--danger)" : "var(--primary)";
  return (
    <span className="block h-1.5 overflow-hidden rounded-full bg-[var(--surface-muted)]">
      <span
        className="block h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${max > 0 ? Math.max(3, (value / max) * 100) : 0}%`, background }}
      />
    </span>
  );
}

// ------------------------------------------------------------------
// Performance
// ------------------------------------------------------------------

function PerformanceTable({
  rows,
  emptyTitle,
  emptyDescription,
  onSelect,
  selectLabel,
}: {
  rows: PerformanceRow[];
  emptyTitle: string;
  emptyDescription: string;
  onSelect?: (row: PerformanceRow) => void;
  selectLabel?: string;
}) {
  const maxAssigned = Math.max(1, ...rows.map((row) => row.assigned));
  if (!rows.length) return <EmptyPanel title={emptyTitle} description={emptyDescription} />;

  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_72px_54px] gap-3 border-b border-[var(--hairline)] px-5 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-[var(--ink-faint)]">
        <span>Name</span>
        <span className="text-right">Done</span>
        <span className="text-right">Late</span>
      </div>
      <div>
        {rows.map((row) => {
          const content = (
            <>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-[var(--ink)]">{row.name}</span>
                  {row.role && (
                    <Badge className="shrink-0" tone="neutral">
                      {row.role}
                    </Badge>
                  )}
                </div>
                <div className="mt-2 grid max-w-[340px] grid-cols-[1fr_auto] items-center gap-2">
                  <BarMeter value={row.assigned} max={maxAssigned} />
                  <span className="text-[11.5px] tabular-nums text-[var(--ink-faint)]">{formatNumber(row.assigned)} tasks</span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-[13px] font-semibold tabular-nums text-[var(--ink)]">{formatPercent(row.completionRate)}</div>
                <div className="mt-0.5 text-[11.5px] tabular-nums text-[var(--ink-faint)]">{formatNumber(row.completed)} done</div>
              </div>
              <div
                className={cn(
                  "text-right text-[13px] font-medium tabular-nums",
                  row.overdue > 0 ? "text-[var(--danger)]" : "text-[var(--ink-muted)]",
                )}
              >
                {formatNumber(row.overdue)}
              </div>
            </>
          );
          return onSelect ? (
            <button
              key={row.id}
              type="button"
              className="grid w-full grid-cols-[minmax(0,1fr)_72px_54px] items-center gap-3 border-b border-[var(--hairline)] px-5 py-3 text-left transition-colors last:border-b-0 hover:bg-[var(--surface-muted)] focus-visible:bg-[var(--surface-muted)] focus-visible:outline-none"
              onClick={() => onSelect(row)}
              aria-label={`${selectLabel ?? "Filter by"} ${row.name}`}
            >
              {content}
            </button>
          ) : (
            <div
              key={row.id}
              className="grid grid-cols-[minmax(0,1fr)_72px_54px] items-center gap-3 border-b border-[var(--hairline)] px-5 py-3 last:border-b-0"
            >
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Feature panels
// ------------------------------------------------------------------

function AttentionPanel({ data }: { data: DashboardData }) {
  const items = [
    {
      label: "Overdue tasks",
      value: data.metrics.overdueTasks,
      helper: "Open one-time tasks past due",
      tone: data.metrics.overdueTasks > 0 ? ("danger" as const) : ("neutral" as const),
    },
    {
      label: "Missed JD cycles",
      value: data.jdCycleHealth.missedCycles,
      helper: `${formatNumber(data.jdCycleHealth.completedCycles)} completed cycles`,
      tone: data.jdCycleHealth.missedCycles > 0 ? ("danger" as const) : ("neutral" as const),
    },
    {
      label: "Late completions",
      value: data.metrics.lateCompletions,
      helper: `${formatPercent(data.metrics.lateCompletionRate)} late rate`,
      tone: data.metrics.lateCompletions > 0 ? ("danger" as const) : ("neutral" as const),
    },
  ];
  const clean = data.metrics.overdueTasks === 0 && data.jdCycleHealth.missedCycles === 0 && data.metrics.lateCompletions === 0;

  return (
    <DashboardCard>
      <PanelHeader
        title="Attention queue"
        description={clean ? "No overdue or late work in this filtered view." : "Work that should be reviewed before the broader trend."}
        icon={<AlertTriangle className="h-4 w-4" />}
      />
      <div className="grid gap-3 px-5 pb-5 sm:grid-cols-2 md:grid-cols-3">
        {items.map((item) => (
          <MiniMetric key={item.label} label={item.label} value={formatNumber(item.value)} helper={item.helper} tone={item.tone} />
        ))}
      </div>
      {data.role !== "Employee" && (
        <div className="border-t border-[var(--hairline)] px-5 py-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-[12px] font-semibold uppercase tracking-[0.04em] text-[var(--ink-muted)]">People needing review</span>
            <span className="text-[12px] tabular-nums text-[var(--ink-faint)]">{formatNumber(data.comparisons.needsAttention.length)} listed</span>
          </div>
          {data.comparisons.needsAttention.length === 0 ? (
            <p className="py-1 text-[13px] text-[var(--ink-faint)]">
              No scoped employee has overdue work or a low completion rate in this view.
            </p>
          ) : (
            <div className="space-y-1">
              {data.comparisons.needsAttention.slice(0, 6).map((person) => (
                <div
                  key={person.id}
                  className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-[13px] transition-colors hover:bg-[var(--surface-muted)]"
                >
                  <span className="min-w-0 truncate font-medium text-[var(--ink)]">{person.name}</span>
                  <span className="shrink-0 text-[12px] tabular-nums text-[var(--ink-faint)]">
                    {formatPercent(person.completionRate)} done · {formatNumber(person.overdue)} overdue
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </DashboardCard>
  );
}

function WorkloadPanel({ data }: { data: DashboardData }) {
  const open = openTaskCount(data);
  const rows = [
    { label: "Open workload", value: open, total: data.metrics.totalTasks },
    { label: "In progress", value: data.metrics.inProgressTasks, total: open },
    { label: "Not started", value: data.metrics.notStartedTasks, total: open },
    { label: "Completed", value: data.metrics.completedTasks, total: data.metrics.totalTasks, tone: "success" as const },
  ];

  return (
    <DashboardCard className="h-full">
      <PanelHeader title="Workload composition" description="Current task load by state and type." icon={<ListChecks className="h-4 w-4" />} />
      <div className="px-5 pb-5">
        <div className="mb-5 grid grid-cols-2 gap-3">
          <MiniMetric label="One-time" value={formatNumber(data.metrics.oneTimeTasks)} />
          <MiniMetric label="Recurring" value={formatNumber(data.metrics.recurringTasks)} />
        </div>
        <div className="space-y-4">
          {rows.map((row) => (
            <div key={row.label}>
              <div className="mb-1.5 flex items-center justify-between gap-3 text-[12px]">
                <span className="text-[var(--ink-muted)]">{row.label}</span>
                <span className="tabular-nums text-[var(--ink)]">
                  {formatNumber(row.value)} <span className="text-[var(--ink-faint)]">/ {formatNumber(row.total)}</span>
                </span>
              </div>
              <BarMeter value={row.value} max={Math.max(1, row.total)} tone={row.tone ?? "accent"} />
            </div>
          ))}
        </div>
      </div>
    </DashboardCard>
  );
}

function OperatingHealthPanel({ data }: { data: DashboardData }) {
  return (
    <DashboardCard className="h-full">
      <PanelHeader title="Operating health" description="Current completion, cycle reliability, and late one-time work." icon={<Timer className="h-4 w-4" />} />
      <div className="grid gap-3 px-5 pb-5 sm:grid-cols-3">
        <MiniMetric
          label="JD cycle health"
          value={formatPercent(data.jdCycleHealth.healthyRate)}
          helper={`${formatNumber(data.jdCycleHealth.completedCycles)} done · ${formatNumber(data.jdCycleHealth.missedCycles)} missed`}
          tone={data.jdCycleHealth.missedCycles > 0 ? "danger" : "neutral"}
        />
        <MiniMetric
          label="Current completion rate"
          value={formatPercent(data.metrics.completionRate)}
          helper={`${formatNumber(data.metrics.completedTasks)} completed current tasks`}
          tone={data.metrics.completionRate >= 80 ? "success" : data.metrics.completionRate >= 50 ? "neutral" : "danger"}
        />
        <MiniMetric
          label="Late completion rate"
          value={formatPercent(data.metrics.lateCompletionRate)}
          helper={`${formatNumber(data.metrics.lateCompletions)} late one-time completions`}
          tone={data.metrics.lateCompletionRate > 0 ? "danger" : "neutral"}
        />
      </div>
    </DashboardCard>
  );
}

// ------------------------------------------------------------------
// Role dashboards
// ------------------------------------------------------------------

function AdminDashboard({
  data,
  onBranch,
  onDepartment,
  onEmployee,
}: {
  data: DashboardData;
  onBranch: (id: string) => void;
  onDepartment: (id: string, branchId: string | null) => void;
  onEmployee: (id: string) => void;
}) {
  const open = openTaskCount(data);
  return (
    <>
      <Section title="Overview" description="High-level operating numbers for the selected scope.">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            icon={<Users className="h-3.5 w-3.5" />}
            label="People in scope"
            value={formatNumber(data.scope.people)}
            helper={`${formatNumber(data.scope.branches)} branches · ${formatNumber(data.scope.departments)} departments`}
          />
          <MetricCard
            icon={<ListChecks className="h-3.5 w-3.5" />}
            label="Open now"
            value={formatNumber(open)}
            helper={`${formatNumber(data.metrics.totalTasks)} current tasks`}
          />
          <MetricCard
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            label="Completed in period"
            value={formatNumber(data.metrics.periodCompletions)}
            helper={data.range.label}
            tone={data.metrics.periodCompletions > 0 ? "success" : "neutral"}
          />
          <MetricCard
            icon={<AlertTriangle className="h-3.5 w-3.5" />}
            label="Overdue now"
            value={formatNumber(data.metrics.overdueTasks)}
            helper="Open one-time tasks past due"
            tone={data.metrics.overdueTasks > 0 ? "danger" : "neutral"}
          />
        </div>
      </Section>

      <Section title="Attention" description="Risk signals that need a closer look.">
        <AttentionPanel data={data} />
      </Section>

      <Section title="Trends" description="How work is moving over time.">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_400px]">
          <DashboardCard>
            <PanelHeader title="Performance trend" description="Completions, overdue work, and new workload." icon={<TrendingUp className="h-4 w-4" />} />
            <TrendChart data={data.trends} />
          </DashboardCard>
          <WorkloadPanel data={data} />
        </div>
      </Section>

      <Section title="Breakdowns" description="Distribution of work across key dimensions.">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <BreakdownCard title="Status" description="Where tasks stand now." icon={<Target className="h-4 w-4" />} items={data.breakdowns.status} />
          <BreakdownCard title="Task type" description="One-time vs recurring." icon={<ListChecks className="h-4 w-4" />} items={data.breakdowns.type} />
          <BreakdownCard title="Priority" description="Priority mix." icon={<AlertTriangle className="h-4 w-4" />} items={data.breakdowns.priority} />
          <BreakdownCard title="SOP scope" description="Procedure visibility." icon={<FileText className="h-4 w-4" />} items={data.sopStats.byScope} />
        </div>
      </Section>

      <Section title="Detailed performance" description="Drill into branches, departments, or people.">
        <div className="grid gap-4 xl:grid-cols-3">
          <DashboardCard>
            <PanelHeader title="Branch performance" description="Click a branch to filter the dashboard." icon={<Building2 className="h-4 w-4" />} />
            <PerformanceTable
              rows={data.comparisons.branches}
              emptyTitle="No branch data"
              emptyDescription="Assign people to branches and tasks to see branch performance."
              onSelect={(row) => onBranch(row.id)}
              selectLabel="Drill into branch"
            />
          </DashboardCard>
          <DashboardCard>
            <PanelHeader title="Department performance" description="Compare departments inside the selected scope." icon={<Layers className="h-4 w-4" />} />
            <PerformanceTable
              rows={data.comparisons.departments}
              emptyTitle="No department data"
              emptyDescription="Department performance appears when scoped assignees have department assignments."
              onSelect={(row) => onDepartment(row.id, row.parentId ?? null)}
              selectLabel="Drill into department"
            />
          </DashboardCard>
          <DashboardCard>
            <PanelHeader title="Employee workload" description="Completion rate, assigned load, and overdue count." icon={<Users className="h-4 w-4" />} />
            <PerformanceTable
              rows={data.comparisons.employees}
              emptyTitle="No employee data"
              emptyDescription="Employee workload appears when tasks match the selected filters."
              onSelect={(row) => onEmployee(row.id)}
              selectLabel="Filter by employee"
            />
          </DashboardCard>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <DashboardCard>
            <PanelHeader title="Top performers" description="Highest completion rates for matching work." icon={<Trophy className="h-4 w-4" />} />
            <PerformanceTable
              rows={data.comparisons.topPerformers}
              emptyTitle="No performers yet"
              emptyDescription="Completed scoped work will populate this list."
            />
          </DashboardCard>
          <OperatingHealthPanel data={data} />
        </div>
      </Section>
    </>
  );
}

function ManagerDashboard({
  data,
  onBranch,
  onDepartment,
  onEmployee,
}: {
  data: DashboardData;
  onBranch: (id: string) => void;
  onDepartment: (id: string, branchId: string | null) => void;
  onEmployee: (id: string) => void;
}) {
  const open = openTaskCount(data);
  return (
    <>
      <Section title="Overview" description="High-level operating numbers for your managed scope.">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            icon={<Users className="h-3.5 w-3.5" />}
            label="People in scope"
            value={formatNumber(data.scope.people)}
            helper={`${formatNumber(data.scope.branches)} branches · ${formatNumber(data.scope.departments)} departments`}
          />
          <MetricCard icon={<ListChecks className="h-3.5 w-3.5" />} label="Open now" value={formatNumber(open)} helper={`${formatNumber(data.metrics.totalTasks)} current tasks`} />
          <MetricCard
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            label="Completed in period"
            value={formatNumber(data.metrics.periodCompletions)}
            helper={data.range.label}
            tone={data.metrics.periodCompletions > 0 ? "success" : "neutral"}
          />
          <MetricCard
            icon={<AlertTriangle className="h-3.5 w-3.5" />}
            label="Overdue now"
            value={formatNumber(data.metrics.overdueTasks)}
            helper="Open one-time tasks past due"
            tone={data.metrics.overdueTasks > 0 ? "danger" : "neutral"}
          />
        </div>
      </Section>

      <Section title="Attention" description="Risk signals that need a closer look.">
        <AttentionPanel data={data} />
      </Section>

      <Section title="Trends" description="How work is moving over time.">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_400px]">
          <DashboardCard>
            <PanelHeader title="Managed trend" description="Completions, overdue work, and new workload." icon={<TrendingUp className="h-4 w-4" />} />
            <TrendChart data={data.trends} />
          </DashboardCard>
          <WorkloadPanel data={data} />
        </div>
      </Section>

      <Section title="Breakdowns" description="Distribution of work across key dimensions.">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <BreakdownCard title="Status" description="Where scoped tasks stand." icon={<Target className="h-4 w-4" />} items={data.breakdowns.status} />
          <BreakdownCard title="Task type" description="One-time vs recurring." icon={<ListChecks className="h-4 w-4" />} items={data.breakdowns.type} />
          <BreakdownCard title="Priority" description="Priority mix." icon={<AlertTriangle className="h-4 w-4" />} items={data.breakdowns.priority} />
          <BreakdownCard title="SOPs in scope" description="Procedure visibility." icon={<FileText className="h-4 w-4" />} items={data.sopStats.byScope} />
        </div>
      </Section>

      <Section title="Detailed performance" description="Drill into your branches, departments, or team.">
        <div className="grid gap-4 xl:grid-cols-3">
          <DashboardCard>
            <PanelHeader title="Branches you manage" icon={<Building2 className="h-4 w-4" />} />
            <PerformanceTable
              rows={data.comparisons.branches}
              emptyTitle="No branch data"
              emptyDescription="Your managed branches do not have matching task data yet."
              onSelect={(row) => onBranch(row.id)}
              selectLabel="Drill into branch"
            />
          </DashboardCard>
          <DashboardCard>
            <PanelHeader title="Departments you manage" icon={<Layers className="h-4 w-4" />} />
            <PerformanceTable
              rows={data.comparisons.departments}
              emptyTitle="No department data"
              emptyDescription="Your managed departments do not have matching task data yet."
              onSelect={(row) => onDepartment(row.id, row.parentId ?? null)}
              selectLabel="Drill into department"
            />
          </DashboardCard>
          <DashboardCard>
            <PanelHeader title="Team workload" icon={<Users className="h-4 w-4" />} />
            <PerformanceTable
              rows={data.comparisons.employees}
              emptyTitle="No team data"
              emptyDescription="People in your scope do not have matching tasks yet."
              onSelect={(row) => onEmployee(row.id)}
              selectLabel="Filter by employee"
            />
          </DashboardCard>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <DashboardCard>
            <PanelHeader title="Strongest performers" icon={<Trophy className="h-4 w-4" />} />
            <PerformanceTable
              rows={data.comparisons.topPerformers}
              emptyTitle="No performers yet"
              emptyDescription="Completed scoped work will populate this list."
            />
          </DashboardCard>
          <OperatingHealthPanel data={data} />
        </div>
      </Section>
    </>
  );
}

function EmployeeDashboard({ data }: { data: DashboardData }) {
  const currentWorkload = openTaskCount(data);
  return (
    <>
      <Section title="Overview" description="Your workload at a glance.">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            icon={<ListChecks className="h-3.5 w-3.5" />}
            label="Open now"
            value={formatNumber(currentWorkload)}
            helper={`${formatNumber(data.metrics.totalTasks)} current tasks`}
          />
          <MetricCard
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            label="Completed in period"
            value={formatNumber(data.metrics.periodCompletions)}
            helper={data.range.label}
            tone={data.metrics.periodCompletions > 0 ? "success" : "neutral"}
          />
          <MetricCard
            icon={<AlertTriangle className="h-3.5 w-3.5" />}
            label="Overdue now"
            value={formatNumber(data.metrics.overdueTasks)}
            helper="Open one-time tasks past due"
            tone={data.metrics.overdueTasks > 0 ? "danger" : "neutral"}
          />
          <MetricCard
            icon={<FileText className="h-3.5 w-3.5" />}
            label="Visible SOPs"
            value={formatNumber(data.sopStats.visible)}
            helper="Assigned procedures visible to you"
          />
        </div>
      </Section>

      <Section title="Attention" description="Your work that needs a closer look.">
        <AttentionPanel data={data} />
      </Section>

      <Section title="Trends" description="How your work is moving over time.">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_400px]">
          <DashboardCard>
            <PanelHeader title="My progress over time" description="Completions, overdue work, and new workload." icon={<TrendingUp className="h-4 w-4" />} />
            <TrendChart data={data.trends} />
          </DashboardCard>
          <WorkloadPanel data={data} />
        </div>
      </Section>

      <Section title="Breakdowns" description="Distribution of your work across key dimensions.">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <BreakdownCard title="My status" description="Where my tasks stand." icon={<Target className="h-4 w-4" />} items={data.breakdowns.status} />
          <BreakdownCard title="Task type" description="One-time vs recurring." icon={<ListChecks className="h-4 w-4" />} items={data.breakdowns.type} />
          <BreakdownCard title="Priority" description="Priority mix." icon={<AlertTriangle className="h-4 w-4" />} items={data.breakdowns.priority} />
          <BreakdownCard title="Recurring work" description="Frequency mix." icon={<Timer className="h-4 w-4" />} items={data.breakdowns.frequency} />
        </div>
      </Section>

      <Section title="Performance details" description="Cycle health and completion timing.">
        <OperatingHealthPanel data={data} />
      </Section>
    </>
  );
}

// ------------------------------------------------------------------
// Loading & empty states
// ------------------------------------------------------------------

function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn("rounded-lg bg-[var(--surface-muted)]", className)} />;
}

function DashboardSkeleton() {
  return (
    <div className="app-page">
      <div className="page-header">
        <div className="min-w-0">
          <SkeletonBlock className="mb-2 h-3.5 w-28" />
          <SkeletonBlock className="h-7 w-56" />
          <SkeletonBlock className="mt-2.5 h-4 w-[420px] max-w-full" />
        </div>
        <SkeletonBlock className="h-6 w-24 rounded-sm" />
      </div>

      <SkeletonBlock className="mb-6 h-[58px] rounded-2xl" />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-[124px] rounded-2xl" />
        ))}
      </div>

      <SkeletonBlock className="mt-8 h-[180px] rounded-2xl" />

      <div className="mt-8 grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_400px]">
        <SkeletonBlock className="h-[340px] rounded-2xl" />
        <SkeletonBlock className="h-[340px] rounded-2xl" />
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-[220px] rounded-2xl" />
        ))}
      </div>

      <div className="mt-8 grid gap-4 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-[260px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

function PermissionDenied() {
  return (
    <div className="app-page">
      <PageHeader title="Dashboard" description="Dashboard access is disabled for your user." />
      <Card className="p-5 text-sm text-[var(--ink-muted)]">Ask an admin to enable dashboard analytics if you need access.</Card>
    </div>
  );
}

function DashboardError({ message }: { message: string }) {
  return (
    <div className="app-page">
      <PageHeader title="Dashboard" description="We could not load this analytics view." />
      <div role="alert">
        <Card className="alert-error p-4 text-sm">{message}</Card>
      </div>
    </div>
  );
}

function pageDescription(data: DashboardData | null) {
  if (!data) return "Role-aware analytics for your current company.";
  if (data.role === "Admin") return "A calm operating view across people, work, teams, SOPs, timing, and risk.";
  if (data.role === "Manager") return "Performance analytics for the branches, departments, and people inside your managed scope.";
  return "Your workload, due work, recurring cycles, and SOP visibility in one focused view.";
}

// ------------------------------------------------------------------
// Page
// ------------------------------------------------------------------

export function DashboardPage() {
  const { activeCompanyId, active } = useCompany();
  const canViewActiveDashboard = canViewDashboard(active?.capabilities);
  const [datePreset, setDatePreset] = useState<DatePreset>("30d");
  const [taskType, setTaskType] = useState<TaskTypeFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [priority, setPriority] = useState<PriorityFilter>("all");
  const [frequency, setFrequency] = useState<FrequencyFilter>("all");
  const [branchId, setBranchId] = useState("all");
  const [departmentId, setDepartmentId] = useState("all");
  const [membershipId, setMembershipId] = useState("all");
  const [scopeData, setScopeData] = useState<DashboardData | null>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    setDatePreset("30d");
    setTaskType("all");
    setStatus("all");
    setPriority("all");
    setFrequency("all");
    setBranchId("all");
    setDepartmentId("all");
    setMembershipId("all");
  }, [activeCompanyId]);

  const scopeDataForActiveCompany = scopeData?.company._id === activeCompanyId ? scopeData : null;
  const canUseScopeFilters = Boolean(
    active?.capabilities.some((capability) => capability === "analytics:view:company" || capability === "analytics:view:managed_scope"),
  );
  const validBranchId =
    canUseScopeFilters && scopeDataForActiveCompany && branchId !== "all" && scopeDataForActiveCompany.filterOptions.branches.some((branch) => branch._id === branchId)
      ? (branchId as Id<"branches">)
      : undefined;
  const validDepartmentId =
    canUseScopeFilters && scopeDataForActiveCompany && departmentId !== "all" && scopeDataForActiveCompany.filterOptions.departments.some(
      (department) => department._id === departmentId && (!validBranchId || department.branchId === validBranchId),
    )
      ? (departmentId as Id<"departments">)
      : undefined;
  const validMembershipId =
    canUseScopeFilters && scopeDataForActiveCompany && membershipId !== "all" && scopeDataForActiveCompany.filterOptions.employees.some(
      (employee) =>
        employee._id === membershipId &&
        (!validBranchId || employee.branchIds.includes(validBranchId)) &&
        (!validDepartmentId || employee.departmentIds.includes(validDepartmentId)),
    )
      ? (membershipId as Id<"companyMemberships">)
      : undefined;

  const queryArgs =
    activeCompanyId && canViewActiveDashboard
      ? {
          companyId: activeCompanyId,
          datePreset,
          taskType,
          status,
          priority,
          frequency,
          branchId: validBranchId,
          departmentId: validDepartmentId,
          membershipId: validMembershipId,
        }
      : "skip";
  const result = useQuery_experimental({ query: api.analytics.dashboard, args: queryArgs });
  const data = result.status === "success" ? (result.data as DashboardData) : null;

  useEffect(() => {
    if (data) setScopeData(data);
  }, [data]);

  useEffect(() => {
    if (!data) return;
    if (branchId !== "all" && !data.filterOptions.branches.some((branch) => branch._id === branchId)) setBranchId("all");
    if (departmentId !== "all" && !data.filterOptions.departments.some((department) => department._id === departmentId)) setDepartmentId("all");
    if (membershipId !== "all" && !data.filterOptions.employees.some((employee) => employee._id === membershipId)) setMembershipId("all");
  }, [branchId, data, departmentId, membershipId]);

  function resetFilters() {
    setDatePreset("30d");
    setTaskType("all");
    setStatus("all");
    setPriority("all");
    setFrequency("all");
    setBranchId("all");
    setDepartmentId("all");
    setMembershipId("all");
  }

  if (!canViewActiveDashboard) return <PermissionDenied />;
  if (result.status === "error") return <DashboardError message={result.error instanceof Error ? result.error.message : "Analytics could not be loaded."} />;
  if (result.status === "pending" || !data) return <DashboardSkeleton />;

  return (
    <motion.div
      className="app-page"
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
    >
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="h-3.5 w-3.5" />
            {data.range.label}
          </span>
        }
        title={data.role === "Admin" ? "Admin Dashboard" : data.role === "Manager" ? "Manager Dashboard" : "My Dashboard"}
        description={pageDescription(data)}
        actions={<Badge tone="neutral">{data.viewer.role}</Badge>}
      />

      <FilterBar
        data={data}
        datePreset={datePreset}
        taskType={taskType}
        status={status}
        priority={priority}
        frequency={frequency}
        branchId={branchId}
        departmentId={departmentId}
        membershipId={membershipId}
        onDatePreset={setDatePreset}
        onTaskType={setTaskType}
        onStatus={setStatus}
        onPriority={setPriority}
        onFrequency={setFrequency}
        onBranch={setBranchId}
        onDepartment={setDepartmentId}
        onMembership={setMembershipId}
        onReset={resetFilters}
      />

      {data.metrics.totalTasks === 0 && (
        <div className="mb-6 flex items-start gap-2.5 rounded-xl border border-[var(--hairline)] bg-[var(--surface)] px-4 py-3 text-[13px] text-[var(--ink-muted)]">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
          <span>No tasks match the selected filters. Charts and comparisons will populate as matching work is created, due, or completed.</span>
        </div>
      )}

      {data.role === "Admin" && (
        <AdminDashboard
          data={data}
          onBranch={(id) => {
            setBranchId(id);
            setDepartmentId("all");
            setMembershipId("all");
          }}
          onDepartment={(id, parentId) => {
            if (parentId) setBranchId(parentId);
            setDepartmentId(id);
            setMembershipId("all");
          }}
          onEmployee={setMembershipId}
        />
      )}
      {data.role === "Manager" && (
        <ManagerDashboard
          data={data}
          onBranch={(id) => {
            setBranchId(id);
            setDepartmentId("all");
            setMembershipId("all");
          }}
          onDepartment={(id, parentId) => {
            if (parentId) setBranchId(parentId);
            setDepartmentId(id);
            setMembershipId("all");
          }}
          onEmployee={setMembershipId}
        />
      )}
      {data.role === "Employee" && <EmployeeDashboard data={data} />}
    </motion.div>
  );
}
