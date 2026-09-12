import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { analyticsScopedMembershipIds, assertAnalyticsViewAccess, buildSopVisibilityContext, membershipCapabilities, requireMembership, taskHasVisibleAssignee, visibleAssigneeMembershipIds, visibleSop } from "./permissions";
import { currentJdCycle, elapsedJdCyclesSince, nextJdCycleStart } from "./taskCycles";
import { bucketIndexFor, buildDashboardBuckets, dashboardRangeValidator, resolveDashboardRange } from "./dashboardTime";
import type { Doc, Id } from "./_generated/dataModel";
import { takeWithOverflow } from "./queryLimits";

type DashboardScope = "company" | "managed" | "self";

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

const dashboardTakeLimit = 500;

type QueryCompleteness = { isTruncated: boolean };

async function takeDashboardRows<T>(
  completeness: QueryCompleteness,
  take: (limit: number) => Promise<T[]>,
) {
  const result = await takeWithOverflow(take, dashboardTakeLimit);
  if (result.isTruncated) completeness.isTruncated = true;
  return result.rows;
}

function firstName(membership: { firstName?: string } | null | undefined, user: Doc<"appUsers">) {
  return membership?.firstName?.trim() || user.firstName.trim() || "Unknown";
}

function fullName(membership: { firstName?: string; secondName?: string } | null | undefined, user: Doc<"appUsers">) {
  const first = firstName(membership, user);
  const second = membership?.secondName !== undefined ? membership.secondName.trim() : (user.secondName?.trim() ?? "");
  return [first === "Unknown" ? "" : first, second].filter(Boolean).join(" ") || first;
}

function safeRate(part: number, total: number) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

async function dashboardAccess(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  completeness: QueryCompleteness,
) {
  const { membership, company } = await requireMembership(ctx, companyId);
  const caps = await membershipCapabilities(ctx, membership);
  assertAnalyticsViewAccess(caps);

  const dashboardScope: DashboardScope = caps.has("analytics:view:company") ? "company" : caps.has("analytics:view:managed_scope") ? "managed" : "self";
  const scopedIds = await analyticsScopedMembershipIds(
    ctx,
    companyId,
    membership,
    caps,
    () => { completeness.isTruncated = true; },
  );
  return { membership, company, caps, dashboardScope, scopedIds };
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
      name: fullName(membership, user),
      firstName: firstName(membership, user),
      imageUrl: user.imageUrl ?? null,
    });
  }
  return people;
}

async function loadAssignments(
  ctx: QueryCtx,
  membershipIds: Set<Id<"companyMemberships">>,
  completeness: QueryCompleteness,
) {
  const byMembership = new Map<Id<"companyMemberships">, OrgAssignments>();

  for (const membershipId of membershipIds) {
    const membershipBranches = await takeDashboardRows(
      completeness,
      (limit) => ctx.db.query("userBranchAssignments").withIndex("by_membership", (q) => q.eq("membershipId", membershipId)).take(limit),
    );
    const membershipDepartments = await takeDashboardRows(
      completeness,
      (limit) => ctx.db.query("userDepartmentAssignments").withIndex("by_membership", (q) => q.eq("membershipId", membershipId)).take(limit),
    );
    byMembership.set(membershipId, {
      branchIds: new Set(membershipBranches.map((row) => row.branchId)),
      departmentIds: new Set(membershipDepartments.map((row) => row.departmentId)),
    });
  }

  return { byMembership };
}

async function loadOrg(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  completeness: QueryCompleteness,
) {
  const branches = await takeDashboardRows(
    completeness,
    (limit) => ctx.db.query("branches").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(limit),
  );
  const departments = await takeDashboardRows(
    completeness,
    (limit) => ctx.db.query("departments").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(limit),
  );
  branches.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  departments.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  return {
    branches,
    departments,
    branchById: new Map(branches.map((branch) => [branch._id, branch])),
    departmentById: new Map(departments.map((department) => [department._id, department])),
  };
}

