import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { analyticsScopedMembershipIds, assertAnalyticsViewAccess, buildSopVisibilityContext, membershipCapabilities, requireMembership, taskHasVisibleAssignee, visibleAssigneeMembershipIds, visibleSop } from "./permissions";
import { currentJdCycle } from "./taskCycles";
import type { Doc, Id } from "./_generated/dataModel";

type DashboardRole = "Admin" | "Manager" | "Employee";
type TaskKind = "jd" | "one_time";
type ManualStatus = "due" | "in_progress" | "completed";
type DashboardStatus = ManualStatus | "overdue";
type DatePreset = "7d" | "30d" | "90d" | "365d";
type Priority = "low" | "medium" | "high";
type Frequency = "daily" | "every_other_day" | "weekly" | "semimonthly" | "monthly" | "semiannually" | "annually";

type DashboardArgs = {
  companyId: Id<"companies">;
  datePreset?: DatePreset;
  branchId?: Id<"branches">;
  departmentId?: Id<"departments">;
  membershipId?: Id<"companyMemberships">;
  taskType?: "all" | TaskKind;
  status?: "all" | DashboardStatus;
  priority?: "all" | Priority;
  frequency?: "all" | Frequency;
};

type Person = {
  _id: Id<"companyMemberships">;
  role: Doc<"companyMemberships">["role"];
  name: string;
  firstName: string;
  imageUrl: string | null;
};

type OrgAssignments = {
  branchIds: Set<Id<"branches">>;
  departmentIds: Set<Id<"departments">>;
};

type DashboardTask = {
  id: string;
  kind: TaskKind;
  title: string;
  status: DashboardStatus;
  createdAt: number;
  updatedAt: number;
  dueAt: number | null;
  overdueAt: number | null;
  completedAt: number | null;
  isLate: boolean;
  priority: Priority | null;
  frequency: Frequency | null;
  assigneeIds: Id<"companyMemberships">[];
  branchIds: Id<"branches">[];
  departmentIds: Id<"departments">[];
};

type CompletionEvent = {
  taskId: string;
  kind: TaskKind;
  title: string;
  at: number;
  byMembershipId: Id<"companyMemberships"> | null;
  isLate: boolean;
};

type MissedEvent = {
  taskId: string;
  title: string;
  at: number;
};

const dayMs = 86_400_000;
const dashboardTakeLimit = 500;

const datePresetValidator = v.union(v.literal("7d"), v.literal("30d"), v.literal("90d"), v.literal("365d"));
const taskTypeFilterValidator = v.union(v.literal("all"), v.literal("jd"), v.literal("one_time"));
const statusFilterValidator = v.union(v.literal("all"), v.literal("due"), v.literal("in_progress"), v.literal("completed"), v.literal("overdue"));
const priorityFilterValidator = v.union(v.literal("all"), v.literal("low"), v.literal("medium"), v.literal("high"));
const frequencyFilterValidator = v.union(v.literal("all"), v.literal("daily"), v.literal("every_other_day"), v.literal("weekly"), v.literal("semimonthly"), v.literal("monthly"), v.literal("semiannually"), v.literal("annually"));

function firstName(user: Doc<"appUsers">) {
  return user.firstName.trim() || "Unknown";
}

function fullName(user: Doc<"appUsers">) {
  return [user.firstName.trim(), user.secondName?.trim()].filter(Boolean).join(" ") || "Unknown";
}

function safeRate(part: number, total: number) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function dateWindow(preset: DatePreset | undefined, now: number) {
  const selected = preset ?? "30d";
  const days = selected === "7d" ? 7 : selected === "90d" ? 90 : selected === "365d" ? 365 : 30;
  const labels: Record<DatePreset, string> = {
    "7d": "Last 7 days",
    "30d": "Last 30 days",
    "90d": "Last 90 days",
    "365d": "Last 12 months",
  };
  return { preset: selected, start: now - days * dayMs, end: now, label: labels[selected] };
}

