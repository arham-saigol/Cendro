"use client";

import { useQuery_experimental } from "convex/react";
import {
  AlertCircle,
  AlertTriangle,
  BarChart3,
  Building2,
  Calendar,
  Check,
  CheckCircle2,
  Inbox,
  Layers,
  ListTodo,
  RotateCcw,
  Timer,
  Trophy,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { PageHeader } from "./page-header";
import { useCompany } from "./company-context";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { canViewDashboard } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import {
  TanStackTrendChart,
  type TrendMetricMode,
} from "./dashboard-charts";

type DashboardRole = "Admin" | "Manager" | "Employee";
type DatePreset = "7d" | "30d" | "90d" | "365d";
type TaskTypeFilter = "all" | "jd" | "one_time";
type StatusFilter = "all" | "due" | "in_progress" | "completed" | "overdue";
type PriorityFilter = "all" | "low" | "medium" | "high";
type FrequencyFilter = "all" | "daily" | "every_other_day" | "weekly" | "semimonthly" | "monthly" | "semiannually" | "annually";
type DashboardTab = "overview" | "attention" | "organization" | "team" | "breakdowns";

type BreakdownItem = { key: string; label: string; value: number };
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

const datePresets: { value: DatePreset; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "365d", label: "12 months" },
];

function formatNumber(val: number) {
  return new Intl.NumberFormat().format(val);
}

function formatPercent(val: number) {
  return `${Math.round(val)}%`;
}

function formatTimeAgo(timestamp: number) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusDotColor(key: string) {
  if (key === "completed" || key === "low") return "bg-[#10b981]";
  if (key === "overdue" || key === "high") return "bg-[#ef4444]";
  if (key === "in_progress" || key === "medium") return "bg-[#3b82f6]";
  return "bg-[var(--ink-faint)]";
}

// ------------------------------------------------------------------
// Notion 4-Metric Strip
// ------------------------------------------------------------------

function NotionMetricStrip({ data }: { data: DashboardData }) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {/* 1. Period Done */}
      <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-3.5 transition-colors hover:border-[var(--hairline-strong)]">
        <div className="flex items-center justify-between text-[11.5px] font-medium text-[var(--ink-muted)]">
          <span>Period Completions</span>
          <CheckCircle2 className="h-3.5 w-3.5 text-[#10b981]" />
        </div>
        <div className="mt-2 text-[24px] font-semibold tracking-tight text-[var(--ink)] tabular-nums">
          {formatNumber(data.metrics.periodCompletions)}
        </div>
        <div className="mt-1 text-[11px] text-[var(--ink-faint)]">
          {formatPercent(data.metrics.completionRate)} total completion rate
        </div>
      </div>

      {/* 2. Open Workload */}
      <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-3.5 transition-colors hover:border-[var(--hairline-strong)]">
        <div className="flex items-center justify-between text-[11.5px] font-medium text-[var(--ink-muted)]">
          <span>Active Workload</span>
          <ListTodo className="h-3.5 w-3.5 text-[#3b82f6]" />
        </div>
        <div className="mt-2 text-[24px] font-semibold tracking-tight text-[var(--ink)] tabular-nums">
          {formatNumber(data.metrics.openTasks)}
        </div>
        <div className="mt-1 text-[11px] text-[var(--ink-faint)]">
          {formatNumber(data.metrics.inProgressTasks)} in progress · {formatNumber(data.metrics.notStartedTasks)} pending
        </div>
      </div>

      {/* 3. Overdue Tasks */}
      <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-3.5 transition-colors hover:border-[var(--hairline-strong)]">
        <div className="flex items-center justify-between text-[11.5px] font-medium text-[var(--ink-muted)]">
          <span>Overdue Work</span>
          <AlertCircle className={cn("h-3.5 w-3.5", data.metrics.overdueTasks > 0 ? "text-[#ef4444]" : "text-[var(--ink-faint)]")} />
        </div>
        <div className={cn("mt-2 text-[24px] font-semibold tracking-tight tabular-nums", data.metrics.overdueTasks > 0 ? "text-[#ef4444]" : "text-[var(--ink)]")}>
          {formatNumber(data.metrics.overdueTasks)}
        </div>
        <div className="mt-1 text-[11px] text-[var(--ink-faint)]">
          {formatNumber(data.metrics.lateCompletions)} late deliveries
        </div>
      </div>

      {/* 4. Cycle Health */}
      <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-3.5 transition-colors hover:border-[var(--hairline-strong)]">
        <div className="flex items-center justify-between text-[11.5px] font-medium text-[var(--ink-muted)]">
          <span>Recurring Cycle Health</span>
          <Timer className={cn("h-3.5 w-3.5", data.jdCycleHealth.missedCycles > 0 ? "text-[#ef4444]" : "text-[#10b981]")} />
        </div>
        <div className={cn("mt-2 text-[24px] font-semibold tracking-tight tabular-nums", data.jdCycleHealth.missedCycles > 0 ? "text-[#ef4444]" : "text-[var(--ink)]")}>
          {data.jdCycleHealth.missedCycles > 0 ? `${formatNumber(data.jdCycleHealth.missedCycles)} missed` : `${formatPercent(data.jdCycleHealth.healthyRate)}`}
        </div>
        <div className="mt-1 text-[11px] text-[var(--ink-faint)]">
          {formatNumber(data.jdCycleHealth.completedCycles)} cycles completed on time
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Notion Inline Filter Row (Ultra Compact Horizontal Pills)
// ------------------------------------------------------------------