/**
 * Loads everything the dashboard endpoints share: the caller's analytics
 * scope, the people and org units inside it, and the branch/department
 * options the caller is allowed to filter by. Branch options never expand
 * through department scopes — only direct manager branch scopes apply.
 */
async function resolveDashboardScope(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  completeness: QueryCompleteness,
) {
  const { membership, company, dashboardScope, scopedIds } = await dashboardAccess(ctx, companyId, completeness);
  const people = await loadPeople(ctx, scopedIds);
  const assignments = await loadAssignments(ctx, scopedIds, completeness);
  const org = await loadOrg(ctx, companyId, completeness);

  const memberBranchIds = new Map<Id<"companyMemberships">, Set<Id<"branches">>>();
  const memberDepartmentIds = new Map<Id<"companyMemberships">, Set<Id<"departments">>>();
  for (const [membershipId, assigned] of assignments.byMembership) {
    const branchIds = new Set(assigned.branchIds);
    for (const departmentId of assigned.departmentIds) {
      const department = org.departmentById.get(departmentId);
      if (department) branchIds.add(department.branchId);
    }
    memberBranchIds.set(membershipId, branchIds);
    memberDepartmentIds.set(membershipId, new Set(assigned.departmentIds));
  }

  let branchOptions: Doc<"branches">[] = [];
  let departmentOptions: Doc<"departments">[] = [];
  if (dashboardScope === "company") {
    branchOptions = org.branches;
    departmentOptions = org.departments;
  } else if (dashboardScope === "managed") {
    const managedBranches = await takeDashboardRows(
      completeness,
      (limit) => ctx.db.query("managerBranchScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", membership._id)).take(limit),
    );
    const managedDepartments = await takeDashboardRows(
      completeness,
      (limit) => ctx.db.query("managerDepartmentScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", membership._id)).take(limit),
    );
    const branchScope = new Set(managedBranches.filter((row) => row.companyId === companyId).map((row) => row.branchId));
    const departmentScope = new Set(managedDepartments.filter((row) => row.companyId === companyId).map((row) => row.departmentId));
    branchOptions = org.branches.filter((branch) => branchScope.has(branch._id));
    departmentOptions = org.departments.filter((department) => branchScope.has(department.branchId) || departmentScope.has(department._id));
  }

  return { membership, company, dashboardScope, scopedIds, people, assignments, org, branchOptions, departmentOptions, memberBranchIds, memberDepartmentIds };
}

export const dashboardFilters = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const completeness: QueryCompleteness = { isTruncated: false };
    const scope = await resolveDashboardScope(ctx, args.companyId, completeness);
    const users = scope.dashboardScope === "self"
      ? []
      : Array.from(scope.people.values())
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((person) => ({
            _id: person._id,
            name: person.name,
            branchIds: Array.from(scope.memberBranchIds.get(person._id) ?? []),
            departmentIds: Array.from(scope.memberDepartmentIds.get(person._id) ?? []),
          }));
    return {
      viewer: { membershipId: scope.membership._id },
      branches: scope.branchOptions.map((branch) => ({ _id: branch._id, name: branch.name })),
      departments: scope.departmentOptions.map((department) => ({ _id: department._id, name: department.name, branchId: department.branchId })),
      users,
    };
  },
});

type WorkItem = {
  kind: "jd" | "task";
  at: number;
  completed: boolean;
  assigneeIds: Id<"companyMemberships">[];
};

