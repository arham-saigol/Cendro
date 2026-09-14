/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { defaultRoleCapabilities } from "../src/lib/permissions";
import { currentJdCycle, defaultTimeZone } from "./taskCycles";

const modules = import.meta.glob("./**/*.ts");
const dayMs = 86_400_000;
const defaultRange = { preset: "last_3_months" } as const;

const dateFieldParts = new Intl.DateTimeFormat("en-US", { timeZone: defaultTimeZone, year: "numeric", month: "2-digit", day: "2-digit" });
function dateField(ms: number) {
  const parts = Object.fromEntries(dateFieldParts.formatToParts(ms).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function identity(key: string, email = `${key}@example.com`) {
  return { tokenIdentifier: `clerk|${key}`, subject: key, issuer: "https://clerk.test", email, name: key };
}

async function seedDashboardCompany() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const companyId = await ctx.db.insert("companies", { name: "Acme", createdAt: now });
    const branchAId = await ctx.db.insert("branches", { companyId, name: "North", order: 0, createdAt: now, updatedAt: now });
    const branchBId = await ctx.db.insert("branches", { companyId, name: "South", order: 1, createdAt: now, updatedAt: now });
    const departmentAId = await ctx.db.insert("departments", { companyId, branchId: branchAId, name: "Ops", order: 0, createdAt: now, updatedAt: now });
    const departmentA2Id = await ctx.db.insert("departments", { companyId, branchId: branchAId, name: "Support", order: 1, createdAt: now, updatedAt: now });
    const departmentBId = await ctx.db.insert("departments", { companyId, branchId: branchBId, name: "Finance", order: 0, createdAt: now, updatedAt: now });
    const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", secondName: "", createdAt: now, updatedAt: now });
    const managerUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|manager", email: "manager@example.com", firstName: "Manager", secondName: "", createdAt: now, updatedAt: now });
    const employeeUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|employee", email: "employee@example.com", firstName: "Employee", secondName: "", createdAt: now, updatedAt: now });
    const hiddenUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|hidden", email: "hidden@example.com", firstName: "Hidden", secondName: "", createdAt: now, updatedAt: now });
    const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
    const managerMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: managerUserId, role: "Manager", active: true, createdAt: now, updatedAt: now });
    const employeeMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: employeeUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
    const hiddenMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: hiddenUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
    await ctx.db.insert("userBranchAssignments", { companyId, membershipId: employeeMembershipId, branchId: branchAId });
    await ctx.db.insert("userDepartmentAssignments", { companyId, membershipId: employeeMembershipId, departmentId: departmentAId });
    await ctx.db.insert("userBranchAssignments", { companyId, membershipId: hiddenMembershipId, branchId: branchBId });
    await ctx.db.insert("userDepartmentAssignments", { companyId, membershipId: hiddenMembershipId, departmentId: departmentBId });
    await ctx.db.insert("managerBranchScopes", { companyId, managerMembershipId, branchId: branchAId, updatedAt: now });
    return { companyId, branchAId, branchBId, departmentAId, departmentA2Id, departmentBId, adminUserId, employeeUserId, adminMembershipId, managerMembershipId, employeeMembershipId, hiddenMembershipId };
  });

  const visibleTaskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, {
    companyId: ids.companyId,
    title: "Visible employee task",
    description: "",
    dueDate: Date.now() + dayMs,
    assigneeMembershipIds: [ids.employeeMembershipId],
    priority: "high",
  });
  const hiddenTaskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, {
    companyId: ids.companyId,
    title: "Hidden branch task",
    description: "",
    dueDate: Date.now() + dayMs,
    assigneeMembershipIds: [ids.hiddenMembershipId],
    priority: "medium",
  });
  return { t, ...ids, visibleTaskId, hiddenTaskId };
}