async function dashboardAccess(ctx: QueryCtx, companyId: Id<"companies">) {
  const { membership, company } = await requireMembership(ctx, companyId);
  const caps = await membershipCapabilities(ctx, membership);
  assertAnalyticsViewAccess(caps);

  const dashboardRole: DashboardRole = caps.has("analytics:view:company") ? "Admin" : caps.has("analytics:view:managed_scope") ? "Manager" : "Employee";
  const scopedIds = await analyticsScopedMembershipIds(ctx, companyId, membership, caps);
  return { membership, company, caps, dashboardRole, scopedIds };
}

async function loadPeople(ctx: QueryCtx, membershipIds: Set<Id<"companyMemberships">>) {
  const people = new Map<Id<"companyMemberships">, Person>();
  for (const membershipId of membershipIds) {
    const membership = await ctx.db.get(membershipId);
    if (!membership || !membership.active) continue;
    const user = await ctx.db.get(membership.userId);
    if (!user) continue;
    people.set(membershipId, {
      _id: membershipId,
      role: membership.role,
      name: fullName(user),
      firstName: firstName(user),
      imageUrl: user.imageUrl ?? null,
    });
  }
  return people;
}

async function loadAssignments(ctx: QueryCtx, membershipIds: Set<Id<"companyMemberships">>) {
  const byMembership = new Map<Id<"companyMemberships">, OrgAssignments>();
  const branchIds = new Set<Id<"branches">>();
  const departmentIds = new Set<Id<"departments">>();

  for (const membershipId of membershipIds) {
    const membershipBranches = await ctx.db.query("userBranchAssignments").withIndex("by_membership", (q) => q.eq("membershipId", membershipId)).take(dashboardTakeLimit);
    const membershipDepartments = await ctx.db.query("userDepartmentAssignments").withIndex("by_membership", (q) => q.eq("membershipId", membershipId)).take(dashboardTakeLimit);
    const assignments = {
      branchIds: new Set(membershipBranches.map((row) => row.branchId)),
      departmentIds: new Set(membershipDepartments.map((row) => row.departmentId)),
    };
    for (const branchId of assignments.branchIds) branchIds.add(branchId);
    for (const departmentId of assignments.departmentIds) departmentIds.add(departmentId);
    byMembership.set(membershipId, assignments);
  }

  return { byMembership, branchIds, departmentIds };
}

async function loadOrg(ctx: QueryCtx, companyId: Id<"companies">) {
  const branches = await ctx.db.query("branches").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(dashboardTakeLimit);
  const departments = await ctx.db.query("departments").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(dashboardTakeLimit);
  branches.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  departments.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  return {
    branches,
    departments,
    branchById: new Map(branches.map((branch) => [branch._id, branch])),
    departmentById: new Map(departments.map((department) => [department._id, department])),
  };
}

async function allowedOrgIds(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  dashboardRole: DashboardRole,
  viewerMembershipId: Id<"companyMemberships">,
  org: Awaited<ReturnType<typeof loadOrg>>,
  assignedBranchIds: Set<Id<"branches">>,
  assignedDepartmentIds: Set<Id<"departments">>,
) {
  if (dashboardRole === "Admin") {
    return {
      branchIds: new Set(org.branches.map((branch) => branch._id)),
      departmentIds: new Set(org.departments.map((department) => department._id)),
    };
  }

  if (dashboardRole === "Manager") {
    const branchIds = new Set<Id<"branches">>();
    const departmentIds = new Set<Id<"departments">>();
    const managedBranches = await ctx.db.query("managerBranchScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", viewerMembershipId)).take(dashboardTakeLimit);
    const managedDepartments = await ctx.db.query("managerDepartmentScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", viewerMembershipId)).take(dashboardTakeLimit);
    for (const row of managedBranches) if (row.companyId === companyId) branchIds.add(row.branchId);
    for (const row of managedDepartments) if (row.companyId === companyId) departmentIds.add(row.departmentId);
    for (const department of org.departments) if (branchIds.has(department.branchId)) departmentIds.add(department._id);
    for (const departmentId of departmentIds) {
      const department = org.departmentById.get(departmentId);
      if (department) branchIds.add(department.branchId);
    }
    return { branchIds, departmentIds };
  }

  return { branchIds: new Set(assignedBranchIds), departmentIds: new Set(assignedDepartmentIds) };
}

