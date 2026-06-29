"use client";

import { useQuery_experimental } from "convex/react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Building2,
  CalendarDays,
  CheckCircle2,
  Clock,
  FileText,
  Filter,
  Layers,
  ListChecks,
  RotateCcw,
  Target,
  Timer,
  TrendingUp,
  Trophy,
  Users,
} from "lucide-react";
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
type TrendPoint = { label: string; completed: number; overdue: number; workload: number };
type PerformanceRow = {
  id: string;
  name: string;
  firstName?: string;
  role?: string;
  parentId?: string | null;
  assigned: number;
  completed: number;
  overdue: number;
  dueSoon?: number;
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
    notStartedTasks: number;
    inProgressTasks: number;
    overdueTasks: number;
    dueSoonTasks: number;
    oneTimeTasks: number;
    recurringTasks: number;
    averageCompletionMs: number | null;
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

function formatDuration(ms: number | null) {
  if (ms === null) return "Not enough data";
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatRelative(ms: number) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(ms));
}

function statusTone(key: string) {
  if (key === "completed") return "bg-[var(--badge-green-fg)]";
  if (key === "in_progress") return "bg-[var(--badge-blue-fg)]";
  if (key === "overdue") return "bg-[var(--badge-red-fg)]";
  return "bg-[var(--badge-neutral-fg)]";
}

function StatCard({
  icon,
  label,
  value,
  helper,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  helper?: React.ReactNode;
  tone?: "neutral" | "good" | "warn" | "danger";
}) {
  const toneClass = tone === "good" ? "text-[var(--badge-green-fg)]" : tone === "warn" ? "text-[var(--badge-yellow-fg)]" : tone === "danger" ? "text-[var(--danger)]" : "text-[var(--ink-muted)]";
  return (
    <Card className="group p-3 transition-colors hover:bg-[var(--canvas-soft)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-[var(--ink-muted)]">{label}</div>
          <div className="mt-1 text-2xl font-semibold leading-tight tracking-[-0.02em] text-[var(--ink)]">{value}</div>
        </div>
        <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[var(--surface-muted)] transition-colors group-hover:bg-[var(--surface-pressed)]", toneClass)}>
          {icon}
        </span>
      </div>
      {helper && <div className="mt-2 min-h-4 text-[12px] leading-4 text-[var(--ink-faint)]">{helper}</div>}
    </Card>
  );
}

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
      <SelectTrigger aria-label={label} className={cn("h-8 w-[150px] bg-[var(--surface)] text-[13px]", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
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
  const branchOptions = useMemo(() => [{ value: "all", label: "All branches" }, ...(data?.filterOptions.branches ?? []).map((branch) => ({ value: branch._id, label: branch.name }))], [data]);
  const departmentOptions = useMemo(() => {
    const departments = (data?.filterOptions.departments ?? []).filter((department) => branchId === "all" || department.branchId === branchId);
    return [{ value: "all", label: "All departments" }, ...departments.map((department) => ({ value: department._id, label: department.name }))];
  }, [branchId, data]);
  const employeeOptions = useMemo(() => {
    const employees = (data?.filterOptions.employees ?? []).filter((employee) => {
      if (branchId !== "all" && !employee.branchIds.includes(branchId)) return false;
      if (departmentId !== "all" && !employee.departmentIds.includes(departmentId)) return false;
      return true;
    });
    return [{ value: "all", label: "All people" }, ...employees.map((employee) => ({ value: employee._id, label: employee.name }))];
  }, [branchId, data, departmentId]);
  const activeFilterCount = [datePreset !== "30d", taskType !== "all", status !== "all", priority !== "all", frequency !== "all", branchId !== "all", departmentId !== "all", membershipId !== "all"].filter(Boolean).length;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-[var(--hairline)] pb-3">
      <div className="inline-flex h-8 items-center gap-2 rounded-md bg-[var(--surface-muted)] px-2 text-[12.5px] font-medium text-[var(--ink-muted)]">
        <Filter className="h-3.5 w-3.5" />
        Filters
      </div>
      <DashboardSelect label="Date range" value={datePreset} options={dateOptions} onChange={onDatePreset} className="w-[122px]" />
      {showScopeFilters && (
        <>
          <DashboardSelect label="Branch filter" value={branchId} options={branchOptions} onChange={(value) => { onBranch(value); onDepartment("all"); onMembership("all"); }} className="w-[156px]" />
          <DashboardSelect label="Department filter" value={departmentId} options={departmentOptions} onChange={(value) => { onDepartment(value); onMembership("all"); }} className="w-[172px]" disabled={departmentOptions.length <= 1} />
          <DashboardSelect label="Employee filter" value={membershipId} options={employeeOptions} onChange={onMembership} className="w-[172px]" disabled={employeeOptions.length <= 1} />
        </>
      )}
      <DashboardSelect label="Task type filter" value={taskType} options={taskTypeOptions} onChange={onTaskType} className="w-[144px]" />
      <DashboardSelect label="Status filter" value={status} options={statusOptions} onChange={onStatus} className="w-[144px]" />
      <DashboardSelect label="Priority filter" value={priority} options={priorityOptions} onChange={onPriority} className="w-[142px]" />
      <DashboardSelect label="Frequency filter" value={frequency} options={frequencyOptions} onChange={onFrequency} className="w-[154px]" />
      <Button className="ml-auto" size="sm" variant="ghost" onClick={onReset} disabled={activeFilterCount === 0}>
        <RotateCcw className="h-3.5 w-3.5" />
        Reset
        {activeFilterCount > 0 && <span className="ml-0.5 text-[var(--ink-faint)]">{activeFilterCount}</span>}
      </Button>
    </div>
  );
}

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-[180px] flex-col items-center justify-center px-5 py-8 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--surface-muted)] text-[var(--ink-faint)]"><BarChart3 className="h-5 w-5" /></span>
      <div className="mt-3 text-sm font-semibold text-[var(--ink)]">{title}</div>
      <p className="mt-1 max-w-[320px] text-[13px] text-[var(--ink-muted)]">{description}</p>
    </div>
  );
}