describe("dashboard analytics scoping", () => {
  test("admin, manager, and employee dashboards receive only their allowed analytics", { timeout: 15_000 }, async () => {
    const { t, companyId, branchAId, branchBId, departmentAId, departmentA2Id, departmentBId, employeeMembershipId, hiddenMembershipId } = await seedDashboardCompany();
    const now = Date.now();

    const admin = t.withIdentity(identity("admin"));
    const adminFilters = await admin.query(api.analytics.dashboardFilters, { companyId });
    expect(adminFilters.branches.map((branch) => branch._id)).toEqual([branchAId, branchBId]);
    expect(adminFilters.departments).toHaveLength(3);
    const adminDashboard = await admin.query(api.analytics.dashboard, { companyId, now, range: defaultRange });
    expect(adminDashboard.tasks.assigned).toBe(2);
    expect(adminDashboard.level).toBe("company");
    expect(adminDashboard.rankings.groups?.kind).toBe("branch");
    await expect(admin.query(api.analytics.dashboard, { companyId, now, range: defaultRange, branchId: branchBId })).resolves.toMatchObject({ tasks: { assigned: 1 } });

    const manager = t.withIdentity(identity("manager"));
    const managerFilters = await manager.query(api.analytics.dashboardFilters, { companyId });
    expect(managerFilters.branches.map((branch) => branch._id)).toEqual([branchAId]);
    expect(managerFilters.departments.map((department) => department._id)).toEqual([departmentAId, departmentA2Id]);
    expect(managerFilters.users.map((user) => user._id)).toContain(employeeMembershipId);
    expect(managerFilters.users.map((user) => user._id)).not.toContain(hiddenMembershipId);
    const managerDashboard = await manager.query(api.analytics.dashboard, { companyId, now, range: defaultRange });
    expect(managerDashboard.tasks.assigned).toBe(1);
    expect(managerDashboard.level).toBe("branch");
    expect(managerDashboard.rankings.groups?.kind).toBe("department");
    await expect(manager.query(api.analytics.dashboard, { companyId, now, range: defaultRange, membershipId: hiddenMembershipId })).rejects.toThrow("outside your analytics scope");
    await expect(manager.query(api.analytics.dashboard, { companyId, now, range: defaultRange, branchId: branchBId })).rejects.toThrow("outside your analytics scope");
    await expect(manager.query(api.analytics.dashboard, { companyId, now, range: defaultRange, departmentId: departmentBId })).rejects.toThrow("outside your analytics scope");

    const employee = t.withIdentity(identity("employee"));
    const employeeFilters = await employee.query(api.analytics.dashboardFilters, { companyId });
    expect(employeeFilters.branches).toEqual([]);
    expect(employeeFilters.departments).toEqual([]);
    expect(employeeFilters.users).toEqual([]);
    const employeeDashboard = await employee.query(api.analytics.dashboard, { companyId, now, range: defaultRange });
    expect(employeeDashboard.tasks.assigned).toBe(1);
    expect(employeeDashboard.level).toBe("user");
    expect(employeeDashboard.rankings.employees).toEqual([]);
    expect(employeeDashboard.rankings.groups).toBeNull();
    await expect(employee.query(api.analytics.dashboard, { companyId, now, range: defaultRange, membershipId: hiddenMembershipId })).rejects.toThrow("outside your analytics scope");
    await expect(employee.query(api.analytics.dashboard, { companyId, now, range: defaultRange, branchId: branchAId })).rejects.toThrow("not available");
  });

  test("JD cycles are counted by deadline within the range, honouring completions, missed records and unrecorded elapsed cycles", { timeout: 15_000 }, async () => {
    const { t, companyId, adminMembershipId, employeeMembershipId } = await seedDashboardCompany();
    const now = Date.now();
    const cycle = (k: number) => currentJdCycle("daily", now - k * dayMs, undefined);

    await t.run(async (ctx) => {
      const jdTaskId = await ctx.db.insert("jdTasks", {
        companyId,
        reference: "JD-0001",
        title: "Daily JD",
        description: "",
        recurrence: "daily",
        cycleStartedAt: cycle(5).start,
        status: "due",
        statusCycleStart: cycle(0).start,
        assigneeMembershipIds: [employeeMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: cycle(5).start,
        updatedAt: cycle(5).start,
      });
      for (const k of [1, 3]) {
        await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId, cycleStart: cycle(k).start, completedByMembershipId: employeeMembershipId, completedAt: cycle(k).start + 3_600_000 });
      }
      await ctx.db.insert("jdTaskCycleRecords", { companyId, jdTaskId, cycleStart: cycle(4).start, cycleEnd: cycle(4).end, status: "missed", recordedAt: now });
    });

    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, range: defaultRange });
    // k=2,4,5 are incomplete with deadlines before now; the current cycle due today is not overdue yet.
    expect(dashboard.jd).toEqual({ due: 6, completed: 2, overdue: 3, completionRate: 33 });
    const trend = dashboard.trend.reduce(
      (sum, bucket) => ({ jdDue: sum.jdDue + bucket.jdDue, jdCompleted: sum.jdCompleted + bucket.jdCompleted }),
      { jdDue: 0, jdCompleted: 0 },
    );
    expect(trend).toEqual({ jdDue: 6, jdCompleted: 2 });
    expect(dashboard.tasks.assigned).toBe(2);
  });

  test("a cycle counts while its deadline is inside the range even before it passes", { timeout: 15_000 }, async () => {
    const { t, companyId, adminMembershipId, employeeMembershipId } = await seedDashboardCompany();
    const now = Date.now();
    const admin = t.withIdentity(identity("admin"));

    const daily = currentJdCycle("daily", now, undefined);
    const dailyTaskId = await t.run(async (ctx) => await ctx.db.insert("jdTasks", {
      companyId,
      reference: "JD-0002",
      title: "Daily JD",
      description: "",
      recurrence: "daily",
      cycleStartedAt: daily.start,
      status: "due",
      statusCycleStart: daily.start,
      assigneeMembershipIds: [employeeMembershipId],
      createdByMembershipId: adminMembershipId,
      createdAt: now,
      updatedAt: now,
    }));

    // The current cycle's deadline is the end of today: inside the to-date
    // range even though the instant has not passed yet.
    const dayRange = { preset: "custom", startDate: dateField(now), endDate: dateField(now) } as const;
    let dashboard = await admin.query(api.analytics.dashboard, { companyId, now, range: dayRange });
    expect(dashboard.jd.due).toBe(1);
    expect(dashboard.jd.completed).toBe(0);
    expect(dashboard.jd.overdue).toBe(0);

    await admin.mutation(api.tasks.completeJd, { companyId, taskId: dailyTaskId });
    dashboard = await admin.query(api.analytics.dashboard, { companyId, now, range: dayRange });
    expect(dashboard.jd.completed).toBe(1);
    expect(dashboard.jd.completionRate).toBe(100);
  });

  test("tasks are a cohort by createdAt; completions outside the cohort don't count", { timeout: 15_000 }, async () => {
    const { t, companyId, adminMembershipId, employeeMembershipId, visibleTaskId } = await seedDashboardCompany();
    const now = Date.now();
    const admin = t.withIdentity(identity("admin"));

    await t.run(async (ctx) => {
      await ctx.db.insert("oneTimeTasks", {
        companyId,
        reference: "OT-OLD",
        title: "Completed long ago",
        description: "",
        priority: "medium",
        status: "completed",
        completedAt: now,
        assigneeMembershipIds: [employeeMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: now - 120 * dayMs,
        updatedAt: now,
      });
      await ctx.db.insert("oneTimeTasks", {
        companyId,
        reference: "OT-OVERDUE",
        title: "Past its due date",
        description: "",
        priority: "medium",
        status: "due",
        dueDate: now - dayMs,
        assigneeMembershipIds: [employeeMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: now,
        updatedAt: now,
      });
    });
    let dashboard = await admin.query(api.analytics.dashboard, { companyId, now, range: defaultRange });
    expect(dashboard.tasks.assigned).toBe(3);

    await admin.mutation(api.tasks.completeOneTime, { companyId, taskId: visibleTaskId });
    dashboard = await admin.query(api.analytics.dashboard, { companyId, now, range: defaultRange });
    expect(dashboard.tasks.completed).toBe(1);
    // The hidden task is incomplete but not due yet, so only the past-due one counts.
    expect(dashboard.tasks.overdue).toBe(1);
    expect(dashboard.tasks.completionRate).toBe(33);
  });

  test("overall completion is weighted by work volume, not averaged", { timeout: 15_000 }, async () => {
    const { t, companyId, branchAId, departmentAId, adminMembershipId, employeeMembershipId, hiddenTaskId } = await seedDashboardCompany();
    const now = Date.now();
    const admin = t.withIdentity(identity("admin"));

    const today = currentJdCycle("daily", now, undefined);
    await t.run(async (ctx) => {
      const jdTaskId = await ctx.db.insert("jdTasks", {
        companyId,
        reference: "JD-0004",
        title: "Employee daily JD",
        description: "",
        recurrence: "daily",
        cycleStartedAt: today.start,
        status: "due",
        statusCycleStart: today.start,
        assigneeMembershipIds: [employeeMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId, cycleStart: today.start, completedByMembershipId: employeeMembershipId, completedAt: now });
      for (let i = 0; i < 4; i++) {
        await ctx.db.insert("oneTimeTasks", {
          companyId,
          reference: `OT-X${i}`,
          title: `Employee extra task ${i}`,
          description: "",
          priority: "low",
          status: "due",
          assigneeMembershipIds: [employeeMembershipId],
          createdByMembershipId: adminMembershipId,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    await admin.mutation(api.tasks.completeOneTime, { companyId, taskId: hiddenTaskId });

    const dashboard = await admin.query(api.analytics.dashboard, { companyId, now, range: defaultRange });
    expect(dashboard.rankings.employees[0]).toMatchObject({ name: "Hidden", completionRate: 100 });
    expect(dashboard.rankings.employees[1]).toMatchObject({ name: "Employee", completionRate: 17, total: 6, completed: 1 });
    expect(dashboard.rankings.groups?.rows[0]).toMatchObject({ name: "South", completionRate: 100 });
    expect(dashboard.rankings.groups?.rows[1]).toMatchObject({ name: "North", completionRate: 17 });

    const branch = await admin.query(api.analytics.dashboard, { companyId, now, range: defaultRange, branchId: branchAId });
    expect(branch.level).toBe("branch");
    expect(branch.rankings.groups?.kind).toBe("department");
    expect(branch.rankings.employees.map((row) => row.name)).toEqual(["Employee"]);

    const department = await admin.query(api.analytics.dashboard, { companyId, now, range: defaultRange, departmentId: departmentAId });
    expect(department.level).toBe("department");
    expect(department.rankings.groups).toBeNull();
    expect(department.rankings.employees).toHaveLength(1);
    expect(department.rankings.employees[0]).toMatchObject({ name: "Employee", jdDue: 1, jdCompleted: 1, tasksAssigned: 5, tasksCompleted: 0 });

    const user = await admin.query(api.analytics.dashboard, { companyId, now, range: defaultRange, membershipId: employeeMembershipId });
    expect(user.level).toBe("user");
    expect(user.rankings.employees).toEqual([]);
  });

  test("person display fallbacks do not expose emails", { timeout: 15_000 }, async () => {
    const { t, companyId, employeeUserId, employeeMembershipId } = await seedDashboardCompany();
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.patch(employeeUserId, { firstName: "", secondName: "" });
    });

    const admin = t.withIdentity(identity("admin"));
    const filters = await admin.query(api.analytics.dashboardFilters, { companyId });
    const employee = filters.users.find((row) => row._id === employeeMembershipId);
    expect(employee?.name).toBe("Unknown");
    const dashboard = await admin.query(api.analytics.dashboard, { companyId, now, range: defaultRange });
    expect(JSON.stringify(filters)).not.toContain("employee@example.com");
    expect(JSON.stringify(dashboard)).not.toContain("employee@example.com");
  });

  test("managed-scope analytics excludes self when analytics:view:self is denied", { timeout: 15_000 }, async () => {
    const { t, companyId, managerMembershipId } = await seedDashboardCompany();
    const now = Date.now();
    await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, {
      companyId,
      title: "Manager self task",
      description: "",
      dueDate: Date.now() + dayMs,
      assigneeMembershipIds: [managerMembershipId],
      priority: "medium",
    });
    await t.run(async (ctx) => {
      const createdAt = Date.now();
      await ctx.db.insert("roles", {
        companyId,
        name: "Manager",
        capabilities: defaultRoleCapabilities.Manager.filter((capability) => capability !== "analytics:view:self"),
        createdAt,
        updatedAt: createdAt,
      });
    });

    const manager = t.withIdentity(identity("manager"));
    const filters = await manager.query(api.analytics.dashboardFilters, { companyId });
    expect(filters.users.map((user) => user._id)).not.toContain(managerMembershipId);
    const dashboard = await manager.query(api.analytics.dashboard, { companyId, now, range: defaultRange });
    expect(dashboard.tasks.assigned).toBe(1);
    const summary = await manager.query(api.analytics.aiSummary, { companyId });
    expect(summary.oneTimeTaskCount).toBe(1);
    expect(summary.scopeSize).toBe(1);
  });

  test("custom ranges reject invalid dates, reversed dates, and spans over two years", { timeout: 15_000 }, async () => {
    const { t, companyId } = await seedDashboardCompany();
    const now = Date.now();
    const admin = t.withIdentity(identity("admin"));

    await expect(admin.query(api.analytics.dashboard, { companyId, now, range: { preset: "custom", startDate: "2026-02-30", endDate: "2026-03-01" } })).rejects.toThrow("Invalid date range");
    await expect(admin.query(api.analytics.dashboard, { companyId, now, range: { preset: "custom", startDate: "2026-03-10", endDate: "2026-03-01" } })).rejects.toThrow("Invalid date range");
    await expect(admin.query(api.analytics.dashboard, { companyId, now, range: { preset: "custom", startDate: "2024-01-01", endDate: "2026-01-02" } })).rejects.toThrow("two years");
  });
});

describe("dashboard historical JD cycles", () => {
  // Fixed timestamps in the default company time zone (GMT+5).
  const day = (iso: string) => new Date(`${iso}T00:00:00+05:00`).getTime();

  function jdDoc(
    ids: { companyId: Id<"companies">; adminMembershipId: Id<"companyMemberships">; employeeMembershipId: Id<"companyMemberships"> },
    fields: { recurrence: "daily" | "monthly"; csa: number; scs: number; status?: "due" | "in_progress" | "completed"; createdAt?: number },
  ) {
    return {
      companyId: ids.companyId,
      reference: "JD-X",
      title: "jd",
      recurrence: fields.recurrence,
      cycleStartedAt: fields.csa,
      status: fields.status ?? "due",
      statusCycleStart: fields.scs,
      assigneeMembershipIds: [ids.employeeMembershipId],
      createdByMembershipId: ids.adminMembershipId,
      createdAt: fields.createdAt ?? fields.csa,
      updatedAt: fields.csa,
    };
  }

  test("missed records keep their own deadline across recurrence changes", { timeout: 15_000 }, async () => {
    const ids = await seedDashboardCompany();
    const { t, companyId } = ids;
    // The task ran weekly and missed Aug 31–Sep 7 (deadline Sep 6); the
    // recurrence was later switched to monthly, moving the doc to that grid.
    const jdTaskId = await t.run(async (ctx) => await ctx.db.insert("jdTasks", jdDoc(ids, { recurrence: "monthly", csa: day("2026-09-01"), scs: day("2026-09-01"), createdAt: day("2026-08-20") })));
    await t.run(async (ctx) => {
      await ctx.db.insert("jdTaskCycleRecords", { companyId, jdTaskId, cycleStart: day("2026-08-31"), cycleEnd: day("2026-09-07"), status: "missed", recordedAt: day("2026-09-08") });
    });
    const now = day("2026-09-12") + 15 * 3_600_000;
    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, range: { preset: "this_month" } });
    // Month-to-date ends Sep 12, so only the missed Sep 6 deadline is in range.
    expect(dashboard.jd).toEqual({ due: 1, completed: 0, overdue: 1, completionRate: 0 });
  });

  test("legacy completions off the current grid count by their completion date", { timeout: 15_000 }, async () => {
    const ids = await seedDashboardCompany();
    const { t, companyId, employeeMembershipId } = ids;
    // A weekly Sep 7–14 cycle completed on Sep 8 (real deadline Sep 13); the
    // recurrence was later switched to monthly and the row predates cycleEnd.
    const jdTaskId = await t.run(async (ctx) => await ctx.db.insert("jdTasks", jdDoc(ids, { recurrence: "monthly", csa: day("2026-09-01"), scs: day("2026-09-01") })));
    await t.run(async (ctx) => {
      await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId, cycleStart: day("2026-09-07"), completedByMembershipId: employeeMembershipId, completedAt: day("2026-09-08") + 3_600_000 });
    });
    const now = day("2026-09-12") + 15 * 3_600_000;
    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, range: { preset: "this_week" } });
    expect(dashboard.jd).toEqual({ due: 1, completed: 1, overdue: 0, completionRate: 100 });
  });

  test("legacy completions on the current grid keep their reconstructed deadline", { timeout: 15_000 }, async () => {
    const ids = await seedDashboardCompany();
    const { t, companyId, employeeMembershipId } = ids;
    // Monthly task completed early on Aug 5; the August deadline is Aug 31.
    // The completion row predates cycleEnd so the deadline is reconstructed.
    const jdTaskId = await t.run(async (ctx) => await ctx.db.insert("jdTasks", jdDoc(ids, { recurrence: "monthly", csa: day("2026-08-01"), scs: day("2026-08-01") })));
    await t.run(async (ctx) => {
      await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId, cycleStart: day("2026-08-01"), completedByMembershipId: employeeMembershipId, completedAt: day("2026-08-05") + 3_600_000 });
    });
    const now = Date.now();
    const admin = t.withIdentity(identity("admin"));
    // No deadline falls inside Aug 1–10 even though the completion happened there.
    const early = await admin.query(api.analytics.dashboard, { companyId, now, range: { preset: "custom", startDate: "2026-08-01", endDate: "2026-08-10" } });
    expect(early.jd).toEqual({ due: 0, completed: 0, overdue: 0, completionRate: 0 });
    // The reconstructed Aug 31 deadline only counts in a range covering it.
    const month = await admin.query(api.analytics.dashboard, { companyId, now, range: { preset: "custom", startDate: "2026-08-01", endDate: "2026-08-31" } });
    expect(month.jd).toEqual({ due: 1, completed: 1, overdue: 0, completionRate: 100 });
  });

  test("a task more than 200 cycles behind still reports its recent in-range cycles", { timeout: 15_000 }, async () => {
    const ids = await seedDashboardCompany();
    const { t, companyId } = ids;
    // Daily task whose cycleStartedAt lagged ~250 cycles without cron records.
    await t.run(async (ctx) => await ctx.db.insert("jdTasks", jdDoc(ids, { recurrence: "daily", csa: day("2026-01-05"), scs: day("2026-01-05") })));
    const now = day("2026-09-12") + 15 * 3_600_000;
    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, range: { preset: "this_month" } });
    // Sep 1–11 elapsed plus the current Sep 12 cycle.
    expect(dashboard.jd.due).toBe(12);
    expect(dashboard.jd.overdue).toBe(11);
    expect(dashboard.isTruncated).toBe(false);
  });

  test("more in-range elapsed cycles than the cap are flagged as truncated", { timeout: 15_000 }, async () => {
    const ids = await seedDashboardCompany();
    const { t, companyId } = ids;
    // Dates stay relative to now because the query clamps now to server time.
    const now = Date.now();
    const start = now - 260 * dayMs;
    await t.run(async (ctx) => await ctx.db.insert("jdTasks", jdDoc(ids, { recurrence: "daily", csa: start, scs: start, createdAt: start })));
    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, range: { preset: "custom", startDate: dateField(start), endDate: dateField(now) } });
    expect(dashboard.jd.due).toBe(201);
    expect(dashboard.isTruncated).toBe(true);
  });

  test("a stored missed deadline survives a recurrence change onto the same cycle start", { timeout: 15_000 }, async () => {
    const ids = await seedDashboardCompany();
    const { t, companyId } = ids;
    // The task was weekly and missed the Sep 1–8 cycle (deadline Sep 7); the
    // recurrence was later switched to monthly, so the current grid cycle
    // shares the same Sep 1 start but reconstructs a Sep 30 deadline.
    const jdTaskId = await t.run(async (ctx) => await ctx.db.insert("jdTasks", jdDoc(ids, { recurrence: "monthly", csa: day("2026-09-01"), scs: day("2026-09-01") })));
    await t.run(async (ctx) => {
      await ctx.db.insert("jdTaskCycleRecords", { companyId, jdTaskId, cycleStart: day("2026-09-01"), cycleEnd: day("2026-09-08"), status: "missed", recordedAt: day("2026-09-08") });
    });
    const now = day("2026-09-12") + 15 * 3_600_000;
    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, range: { preset: "this_month" } });
    // The stored Sep 7 deadline stays in range; the current-grid reconstruction
    // must not overwrite it with Sep 30.
    expect(dashboard.jd).toEqual({ due: 1, completed: 0, overdue: 1, completionRate: 0 });
  });

  test("a task marked completed before the completion ledger counts its stamped cycle", { timeout: 15_000 }, async () => {
    const ids = await seedDashboardCompany();
    const { t, companyId } = ids;
    // Legacy task: marked completed in the Sep 9 daily cycle, but no completion
    // row exists and the cron recorded that cycle as missed anyway.
    const jdTaskId = await t.run(async (ctx) => await ctx.db.insert("jdTasks", jdDoc(ids, { recurrence: "daily", csa: day("2026-09-12"), scs: day("2026-09-09"), status: "completed", createdAt: day("2026-09-08") })));
    await t.run(async (ctx) => {
      for (const d of [8, 9, 10, 11]) {
        const iso = `2026-09-${String(d).padStart(2, "0")}`;
        await ctx.db.insert("jdTaskCycleRecords", { companyId, jdTaskId, cycleStart: day(iso), cycleEnd: day(iso) + dayMs, status: "missed", recordedAt: day("2026-09-12") });
      }
    });
    const now = day("2026-09-12") + 15 * 3_600_000;
    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, range: { preset: "this_month" } });
    // Sep 8, 9, 10, 11 elapsed plus the current Sep 12 cycle; Sep 9 completed.
    expect(dashboard.jd).toEqual({ due: 5, completed: 1, overdue: 3, completionRate: 20 });
  });

  test("a completion and a missed record for the same cycle count once as completed", { timeout: 15_000 }, async () => {
    const ids = await seedDashboardCompany();
    const { t, companyId, employeeMembershipId } = ids;
    const jdTaskId = await t.run(async (ctx) => await ctx.db.insert("jdTasks", jdDoc(ids, { recurrence: "daily", csa: day("2026-09-09"), scs: day("2026-09-09"), createdAt: day("2026-09-09") })));
    await t.run(async (ctx) => {
      await ctx.db.insert("jdTaskCycleRecords", { companyId, jdTaskId, cycleStart: day("2026-09-09"), cycleEnd: day("2026-09-10"), status: "missed", recordedAt: day("2026-09-12") });
      await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId, cycleStart: day("2026-09-09"), cycleEnd: day("2026-09-10"), completedByMembershipId: employeeMembershipId, completedAt: day("2026-09-09") + 3_600_000 });
    });
    const now = day("2026-09-12") + 15 * 3_600_000;
    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, range: { preset: "this_month" } });
    // Sep 9–11 elapsed plus the current Sep 12 cycle; Sep 9 is a single completed cycle.
    expect(dashboard.jd).toEqual({ due: 4, completed: 1, overdue: 2, completionRate: 25 });
  });
});