function assigneeOrg(assigneeIds: Id<"companyMemberships">[], assignments: Map<Id<"companyMemberships">, OrgAssignments>) {
  const branchIds = new Set<Id<"branches">>();
  const departmentIds = new Set<Id<"departments">>();
  for (const assigneeId of assigneeIds) {
    const row = assignments.get(assigneeId);
    if (!row) continue;
    for (const branchId of row.branchIds) branchIds.add(branchId);
    for (const departmentId of row.departmentIds) departmentIds.add(departmentId);
  }
  return { branchIds: Array.from(branchIds), departmentIds: Array.from(departmentIds) };
}

function currentJdStatus(task: Doc<"jdTasks">, completion: Doc<"jdTaskCompletions"> | null, now: number, timeZone?: string | null) {
  const cycle = currentJdCycle(task.recurrence, now, timeZone);
  const status: ManualStatus = completion || (task.statusCycleStart === cycle.start && task.status === "completed") ? "completed" : task.statusCycleStart === cycle.start ? task.status : "due";
  return { cycle, status };
}

function currentOneTimeStatus(task: Doc<"oneTimeTasks">, now: number): DashboardStatus {
  return task.status !== "completed" && (Boolean(task.overdueAt) || Boolean(task.dueDate && task.dueDate < now)) ? "overdue" : task.status;
}

function matchesDashboardFilters(task: DashboardTask, args: DashboardArgs) {
  if (args.taskType && args.taskType !== "all" && task.kind !== args.taskType) return false;
  if (args.status && args.status !== "all" && task.status !== args.status) return false;
  if (args.priority && args.priority !== "all" && task.priority !== args.priority) return false;
  if (args.frequency && args.frequency !== "all" && task.frequency !== args.frequency) return false;
  if (args.membershipId && !task.assigneeIds.includes(args.membershipId)) return false;
  if (args.branchId && !task.branchIds.includes(args.branchId)) return false;
  if (args.departmentId && !task.departmentIds.includes(args.departmentId)) return false;
  return true;
}