export const dashboard = query({
  args: {
    companyId: v.id("companies"),
    now: v.number(),
    range: dashboardRangeValidator,
    branchId: v.optional(v.id("branches")),
    departmentId: v.optional(v.id("departments")),
    membershipId: v.optional(v.id("companyMemberships")),
  },
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.now)) throw new ConvexError("Invalid time.");
    const now = args.now;
    const completeness: QueryCompleteness = { isTruncated: false };
    const scope = await resolveDashboardScope(ctx, args.companyId, completeness);
    const timeZone = scope.company.timeZone ?? null;

    if (scope.dashboardScope === "self" && (args.branchId || args.departmentId)) {
      throw new ConvexError("Team filters are not available for your dashboard.");
    }
    if (args.membershipId && !scope.scopedIds.has(args.membershipId)) {
      throw new ConvexError("Employee filter is outside your analytics scope.");
    }
    const branchOptionIds = new Set(scope.branchOptions.map((branch) => branch._id));
    const departmentOptionsById = new Map(scope.departmentOptions.map((department) => [department._id, department]));
    if (args.branchId && !branchOptionIds.has(args.branchId)) {
      throw new ConvexError("Branch filter is outside your analytics scope.");
    }
    const filteredDepartment = args.departmentId ? departmentOptionsById.get(args.departmentId) : undefined;
    if (args.departmentId && !filteredDepartment) {
      throw new ConvexError("Department filter is outside your analytics scope.");
    }
    if (args.branchId && filteredDepartment && filteredDepartment.branchId !== args.branchId) {
      throw new ConvexError("Department filter is outside your analytics scope.");
    }

    const effectiveIds = new Set<Id<"companyMemberships">>();
    for (const id of scope.scopedIds) {
      if (args.branchId && !scope.memberBranchIds.get(id)?.has(args.branchId)) continue;
      if (args.departmentId && !scope.memberDepartmentIds.get(id)?.has(args.departmentId)) continue;
      if (args.membershipId && id !== args.membershipId) continue;
      effectiveIds.add(id);
    }

    const range = resolveDashboardRange(args.range, now, timeZone);
    const buckets = buildDashboardBuckets(range, timeZone);

    const items: WorkItem[] = [];

    const jdTasks = await takeDashboardRows(
      completeness,
      (limit) => ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(limit),
    );
    for (const task of jdTasks) {
      const assignees = visibleAssigneeMembershipIds(task.assigneeMembershipIds, effectiveIds);
      if (!assignees.length) continue;

      const lowerBound = currentJdCycle(task.recurrence, range.start, timeZone).start;
      const cycles = new Map<number, { dueAt: number; completed: boolean }>();
      const put = (start: number, dueAt: number, completed: boolean) => {
        const existing = cycles.get(start);
        cycles.set(start, { dueAt, completed: (existing?.completed ?? false) || completed });
      };

      const completions = await takeDashboardRows(
        completeness,
        (limit) => ctx.db.query("jdTaskCompletions").withIndex("by_task_and_completedAt", (q) => q.eq("jdTaskId", task._id).gte("completedAt", lowerBound).lte("completedAt", range.end)).take(limit),
      );
      for (const completion of completions) {
        put(completion.cycleStart, nextJdCycleStart(completion.cycleStart, task.recurrence, timeZone) - 1, true);
      }

      const missed = await takeDashboardRows(
        completeness,
        (limit) => ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", task._id).gte("cycleStart", lowerBound).lte("cycleStart", range.end)).take(limit),
      );
      for (const record of missed) put(record.cycleStart, record.cycleEnd - 1, false);

      for (const cycle of elapsedJdCyclesSince(task.recurrence, task.cycleStartedAt, now, 200, timeZone).cycles) {
        put(cycle.start, cycle.end - 1, false);
      }

      const current = currentJdCycle(task.recurrence, now, timeZone);
      const currentDone = Boolean(cycles.get(current.start)?.completed) || (task.statusCycleStart === current.start && task.status === "completed");
      put(current.start, current.end - 1, currentDone);

      for (const [start, cycle] of cycles) {
        if (start <= now && cycle.dueAt >= range.start && cycle.dueAt <= range.end) {
          items.push({ kind: "jd", at: cycle.dueAt, completed: cycle.completed, assigneeIds: assignees });
        }
      }
    }

    const oneTimeTasks = await takeDashboardRows(
      completeness,
      (limit) => ctx.db.query("oneTimeTasks").withIndex("by_companyId_and_createdAt", (q) => q.eq("companyId", args.companyId).gte("createdAt", range.start).lte("createdAt", range.end)).take(limit),
    );
    for (const task of oneTimeTasks) {
      const assignees = visibleAssigneeMembershipIds(task.assigneeMembershipIds, effectiveIds);
      if (!assignees.length) continue;
      items.push({ kind: "task", at: task.createdAt, completed: task.status === "completed", assigneeIds: assignees });
    }

    let jdDue = 0;
    let jdCompleted = 0;
    let tasksAssigned = 0;
    let tasksCompleted = 0;
    const trend = buckets.map((bucket) => ({
      bucketStart: bucket.start,
      label: bucket.label,
      jdDue: 0,
      jdCompleted: 0,
      tasksAssigned: 0,
      tasksCompleted: 0,
    }));
    for (const item of items) {
      const bucketIndex = bucketIndexFor(buckets, item.at);
      const bucket = bucketIndex === -1 ? undefined : trend[bucketIndex];
      if (item.kind === "jd") {
        jdDue += 1;
        if (item.completed) jdCompleted += 1;
        if (bucket) {
          bucket.jdDue += 1;
          if (item.completed) bucket.jdCompleted += 1;
        }
      } else {
        tasksAssigned += 1;
        if (item.completed) tasksCompleted += 1;
        if (bucket) {
          bucket.tasksAssigned += 1;
          if (item.completed) bucket.tasksCompleted += 1;
        }
      }
    }

    const singleMember = scope.scopedIds.size <= 1 || scope.dashboardScope === "self";
    let level: "company" | "branch" | "department" | "user";
    let groupKind: "branch" | "department" | null = null;
    let groupCandidates: (Doc<"branches"> | Doc<"departments">)[] = [];
    if (args.membershipId || singleMember) {
      level = "user";
    } else if (args.departmentId) {
      level = "department";
    } else {
      const branchCandidates = args.branchId ? [] : scope.branchOptions;
      if (branchCandidates.length >= 2) {
        level = "company";
        groupKind = "branch";
        groupCandidates = branchCandidates;
      } else {
        const departmentCandidates = scope.departmentOptions.filter((department) => !args.branchId || department.branchId === args.branchId);
        if (departmentCandidates.length >= 2) {
          level = "branch";
          groupKind = "department";
          groupCandidates = departmentCandidates;
        } else {
          level = "department";
        }
      }
    }

    const employeeTotals = new Map<Id<"companyMemberships">, { id: Id<"companyMemberships">; name: string; jdDue: number; jdCompleted: number; tasksAssigned: number; tasksCompleted: number }>();
    if (level !== "user") {
      for (const id of effectiveIds) {
        const person = scope.people.get(id);
        if (person) employeeTotals.set(id, { id, name: person.name, jdDue: 0, jdCompleted: 0, tasksAssigned: 0, tasksCompleted: 0 });
      }
      for (const item of items) {
        for (const assigneeId of item.assigneeIds) {
          const row = employeeTotals.get(assigneeId);
          if (!row) continue;
          if (item.kind === "jd") {
            row.jdDue += 1;
            if (item.completed) row.jdCompleted += 1;
          } else {
            row.tasksAssigned += 1;
            if (item.completed) row.tasksCompleted += 1;
          }
        }
      }
    }
    const employees = Array.from(employeeTotals.values())
      .map((row) => {
        const total = row.jdDue + row.tasksAssigned;
        const completed = row.jdCompleted + row.tasksCompleted;
        return { ...row, total, completed, completionRate: safeRate(completed, total) };
      })
      .filter((row) => row.total > 0)
      .sort((a, b) => b.completionRate - a.completionRate || b.total - a.total || a.name.localeCompare(b.name))
      .slice(0, 5);

    let groups: { kind: "branch" | "department"; rows: { id: string; name: string; total: number; completed: number; completionRate: number }[] } | null = null;
    if (groupKind) {
      const memberSets: ReadonlyMap<Id<"companyMemberships">, ReadonlySet<string>> = groupKind === "branch" ? scope.memberBranchIds : scope.memberDepartmentIds;
      const rows = groupCandidates
        .map((candidate) => {
          let total = 0;
          let completed = 0;
          for (const item of items) {
            if (!item.assigneeIds.some((id) => memberSets.get(id)?.has(candidate._id))) continue;
            total += 1;
            if (item.completed) completed += 1;
          }
          return { id: candidate._id as string, name: candidate.name, total, completed, completionRate: safeRate(completed, total) };
        })
        .filter((row) => row.total > 0)
        .sort((a, b) => b.completionRate - a.completionRate || b.total - a.total || a.name.localeCompare(b.name))
        .slice(0, 5);
      groups = { kind: groupKind, rows };
    }

    return {
      isTruncated: completeness.isTruncated,
      level,
      range: { start: range.start, end: range.end, grouping: range.grouping },
      jd: { due: jdDue, completed: jdCompleted, outstanding: jdDue - jdCompleted, completionRate: safeRate(jdCompleted, jdDue) },
      tasks: { assigned: tasksAssigned, completed: tasksCompleted, open: tasksAssigned - tasksCompleted, completionRate: safeRate(tasksCompleted, tasksAssigned) },
      trend,
      rankings: { employees, groups },
    };
  },
});

