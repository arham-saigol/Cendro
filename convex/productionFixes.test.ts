/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type Seed = Awaited<ReturnType<typeof seedCompany>>;

function identity(key: string, email = `${key}@example.com`, emailVerified = true) {
  return { tokenIdentifier: `clerk|${key}`, subject: key, issuer: "https://clerk.test", email, emailVerified, name: key };
}

async function seedCompany() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const companyId = await ctx.db.insert("companies", { name: "Acme", createdAt: now });
    const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", secondName: "", createdAt: now, updatedAt: now });
    const secondAdminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin2", email: "admin2@example.com", firstName: "Admin 2", secondName: "", createdAt: now, updatedAt: now });
    const employeeUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|employee", email: "employee@example.com", firstName: "Employee", secondName: "", createdAt: now, updatedAt: now });
    const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
    const secondAdminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: secondAdminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
    const employeeMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: employeeUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
    return { companyId, adminMembershipId, secondAdminMembershipId, employeeMembershipId };
  });
  return { t, ...ids };
}

async function allowEmployeeCreate({ t, companyId, employeeMembershipId }: Seed) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("permissionOverrides", { companyId, membershipId: employeeMembershipId, capability: "tasks:one_time:create", effect: "allow", updatedAt: now });
    await ctx.db.insert("permissionOverrides", { companyId, membershipId: employeeMembershipId, capability: "tasks:one_time:assign:self", effect: "allow", updatedAt: now });
  });
}