function Panel({ title, icon, actions, children, className }: { title: string; icon?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-[var(--hairline)] px-3 py-2">
        <h2 className="inline-flex min-w-0 items-center gap-2 text-[13px] font-semibold text-[var(--ink)]">
          {icon && <span className="text-[var(--ink-faint)]">{icon}</span>}
          <span className="truncate">{title}</span>
        </h2>
        {actions}
      </div>
      {children}
    </Card>
  );
}

function SegmentBar({ items }: { items: BreakdownItem[] }) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) return <div className="h-2 rounded-full bg-[var(--surface-muted)]" />;
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-[var(--surface-muted)]" aria-hidden="true">
      {items.filter((item) => item.value > 0).map((item) => (
        <span key={item.key} className={statusTone(item.key)} style={{ width: `${Math.max(4, (item.value / total) * 100)}%` }} />
      ))}
    </div>
  );
}

function BreakdownPanel({ title, items, icon }: { title: string; items: BreakdownItem[]; icon: React.ReactNode }) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return (
    <Panel title={title} icon={icon}>
      <div className="p-3">
        <SegmentBar items={items} />
        <div className="mt-3 space-y-2">
          {items.map((item) => (
            <div key={item.key} className="flex items-center gap-2 text-[13px]">
              <span className={cn("h-2 w-2 rounded-full", statusTone(item.key))} />
              <span className="min-w-0 flex-1 truncate text-[var(--ink-secondary)]">{item.label}</span>
              <span className="font-medium tabular-nums text-[var(--ink)]">{formatNumber(item.value)}</span>
              <span className="w-9 text-right text-[12px] tabular-nums text-[var(--ink-faint)]">{total ? formatPercent(safePercent(item.value, total)) : "0%"}</span>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function safePercent(part: number, total: number) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function TrendChart({ data }: { data: TrendPoint[] }) {
  const width = 640;
  const height = 210;
  const padding = { top: 16, right: 18, bottom: 28, left: 30 };
  const max = Math.max(1, ...data.flatMap((point) => [point.completed, point.overdue, point.workload]));
  const x = (index: number) => padding.left + (index / Math.max(1, data.length - 1)) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + (1 - value / max) * (height - padding.top - padding.bottom);
  const line = (key: keyof TrendPoint) => data.map((point, index) => `${x(index)},${y(Number(point[key]))}`).join(" ");
  const isEmpty = data.every((point) => point.completed === 0 && point.overdue === 0 && point.workload === 0);
  if (isEmpty) return <EmptyPanel title="No trend data yet" description="Completions, overdue work, and new workload will appear here as tasks move through the selected window." />;

  return (
    <div className="p-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[230px] w-full" role="img" aria-label="Task completion, overdue, and workload trend chart">
        {[0, 0.5, 1].map((tick) => (
          <line key={tick} x1={padding.left} x2={width - padding.right} y1={y(max * tick)} y2={y(max * tick)} stroke="var(--hairline)" />
        ))}
        <polyline points={line("workload")} fill="none" stroke="var(--ink-faint)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points={line("completed")} fill="none" stroke="var(--badge-green-fg)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points={line("overdue")} fill="none" stroke="var(--badge-red-fg)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {data.map((point, index) => (
          <g key={point.label}>
            <text x={x(index)} y={height - 8} textAnchor="middle" fill="var(--ink-faint)" fontSize="11">{point.label}</text>
          </g>
        ))}
      </svg>
      <div className="flex flex-wrap gap-3 px-1 text-[12px] text-[var(--ink-muted)]">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[var(--badge-green-fg)]" />Completed</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[var(--badge-red-fg)]" />Overdue / missed</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[var(--ink-faint)]" />New workload</span>
      </div>
    </div>
  );
}

function BarMeter({ value, max, tone = "neutral" }: { value: number; max: number; tone?: "neutral" | "good" | "danger" }) {
  const color = tone === "good" ? "bg-[var(--badge-green-fg)]" : tone === "danger" ? "bg-[var(--badge-red-fg)]" : "bg-[var(--primary)]";
  return (
    <span className="block h-1.5 overflow-hidden rounded-full bg-[var(--surface-muted)]">
      <span className={cn("block h-full rounded-full", color)} style={{ width: `${max > 0 ? Math.max(3, (value / max) * 100) : 0}%` }} />
    </span>
  );
}

function PerformanceList({
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
    <div className="divide-y divide-[var(--hairline)]">
      {rows.map((row) => {
        const content = (
          <>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[13px] font-medium text-[var(--ink)]">{row.name}</span>
                {row.role && <Badge className="shrink-0" tone="neutral">{row.role}</Badge>}
              </div>
              <div className="mt-1 grid max-w-[320px] grid-cols-[1fr_auto] items-center gap-2">
                <BarMeter value={row.assigned} max={maxAssigned} />
                <span className="text-[11.5px] tabular-nums text-[var(--ink-faint)]">{formatNumber(row.assigned)} tasks</span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[13px] font-semibold tabular-nums text-[var(--ink)]">{formatPercent(row.completionRate)}</div>
              <div className="mt-0.5 text-[11.5px] text-[var(--ink-faint)]">{formatNumber(row.completed)} done</div>
            </div>
            <div className={cn("text-right text-[13px] font-medium tabular-nums", row.overdue > 0 ? "text-[var(--danger)]" : "text-[var(--ink-muted)]")}>{formatNumber(row.overdue)}</div>
          </>
        );
        return onSelect ? (
          <button key={row.id} type="button" className="grid w-full grid-cols-[minmax(0,1fr)_70px_46px] items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--canvas-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" onClick={() => onSelect(row)} aria-label={`${selectLabel ?? "Filter by"} ${row.name}`}>
            {content}
          </button>
        ) : (
          <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_70px_46px] items-center gap-3 px-3 py-2.5">
            {content}
          </div>
        );
      })}
    </div>
  );
}