async function buildTasks(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  allowedMembershipIds: Set<Id<"companyMemberships">>,
  assignments: Map<Id<"companyMemberships">, OrgAssignments>,
  now: number,
  timeZone?: string | null,
) {
  const tasks: DashboardTask[] = [];
  const completionEvents: CompletionEvent[] = [];
  const missedEvents: MissedEvent[] = [];

  const jdTasks = await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(dashboardTakeLimit);
  for (const task of jdTasks) {
    const scopedAssignees = visibleAssigneeMembershipIds(task.assigneeMembershipIds, allowedMembershipIds);
    if (!scopedAssignees.length) continue;

    const cycle = currentJdCycle(task.recurrence, now, timeZone);
    const currentCompletion = await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", task._id).eq("cycleStart", cycle.start)).unique();
    const state = currentJdStatus(task, currentCompletion, now, timeZone);
    const org = assigneeOrg(scopedAssignees, assignments);
    const completedAt = currentCompletion?.completedAt ?? null;
    const row: DashboardTask = {
      id: task._id,
      kind: "jd",
      title: task.title,
      status: state.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      dueAt: state.cycle.end,
      overdueAt: null,
      completedAt,
      isLate: false,
      priority: null,
      frequency: task.recurrence,
      assigneeIds: scopedAssignees,
      branchIds: org.branchIds,
      departmentIds: org.departmentIds,
    };
    tasks.push(row);

    const completions = await ctx.db.query("jdTaskCompletions").withIndex("by_task", (q) => q.eq("jdTaskId", task._id)).take(dashboardTakeLimit);
    for (const completion of completions) {
      if (!allowedMembershipIds.has(completion.completedByMembershipId)) continue;
      completionEvents.push({
        taskId: task._id,
        kind: "jd",
        title: task.title,
        at: completion.completedAt,
        byMembershipId: completion.completedByMembershipId,
        isLate: false,
      });
    }

    const missed = await ctx.db.query("jdTaskCycleRecords").withIndex("by_task", (q) => q.eq("jdTaskId", task._id)).take(dashboardTakeLimit);
    for (const record of missed) missedEvents.push({ taskId: task._id, title: task.title, at: record.cycleEnd });
  }

  const oneTimeTasks = await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(dashboardTakeLimit);
  for (const task of oneTimeTasks) {
    const scopedAssignees = visibleAssigneeMembershipIds(task.assigneeMembershipIds, allowedMembershipIds);
    if (!scopedAssignees.length) continue;
    const org = assigneeOrg(scopedAssignees, assignments);
    const status = currentOneTimeStatus(task, now);
    const completedAt = task.completedAt ?? null;
    const completedByMembershipId = task.completedByMembershipId ?? null;
    const row: DashboardTask = {
      id: task._id,
      kind: "one_time",
      title: task.title,
      status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      dueAt: task.dueDate ?? null,
      overdueAt: task.overdueAt ?? (status === "overdue" ? task.dueDate ?? null : null),
      completedAt,
      isLate: Boolean(completedAt && task.dueDate && completedAt > task.dueDate),
      priority: task.priority,
      frequency: null,
      assigneeIds: scopedAssignees,
      branchIds: org.branchIds,
      departmentIds: org.departmentIds,
    };
    tasks.push(row);

    if (completedAt && (!completedByMembershipId || allowedMembershipIds.has(completedByMembershipId))) {
      completionEvents.push({
        taskId: task._id,
        kind: "one_time",
        title: task.title,
        at: completedAt,
        byMembershipId: completedByMembershipId,
        isLate: row.isLate,
      });
    }
  }

  return { tasks, completionEvents, missedEvents };
}

function assertAllowedFilters(args: DashboardArgs, role: DashboardRole, scopedIds: Set<Id<"companyMemberships">>, branchIds: Set<Id<"branches">>, departmentIds: Set<Id<"departments">>, viewerId: Id<"companyMemberships">) {
  if (args.membershipId && !scopedIds.has(args.membershipId)) throw new ConvexError("Employee filter is outside your analytics scope.");
  if (role === "Employee" && args.membershipId && args.membershipId !== viewerId) throw new ConvexError("Employee filter is outside your analytics scope.");
  if (role === "Employee" && (args.branchId || args.departmentId)) throw new ConvexError("Team filters are not available for your dashboard.");
  if (args.branchId && !branchIds.has(args.branchId)) throw new ConvexError("Branch filter is outside your analytics scope.");
  if (args.departmentId && !departmentIds.has(args.departmentId)) throw new ConvexError("Department filter is outside your analytics scope.");
}

function makeBreakdown<T extends string>(values: readonly T[], counts: Map<T, number>, labels: Record<T, string>) {
  return values.map((value) => ({ key: value, label: labels[value], value: counts.get(value) ?? 0 }));
}

function bucketLabel(ms: number) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(ms));
}