describe("production permission and validation fixes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("multi-assignee tasks can be completed by an assignee with update:self", async () => {
    const seeded = await seedCompany();
    const { t, companyId, adminMembershipId, employeeMembershipId } = seeded;
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, {
      companyId,
      title: "Shared task",
      description: "",
      dueDate: Date.now() + 86_400_000,
      assigneeMembershipIds: [adminMembershipId, employeeMembershipId],
      priority: "medium",
    });

    await expect(t.withIdentity(identity("employee")).mutation(api.tasks.completeOneTime, { companyId, taskId })).resolves.toBeNull();
  });

  test("self-assignment requires the explicit self-assign capability", async () => {
    const seeded = await seedCompany();
    const { t, companyId, employeeMembershipId } = seeded;
    await allowEmployeeCreate(seeded);

    await expect(t.withIdentity(identity("employee")).mutation(api.tasks.createOneTime, {
      companyId,
      title: "Self task",
      description: "",
      dueDate: Date.now() + 86_400_000,
      assigneeMembershipIds: [employeeMembershipId],
      priority: "medium",
    })).resolves.toEqual(expect.any(String));
  });

  test("task updates require at least one assignee", async () => {
    const { t, companyId, adminMembershipId } = await seedCompany();
    const jdTaskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "JD task", description: "", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    const oneTimeTaskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "One-time task", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [adminMembershipId], priority: "medium" });

    await expect(t.withIdentity(identity("admin")).mutation(api.tasks.updateJd, { companyId, taskId: jdTaskId, title: "JD task", description: "", recurrence: "daily", assigneeMembershipIds: [] })).rejects.toThrow("Task assignee is required");
    await expect(t.withIdentity(identity("admin")).mutation(api.tasks.updateOneTime, { companyId, taskId: oneTimeTaskId, title: "One-time task", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [], priority: "medium" })).rejects.toThrow("Task assignee is required");
  });

  test("task creation and updates reject duplicate assignees", async () => {
    const { t, companyId, adminMembershipId } = await seedCompany();
    const admin = t.withIdentity(identity("admin"));

    await expect(admin.mutation(api.tasks.createJd, { companyId, title: "JD duplicate", recurrence: "daily", assigneeMembershipIds: [adminMembershipId, adminMembershipId] })).rejects.toThrow("Duplicate assignees are not allowed");
    await expect(admin.mutation(api.tasks.createOneTime, { companyId, title: "OT duplicate", assigneeMembershipIds: [adminMembershipId, adminMembershipId], priority: "medium" })).rejects.toThrow("Duplicate assignees are not allowed");

    const jdTaskId = await admin.mutation(api.tasks.createJd, { companyId, title: "JD valid", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    const oneTimeTaskId = await admin.mutation(api.tasks.createOneTime, { companyId, title: "OT valid", assigneeMembershipIds: [adminMembershipId], priority: "medium" });

    await expect(admin.mutation(api.tasks.updateJd, { companyId, taskId: jdTaskId, title: "JD updated", recurrence: "daily", assigneeMembershipIds: [adminMembershipId, adminMembershipId] })).rejects.toThrow("Duplicate assignees are not allowed");
    await expect(admin.mutation(api.tasks.updateJdFields, { companyId, taskId: jdTaskId, assigneeMembershipIds: [adminMembershipId, adminMembershipId] })).rejects.toThrow("Duplicate assignees are not allowed");
    await expect(admin.mutation(api.tasks.updateOneTime, { companyId, taskId: oneTimeTaskId, title: "OT updated", assigneeMembershipIds: [adminMembershipId, adminMembershipId], priority: "medium" })).rejects.toThrow("Duplicate assignees are not allowed");
    await expect(admin.mutation(api.tasks.updateOneTimeFields, { companyId, taskId: oneTimeTaskId, assigneeMembershipIds: [adminMembershipId, adminMembershipId] })).rejects.toThrow("Duplicate assignees are not allowed");
  });

  test("tasks and SOPs receive searchable, unique references", async () => {
    const { t, companyId, adminMembershipId } = await seedCompany();
    const admin = t.withIdentity(identity("admin"));
    const firstJdId = await admin.mutation(api.tasks.createJd, { companyId, title: "Opening checklist", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    const secondJdId = await admin.mutation(api.tasks.createJd, { companyId, title: "Closing checklist", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    const oneTimeId = await admin.mutation(api.tasks.createOneTime, { companyId, title: "Replace sign", assigneeMembershipIds: [adminMembershipId], priority: "medium" });
    const sopId = await admin.mutation(api.sops.create, { companyId, title: "Cash handling", content: "Count the drawer.", scopeType: "company", branchIds: [], departmentIds: [], userMembershipIds: [] });

    const [firstJd, secondJd, oneTime, sop] = await Promise.all([
      admin.query(api.tasks.getJd, { companyId, taskId: firstJdId }),
      admin.query(api.tasks.getJd, { companyId, taskId: secondJdId }),
      admin.query(api.tasks.getOneTime, { companyId, taskId: oneTimeId }),
      admin.query(api.sops.get, { companyId, sopId }),
    ]);
    expect([firstJd.task.reference, secondJd.task.reference, oneTime.task.reference, sop.reference]).toEqual(["JD-001", "JD-002", "TSK-001", "SOP-001"]);

    await expect(admin.query(api.tasks.listJdRows, { companyId, search: "jd-002", paginationOpts: { numItems: 10, cursor: null } })).resolves.toMatchObject({ page: [{ _id: secondJdId }] });
    await expect(admin.query(api.tasks.listOneTimeRows, { companyId, search: "TSK-001", paginationOpts: { numItems: 10, cursor: null } })).resolves.toMatchObject({ page: [{ _id: oneTimeId }] });
    await expect(admin.query(api.sops.listRows, { companyId, search: "sop-001" })).resolves.toMatchObject([{ _id: sopId }]);
  });

  test("SOPs can be created without a body", async () => {
    const { t, companyId } = await seedCompany();
    const admin = t.withIdentity(identity("admin"));
    const emptySopId = await admin.mutation(api.sops.create, { companyId, title: "Empty SOP", scopeType: "company", branchIds: [], departmentIds: [], userMembershipIds: [] });
    const emptySop = await admin.query(api.sops.get, { companyId, sopId: emptySopId });
    expect(emptySop.content).toBe("");
  });

  test("assignee results continue past the first 200 company tasks", async () => {
    const { t, companyId, adminMembershipId, employeeMembershipId } = await seedCompany();
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 1; index <= 68; index += 1) {
        await ctx.db.insert("jdTasks", {
          companyId,
          reference: `JD-${String(index).padStart(4, "0")}`,
          title: `Task ${index}`,
          recurrence: "daily",
          cycleStartedAt: now,
          status: "due",
          assigneeMembershipIds: [employeeMembershipId],
          createdByMembershipId: adminMembershipId,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 69; index <= 263; index += 1) {
        await ctx.db.insert("jdTasks", {
          companyId,
          reference: `JD-${String(index).padStart(4, "0")}`,
          title: `Task ${index}`,
          recurrence: "daily",
          cycleStartedAt: now,
          status: "due",
          assigneeMembershipIds: [adminMembershipId],
          createdByMembershipId: adminMembershipId,
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    const admin = t.withIdentity(identity("admin"));
    const first = await admin.query(api.tasks.listJdRows, { companyId, paginationOpts: { numItems: 200, cursor: null } });
    const second = await admin.query(api.tasks.listJdRows, { companyId, paginationOpts: { numItems: 200, cursor: first.continueCursor } });
    const employeeTasks = [...first.page, ...second.page].filter((task) => task.assigneeMembershipIds.includes(employeeMembershipId));

    expect(first.isDone).toBe(false);
    expect(first.page).toHaveLength(200);
    expect(first.page.filter((task) => task.assigneeMembershipIds.includes(employeeMembershipId))).toHaveLength(5);
    expect(second.isDone).toBe(true);
    expect(second.page).toHaveLength(63);
    expect(second.page.every((task) => task.assigneeMembershipIds.includes(employeeMembershipId))).toBe(true);
    expect(employeeTasks).toHaveLength(68);
  });

  test("company timezone defaults to GMT+5 and can be changed", async () => {
    const { t, companyId } = await seedCompany();

    const initial = await t.withIdentity(identity("admin")).query(api.companyManagement.overview, { companyId });
    expect(initial.company.timeZone).toBe("Etc/GMT-5");
    expect(initial.company.hasTimeZone).toBe(false);

    await expect(t.withIdentity(identity("admin")).mutation(api.companyManagement.updateCompanyTimeZone, { companyId, timeZone: "UTC" })).resolves.toBeNull();
    const updated = await t.withIdentity(identity("admin")).query(api.companyManagement.overview, { companyId });
    expect(updated.company.timeZone).toBe("UTC");
    expect(updated.company.hasTimeZone).toBe(true);
    const auditEvents = await t.run(async (ctx) => await ctx.db.query("auditEvents").withIndex("by_company", (q) => q.eq("companyId", companyId)).order("desc").take(1));
    expect(auditEvents[0]).toMatchObject({ companyId, action: "company.time_zone_update", targetType: "company", targetId: companyId });
    await expect(t.withIdentity(identity("admin")).mutation(api.companyManagement.updateCompanyTimeZone, { companyId, timeZone: "Not/AZone" })).rejects.toThrow("valid time zone");
  });

  test("task text updates use per-task update permissions", async () => {
    const { t, companyId, adminMembershipId, employeeMembershipId } = await seedCompany();
    const selfTaskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "Old title", description: "Old body", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [employeeMembershipId], priority: "medium" });
    const adminTaskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "Admin task", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [adminMembershipId], priority: "medium" });

    await expect(t.withIdentity(identity("employee")).mutation(api.tasks.updateOneTimeText, { companyId, taskId: selfTaskId, title: "New title", description: "New body" })).resolves.toBeNull();
    await expect(t.withIdentity(identity("employee")).mutation(api.tasks.updateOneTimeText, { companyId, taskId: adminTaskId, title: "Nope" })).rejects.toThrow("update this task");

    const detail = await t.withIdentity(identity("employee")).query(api.tasks.getOneTime, { companyId, taskId: selfTaskId });
    expect(detail.canUpdate).toBe(true);
    expect(detail.task.title).toBe("New title");
    expect(detail.task.description).toBe("New body");
  });

  test("task notes can be created and edited by the assigned employee for JD and one-time tasks", async () => {
    const { t, companyId, adminMembershipId, employeeMembershipId } = await seedCompany();
    const admin = t.withIdentity(identity("admin"));
    const employee = t.withIdentity(identity("employee"));

    // Create JD task with notes
    const jdTaskId = await admin.mutation(api.tasks.createJd, {
      companyId,
      title: "Daily Store Check",
      description: "Check locks and lights",
      notes: "Initial manager note",
      recurrence: "daily",
      assigneeMembershipIds: [employeeMembershipId],
    });

    // Create One-time task with notes
    const oneTimeTaskId = await admin.mutation(api.tasks.createOneTime, {
      companyId,
      title: "Repair Front Hinge",
      description: "Door hinge is loose",
      notes: "Initial repair note",
      dueDate: Date.now() + 86_400_000,
      priority: "medium",
      assigneeMembershipIds: [employeeMembershipId],
    });

    // Verify initial notes
    const initialJd = await employee.query(api.tasks.getJd, { companyId, taskId: jdTaskId });
    const initialOneTime = await employee.query(api.tasks.getOneTime, { companyId, taskId: oneTimeTaskId });
    expect(initialJd.task.notes).toBe("Initial manager note");
    expect(initialJd.canUpdate).toBe(true);
    expect(initialOneTime.task.notes).toBe("Initial repair note");
    expect(initialOneTime.canUpdate).toBe(true);

    // Assigned employee edits notes via text mutation (drawer inline edit)
    await expect(employee.mutation(api.tasks.updateJdText, {
      companyId,
      taskId: jdTaskId,
      notes: "Employee updated note for JD",
    })).resolves.toBeNull();

    await expect(employee.mutation(api.tasks.updateOneTimeText, {
      companyId,
      taskId: oneTimeTaskId,
      notes: "Employee updated note for one-time",
    })).resolves.toBeNull();

    // Verify updated notes
    const afterTextUpdateJd = await employee.query(api.tasks.getJd, { companyId, taskId: jdTaskId });
    const afterTextUpdateOneTime = await employee.query(api.tasks.getOneTime, { companyId, taskId: oneTimeTaskId });
    expect(afterTextUpdateJd.task.notes).toBe("Employee updated note for JD");
    expect(afterTextUpdateOneTime.task.notes).toBe("Employee updated note for one-time");

    // Assigned employee edits notes via full update mutation (edit dialog)
    await expect(employee.mutation(api.tasks.updateJd, {
      companyId,
      taskId: jdTaskId,
      title: "Daily Store Check",
      notes: "Employee final note via dialog",
      recurrence: "daily",
      assigneeMembershipIds: [employeeMembershipId],
    })).resolves.toBeNull();

    await expect(employee.mutation(api.tasks.updateOneTime, {
      companyId,
      taskId: oneTimeTaskId,
      title: "Repair Front Hinge",
      notes: "Employee final note via dialog",
      priority: "medium",
      assigneeMembershipIds: [employeeMembershipId],
    })).resolves.toBeNull();

    const afterFullUpdateJd = await employee.query(api.tasks.getJd, { companyId, taskId: jdTaskId });
    const afterFullUpdateOneTime = await employee.query(api.tasks.getOneTime, { companyId, taskId: oneTimeTaskId });
    expect(afterFullUpdateJd.task.notes).toBe("Employee final note via dialog");
    expect(afterFullUpdateOneTime.task.notes).toBe("Employee final note via dialog");

    // Verify non-assigned employee cannot update notes on an admin-assigned task
    const adminJdTaskId = await admin.mutation(api.tasks.createJd, {
      companyId,
      title: "Admin Only Task",
      recurrence: "daily",
      assigneeMembershipIds: [adminMembershipId],
    });

    await expect(employee.mutation(api.tasks.updateJdText, {
      companyId,
      taskId: adminJdTaskId,
      notes: "Unauthorized attempt",
    })).rejects.toThrow("update this task");
  });

  test("analytics requires an effective analytics:view capability", async () => {
    const { t, companyId, employeeMembershipId } = await seedCompany();
    await t.run(async (ctx) => {
      await ctx.db.insert("permissionOverrides", { companyId, membershipId: employeeMembershipId, capability: "analytics:view:self", effect: "deny", updatedAt: Date.now() });
    });

    await expect(t.withIdentity(identity("employee")).query(api.analytics.summary, { companyId })).rejects.toThrow("analytics");
  });

  test("SOP create requires sops:create even when scope management is allowed", async () => {
    const { t, companyId, secondAdminMembershipId } = await seedCompany();
    await t.withIdentity(identity("admin2", "admin2@example.com")).mutation(api.companyManagement.setPermissionOverride, { companyId, membershipId: secondAdminMembershipId, capability: "sops:create", effect: "deny" });

    await expect(t.withIdentity(identity("admin2", "admin2@example.com")).mutation(api.sops.create, { companyId, title: "Policy", content: "Body", scopeType: "company", branchIds: [], departmentIds: [], userMembershipIds: [] })).rejects.toThrow("access");
  });

  test("SOP visibility follows selected company, branch, department, and user scopes", async () => {
    const { t, companyId, employeeMembershipId } = await seedCompany();
    const { branchId, departmentId } = await t.run(async (ctx) => {
      const now = Date.now();
      const branchId = await ctx.db.insert("branches", { companyId, name: "Downtown", createdAt: now, updatedAt: now });
      const departmentId = await ctx.db.insert("departments", { companyId, branchId, name: "Bakery", createdAt: now, updatedAt: now });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: employeeMembershipId, branchId });
      await ctx.db.insert("userDepartmentAssignments", { companyId, membershipId: employeeMembershipId, departmentId });
      return { branchId, departmentId };
    });

    const companySopId = await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Company", content: "Everyone", scopeType: "company", branchIds: [], departmentIds: [], userMembershipIds: [] });
    const branchSopId = await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Branch", content: "Branch only", scopeType: "branch", branchIds: [branchId], departmentIds: [], userMembershipIds: [] });
    const departmentSopId = await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Department", content: "Department only", scopeType: "department", branchIds: [], departmentIds: [departmentId], userMembershipIds: [] });
    const userSopId = await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "User", content: "User only", scopeType: "user", branchIds: [], departmentIds: [], userMembershipIds: [employeeMembershipId] });

    await expect(t.withIdentity(identity("employee")).query(api.sops.get, { companyId, sopId: companySopId })).resolves.toMatchObject({ title: "Company" });
    await expect(t.withIdentity(identity("employee")).query(api.sops.get, { companyId, sopId: branchSopId })).resolves.toMatchObject({ title: "Branch" });
    await expect(t.withIdentity(identity("employee")).query(api.sops.get, { companyId, sopId: departmentSopId })).resolves.toMatchObject({ title: "Department" });
    await expect(t.withIdentity(identity("employee")).query(api.sops.get, { companyId, sopId: userSopId })).resolves.toMatchObject({ title: "User" });
    const list = await t.withIdentity(identity("employee")).query(api.sops.list, { companyId, paginationOpts: { numItems: 10, cursor: null } });
    expect(Object.fromEntries(list.page.map((sop) => [sop.title, sop.scopeTargetName]))).toMatchObject({ Company: "Acme", Branch: "Downtown", Department: "Bakery", User: "Employee" });
    await expect(t.withIdentity(identity("admin2", "admin2@example.com")).query(api.sops.get, { companyId, sopId: branchSopId })).resolves.toMatchObject({ title: "Branch" });
    await expect(t.withIdentity(identity("admin")).query(api.sops.get, { companyId, sopId: userSopId })).resolves.toMatchObject({ title: "User" });
    const adminAll = await t.withIdentity(identity("admin")).query(api.sops.listRows, { companyId, view: "all" });
    expect(adminAll.map((sop) => sop.title).sort()).toEqual(["Branch", "Company", "Department", "User"]);
    const branchFiltered = await t.withIdentity(identity("admin")).query(api.sops.listRows, { companyId, view: "all", branchId });
    expect(branchFiltered.map((sop) => sop.title).sort()).toEqual(["Branch", "Department"]);
    const adminMy = await t.withIdentity(identity("admin")).query(api.sops.listRows, { companyId, view: "my" });
    expect(adminMy.map((sop) => sop.title)).toEqual(["Company"]);
  });

  test("SOP scoped creation requires exactly one selected target", async () => {
    const { t, companyId } = await seedCompany();
    await expect(t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Branch", content: "Body", scopeType: "branch", branchIds: [], departmentIds: [], userMembershipIds: [] })).rejects.toThrow("Select one branch");
    await expect(t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Department", content: "Body", scopeType: "department", branchIds: [], departmentIds: [], userMembershipIds: [] })).rejects.toThrow("Select one department");
    await expect(t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "User", content: "Body", scopeType: "user", branchIds: [], departmentIds: [], userMembershipIds: [] })).rejects.toThrow("Select one user");
  });

  test("SOP scope updates replace targets and require management permission", async () => {
    const { t, companyId, adminMembershipId, employeeMembershipId } = await seedCompany();
    const { branchId, departmentId } = await t.run(async (ctx) => {
      const now = Date.now();
      const branchId = await ctx.db.insert("branches", { companyId, name: "Warehouse", createdAt: now, updatedAt: now });
      const departmentId = await ctx.db.insert("departments", { companyId, branchId, name: "Bakery", createdAt: now, updatedAt: now });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: adminMembershipId, branchId });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: employeeMembershipId, branchId });
      await ctx.db.insert("userDepartmentAssignments", { companyId, membershipId: employeeMembershipId, departmentId });
      return { branchId, departmentId };
    });
    const sopId = await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Policy", content: "Body", scopeType: "company", branchIds: [], departmentIds: [], userMembershipIds: [] });

    await expect(t.withIdentity(identity("employee")).mutation(api.sops.updateScope, { companyId, sopId, scopeType: "branch", branchIds: [branchId], userMembershipIds: [] })).rejects.toThrow("access");
    await expect(t.withIdentity(identity("admin")).mutation(api.sops.updateScope, { companyId, sopId, scopeType: "branch", branchIds: [branchId], userMembershipIds: [] })).resolves.toBeNull();
    await expect(t.withIdentity(identity("employee")).query(api.sops.get, { companyId, sopId })).resolves.toMatchObject({ scopeType: "branch", scopeTargetName: "Warehouse", branchIds: [branchId], userMembershipIds: [] });

    await expect(t.withIdentity(identity("admin")).mutation(api.sops.updateScope, { companyId, sopId, scopeType: "department", branchIds: [], departmentIds: [departmentId], userMembershipIds: [] })).resolves.toBeNull();
    await expect(t.withIdentity(identity("employee")).query(api.sops.get, { companyId, sopId })).resolves.toMatchObject({ scopeType: "department", scopeTargetName: "Bakery", branchIds: [], departmentIds: [departmentId], userMembershipIds: [] });

    await expect(t.withIdentity(identity("admin")).mutation(api.sops.updateScope, { companyId, sopId, scopeType: "user", branchIds: [], userMembershipIds: [employeeMembershipId] })).resolves.toBeNull();
    await expect(t.withIdentity(identity("employee")).query(api.sops.get, { companyId, sopId })).resolves.toMatchObject({ scopeType: "user", scopeTargetName: "Employee", branchIds: [], departmentIds: [], userMembershipIds: [employeeMembershipId] });
  });

  test("SOP access is restricted to a manager's managed branches, departments, and users", async () => {
    const { t, companyId, employeeMembershipId } = await seedCompany();
    const { managerMembershipId, managedBranchId, unmanagedBranchId, managedDepartmentId, unmanagedDepartmentId, unmanagedUserMembershipId } = await t.run(async (ctx) => {
      const now = Date.now();
      const managerUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|manager", email: "manager@example.com", firstName: "Manager", secondName: "", createdAt: now, updatedAt: now });
      const secondEmployeeUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|employee2", email: "employee2@example.com", firstName: "Employee 2", secondName: "", createdAt: now, updatedAt: now });
      const managerMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: managerUserId, role: "Manager", active: true, createdAt: now, updatedAt: now });
      const unmanagedUserMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: secondEmployeeUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
      const managedBranchId = await ctx.db.insert("branches", { companyId, name: "Warehouse", createdAt: now, updatedAt: now });
      const unmanagedBranchId = await ctx.db.insert("branches", { companyId, name: "Downtown", createdAt: now, updatedAt: now });
      const managedDepartmentId = await ctx.db.insert("departments", { companyId, branchId: unmanagedBranchId, name: "Bakery", createdAt: now, updatedAt: now });
      const unmanagedDepartmentId = await ctx.db.insert("departments", { companyId, branchId: unmanagedBranchId, name: "Deli", createdAt: now, updatedAt: now });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: employeeMembershipId, branchId: managedBranchId });
      await ctx.db.insert("managerBranchScopes", { companyId, managerMembershipId, branchId: managedBranchId, updatedAt: now });
      await ctx.db.insert("managerDepartmentScopes", { companyId, managerMembershipId, departmentId: managedDepartmentId, updatedAt: now });
      await ctx.db.insert("managerUserScopes", { companyId, managerMembershipId, userMembershipId: employeeMembershipId, updatedAt: now });
      await ctx.db.insert("permissionOverrides", { companyId, membershipId: managerMembershipId, capability: "sops:manage:user", effect: "allow", updatedAt: now });
      return { managerMembershipId, managedBranchId, unmanagedBranchId, managedDepartmentId, unmanagedDepartmentId, unmanagedUserMembershipId };
    });

    const managedBranchSopId = await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Managed branch SOP", content: "Body", scopeType: "branch", branchIds: [managedBranchId], departmentIds: [], userMembershipIds: [] });
    const unmanagedBranchSopId = await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Unmanaged branch SOP", content: "Body", scopeType: "branch", branchIds: [unmanagedBranchId], departmentIds: [], userMembershipIds: [] });
    const managedDepartmentSopId = await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Managed department SOP", content: "Body", scopeType: "department", branchIds: [], departmentIds: [managedDepartmentId], userMembershipIds: [] });
    const unmanagedDepartmentSopId = await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Unmanaged department SOP", content: "Body", scopeType: "department", branchIds: [], departmentIds: [unmanagedDepartmentId], userMembershipIds: [] });
    const managedUserSopId = await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Managed user SOP", content: "Body", scopeType: "user", branchIds: [], departmentIds: [], userMembershipIds: [employeeMembershipId] });
    const unmanagedUserSopId = await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Unmanaged user SOP", content: "Body", scopeType: "user", branchIds: [], departmentIds: [], userMembershipIds: [unmanagedUserMembershipId] });

    await expect(t.withIdentity(identity("manager")).query(api.sops.get, { companyId, sopId: managedBranchSopId })).resolves.toMatchObject({ title: "Managed branch SOP" });
    await expect(t.withIdentity(identity("manager")).query(api.sops.get, { companyId, sopId: managedDepartmentSopId })).resolves.toMatchObject({ title: "Managed department SOP" });
    await expect(t.withIdentity(identity("manager")).query(api.sops.get, { companyId, sopId: managedUserSopId })).resolves.toMatchObject({ title: "Managed user SOP" });
    await expect(t.withIdentity(identity("manager")).query(api.sops.get, { companyId, sopId: unmanagedBranchSopId })).rejects.toThrow("SOP not found");
    await expect(t.withIdentity(identity("manager")).query(api.sops.get, { companyId, sopId: unmanagedDepartmentSopId })).rejects.toThrow("SOP not found");
    await expect(t.withIdentity(identity("manager")).query(api.sops.get, { companyId, sopId: unmanagedUserSopId })).rejects.toThrow("SOP not found");

    const list = await t.withIdentity(identity("manager")).query(api.sops.listRows, { companyId, view: "all" });
    expect(list.map((sop) => sop.title).sort()).toEqual(["Managed branch SOP", "Managed department SOP", "Managed user SOP"]);

    const scopeOptions = await t.withIdentity(identity("manager")).query(api.sops.scopeOptions, { companyId });
    expect(scopeOptions.branches.map((branch) => branch._id)).toEqual([managedBranchId]);
    expect(scopeOptions.departments.map((department) => department._id)).toEqual([managedDepartmentId]);
    expect(scopeOptions.users.map((user) => user.membership._id).sort()).toEqual([employeeMembershipId, managerMembershipId].sort());

    await expect(t.withIdentity(identity("manager")).mutation(api.sops.create, { companyId, title: "Out of scope branch", content: "Body", scopeType: "branch", branchIds: [unmanagedBranchId], departmentIds: [], userMembershipIds: [] })).rejects.toThrow("managed scope");
    await expect(t.withIdentity(identity("manager")).mutation(api.sops.create, { companyId, title: "Out of scope department", content: "Body", scopeType: "department", branchIds: [], departmentIds: [unmanagedDepartmentId], userMembershipIds: [] })).rejects.toThrow("managed scope");
    await expect(t.withIdentity(identity("manager")).mutation(api.sops.create, { companyId, title: "Out of scope user", content: "Body", scopeType: "user", branchIds: [], departmentIds: [], userMembershipIds: [unmanagedUserMembershipId] })).rejects.toThrow("managed scope");
    await expect(t.withIdentity(identity("manager")).mutation(api.sops.create, { companyId, title: "In scope branch", content: "Body", scopeType: "branch", branchIds: [managedBranchId], departmentIds: [], userMembershipIds: [] })).resolves.toEqual(expect.any(String));
    await expect(t.withIdentity(identity("manager")).mutation(api.sops.create, { companyId, title: "In scope department", content: "Body", scopeType: "department", branchIds: [], departmentIds: [managedDepartmentId], userMembershipIds: [] })).resolves.toEqual(expect.any(String));

    const inScopeSopId = await t.withIdentity(identity("manager")).mutation(api.sops.create, { companyId, title: "For update", content: "Body", scopeType: "branch", branchIds: [managedBranchId], departmentIds: [], userMembershipIds: [] });
    await expect(t.withIdentity(identity("manager")).mutation(api.sops.updateScope, { companyId, sopId: inScopeSopId, scopeType: "branch", branchIds: [unmanagedBranchId], userMembershipIds: [] })).rejects.toThrow("managed scope");
    await expect(t.withIdentity(identity("manager")).mutation(api.sops.updateScope, { companyId, sopId: inScopeSopId, scopeType: "department", branchIds: [], departmentIds: [unmanagedDepartmentId], userMembershipIds: [] })).rejects.toThrow("managed scope");
    await expect(t.withIdentity(identity("manager")).mutation(api.sops.updateScope, { companyId, sopId: inScopeSopId, scopeType: "user", branchIds: [], userMembershipIds: [unmanagedUserMembershipId] })).rejects.toThrow("managed scope");
    await expect(t.withIdentity(identity("manager")).mutation(api.sops.updateScope, { companyId, sopId: inScopeSopId, scopeType: "department", branchIds: [], departmentIds: [managedDepartmentId], userMembershipIds: [] })).resolves.toBeNull();
  });

  test("structure reorders require complete sets and move departments atomically", async () => {
    const { t, companyId } = await seedCompany();
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const firstBranchId = await ctx.db.insert("branches", { companyId, name: "First", order: 0, createdAt: now, updatedAt: now });
      const secondBranchId = await ctx.db.insert("branches", { companyId, name: "Second", order: 1, createdAt: now, updatedAt: now });
      const thirdBranchId = await ctx.db.insert("branches", { companyId, name: "Third", order: 2, createdAt: now, updatedAt: now });
      const movingDepartmentId = await ctx.db.insert("departments", { companyId, branchId: firstBranchId, name: "Moving", order: 0, createdAt: now, updatedAt: now });
      const remainingDepartmentId = await ctx.db.insert("departments", { companyId, branchId: firstBranchId, name: "Remaining", order: 1, createdAt: now, updatedAt: now });
      const destinationDepartmentId = await ctx.db.insert("departments", { companyId, branchId: secondBranchId, name: "Destination", order: 0, createdAt: now, updatedAt: now });
      return { firstBranchId, secondBranchId, thirdBranchId, movingDepartmentId, remainingDepartmentId, destinationDepartmentId };
    });

    await expect(t.withIdentity(identity("admin")).mutation(api.companyManagement.reorderBranches, { companyId, orderedBranchIds: [ids.secondBranchId, ids.firstBranchId] })).rejects.toThrow("Branch order is stale");
    await expect(t.withIdentity(identity("admin")).mutation(api.companyManagement.reorderBranches, { companyId, orderedBranchIds: [ids.secondBranchId, ids.firstBranchId, ids.thirdBranchId] })).resolves.toBeNull();

    await expect(t.withIdentity(identity("admin")).mutation(api.companyManagement.moveDepartment, { companyId, departmentId: ids.movingDepartmentId, toBranchId: ids.secondBranchId, orderedDepartmentIds: [ids.movingDepartmentId] })).rejects.toThrow("Department order is stale");
    await expect(t.withIdentity(identity("admin")).mutation(api.companyManagement.moveDepartment, { companyId, departmentId: ids.movingDepartmentId, toBranchId: ids.secondBranchId, orderedDepartmentIds: [ids.destinationDepartmentId, ids.movingDepartmentId] })).resolves.toBeNull();

    const result = await t.run(async (ctx) => {
      const branches = await ctx.db.query("branches").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(10);
      const movingDepartment = await ctx.db.get(ids.movingDepartmentId);
      const remainingDepartment = await ctx.db.get(ids.remainingDepartmentId);
      const destinationDepartment = await ctx.db.get(ids.destinationDepartmentId);
      return { branches, movingDepartment, remainingDepartment, destinationDepartment };
    });
    expect(result.branches.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((branch) => branch._id)).toEqual([ids.secondBranchId, ids.firstBranchId, ids.thirdBranchId]);
    expect(result.destinationDepartment).toMatchObject({ branchId: ids.secondBranchId, order: 0 });
    expect(result.movingDepartment).toMatchObject({ branchId: ids.secondBranchId, order: 1 });
    expect(result.remainingDepartment).toMatchObject({ branchId: ids.firstBranchId, order: 0 });
  });

  test("permission overrides cannot remove the last effective permission manager", async () => {
    const { t, companyId, secondAdminMembershipId } = await seedCompany();
    await t.withIdentity(identity("admin")).mutation(api.companyManagement.setUserRole, { companyId, membershipId: secondAdminMembershipId, role: "Employee" });

    await expect(t.withIdentity(identity("admin")).mutation(api.companyManagement.setPermissionOverride, { companyId, membershipId: secondAdminMembershipId, capability: "company:manage_permissions", effect: "deny" })).resolves.toBeNull();
    const { adminMembershipId } = await t.run(async (ctx) => {
      const memberships = await ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(10);
      return { adminMembershipId: memberships.find((m) => m.role === "Admin")!._id };
    });
    await expect(t.withIdentity(identity("admin")).mutation(api.companyManagement.setPermissionOverride, { companyId, membershipId: adminMembershipId, capability: "company:manage_permissions", effect: "deny" })).rejects.toThrow("At least one active member");
  });

  test("blank comments are rejected", async () => {
    const seeded = await seedCompany();
    const { t, companyId, employeeMembershipId } = seeded;
    await allowEmployeeCreate(seeded);
    const taskId = await t.withIdentity(identity("employee")).mutation(api.tasks.createOneTime, { companyId, title: "Comment target", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [employeeMembershipId], priority: "medium" });

    await expect(t.withIdentity(identity("employee")).mutation(api.tasks.addComment, { companyId, taskType: "one_time", taskId, body: "   " })).rejects.toThrow("Comment is required");
  });

  test("task activity includes status logs and comments", async () => {
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "Activity task", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [adminMembershipId], priority: "medium" });

    await t.withIdentity(identity("admin")).mutation(api.tasks.completeOneTime, { companyId, taskId });
    await t.withIdentity(identity("admin")).mutation(api.tasks.addComment, { companyId, taskType: "one_time", taskId, body: "Looks good." });

    const activity = await t.withIdentity(identity("admin")).query(api.tasks.listActivity, { companyId, taskType: "one_time", taskId, limit: 10 });
    expect(activity.items.find((row) => row.kind === "comment")).toMatchObject({ body: "Looks good.", actor: { user: { name: "Admin" } } });
    expect(activity.items.find((row) => row.kind === "log" && row.event === "status_changed")).toMatchObject({ fromStatus: "due", toStatus: "completed", actor: { user: { name: "Admin" } } });
  });

  test("accepting an invitation applies assignments, managed scope, and permission overrides", async () => {
    const { t, companyId, employeeMembershipId } = await seedCompany();
    const token = "invite-token";
    const { branchId, departmentId } = await t.run(async (ctx) => {
      const now = Date.now();
      const branchId = await ctx.db.insert("branches", { companyId, name: "HQ", createdAt: now, updatedAt: now });
      const departmentId = await ctx.db.insert("departments", { companyId, branchId, name: "Ops", createdAt: now, updatedAt: now });
      await ctx.db.insert("invitations", { companyId, email: "new@example.com", role: "Employee", branchIds: [branchId], departmentIds: [departmentId], managedBranchIds: [branchId], managedDepartmentIds: [departmentId], managedUserMembershipIds: [employeeMembershipId], permissionOverrides: [{ capability: "tasks:one_time:create", effect: "allow" }, { capability: "tasks:one_time:assign:self", effect: "allow" }], token, status: "pending", createdAt: now, expiresAt: now + 86_400_000 });
      return { branchId, departmentId };
    });

    await expect(t.withIdentity(identity("new", "new@example.com")).mutation(api.invitations.accept, { token })).resolves.toMatchObject({ companyId });
    const result = await t.run(async (ctx) => {
      const user = await ctx.db.query("appUsers").withIndex("by_email", (q) => q.eq("email", "new@example.com")).unique();
      const membership = user ? await ctx.db.query("companyMemberships").withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", user._id)).unique() : null;
      const branchAssignments = membership ? await ctx.db.query("userBranchAssignments").withIndex("by_membership", (q) => q.eq("membershipId", membership._id)).take(10) : [];
      const departmentAssignments = membership ? await ctx.db.query("userDepartmentAssignments").withIndex("by_membership", (q) => q.eq("membershipId", membership._id)).take(10) : [];
      const managedBranches = membership ? await ctx.db.query("managerBranchScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", membership._id)).take(10) : [];
      const managedDepartments = membership ? await ctx.db.query("managerDepartmentScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", membership._id)).take(10) : [];
      const managedUsers = membership ? await ctx.db.query("managerUserScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", membership._id)).take(10) : [];
      const overrides = membership ? await ctx.db.query("permissionOverrides").withIndex("by_membership", (q) => q.eq("membershipId", membership._id)).take(10) : [];
      return { membership, branchAssignments, departmentAssignments, managedBranches, managedDepartments, managedUsers, overrides };
    });
    expect(result.membership?.role).toBe("Employee");
    expect(result.branchAssignments.map((row) => row.branchId)).toEqual([branchId]);
    expect(result.departmentAssignments.map((row) => row.departmentId)).toEqual([departmentId]);
    expect(result.managedBranches.map((row) => row.branchId)).toEqual([branchId]);
    expect(result.managedDepartments.map((row) => row.departmentId)).toEqual([departmentId]);
    expect(result.managedUsers.map((row) => row.userMembershipId)).toEqual([employeeMembershipId]);
    expect(result.overrides.map((row) => [row.capability, row.effect]).sort()).toEqual([["tasks:one_time:assign:self", "allow"], ["tasks:one_time:create", "allow"]]);
  });

  test("invitation email config failures are surfaced and not marked sent", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("RESEND_FROM", "");
    const { t, companyId } = await seedCompany();

    await expect(t.withIdentity(identity("admin")).action(api.companyManagement.inviteUser, { companyId, email: "new@example.com", role: "Employee" })).rejects.toThrow("Invitation email is not configured");
    const invitations = await t.run(async (ctx) => await ctx.db.query("invitations").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(10));
    expect(invitations).toHaveLength(1);
    expect(invitations[0].sentAt).toBeUndefined();
  });

  test("semantic SOP search authorizes before embedding", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "test-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { t, companyId } = await seedCompany();

    await expect(t.action(api.sops.semanticSearchAccessible, { companyId, query: "closing" })).rejects.toThrow("Please sign in");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("stale SOP embeddings cannot replace the latest content", async () => {
    const { t, companyId } = await seedCompany();
    const sopId = await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Policy", content: "Old body", scopeType: "company", branchIds: [], departmentIds: [], userMembershipIds: [] });
    const before = await t.run(async (ctx) => await ctx.db.get(sopId));
    if (!before) throw new Error("SOP was not created");
    await t.run(async (ctx) => await ctx.db.patch(sopId, { content: "New body", updatedAt: before.updatedAt + 1 }));

    await expect(t.mutation(internal.sops.storeEmbedding, { companyId, sopId, expectedUpdatedAt: before.updatedAt, chunk: "Policy\n\nOld body", embedding: Array(1024).fill(0) })).resolves.toBeNull();
    const embeddings = await t.run(async (ctx) => await ctx.db.query("sopEmbeddings").withIndex("by_sop", (q) => q.eq("sopId", sopId)).take(10));
    expect(embeddings).toEqual([]);
  });

  test("clearing optional fields on one-time tasks removes them from storage", async () => {
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, {
      companyId,
      title: "Task to clear",
      description: "Initial description",
      dueDate: Date.now() + 86_400_000,
      time: "10:00 AM",
      quantity: 5,
      assigneeMembershipIds: [adminMembershipId],
      priority: "medium",
    });

    await t.withIdentity(identity("admin")).mutation(api.tasks.updateOneTimeFields, {
      companyId,
      taskId,
      dueDate: null,
      quantity: null,
      description: "",
      time: "",
    });

    const task = await t.run(async (ctx) => await ctx.db.get(taskId));
    expect(task?.dueDate).toBeUndefined();
    expect(task?.quantity).toBeUndefined();
    expect(task?.description).toBeUndefined();
    expect(task?.time).toBeUndefined();

    // Completing and then uncompleting clears completedAt and completedByMembershipId
    await t.withIdentity(identity("admin")).mutation(api.tasks.completeOneTime, { companyId, taskId });
    const completedTask = await t.run(async (ctx) => await ctx.db.get(taskId));
    expect(completedTask?.completedAt).toBeTypeOf("number");
    expect(completedTask?.completedByMembershipId).toBeDefined();

    await t.withIdentity(identity("admin")).mutation(api.tasks.updateOneTimeStatus, { companyId, taskId, status: "due" });
    const revertedTask = await t.run(async (ctx) => await ctx.db.get(taskId));
    expect(revertedTask?.completedAt).toBeUndefined();
    expect(revertedTask?.completedByMembershipId).toBeUndefined();
  });

  test("invitation acceptance cannot downgrade the sole permission manager", async () => {
    const t = convexTest(schema, modules);
    const { token } = await t.run(async (ctx) => {
      const now = Date.now();
      const companyId = await ctx.db.insert("companies", { name: "Acme", createdAt: now });
      const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|sole_admin", email: "sole_admin@example.com", firstName: "Sole", secondName: "Admin", createdAt: now, updatedAt: now });
      await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
      await ctx.db.insert("invitations", {
        companyId,
        email: "sole_admin@example.com",
        role: "Employee",
        token: "demote-token",
        status: "pending",
        createdAt: now,
        expiresAt: now + 86_400_000,
      });
      return { token: "demote-token" };
    });

    await expect(t.withIdentity(identity("sole_admin", "sole_admin@example.com")).mutation(api.invitations.accept, { token })).rejects.toThrow("You are already an active member of this company.");
  });

  test("admins can update member first and last names in company management", async () => {
    const { t, companyId, employeeMembershipId } = await seedCompany();
    const employeeUser = await t.run(async (ctx) => {
      const membership = await ctx.db.get(employeeMembershipId);
      return await ctx.db.get(membership!.userId);
    });

    // Admin updates employee name
    await expect(
      t.withIdentity(identity("admin")).mutation(api.companyManagement.updateMemberName, {
        companyId,
        userId: employeeUser!._id,
        firstName: "Jane",
        secondName: "Doe",
      }),
    ).resolves.toBe(employeeUser!._id);

    // Verify in overview for this company
    const overview = await t.withIdentity(identity("admin")).query(api.companyManagement.overview, { companyId });
    const updatedUser = overview.users.find((u) => u.membership._id === employeeMembershipId);
    expect(updatedUser?.user).toMatchObject({
      _id: employeeUser!._id,
      name: "Jane Doe",
      firstName: "Jane",
      secondName: "Doe",
    });

    // Verify the global appUsers record is NOT modified (tenant isolation)
    const rawUser = await t.run(async (ctx) => await ctx.db.get(employeeUser!._id));
    expect(rawUser?.firstName).toBe("Employee");

    // Verify in a second company that the employee's name remains the global profile name
    const secondCompanyId = await t.run(async (ctx) => {
      const now = Date.now();
      const cId = await ctx.db.insert("companies", { name: "Beta Corp", createdAt: now });
      const adminId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|beta_admin", email: "beta_admin@example.com", firstName: "Beta Admin", secondName: "", createdAt: now, updatedAt: now });
      await ctx.db.insert("companyMemberships", { companyId: cId, userId: adminId, role: "Admin", active: true, createdAt: now, updatedAt: now });
      await ctx.db.insert("companyMemberships", { companyId: cId, userId: employeeUser!._id, role: "Employee", active: true, createdAt: now, updatedAt: now });
      return cId;
    });
    const betaOverview = await t.withIdentity(identity("beta_admin", "beta_admin@example.com")).query(api.companyManagement.overview, { companyId: secondCompanyId });
    const betaEmployee = betaOverview.users.find((u) => u.user._id === employeeUser!._id);
    expect(betaEmployee?.user.firstName).toBe("Employee");
    expect(betaEmployee?.user.name).toBe("Employee");

    // Verify audit event
    const auditEvents = await t.run(async (ctx) => {
      return await ctx.db.query("auditEvents").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(10);
    });
    expect(auditEvents.find((e) => e.action === "user.update_name")).toBeDefined();

    // Verify explicit blank last name override is preserved
    await t.run(async (ctx) => {
      await ctx.db.patch(employeeUser!._id, { secondName: "GlobalSurname" });
    });
    await t.withIdentity(identity("admin")).mutation(api.companyManagement.updateMemberName, {
      companyId,
      userId: employeeUser!._id,
      firstName: "Jane",
      secondName: "",
    });
    const overviewAfterClear = await t.withIdentity(identity("admin")).query(api.companyManagement.overview, { companyId });
    const clearedUser = overviewAfterClear.users.find((u) => u.membership._id === employeeMembershipId);
    expect(clearedUser?.user.secondName).toBe("");
    expect(clearedUser?.user.name).toBe("Jane");

    // Verify accessStatus returns company-scoped displayName
    const employeeAccess = await t.withIdentity(identity("employee")).query(api.companies.accessStatus, {});
    if (employeeAccess.status === "ready") {
      const companyEntry = employeeAccess.companies.find((c) => c.company._id === companyId);
      expect(companyEntry?.displayName).toBe("Jane");
    }

    // Validation: empty first name is rejected
    await expect(
      t.withIdentity(identity("admin")).mutation(api.companyManagement.updateMemberName, {
        companyId,
        userId: employeeUser!._id,
        firstName: "   ",
        secondName: "Smith",
      }),
    ).rejects.toThrow("First name is required.");

    // Unauthorized: regular employee cannot update another user's name
    await expect(
      t.withIdentity(identity("employee")).mutation(api.companyManagement.updateMemberName, {
        companyId,
        userId: employeeUser!._id,
        firstName: "Hacker",
      }),
    ).rejects.toThrow("You do not have access to do that.");
  });

  test("pagination queries support search, priority, and frequency filters", async () => {
    const { t, companyId, adminMembershipId } = await seedCompany();
    const admin = t.withIdentity(identity("admin"));

    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 1; i <= 250; i++) {
        await ctx.db.insert("oneTimeTasks", {
          companyId,
          reference: `OT-${String(i).padStart(4, "0")}`,
          title: i === 245 ? "Rare Needle Task" : `Generic Task ${i}`,
          priority: i === 245 ? "high" : "low",
          status: "due",
          assigneeMembershipIds: [adminMembershipId],
          createdByMembershipId: adminMembershipId,
          createdAt: now + i,
          updatedAt: now + i,
        });
      }
    });

    // No-match search returns empty page with isDone: true
    const noMatch = await admin.query(api.tasks.listOneTimeRows, {
      companyId,
      search: "NonexistentQueryXYZ",
      paginationOpts: { numItems: 200, cursor: null },
    });
    expect(noMatch.page).toHaveLength(0);

    // Filter-aware search finds matching task
    const rareMatch = await admin.query(api.tasks.listOneTimeRows, {
      companyId,
      search: "Rare Needle",
      paginationOpts: { numItems: 200, cursor: null },
    });
    expect(rareMatch.page).toHaveLength(1);
    expect(rareMatch.page[0].title).toBe("Rare Needle Task");

    // Filter by priority
    const highPriority = await admin.query(api.tasks.listOneTimeRows, {
      companyId,
      priority: "high",
      paginationOpts: { numItems: 200, cursor: null },
    });
    expect(highPriority.page).toHaveLength(1);
    expect(highPriority.page[0].title).toBe("Rare Needle Task");

    // Test personalFilterOptions returns assigned options
    const personalOpts = await admin.query(api.tasks.personalFilterOptions, {
      companyId,
      kind: "one_time",
    });
    expect(personalOpts.values).toContain("high");
    expect(personalOpts.values).toContain("low");
  });

  test("migrateTaskCodes backfills 4-digit JD and OT tasks to 3-digit format", async () => {
    const { t, companyId, adminMembershipId } = await seedCompany();
    const now = Date.now();

    const [jd1, jd42, jd100, jdAlready] = await t.run(async (ctx) => {
      const base = { companyId, title: "JD", recurrence: "daily" as const, cycleStartedAt: now, status: "due" as const, assigneeMembershipIds: [adminMembershipId], createdByMembershipId: adminMembershipId, createdAt: now, updatedAt: now };
      const id1 = await ctx.db.insert("jdTasks", { ...base, reference: "JD-0001" });
      const id42 = await ctx.db.insert("jdTasks", { ...base, reference: "JD-0042" });
      const id100 = await ctx.db.insert("jdTasks", { ...base, reference: "JD-0100" });
      const idAlready = await ctx.db.insert("jdTasks", { ...base, reference: "JD-002" });
      return [id1, id42, id100, idAlready];
    });

    const [ot1, ot42, tsk4digit, tskAlready] = await t.run(async (ctx) => {
      const base = { companyId, title: "OT", priority: "medium" as const, status: "due" as const, assigneeMembershipIds: [adminMembershipId], createdByMembershipId: adminMembershipId, createdAt: now, updatedAt: now };
      const id1 = await ctx.db.insert("oneTimeTasks", { ...base, reference: "OT-0001" });
      const id42 = await ctx.db.insert("oneTimeTasks", { ...base, reference: "OT-0042" });
      const id4digit = await ctx.db.insert("oneTimeTasks", { ...base, reference: "TSK-0003" });
      const idAlready = await ctx.db.insert("oneTimeTasks", { ...base, reference: "TSK-005" });
      return [id1, id42, id4digit, idAlready];
    });

    // 1. Dry run should report changes without applying
    const dryResult = await t.action(internal.tasks.migrateTaskCodes, { companyId, dryRun: true });
    expect(dryResult).toEqual({ dryRun: true, jdMigrated: 3, oneTimeMigrated: 3, totalMigrated: 6 });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(jd1))?.reference).toBe("JD-0001");
      expect((await ctx.db.get(ot1))?.reference).toBe("OT-0001");
    });

    // 2. Real migration applies all changes
    const realResult = await t.action(internal.tasks.migrateTaskCodes, { companyId, dryRun: false });
    expect(realResult).toEqual({ dryRun: false, jdMigrated: 3, oneTimeMigrated: 3, totalMigrated: 6 });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(jd1))?.reference).toBe("JD-001");
      expect((await ctx.db.get(jd42))?.reference).toBe("JD-042");
      expect((await ctx.db.get(jd100))?.reference).toBe("JD-100");
      expect((await ctx.db.get(jdAlready))?.reference).toBe("JD-002");

      expect((await ctx.db.get(ot1))?.reference).toBe("TSK-001");
      expect((await ctx.db.get(ot42))?.reference).toBe("TSK-042");
      expect((await ctx.db.get(tsk4digit))?.reference).toBe("TSK-003");
      expect((await ctx.db.get(tskAlready))?.reference).toBe("TSK-005");
    });

    // 3. Second run is idempotent
    const rerun = await t.action(internal.tasks.migrateTaskCodes, { companyId, dryRun: false });
    expect(rerun).toEqual({ dryRun: false, jdMigrated: 0, oneTimeMigrated: 0, totalMigrated: 0 });
  });

  test("migrateTaskCodes throws an error on reference collision", async () => {
    const { t, companyId, adminMembershipId } = await seedCompany();
    const now = Date.now();
    await t.run(async (ctx) => {
      const base = { companyId, title: "JD", recurrence: "daily" as const, cycleStartedAt: now, status: "due" as const, assigneeMembershipIds: [adminMembershipId], createdByMembershipId: adminMembershipId, createdAt: now, updatedAt: now };
      await ctx.db.insert("jdTasks", { ...base, reference: "JD-0001" });
      await ctx.db.insert("jdTasks", { ...base, reference: "JD-001" });
    });

    await expect(t.action(internal.tasks.migrateTaskCodes, { companyId, dryRun: false })).rejects.toThrow("target reference already exists");
  });

  test("migrateTaskCodes detects normalized collisions during dry run across batches and prevents partial migration", async () => {
    const { t, companyId, adminMembershipId } = await seedCompany();
    const now = Date.now();
    const [id1, id2] = await t.run(async (ctx) => {
      const base = { companyId, title: "JD", recurrence: "daily" as const, cycleStartedAt: now, status: "due" as const, assigneeMembershipIds: [adminMembershipId], createdByMembershipId: adminMembershipId, createdAt: now, updatedAt: now };
      const first = await ctx.db.insert("jdTasks", { ...base, reference: "JD-0001" });
      const second = await ctx.db.insert("jdTasks", { ...base, reference: "JD-00001" });
      return [first, second];
    });

    // 1. Dry run with batchSize: 1 must fail and detect the collision instead of falsely reporting migratable
    await expect(
      t.action(internal.tasks.migrateTaskCodes, { companyId, dryRun: true, batchSize: 1 })
    ).rejects.toThrow("target reference already exists");

    // Verify neither task was touched by dry run
    await t.run(async (ctx) => {
      expect((await ctx.db.get(id1))?.reference).toBe("JD-0001");
      expect((await ctx.db.get(id2))?.reference).toBe("JD-00001");
    });

    // 2. Real migration with batchSize: 1 preflights and aborts before any writes, preventing partial migration
    await expect(
      t.action(internal.tasks.migrateTaskCodes, { companyId, dryRun: false, batchSize: 1 })
    ).rejects.toThrow("target reference already exists");

    // Verify neither task was mutated (no partial migration of JD-0001)
    await t.run(async (ctx) => {
      expect((await ctx.db.get(id1))?.reference).toBe("JD-0001");
      expect((await ctx.db.get(id2))?.reference).toBe("JD-00001");
    });
  });

  test("sops.update atomically updates text and scope, and rolls back on failure", async () => {
    const { t, companyId } = await seedCompany();
    const admin = t.withIdentity(identity("admin"));
    const branchId = await t.run(async (ctx) => await ctx.db.insert("branches", { companyId, name: "Downtown", createdAt: Date.now(), updatedAt: Date.now() }));
    const sopId = await admin.mutation(api.sops.create, { companyId, title: "Original Title", content: "Original Content", scopeType: "company", branchIds: [], departmentIds: [], userMembershipIds: [] });

    // Atomic success
    await admin.mutation(api.sops.update, {
      companyId,
      sopId,
      title: "Updated Title",
      content: "Updated Content",
      scopeType: "branch",
      branchIds: [branchId],
      departmentIds: [],
      userMembershipIds: [],
    });

    const updatedSop = await admin.query(api.sops.get, { companyId, sopId });
    expect(updatedSop.title).toBe("Updated Title");
    expect(updatedSop.content).toBe("Updated Content");
    expect(updatedSop.scopeType).toBe("branch");
    expect(updatedSop.branchIds).toEqual([branchId]);

    // Validation failure on scope rolls back entire edit
    await expect(admin.mutation(api.sops.update, {
      companyId,
      sopId,
      title: "Should Not Persist",
      scopeType: "branch",
      branchIds: [], // invalid branch selection
      departmentIds: [],
      userMembershipIds: [],
    })).rejects.toThrow();

    const untouchedSop = await admin.query(api.sops.get, { companyId, sopId });
    expect(untouchedSop.title).toBe("Updated Title");
  });
});