function NotionInlineFilters({
  data,
  datePreset,
  branchId,
  departmentId,
  membershipId,
  taskType,
  onDatePreset,
  onBranch,
  onDepartment,
  onMembership,
  onTaskType,
  onReset,
}: {
  data: DashboardData;
  datePreset: DatePreset;
  branchId: string;
  departmentId: string;
  membershipId: string;
  taskType: TaskTypeFilter;
  onDatePreset: (v: DatePreset) => void;
  onBranch: (v: string) => void;
  onDepartment: (v: string) => void;
  onMembership: (v: string) => void;
  onTaskType: (v: TaskTypeFilter) => void;
  onReset: () => void;
}) {
  const showScope = data.role === "Admin" || data.role === "Manager";

  const branchOptions = useMemo(
    () => [{ value: "all", label: "All branches" }, ...(data.filterOptions.branches ?? []).map((b) => ({ value: b._id, label: b.name }))],
    [data],
  );
  const departmentOptions = useMemo(() => {
    const departments = (data.filterOptions.departments ?? []).filter((d) => branchId === "all" || d.branchId === branchId);
    return [{ value: "all", label: "All departments" }, ...departments.map((d) => ({ value: d._id, label: d.name }))];
  }, [branchId, data]);
  const employeeOptions = useMemo(() => {
    const employees = (data.filterOptions.employees ?? []).filter((e) => {
      if (branchId !== "all" && !e.branchIds.includes(branchId)) return false;
      if (departmentId !== "all" && !e.departmentIds.includes(departmentId)) return false;
      return true;
    });
    return [{ value: "all", label: "All people" }, ...employees.map((e) => ({ value: e._id, label: e.name }))];
  }, [branchId, data, departmentId]);

  const hasActiveFilters = datePreset !== "30d" || branchId !== "all" || departmentId !== "all" || membershipId !== "all" || taskType !== "all";

  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] pb-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {/* Date Filter */}
        <Select value={datePreset} onValueChange={(v) => onDatePreset(v as DatePreset)}>
          <SelectTrigger className="h-7.5 w-auto min-w-[115px] rounded-md border-[var(--hairline)] bg-[var(--surface)] px-2.5 text-[12px] font-normal shadow-none hover:bg-[var(--surface-muted)]">
            <Calendar className="mr-1.5 h-3 w-3 shrink-0 text-[var(--ink-faint)]" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {datePresets.map((opt) => (
              <SelectItem key={opt.value} value={opt.value} className="text-[12px]">
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {showScope && (
          <>
            {/* Branch Filter */}
            <Select
              value={branchId}
              onValueChange={(val) => {
                onBranch(val);
                onDepartment("all");
                onMembership("all");
              }}
            >
              <SelectTrigger
                className={cn(
                  "h-7.5 w-auto min-w-[125px] rounded-md border-[var(--hairline)] bg-[var(--surface)] px-2.5 text-[12px] shadow-none hover:bg-[var(--surface-muted)]",
                  branchId !== "all" ? "border-[var(--primary)] text-[var(--primary)] font-medium" : "text-[var(--ink-secondary)] font-normal"
                )}
              >
                <Building2 className="mr-1.5 h-3 w-3 shrink-0 text-[var(--ink-faint)]" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {branchOptions.map((b) => (
                  <SelectItem key={b.value} value={b.value} className="text-[12px]">
                    {b.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Department Filter */}
            <Select
              value={departmentId}
              onValueChange={(val) => {
                onDepartment(val);
                onMembership("all");
              }}
              disabled={departmentOptions.length <= 1}
            >
              <SelectTrigger
                className={cn(
                  "h-7.5 w-auto min-w-[135px] rounded-md border-[var(--hairline)] bg-[var(--surface)] px-2.5 text-[12px] shadow-none hover:bg-[var(--surface-muted)]",
                  departmentId !== "all" ? "border-[var(--primary)] text-[var(--primary)] font-medium" : "text-[var(--ink-secondary)] font-normal"
                )}
              >
                <Layers className="mr-1.5 h-3 w-3 shrink-0 text-[var(--ink-faint)]" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {departmentOptions.map((d) => (
                  <SelectItem key={d.value} value={d.value} className="text-[12px]">
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* People Filter */}
            <Select value={membershipId} onValueChange={onMembership} disabled={employeeOptions.length <= 1}>
              <SelectTrigger
                className={cn(
                  "h-7.5 w-auto min-w-[120px] rounded-md border-[var(--hairline)] bg-[var(--surface)] px-2.5 text-[12px] shadow-none hover:bg-[var(--surface-muted)]",
                  membershipId !== "all" ? "border-[var(--primary)] text-[var(--primary)] font-medium" : "text-[var(--ink-secondary)] font-normal"
                )}
              >
                <Users className="mr-1.5 h-3 w-3 shrink-0 text-[var(--ink-faint)]" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {employeeOptions.map((e) => (
                  <SelectItem key={e.value} value={e.value} className="text-[12px]">
                    {e.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}

        {/* Task Type Filter */}
        <Select value={taskType} onValueChange={(v) => onTaskType(v as TaskTypeFilter)}>
          <SelectTrigger
            className={cn(
              "h-7.5 w-auto min-w-[125px] rounded-md border-[var(--hairline)] bg-[var(--surface)] px-2.5 text-[12px] shadow-none hover:bg-[var(--surface-muted)]",
              taskType !== "all" ? "border-[var(--primary)] text-[var(--primary)] font-medium" : "text-[var(--ink-secondary)] font-normal"
            )}
          >
            <ListTodo className="mr-1.5 h-3 w-3 shrink-0 text-[var(--ink-faint)]" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-[12px]">All task kinds</SelectItem>
            <SelectItem value="jd" className="text-[12px]">Recurring JD</SelectItem>
            <SelectItem value="one_time" className="text-[12px]">One-time tasks</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {hasActiveFilters && (
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
        >
          <RotateCcw className="h-3 w-3" />
          Reset filters
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Overview View
// ------------------------------------------------------------------

function OverviewView({ data }: { data: DashboardData }) {
  const [metricMode, setMetricMode] = useState<TrendMetricMode>("all");
  const isEmptyTrend = data.trends.every((p) => p.completed === 0 && p.overdue === 0 && p.workload === 0);

  return (
    <div className="space-y-6">
      {/* TanStack Charts Performance Trend */}
      <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-4 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hairline)] pb-3">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-[var(--ink-secondary)]" />
            <span className="text-[13px] font-semibold text-[var(--ink)]">Performance Throughput</span>
            <span className="text-[11.5px] text-[var(--ink-faint)]">({data.range.label})</span>
          </div>

          <div className="flex items-center gap-1 rounded bg-[var(--surface-muted)]/70 p-0.5">
            <button
              type="button"
              onClick={() => setMetricMode("all")}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                metricMode === "all" ? "bg-[var(--surface)] text-[var(--ink)] shadow-2xs font-semibold" : "text-[var(--ink-muted)] hover:text-[var(--ink)]"
              )}
            >
              All Series
            </button>
            <button
              type="button"
              onClick={() => setMetricMode("completed")}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                metricMode === "completed" ? "bg-[var(--surface)] text-[#10b981] shadow-2xs font-semibold" : "text-[var(--ink-muted)] hover:text-[var(--ink)]"
              )}
            >
              Done
            </button>
            <button
              type="button"
              onClick={() => setMetricMode("workload")}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                metricMode === "workload" ? "bg-[var(--surface)] text-[#3b82f6] shadow-2xs font-semibold" : "text-[var(--ink-muted)] hover:text-[var(--ink)]"
              )}
            >
              Workload
            </button>
            <button
              type="button"
              onClick={() => setMetricMode("overdue")}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                metricMode === "overdue" ? "bg-[var(--surface)] text-[#ef4444] shadow-2xs font-semibold" : "text-[var(--ink-muted)] hover:text-[var(--ink)]"
              )}
            >
              Overdue
            </button>
          </div>
        </div>

        <div className="pt-3">
          {isEmptyTrend ? (
            <div className="flex h-48 flex-col items-center justify-center text-center">
              <Inbox className="h-5 w-5 text-[var(--ink-faint)]" />
              <p className="mt-1.5 text-[12.5px] font-medium text-[var(--ink)]">No activity during this period</p>
              <p className="text-[11px] text-[var(--ink-faint)]">Tasks scheduled or completed will automatically graph here.</p>
            </div>
          ) : (
            <TanStackTrendChart data={data.trends} mode={metricMode} height={200} />
          )}
        </div>
      </div>

      {/* Grid: Status Distribution + Activity Stream */}
      <div className="grid gap-5 sm:grid-cols-2">
        {/* Status Distribution */}
        <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-4 shadow-2xs">
          <div className="flex items-center justify-between border-b border-[var(--hairline)] pb-2.5">
            <span className="text-[13px] font-semibold text-[var(--ink)]">Workload by Status</span>
            <span className="text-[11.5px] tabular-nums text-[var(--ink-faint)]">{data.metrics.totalTasks} total</span>
          </div>

          <div className="mt-3 space-y-2.5">
            {data.breakdowns.status.map((item) => (
              <div key={item.key} className="flex items-center justify-between text-[12px]">
                <div className="flex items-center gap-2">
                  <span className={cn("h-2 w-2 rounded-full", statusDotColor(item.key))} />
                  <span className="text-[var(--ink-secondary)]">{item.label}</span>
                </div>
                <div className="flex items-center gap-2 tabular-nums">
                  <span className="font-medium text-[var(--ink)]">{item.value}</span>
                  <span className="text-[11px] text-[var(--ink-faint)]">
                    ({data.metrics.totalTasks > 0 ? `${Math.round((item.value / data.metrics.totalTasks) * 100)}%` : "0%"})
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3.5 flex h-1.5 overflow-hidden rounded-full bg-[var(--surface-muted)]">
            {data.breakdowns.status
              .filter((i) => i.value > 0)
              .map((i) => (
                <span
                  key={i.key}
                  style={{ width: `${(i.value / (data.metrics.totalTasks || 1)) * 100}%` }}
                  className={statusDotColor(i.key)}
                />
              ))}
          </div>
        </div>

        {/* Live Activity Feed */}
        <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-4 shadow-2xs">
          <div className="flex items-center justify-between border-b border-[var(--hairline)] pb-2.5">
            <span className="text-[13px] font-semibold text-[var(--ink)]">Recent Completions</span>
            <span className="text-[11px] text-[var(--ink-faint)]">Live Stream</span>
          </div>

          <div className="mt-3">
            {data.recent.completions.length === 0 ? (
              <div className="py-6 text-center text-[12px] text-[var(--ink-faint)]">
                No completions in this timeframe yet.
              </div>
            ) : (
              <div className="space-y-1.5">
                {data.recent.completions.slice(0, 5).map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between rounded p-1.5 text-[12px] transition-colors hover:bg-[var(--surface-muted)]"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#10b981]" />
                      <span className="truncate font-medium text-[var(--ink)]">{item.title}</span>
                    </div>
                    <span className="shrink-0 text-[11px] text-[var(--ink-faint)]">
                      {item.actorName ? `${item.actorName} · ` : ""}
                      {formatTimeAgo(item.completedAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Attention View
// ------------------------------------------------------------------

function AttentionView({
  data,
  onSelectEmployee,
}: {
  data: DashboardData;
  onSelectEmployee: (id: string) => void;
}) {
  const isClean = data.metrics.overdueTasks === 0 && data.jdCycleHealth.missedCycles === 0 && data.metrics.lateCompletions === 0;

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-4 shadow-2xs">
        <div className="flex items-center justify-between border-b border-[var(--hairline)] pb-3">
          <div>
            <h3 className="text-[13.5px] font-semibold text-[var(--ink)]">Attention Queue</h3>
            <p className="text-[11.5px] text-[var(--ink-muted)]">Bottlenecks and overdue deliverables.</p>
          </div>
          {isClean && (
            <Badge tone="green" className="text-[11px]">
              <Check className="mr-1 h-3 w-3" />
              All Clear
            </Badge>
          )}
        </div>

        <div className="mt-3.5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-md border border-[var(--hairline)] bg-[var(--surface-muted)]/30 p-3">
            <div className="text-[11.5px] font-medium text-[var(--ink-muted)]">Overdue Tasks</div>
            <div className={cn("mt-1 text-[20px] font-semibold tabular-nums", data.metrics.overdueTasks > 0 ? "text-[#ef4444]" : "text-[var(--ink)]")}>
              {formatNumber(data.metrics.overdueTasks)}
            </div>
            <div className="mt-0.5 text-[11px] text-[var(--ink-faint)]">Past deadline</div>
          </div>

          <div className="rounded-md border border-[var(--hairline)] bg-[var(--surface-muted)]/30 p-3">
            <div className="text-[11.5px] font-medium text-[var(--ink-muted)]">Missed JD Cycles</div>
            <div className={cn("mt-1 text-[20px] font-semibold tabular-nums", data.jdCycleHealth.missedCycles > 0 ? "text-[#ef4444]" : "text-[var(--ink)]")}>
              {formatNumber(data.jdCycleHealth.missedCycles)}
            </div>
            <div className="mt-0.5 text-[11px] text-[var(--ink-faint)]">Missed recurring cycles</div>
          </div>

          <div className="rounded-md border border-[var(--hairline)] bg-[var(--surface-muted)]/30 p-3">
            <div className="text-[11.5px] font-medium text-[var(--ink-muted)]">Late Completions</div>
            <div className={cn("mt-1 text-[20px] font-semibold tabular-nums", data.metrics.lateCompletions > 0 ? "text-[#ef4444]" : "text-[var(--ink)]")}>
              {formatNumber(data.metrics.lateCompletions)}
            </div>
            <div className="mt-0.5 text-[11px] text-[var(--ink-faint)]">
              {formatPercent(data.metrics.lateCompletionRate)} late rate
            </div>
          </div>
        </div>

        {data.role !== "Employee" && (
          <div className="mt-5 border-t border-[var(--hairline)] pt-3.5">
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-[12px] font-semibold text-[var(--ink)]">Team Members with Bottlenecks</span>
              <span className="text-[11px] text-[var(--ink-faint)]">{data.comparisons.needsAttention.length} listed</span>
            </div>

            {data.comparisons.needsAttention.length === 0 ? (
              <p className="py-2 text-[12px] text-[var(--ink-faint)]">No team members flagged for overdue tasks or poor throughput.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                {data.comparisons.needsAttention.map((person) => (
                  <button
                    key={person.id}
                    type="button"
                    onClick={() => onSelectEmployee(person.id)}
                    className="flex items-center justify-between rounded border border-[var(--hairline)] bg-[var(--surface)] p-2.5 text-left transition-colors hover:bg-[var(--surface-muted)]"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[12.5px] font-medium text-[var(--ink)]">{person.name}</div>
                      <div className="text-[11px] text-[var(--ink-faint)]">{formatPercent(person.completionRate)} done · {person.assigned} tasks</div>
                    </div>
                    <Badge tone="red" className="shrink-0 text-[10px]">
                      {person.overdue} overdue
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Notion Database Table Component
// ------------------------------------------------------------------

function NotionDatabaseTable({
  title,
  rows,
  emptyMessage,
  onSelectRow,
}: {
  title: string;
  rows: PerformanceRow[];
  emptyMessage: string;
  onSelectRow?: (row: PerformanceRow) => void;
}) {
  const maxAssigned = Math.max(1, ...rows.map((r) => r.assigned));

  return (
    <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] shadow-2xs">
      <div className="flex items-center justify-between border-b border-[var(--hairline)] px-4 py-2.5">
        <span className="text-[13px] font-semibold text-[var(--ink)]">{title}</span>
        <span className="text-[11px] tabular-nums text-[var(--ink-faint)]">{rows.length} rows</span>
      </div>

      {rows.length === 0 ? (
        <div className="py-8 text-center text-[12px] text-[var(--ink-faint)]">{emptyMessage}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="task-table w-full text-left text-[12.5px]">
            <thead>
              <tr className="border-b border-[var(--hairline)] text-[11px] font-semibold text-[var(--ink-faint)]">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Workload</th>
                <th className="px-4 py-2 text-right">Completion</th>
                <th className="px-4 py-2 text-right">Overdue</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  tabIndex={onSelectRow ? 0 : undefined}
                  role={onSelectRow ? "button" : undefined}
                  onClick={() => onSelectRow?.(row)}
                  onKeyDown={
                    onSelectRow
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelectRow(row);
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    "border-b border-[var(--hairline)]/50 transition-colors hover:bg-[var(--surface-muted)]/50",
                    onSelectRow && "cursor-pointer focus-visible:outline-none focus-visible:bg-[var(--surface-muted)]"
                  )}
                >
                  <td className="px-4 py-2.5 font-medium text-[var(--ink)]">
                    <div className="flex items-center gap-1.5">
                      <span>{row.name}</span>
                      {row.role && (
                        <Badge tone="neutral" className="text-[10px]">
                          {row.role}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex max-w-[180px] items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-muted)]">
                        <div
                          className="h-full rounded-full bg-[var(--primary)]"
                          style={{ width: `${(row.assigned / maxAssigned) * 100}%` }}
                        />
                      </div>
                      <span className="text-[11px] tabular-nums text-[var(--ink-faint)]">
                        {row.assigned}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-[var(--ink)]">
                    {formatPercent(row.completionRate)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {row.overdue > 0 ? (
                      <span className="font-semibold text-[#ef4444]">{row.overdue}</span>
                    ) : (
                      <span className="text-[var(--ink-faint)]">0</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Main Dashboard Page
// ------------------------------------------------------------------

export function DashboardPage() {
  const { activeCompanyId, active } = useCompany();
  const canViewActiveDashboard = canViewDashboard(active?.capabilities);
  const [activeTab, setActiveTab] = useState<DashboardTab>("overview");

  // Filters
  const [datePreset, setDatePreset] = useState<DatePreset>("30d");
  const [taskType, setTaskType] = useState<TaskTypeFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [priority, setPriority] = useState<PriorityFilter>("all");
  const [frequency, setFrequency] = useState<FrequencyFilter>("all");
  const [branchId, setBranchId] = useState("all");
  const [departmentId, setDepartmentId] = useState("all");
  const [membershipId, setMembershipId] = useState("all");
  const [scopeData, setScopeData] = useState<DashboardData | null>(null);

  useEffect(() => {
    setActiveTab("overview");
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
    canUseScopeFilters && scopeDataForActiveCompany && branchId !== "all" && scopeDataForActiveCompany.filterOptions.branches.some((b) => b._id === branchId)
      ? (branchId as Id<"branches">)
      : undefined;
  const validDepartmentId =
    canUseScopeFilters && scopeDataForActiveCompany && departmentId !== "all" && scopeDataForActiveCompany.filterOptions.departments.some(
      (d) => d._id === departmentId && (!validBranchId || d.branchId === validBranchId),
    )
      ? (departmentId as Id<"departments">)
      : undefined;
  const validMembershipId =
    canUseScopeFilters && scopeDataForActiveCompany && membershipId !== "all" && scopeDataForActiveCompany.filterOptions.employees.some(
      (e) =>
        e._id === membershipId &&
        (!validBranchId || e.branchIds.includes(validBranchId)) &&
        (!validDepartmentId || e.departmentIds.includes(validDepartmentId)),
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
    if (data?.role === "Employee" && (activeTab === "organization" || activeTab === "team")) setActiveTab("overview");
  }, [activeTab, data?.role]);

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

  if (!canViewActiveDashboard) {
    return (
      <div className="app-page">
        <PageHeader title="Dashboard" description="Dashboard access is disabled for your account." />
      </div>
    );
  }

  if (result.status === "error") {
    return (
      <div className="app-page">
        <PageHeader title="Dashboard" description="Could not load analytics view." />
        <div className="mt-4 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-surface)] p-4 text-sm text-[var(--danger)]">
          {result.error instanceof Error ? result.error.message : "An error occurred."}
        </div>
      </div>
    );
  }

  if (result.status === "pending" || !data) {
    return (
      <div className="app-page space-y-4">
        <div className="h-7 w-48 animate-pulse rounded bg-[var(--surface-muted)]" />
        <div className="h-20 w-full animate-pulse rounded-lg bg-[var(--surface-muted)]" />
        <div className="h-60 w-full animate-pulse rounded-lg bg-[var(--surface-muted)]" />
      </div>
    );
  }

  const attentionBadgeCount = data.metrics.overdueTasks + data.jdCycleHealth.missedCycles;

  return (
    <div className="app-page max-w-5xl">
      {/* Calm Notion Page Title */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-[var(--ink)]">
              {data.role === "Admin" ? "Executive Dashboard" : data.role === "Manager" ? "Manager Overview" : "My Dashboard"}
            </h1>
            <Badge tone="neutral" className="text-[11px]">
              {data.viewer.role}
            </Badge>
          </div>
          <p className="mt-0.5 text-[13px] text-[var(--ink-muted)]">
            Operations, team workload, recurring cycles, and risk signals across {data.company.name}.
          </p>
        </div>
      </div>

      {/* 4-Metric Overview Strip */}
      <NotionMetricStrip data={data} />

      {/* Notion View Switcher Tabs */}
      <div className="mb-3 flex items-center gap-1 border-b border-[var(--hairline)] pb-px">
        <button
          type="button"
          onClick={() => setActiveTab("overview")}
          className={cn(
            "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[12.5px] transition-colors",
            activeTab === "overview"
              ? "border-[var(--primary)] text-[var(--primary)] font-semibold"
              : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]"
          )}
        >
          <BarChart3 className="h-3.5 w-3.5" />
          Overview
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("attention")}
          className={cn(
            "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[12.5px] transition-colors",
            activeTab === "attention"
              ? "border-[var(--primary)] text-[var(--primary)] font-semibold"
              : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]"
          )}
        >
          <AlertTriangle className={cn("h-3.5 w-3.5", attentionBadgeCount > 0 && "text-[#ef4444]")} />
          Attention
          {attentionBadgeCount > 0 && (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-[#ef4444] px-1 text-[10px] font-bold text-white">
              {attentionBadgeCount}
            </span>
          )}
        </button>

        {data.role !== "Employee" && (
          <>
            <button
              type="button"
              onClick={() => setActiveTab("organization")}
              className={cn(
                "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[12.5px] transition-colors",
                activeTab === "organization"
                  ? "border-[var(--primary)] text-[var(--primary)] font-semibold"
                  : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]"
              )}
            >
              <Building2 className="h-3.5 w-3.5" />
              Branches & Depts
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("team")}
              className={cn(
                "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[12.5px] transition-colors",
                activeTab === "team"
                  ? "border-[var(--primary)] text-[var(--primary)] font-semibold"
                  : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]"
              )}
            >
              <Users className="h-3.5 w-3.5" />
              Team Capacity
            </button>
          </>
        )}

        <button
          type="button"
          onClick={() => setActiveTab("breakdowns")}
          className={cn(
            "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[12.5px] transition-colors",
            activeTab === "breakdowns"
              ? "border-[var(--primary)] text-[var(--primary)] font-semibold"
              : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]"
          )}
        >
          <Layers className="h-3.5 w-3.5" />
          Breakdowns
        </button>
      </div>

      {/* Notion Inline Filter Toolbar */}
      <NotionInlineFilters
        data={data}
        datePreset={datePreset}
        branchId={branchId}
        departmentId={departmentId}
        membershipId={membershipId}
        taskType={taskType}
        onDatePreset={setDatePreset}
        onBranch={setBranchId}
        onDepartment={setDepartmentId}
        onMembership={setMembershipId}
        onTaskType={setTaskType}
        onReset={resetFilters}
      />

      {/* Active Tab View Content */}
      {activeTab === "overview" && <OverviewView data={data} />}

      {activeTab === "attention" && (
        <AttentionView
          data={data}
          onSelectEmployee={(empId) => {
            setMembershipId(empId);
            setActiveTab("overview");
          }}
        />
      )}

      {activeTab === "organization" && (
        <div className="space-y-6">
          <NotionDatabaseTable
            title="Branches Performance"
            rows={data.comparisons.branches}
            emptyMessage="No branches with matching task data."
            onSelectRow={(row) => {
              setBranchId(row.id);
              setDepartmentId("all");
              setMembershipId("all");
            }}
          />

          <NotionDatabaseTable
            title="Department Breakdown"
            rows={data.comparisons.departments}
            emptyMessage="No departments with matching task data."
            onSelectRow={(row) => {
              if (row.parentId) setBranchId(row.parentId);
              setDepartmentId(row.id);
              setMembershipId("all");
            }}
          />
        </div>
      )}

      {activeTab === "team" && (
        <div className="space-y-6">
          {/* Top Performers Leaderboard */}
          <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-4 shadow-2xs">
            <div className="flex items-center justify-between border-b border-[var(--hairline)] pb-2.5">
              <div className="flex items-center gap-1.5">
                <Trophy className="h-4 w-4 text-[#f59e0b]" />
                <span className="text-[13px] font-semibold text-[var(--ink)]">Strongest Performers</span>
              </div>
              <span className="text-[11px] text-[var(--ink-faint)]">Ranked by completion rate</span>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2 md:grid-cols-3">
              {data.comparisons.topPerformers.map((person, idx) => (
                <button
                  type="button"
                  key={person.id}
                  onClick={() => setMembershipId(person.id)}
                  className="flex cursor-pointer items-center justify-between rounded border border-[var(--hairline)] bg-[var(--surface-muted)]/30 p-2 text-left transition-colors hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ink)]"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="grid h-4.5 w-4.5 place-items-center rounded bg-[var(--surface)] text-[10px] font-semibold text-[var(--ink-muted)]">
                      {idx + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium text-[var(--ink)]">{person.name}</div>
                      <div className="text-[10.5px] text-[var(--ink-faint)]">{person.completed} tasks done</div>
                    </div>
                  </div>
                  <span className="text-[12px] font-semibold text-[#10b981] tabular-nums">
                    {formatPercent(person.completionRate)}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <NotionDatabaseTable
            title="Team Workload Table"
            rows={data.comparisons.employees}
            emptyMessage="No team members in this filtered view."
            onSelectRow={(row) => setMembershipId(row.id)}
          />
        </div>
      )}

      {activeTab === "breakdowns" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-4 shadow-2xs">
            <h4 className="text-[12.5px] font-semibold text-[var(--ink)]">Task Status Mix</h4>
            <div className="mt-3 space-y-2">
              {data.breakdowns.status.map((item) => (
                <div key={item.key} className="flex items-center justify-between text-[12px]">
                  <div className="flex items-center gap-2">
                    <span className={cn("h-2 w-2 rounded-full", statusDotColor(item.key))} />
                    <span>{item.label}</span>
                  </div>
                  <span className="font-semibold tabular-nums text-[var(--ink)]">{formatNumber(item.value)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-4 shadow-2xs">
            <h4 className="text-[12.5px] font-semibold text-[var(--ink)]">Priority Distribution</h4>
            <div className="mt-3 space-y-2">
              {data.breakdowns.priority.map((item) => (
                <div key={item.key} className="flex items-center justify-between text-[12px]">
                  <div className="flex items-center gap-2">
                    <span className={cn("h-2 w-2 rounded-full", statusDotColor(item.key))} />
                    <span>{item.label}</span>
                  </div>
                  <span className="font-semibold tabular-nums text-[var(--ink)]">{formatNumber(item.value)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-4 shadow-2xs">
            <h4 className="text-[12.5px] font-semibold text-[var(--ink)]">Task Types</h4>
            <div className="mt-3 space-y-2">
              {data.breakdowns.type.map((item) => (
                <div key={item.key} className="flex items-center justify-between text-[12px]">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-[#3b82f6]" />
                    <span>{item.label}</span>
                  </div>
                  <span className="font-semibold tabular-nums text-[var(--ink)]">{formatNumber(item.value)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] p-4 shadow-2xs">
            <h4 className="text-[12.5px] font-semibold text-[var(--ink)]">SOP Visibility Scope</h4>
            <div className="mt-3 space-y-2">
              {data.sopStats.byScope.map((item) => (
                <div key={item.key} className="flex items-center justify-between text-[12px]">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-[#8b5cf6]" />
                    <span>{item.label}</span>
                  </div>
                  <span className="font-semibold tabular-nums text-[var(--ink)]">{formatNumber(item.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