function buildTrend(tasks: DashboardTask[], completionEvents: CompletionEvent[], missedEvents: MissedEvent[], start: number, end: number) {
  const span = Math.max(1, end - start);
  const rangeDays = Math.max(1, Math.round(span / dayMs));
  const bucketCount = Math.min(8, rangeDays);
  const bucketSize = Math.ceil(span / bucketCount);
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = start + index * bucketSize;
    const bucketEnd = index === bucketCount - 1 ? end : Math.min(end, bucketStart + bucketSize - 1);
    return { bucketStart, label: bucketLabel(bucketStart), start: bucketStart, end: bucketEnd, completed: 0, overdue: 0, workload: 0 };
  });
  const add = (at: number, key: "completed" | "overdue" | "workload") => {
    if (at < start || at > end) return;
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((at - start) / bucketSize)));
    buckets[index][key] += 1;
  };
  for (const event of completionEvents) add(event.at, "completed");
  for (const event of missedEvents) add(event.at, "overdue");
  for (const task of tasks) {
    add(task.createdAt, "workload");
    if (task.kind === "one_time" && task.overdueAt) add(task.overdueAt, "overdue");
  }
  return buckets.map((bucket) => ({ bucketStart: bucket.bucketStart, label: bucket.label, completed: bucket.completed, overdue: bucket.overdue, workload: bucket.workload }));
}

function buildPersonPerformance(tasks: DashboardTask[], people: Map<Id<"companyMemberships">, Person>, allowedIds: Set<Id<"companyMemberships">>) {
  const rows = new Map<Id<"companyMemberships">, { person: Person; assigned: number; completed: number; overdue: number }>();
  for (const id of allowedIds) {
    const person = people.get(id);
    if (person) rows.set(id, { person, assigned: 0, completed: 0, overdue: 0 });
  }
  for (const task of tasks) {
    for (const id of task.assigneeIds) {
      const row = rows.get(id);
      if (!row) continue;
      row.assigned += 1;
      if (task.status === "completed") row.completed += 1;
      if (task.status === "overdue") row.overdue += 1;
    }
  }
  return Array.from(rows.values())
    .filter((row) => row.assigned > 0)
    .map((row) => ({
      id: row.person._id,
      name: row.person.name,
      firstName: row.person.firstName,
      role: row.person.role,
      assigned: row.assigned,
      completed: row.completed,
      overdue: row.overdue,
      completionRate: safeRate(row.completed, row.assigned),
    }))
    .sort((a, b) => b.assigned - a.assigned || a.name.localeCompare(b.name));
}

function buildOrgPerformance<T extends Id<"branches"> | Id<"departments">>(
  tasks: DashboardTask[],
  ids: Set<T>,
  nameFor: (id: T) => { name: string; parentId: Id<"branches"> | null } | null,
  taskIdsFor: (task: DashboardTask) => T[],
) {
  const rows = new Map<T, { id: T; name: string; parentId: Id<"branches"> | null; assigned: number; completed: number; overdue: number }>();
  for (const id of ids) {
    const named = nameFor(id);
    if (named) rows.set(id, { id, name: named.name, parentId: named.parentId, assigned: 0, completed: 0, overdue: 0 });
  }
  for (const task of tasks) {
    const seen = new Set<T>();
    for (const id of taskIdsFor(task)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = rows.get(id);
      if (!row) continue;
      row.assigned += 1;
      if (task.status === "completed") row.completed += 1;
      if (task.status === "overdue") row.overdue += 1;
    }
  }
  return Array.from(rows.values())
    .filter((row) => row.assigned > 0)
    .map((row) => ({ ...row, completionRate: safeRate(row.completed, row.assigned) }))
    .sort((a, b) => b.assigned - a.assigned || a.name.localeCompare(b.name));
}

async function visibleSopStats(ctx: QueryCtx, companyId: Id<"companies">, membership: Doc<"companyMemberships">, caps: Awaited<ReturnType<typeof membershipCapabilities>>) {
  const sops = await ctx.db.query("sops").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(dashboardTakeLimit);
  const visibility = await buildSopVisibilityContext(ctx, companyId, membership, caps);
  const counts = new Map<Doc<"sops">["scopeType"], number>([
    ["company", 0],
    ["branch", 0],
    ["department", 0],
    ["user", 0],
  ]);
  let total = 0;
  for (const sop of sops) {
    if (!(await visibleSop(ctx, companyId, membership, sop, visibility, caps))) continue;
    total += 1;
    counts.set(sop.scopeType, (counts.get(sop.scopeType) ?? 0) + 1);
  }
  return {
    visible: total,
    byScope: [
      { key: "company", label: "Company", value: counts.get("company") ?? 0 },
      { key: "branch", label: "Branch", value: counts.get("branch") ?? 0 },
      { key: "department", label: "Department", value: counts.get("department") ?? 0 },
      { key: "user", label: "User", value: counts.get("user") ?? 0 },
    ],
  };
}