async function analyticsSummary(ctx: QueryCtx, args: { companyId: Id<"companies"> }) {
  const { membership } = await requireMembership(ctx, args.companyId);
  const caps = await membershipCapabilities(ctx, membership);
  assertAnalyticsViewAccess(caps);
  const completeness: QueryCompleteness = { isTruncated: false };
  const scoped = await analyticsScopedMembershipIds(
    ctx,
    args.companyId,
    membership,
    caps,
    () => { completeness.isTruncated = true; },
  );
  const jd = await takeDashboardRows(
    completeness,
    (limit) => ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(limit),
  );
  const one = await takeDashboardRows(
    completeness,
    (limit) => ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(limit),
  );
  const visibleJd = jd.filter((task) => taskHasVisibleAssignee(task, scoped));
  const visibleOne = one.filter((task) => taskHasVisibleAssignee(task, scoped));
  const overdueOne = visibleOne.filter((t) => t.status !== "completed" && (t.overdueAt || (t.dueDate && t.dueDate < Date.now()))).length;
  const completedOne = visibleOne.filter((t) => t.status === "completed").length;
  const sops = await takeDashboardRows(
    completeness,
    (limit) => ctx.db.query("sops").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(limit),
  );
  const markTruncated = () => { completeness.isTruncated = true; };
  const sopVisibility = sops.length
    ? await buildSopVisibilityContext(ctx, args.companyId, membership, caps, markTruncated)
    : null;
  let sopCount = 0;
  for (const sop of sops) if (await visibleSop(ctx, args.companyId, membership, sop, sopVisibility, caps, markTruncated)) sopCount++;
  const recent = caps.has("company:view_audit_log")
    ? (await ctx.db.query("auditEvents").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").take(8)).map((event) => ({ _id: event._id, action: event.action, targetType: event.targetType, createdAt: event.createdAt }))
    : [];
  return {
    role: membership.role,
    scopeSize: scoped.size,
    jdTaskCount: visibleJd.length,
    oneTimeTaskCount: visibleOne.length,
    overdueTasks: overdueOne,
    completionRate: visibleOne.length ? Math.round(completedOne / visibleOne.length * 100) : 100,
    sopCount,
    recent,
    isTruncated: completeness.isTruncated,
    isComplete: !completeness.isTruncated,
  };
}

export const summary = query({
  args: { companyId: v.id("companies") },
  handler: analyticsSummary,
});

export const aiSummary = query({
  args: { companyId: v.id("companies") },
  handler: analyticsSummary,
});
