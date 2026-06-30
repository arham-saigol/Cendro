/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type Seed = Awaited<ReturnType<typeof seedCompany>>;

function identity(key: string, email = `${key}@example.com`) {
  return { tokenIdentifier: `clerk|${key}`, subject: key, issuer: "https://clerk.test", email, name: key };
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
});