export const dashboard = query({
  args: {
    companyId: v.id("companies"),
    datePreset: v.optional(datePresetValidator),
    branchId: v.optional(v.id("branches")),
    departmentId: v.optional(v.id("departments")),
    membershipId: v.optional(v.id("companyMemberships")),
    taskType: v.optional(taskTypeFilterValidator),
    status: v.optional(statusFilterValidator),
    priority: v.optional(priorityFilterValidator),
    frequency: v.optional(frequencyFilterValidator),
  },
  handler: async (ctx, args: DashboardArgs) => {
    const now = Date.now();
    const range = dateWindow(args.datePreset, now);
    const access = await dashboardAccess(ctx, args.companyId);
    const people = await loadPeople(ctx, access.scopedIds);
    const assignments = await loadAssignments(ctx, access.scopedIds);
    const org = await loadOrg(ctx, args.companyId);
    const allowedOrg = await allowedOrgIds(ctx, args.companyId, access.dashboardRole, access.membership._id, org, assignments.branchIds, assignments.departmentIds);

    assertAllowedFilters(args, access.dashboardRole, access.scopedIds, allowedOrg.branchIds, allowedOrg.departmentIds, access.membership._id);

    const built = await buildTasks(ctx, args.companyId, access.scopedIds, assignments.byMembership, now, access.company.timeZone);
    const filteredTasks = built.tasks.filter((task) => matchesDashboardFilters(task, args));
    const filteredTaskIds = new Set(filteredTasks.map((task) => task.id));
    const completionEvents = built.completionEvents.filter((event) => filteredTaskIds.has(event.taskId) && event.at >= range.start && event.at <= range.end);
    const missedEvents = built.missedEvents.filter((event) => filteredTaskIds.has(event.taskId) && event.at >= range.start && event.at <= range.end);

    const statusCounts = new Map<DashboardStatus, number>();
    const priorityCounts = new Map<Priority, number>();
    const frequencyCounts = new Map<Frequency, number>();
    const typeCounts = new Map<TaskKind, number>();
    for (const task of filteredTasks) {
      statusCounts.set(task.status, (statusCounts.get(task.status) ?? 0) + 1);
      typeCounts.set(task.kind, (typeCounts.get(task.kind) ?? 0) + 1);
      if (task.priority) priorityCounts.set(task.priority, (priorityCounts.get(task.priority) ?? 0) + 1);
      if (task.frequency) frequencyCounts.set(task.frequency, (frequencyCounts.get(task.frequency) ?? 0) + 1);
    }

    const totalTasks = filteredTasks.length;
    const completedTasks = statusCounts.get("completed") ?? 0;
    const overdueTasks = statusCounts.get("overdue") ?? 0;
    const inProgressTasks = statusCounts.get("in_progress") ?? 0;
    const notStartedTasks = statusCounts.get("due") ?? 0;
    const openTasks = totalTasks - completedTasks;
    const lateCompletions = completionEvents.filter((event) => event.isLate).length;
    const jdCompletions = completionEvents.filter((event) => event.kind === "jd").length;
    const jdMissedCycles = missedEvents.length;
    const personPerformance = access.dashboardRole === "Employee" ? [] : buildPersonPerformance(filteredTasks, people, access.scopedIds);
    const topPerformers = personPerformance
      .filter((row) => row.assigned > 0)
      .sort((a, b) => b.completionRate - a.completionRate || b.completed - a.completed || a.overdue - b.overdue || a.name.localeCompare(b.name))
      .slice(0, 5);
    const needsAttention = personPerformance
      .filter((row) => row.overdue > 0 || (row.assigned >= 3 && row.completionRate < 70))
      .sort((a, b) => b.overdue - a.overdue || a.completionRate - b.completionRate || b.assigned - a.assigned)
      .slice(0, 5);

    const branchPerformance = access.dashboardRole === "Employee" ? [] : buildOrgPerformance(
      filteredTasks,
      allowedOrg.branchIds,
      (id) => {
        const branch = org.branchById.get(id);
        return branch ? { name: branch.name, parentId: null } : null;
      },
      (task) => task.branchIds as Id<"branches">[],
    );
    const departmentIdsForPerformance = new Set(Array.from(allowedOrg.departmentIds).filter((id) => {
      if (!args.branchId) return true;
      return org.departmentById.get(id)?.branchId === args.branchId;
    }));
    const departmentPerformance = access.dashboardRole === "Employee" ? [] : buildOrgPerformance(
      filteredTasks,
      departmentIdsForPerformance,
      (id) => {
        const department = org.departmentById.get(id);
        return department ? { name: department.name, parentId: department.branchId } : null;
      },
      (task) => task.departmentIds as Id<"departments">[],
    );
    const sopStats = await visibleSopStats(ctx, args.companyId, access.membership, access.caps);
    const viewer = people.get(access.membership._id);

    const branches = access.dashboardRole === "Employee" ? [] : org.branches
      .filter((branch) => allowedOrg.branchIds.has(branch._id))
      .map((branch) => ({ _id: branch._id, name: branch.name }));
    const departments = access.dashboardRole === "Employee" ? [] : org.departments
      .filter((department) => allowedOrg.departmentIds.has(department._id))
      .map((department) => ({ _id: department._id, branchId: department.branchId, name: department.name, branchName: org.branchById.get(department.branchId)?.name ?? "Unknown branch" }));
    const employees = access.dashboardRole === "Employee" ? [] : Array.from(people.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((person) => {
        const orgRow = assignments.byMembership.get(person._id);
        return {
          _id: person._id,
          name: person.name,
          firstName: person.firstName,
          role: person.role,
          branchIds: Array.from(orgRow?.branchIds ?? []),
          departmentIds: Array.from(orgRow?.departmentIds ?? []),
        };
      });

    const recentCompletions = completionEvents
      .slice()
      .sort((a, b) => b.at - a.at)
      .slice(0, 8)
      .map((event) => {
        const actor = event.byMembershipId ? people.get(event.byMembershipId) : null;
        return {
          id: `${event.kind}:${event.taskId}:${event.at}`,
          kind: event.kind,
          title: event.title,
          completedAt: event.at,
          actorName: actor ? actor.name : null,
        };
      });
    const recentAudit = access.dashboardRole === "Admin"
      ? (await ctx.db.query("auditEvents").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").take(6)).map((event) => ({
        id: event._id,
        action: event.action,
        targetType: event.targetType,
        createdAt: event.createdAt,
      }))
      : [];

    return {
      role: access.dashboardRole,
      viewer: {
        membershipId: access.membership._id,
        role: access.membership.role,
        name: viewer?.name ?? "You",
        firstName: viewer?.firstName ?? "You",
      },
      company: { _id: access.company._id, name: access.company.name, timeZone: access.company.timeZone ?? null },
      generatedAt: now,
      range,
      appliedFilters: {
        branchId: args.branchId ?? null,
        departmentId: args.departmentId ?? null,
        membershipId: args.membershipId ?? null,
        taskType: args.taskType ?? "all",
        status: args.status ?? "all",
        priority: args.priority ?? "all",
        frequency: args.frequency ?? "all",
      },
      filterOptions: { branches, departments, employees },
      scope: {
        people: access.scopedIds.size,
        branches: access.dashboardRole === "Employee" ? 0 : branches.length,
        departments: access.dashboardRole === "Employee" ? 0 : departments.length,
      },
      metrics: {
        totalTasks,
        completedTasks,
        completionRate: safeRate(completedTasks, totalTasks),
        openTasks,
        periodCompletions: completionEvents.length,
        notStartedTasks,
        inProgressTasks,
        overdueTasks,
        oneTimeTasks: typeCounts.get("one_time") ?? 0,
        recurringTasks: typeCounts.get("jd") ?? 0,
        lateCompletions,
        lateCompletionRate: safeRate(lateCompletions, completionEvents.filter((event) => event.kind === "one_time").length),
      },
      breakdowns: {
        status: makeBreakdown(["due", "in_progress", "completed", "overdue"] as const, statusCounts, { due: "Not started", in_progress: "In progress", completed: "Completed", overdue: "Overdue" }),
        priority: makeBreakdown(["high", "medium", "low"] as const, priorityCounts, { high: "High", medium: "Medium", low: "Low" }),
        frequency: makeBreakdown(["daily", "every_other_day", "weekly", "semimonthly", "monthly", "semiannually", "annually"] as const, frequencyCounts, { daily: "Daily", every_other_day: "Alternate days", weekly: "Weekly", semimonthly: "Semi-monthly", monthly: "Monthly", semiannually: "Bi-yearly", annually: "Yearly" }),
        type: makeBreakdown(["one_time", "jd"] as const, typeCounts, { one_time: "One-time", jd: "JD / recurring" }),
      },
      jdCycleHealth: {
        completedCycles: jdCompletions,
        missedCycles: jdMissedCycles,
        healthyRate: safeRate(jdCompletions, jdCompletions + jdMissedCycles),
      },
      sopStats,
      trends: buildTrend(filteredTasks, completionEvents, missedEvents, range.start, range.end),
      comparisons: {
        branches: branchPerformance.slice(0, 12),
        departments: departmentPerformance.slice(0, 12),
        employees: personPerformance.slice(0, 12),
        topPerformers,
        needsAttention,
      },
      recent: {
        completions: recentCompletions,
        audit: recentAudit,
      },
      limitations: {
        sopCompliance: false,
        lateJdCompletionRate: false,
      },
    };
  },
});