function InsightStrip({ data }: { data: DashboardData }) {
  const insights = [
    data.metrics.overdueTasks > 0 ? { label: "Overdue work", value: `${formatNumber(data.metrics.overdueTasks)} task${data.metrics.overdueTasks === 1 ? "" : "s"} need attention`, tone: "danger" as const } : null,
    data.metrics.dueSoonTasks > 0 ? { label: "Due soon", value: `${formatNumber(data.metrics.dueSoonTasks)} task${data.metrics.dueSoonTasks === 1 ? "" : "s"} due in 48h`, tone: "warn" as const } : null,
    data.jdCycleHealth.missedCycles > 0 ? { label: "Recurring cycles", value: `${formatNumber(data.jdCycleHealth.missedCycles)} missed cycle${data.jdCycleHealth.missedCycles === 1 ? "" : "s"}`, tone: "warn" as const } : null,
    data.metrics.totalTasks > 0 && data.metrics.completionRate >= 85 ? { label: "Completion", value: `${formatPercent(data.metrics.completionRate)} completion rate`, tone: "good" as const } : null,
  ].filter(Boolean) as { label: string; value: string; tone: "danger" | "warn" | "good" }[];

  if (!insights.length) {
    return (
      <div className="mb-4 rounded-md border border-[var(--hairline)] bg-[var(--canvas-soft)] px-3 py-2 text-[13px] text-[var(--ink-muted)]">
        No urgent dashboard flags for the selected scope.
      </div>
    );
  }

  return (
    <div className="mb-4 grid gap-2 md:grid-cols-3">
      {insights.slice(0, 3).map((insight) => (
        <div key={insight.label} className="rounded-md border border-[var(--hairline)] bg-[var(--canvas-soft)] px-3 py-2">
          <div className="text-[11.5px] font-medium uppercase tracking-[0.02em] text-[var(--ink-faint)]">{insight.label}</div>
          <div className={cn("mt-0.5 text-[13px] font-medium", insight.tone === "danger" ? "text-[var(--danger)]" : insight.tone === "warn" ? "text-[var(--badge-yellow-fg)]" : "text-[var(--badge-green-fg)]")}>{insight.value}</div>
        </div>
      ))}
    </div>
  );
}