async function analyticsSummary(ctx: QueryCtx, args: { companyId: Id<"companies"> }) {
  const { membership } = await requireMembership(ctx, args.companyId);
  const caps = await membershipCapabilities(ctx, membership);
  assertAnalyticsViewAccess(caps);
  const scoped = await analyticsScopedMembershipIds(ctx, args.companyId, membership, caps);
  const jd = await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(dashboardTakeLimit);
  const one = await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(dashboardTakeLimit);
  const visibleJd = jd.filter((task) => taskHasVisibleAssignee(task, scoped));
  const visibleOne = one.filter((task) => taskHasVisibleAssignee(task, scoped));
  const overdueOne = visibleOne.filter((t) => t.status !== "completed" && (t.overdueAt || (t.dueDate && t.dueDate < Date.now()))).length;
  const completedOne = visibleOne.filter((t) => t.status === "completed").length;
  const sops = await ctx.db.query("sops").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(dashboardTakeLimit);
  const sopVisibility = await buildSopVisibilityContext(ctx, args.companyId, membership, caps);
  let sopCount = 0;
  for (const sop of sops) if (await visibleSop(ctx, args.companyId, membership, sop, sopVisibility, caps)) sopCount++;
  const recent = membership.role === "Admin"
    ? (await ctx.db.query("auditEvents").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").take(8)).map((event) => ({ _id: event._id, action: event.action, targetType: event.targetType, createdAt: event.createdAt }))
    : [];
  return { role: membership.role, scopeSize: scoped.size, jdTaskCount: visibleJd.length, oneTimeTaskCount: visibleOne.length, overdueTasks: overdueOne, completionRate: visibleOne.length ? Math.round(completedOne / visibleOne.length * 100) : 100, sopCount, recent };
}

export const summary = query({
  args: { companyId: v.id("companies") },
  handler: analyticsSummary,
});

export const aiSummary = query({
  args: { companyId: v.id("companies") },
  handler: analyticsSummary,
});