function RecentPanel({ data }: { data: DashboardData }) {
  return (
    <Panel title="Recent activity" icon={<Activity className="h-4 w-4" />}>
      {data.recent.completions.length === 0 && data.recent.audit.length === 0 ? (
        <EmptyPanel title="No recent activity" description="Task completions and dashboard-relevant activity will appear here when they happen." />
      ) : (
        <div className="divide-y divide-[var(--hairline)]">
          {data.recent.completions.map((event) => (
            <div key={event.id} className="grid gap-2 px-3 py-2.5 text-[13px] md:grid-cols-[110px_minmax(0,1fr)_130px] md:items-center">
              <Badge tone={event.kind === "jd" ? "blue" : "green"}>{event.kind === "jd" ? "JD done" : "Task done"}</Badge>
              <div className="min-w-0">
                <div className="truncate font-medium text-[var(--ink)]">{event.title}</div>
                {event.actorName && data.role !== "Employee" && <div className="text-[12px] text-[var(--ink-faint)]">Completed by {event.actorName}</div>}
              </div>
              <div className="text-[12px] text-[var(--ink-muted)] md:text-right">{formatRelative(event.completedAt)}</div>
            </div>
          ))}
          {data.recent.audit.map((event) => (
            <div key={event.id} className="grid gap-2 px-3 py-2.5 text-[13px] md:grid-cols-[110px_minmax(0,1fr)_130px] md:items-center">
              <Badge tone="neutral">{event.action}</Badge>
              <div className="truncate text-[var(--ink-secondary)]">{event.targetType}</div>
              <div className="text-[12px] text-[var(--ink-muted)] md:text-right">{formatRelative(event.createdAt)}</div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function AdminDashboard({ data, onBranch, onDepartment, onEmployee }: { data: DashboardData; onBranch: (id: string) => void; onDepartment: (id: string, branchId: string | null) => void; onEmployee: (id: string) => void }) {
  return (
    <>
      <InsightStrip data={data} />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={<ListChecks className="h-4 w-4" />} label="Total tasks assigned" value={formatNumber(data.metrics.totalTasks)} helper={`${formatNumber(data.metrics.oneTimeTasks)} one-time, ${formatNumber(data.metrics.recurringTasks)} recurring`} />
        <StatCard icon={<CheckCircle2 className="h-4 w-4" />} label="Completion rate" value={formatPercent(data.metrics.completionRate)} helper={`${formatNumber(data.metrics.completedTasks)} completed`} tone={data.metrics.completionRate >= 80 ? "good" : "neutral"} />
        <StatCard icon={<AlertTriangle className="h-4 w-4" />} label="Overdue tasks" value={formatNumber(data.metrics.overdueTasks)} helper={`${formatNumber(data.metrics.dueSoonTasks)} due soon`} tone={data.metrics.overdueTasks > 0 ? "danger" : "neutral"} />
        <StatCard icon={<FileText className="h-4 w-4" />} label="Visible SOPs" value={formatNumber(data.sopStats.visible)} helper="Compliance tracking is not in the schema yet" />
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_360px]">
        <Panel title="Performance trend" icon={<TrendingUp className="h-4 w-4" />}><TrendChart data={data.trends} /></Panel>
        <BreakdownPanel title="Status breakdown" icon={<Target className="h-4 w-4" />} items={data.breakdowns.status} />
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-3">
        <Panel title="Branch performance" icon={<Building2 className="h-4 w-4" />}>
          <PerformanceList rows={data.comparisons.branches} emptyTitle="No branch data" emptyDescription="Assign people to branches and tasks to see branch performance." onSelect={(row) => onBranch(row.id)} selectLabel="Drill into branch" />
        </Panel>
        <Panel title="Department performance" icon={<Layers className="h-4 w-4" />}>
          <PerformanceList rows={data.comparisons.departments} emptyTitle="No department data" emptyDescription="Department performance appears when scoped assignees have department assignments." onSelect={(row) => onDepartment(row.id, row.parentId ?? null)} selectLabel="Drill into department" />
        </Panel>
        <Panel title="Employee workload" icon={<Users className="h-4 w-4" />}>
          <PerformanceList rows={data.comparisons.employees} emptyTitle="No employee data" emptyDescription="Employee workload appears when tasks match the selected filters." onSelect={(row) => onEmployee(row.id)} selectLabel="Filter by employee" />
        </Panel>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Panel title="Top performers" icon={<Trophy className="h-4 w-4" />}>
          <PerformanceList rows={data.comparisons.topPerformers} emptyTitle="No performers yet" emptyDescription="Completed scoped work will populate this list." />
        </Panel>
        <Panel title="Needs attention" icon={<AlertTriangle className="h-4 w-4" />}>
          <PerformanceList rows={data.comparisons.needsAttention} emptyTitle="No attention list" emptyDescription="No one has overdue work or a low completion rate in this view." />
        </Panel>
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[360px_minmax(0,1fr)]">
        <BreakdownPanel title="SOP scope" icon={<FileText className="h-4 w-4" />} items={data.sopStats.byScope} />
        <RecentPanel data={data} />
      </div>
    </>
  );
}

function ManagerDashboard({ data, onBranch, onDepartment, onEmployee }: { data: DashboardData; onBranch: (id: string) => void; onDepartment: (id: string, branchId: string | null) => void; onEmployee: (id: string) => void }) {
  return (
    <>
      <InsightStrip data={data} />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={<Users className="h-4 w-4" />} label="People in scope" value={formatNumber(data.scope.people)} helper={`${formatNumber(data.scope.branches)} branches, ${formatNumber(data.scope.departments)} departments`} />
        <StatCard icon={<ListChecks className="h-4 w-4" />} label="Scoped tasks" value={formatNumber(data.metrics.totalTasks)} helper={`${formatNumber(data.metrics.inProgressTasks)} in progress`} />
        <StatCard icon={<CheckCircle2 className="h-4 w-4" />} label="Completion rate" value={formatPercent(data.metrics.completionRate)} helper={`${formatNumber(data.metrics.completedTasks)} completed`} tone={data.metrics.completionRate >= 80 ? "good" : "neutral"} />
        <StatCard icon={<AlertTriangle className="h-4 w-4" />} label="Overdue" value={formatNumber(data.metrics.overdueTasks)} helper={`${formatNumber(data.metrics.dueSoonTasks)} due soon`} tone={data.metrics.overdueTasks > 0 ? "danger" : "neutral"} />
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_360px]">
        <Panel title="Managed trend" icon={<TrendingUp className="h-4 w-4" />}><TrendChart data={data.trends} /></Panel>
        <BreakdownPanel title="Status breakdown" icon={<Target className="h-4 w-4" />} items={data.breakdowns.status} />
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-3">
        <Panel title="Branches you manage" icon={<Building2 className="h-4 w-4" />}>
          <PerformanceList rows={data.comparisons.branches} emptyTitle="No branch data" emptyDescription="Your managed branches do not have matching task data yet." onSelect={(row) => onBranch(row.id)} selectLabel="Drill into branch" />
        </Panel>
        <Panel title="Departments you manage" icon={<Layers className="h-4 w-4" />}>
          <PerformanceList rows={data.comparisons.departments} emptyTitle="No department data" emptyDescription="Your managed departments do not have matching task data yet." onSelect={(row) => onDepartment(row.id, row.parentId ?? null)} selectLabel="Drill into department" />
        </Panel>
        <Panel title="Team workload" icon={<Users className="h-4 w-4" />}>
          <PerformanceList rows={data.comparisons.employees} emptyTitle="No team data" emptyDescription="People in your scope do not have matching tasks yet." onSelect={(row) => onEmployee(row.id)} selectLabel="Filter by employee" />
        </Panel>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Panel title="Strongest performers" icon={<Trophy className="h-4 w-4" />}>
          <PerformanceList rows={data.comparisons.topPerformers} emptyTitle="No performers yet" emptyDescription="Completed scoped work will populate this list." />
        </Panel>
        <Panel title="Needs your attention" icon={<AlertTriangle className="h-4 w-4" />}>
          <PerformanceList rows={data.comparisons.needsAttention} emptyTitle="No attention list" emptyDescription="No scoped employee has overdue work or a low completion rate in this view." />
        </Panel>
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[360px_minmax(0,1fr)]">
        <BreakdownPanel title="SOPs in scope" icon={<FileText className="h-4 w-4" />} items={data.sopStats.byScope} />
        <RecentPanel data={data} />
      </div>
    </>
  );
}

function EmployeeDashboard({ data }: { data: DashboardData }) {
  const currentWorkload = data.metrics.totalTasks - data.metrics.completedTasks;
  return (
    <>
      <InsightStrip data={data} />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={<ListChecks className="h-4 w-4" />} label="My assigned tasks" value={formatNumber(data.metrics.totalTasks)} helper={`${formatNumber(currentWorkload)} still open`} />
        <StatCard icon={<CheckCircle2 className="h-4 w-4" />} label="My completion rate" value={formatPercent(data.metrics.completionRate)} helper={`${formatNumber(data.metrics.completedTasks)} completed`} tone={data.metrics.completionRate >= 80 ? "good" : "neutral"} />
        <StatCard icon={<Clock className="h-4 w-4" />} label="Due soon" value={formatNumber(data.metrics.dueSoonTasks)} helper={`${formatNumber(data.metrics.overdueTasks)} overdue`} tone={data.metrics.overdueTasks > 0 ? "danger" : data.metrics.dueSoonTasks > 0 ? "warn" : "neutral"} />
        <StatCard icon={<FileText className="h-4 w-4" />} label="My visible SOPs" value={formatNumber(data.sopStats.visible)} helper="Assigned procedures currently visible to you" />
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_360px]">
        <Panel title="My progress over time" icon={<TrendingUp className="h-4 w-4" />}><TrendChart data={data.trends} /></Panel>
        <BreakdownPanel title="My status breakdown" icon={<Target className="h-4 w-4" />} items={data.breakdowns.status} />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <StatCard icon={<Timer className="h-4 w-4" />} label="Average completion time" value={formatDuration(data.metrics.averageCompletionMs)} helper="Based on completed tasks with timestamps" />
        <StatCard icon={<Activity className="h-4 w-4" />} label="JD cycle health" value={formatPercent(data.jdCycleHealth.healthyRate)} helper={`${formatNumber(data.jdCycleHealth.completedCycles)} completed, ${formatNumber(data.jdCycleHealth.missedCycles)} missed`} tone={data.jdCycleHealth.missedCycles > 0 ? "warn" : "neutral"} />
        <StatCard icon={<AlertTriangle className="h-4 w-4" />} label="Late completions" value={formatNumber(data.metrics.lateCompletions)} helper="Only one-time tasks support this today" tone={data.metrics.lateCompletions > 0 ? "warn" : "neutral"} />
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[360px_360px_minmax(0,1fr)]">
        <BreakdownPanel title="Priority mix" icon={<Target className="h-4 w-4" />} items={data.breakdowns.priority} />
        <BreakdownPanel title="Recurring work" icon={<Activity className="h-4 w-4" />} items={data.breakdowns.frequency} />
        <RecentPanel data={data} />
      </div>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <div className="app-page animate-pulse">
      <div className="mb-5 h-8 w-52 rounded bg-[var(--surface-muted)]" />
      <div className="mb-4 h-9 w-full rounded bg-[var(--surface-muted)]" />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-24 rounded-md bg-[var(--surface-muted)]" />)}
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_360px]">
        <div className="h-80 rounded-md bg-[var(--surface-muted)]" />
        <div className="h-80 rounded-md bg-[var(--surface-muted)]" />
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
  if (data.role === "Admin") return "Company-wide performance across branches, departments, managers, employees, tasks, and SOPs.";
  if (data.role === "Manager") return "Performance analytics for only the branches, departments, and people inside your managed scope.";
  return "Your personal workload, task performance, due work, recurring cycles, and SOP visibility.";
}

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

  const queryArgs = activeCompanyId && canViewActiveDashboard ? {
    companyId: activeCompanyId,
    datePreset,
    taskType,
    status,
    priority,
    frequency,
    branchId: branchId === "all" ? undefined : branchId as Id<"branches">,
    departmentId: departmentId === "all" ? undefined : departmentId as Id<"departments">,
    membershipId: membershipId === "all" ? undefined : membershipId as Id<"companyMemberships">,
  } : "skip";
  const result = useQuery_experimental({ query: api.analytics.dashboard, args: queryArgs });
  const data = result.status === "success" ? result.data as DashboardData : null;

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
    <div className="app-page">
      <PageHeader
        eyebrow={<span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5" />{data.range.label}</span>}
        title={data.role === "Admin" ? "Admin Dashboard" : data.role === "Manager" ? "Manager Dashboard" : "My Dashboard"}
        description={pageDescription(data)}
        actions={<Badge tone={data.role === "Admin" ? "blue" : data.role === "Manager" ? "green" : "neutral"}>{data.viewer.role}</Badge>}
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
        <div className="mb-4 rounded-md border border-[var(--hairline)] bg-[var(--canvas-soft)] px-3 py-2 text-[13px] text-[var(--ink-muted)]">
          No tasks match the selected filters. Charts and comparisons will populate as matching work is created, due, or completed.
        </div>
      )}

      {data.role === "Admin" && (
        <AdminDashboard
          data={data}
          onBranch={(id) => { setBranchId(id); setDepartmentId("all"); setMembershipId("all"); }}
          onDepartment={(id, parentId) => { if (parentId) setBranchId(parentId); setDepartmentId(id); setMembershipId("all"); }}
          onEmployee={setMembershipId}
        />
      )}
      {data.role === "Manager" && (
        <ManagerDashboard
          data={data}
          onBranch={(id) => { setBranchId(id); setDepartmentId("all"); setMembershipId("all"); }}
          onDepartment={(id, parentId) => { if (parentId) setBranchId(parentId); setDepartmentId(id); setMembershipId("all"); }}
          onEmployee={setMembershipId}
        />
      )}
      {data.role === "Employee" && <EmployeeDashboard data={data} />}
    </div>
  );
}
