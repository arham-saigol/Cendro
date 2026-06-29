/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

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
    return { companyId, branchAId, branchBId, departmentAId, departmentBId, adminMembershipId, managerMembershipId, employeeMembershipId, hiddenMembershipId };
  });

  await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, {
    companyId: ids.companyId,
    title: "Visible employee task",
    description: "",
    dueDate: Date.now() + 86_400_000,
    assigneeMembershipIds: [ids.employeeMembershipId],
    priority: "high",
  });
  await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, {
    companyId: ids.companyId,
    title: "Hidden branch task",
    description: "",
    dueDate: Date.now() + 86_400_000,
    assigneeMembershipIds: [ids.hiddenMembershipId],
    priority: "medium",
  });
  return { t, ...ids };
}

describe("dashboard analytics scoping", () => {
  test("admin, manager, and employee dashboards receive only their allowed analytics", async () => {
    const { t, companyId, branchAId, branchBId, employeeMembershipId, hiddenMembershipId } = await seedDashboardCompany();

    const admin = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId });
    expect(admin.role).toBe("Admin");
    expect(admin.metrics.totalTasks).toBe(2);
    expect(admin.filterOptions.branches.map((branch) => branch._id).sort()).toEqual([branchAId, branchBId].sort());
    await expect(t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, branchId: branchBId })).resolves.toMatchObject({ metrics: { totalTasks: 1 } });

    const manager = await t.withIdentity(identity("manager")).query(api.analytics.dashboard, { companyId });
    expect(manager.role).toBe("Manager");
    expect(manager.metrics.totalTasks).toBe(1);
    expect(manager.filterOptions.branches.map((branch) => branch._id)).toEqual([branchAId]);
    expect(manager.filterOptions.employees.map((employee) => employee._id)).toContain(employeeMembershipId);
    expect(manager.filterOptions.employees.map((employee) => employee._id)).not.toContain(hiddenMembershipId);
    await expect(t.withIdentity(identity("manager")).query(api.analytics.dashboard, { companyId, membershipId: hiddenMembershipId })).rejects.toThrow("outside your analytics scope");
    await expect(t.withIdentity(identity("manager")).query(api.analytics.dashboard, { companyId, branchId: branchBId })).rejects.toThrow("outside your analytics scope");

    const employee = await t.withIdentity(identity("employee")).query(api.analytics.dashboard, { companyId });
    expect(employee.role).toBe("Employee");
    expect(employee.metrics.totalTasks).toBe(1);
    expect(employee.filterOptions.employees).toEqual([]);
    expect(employee.comparisons.employees).toEqual([]);
    await expect(t.withIdentity(identity("employee")).query(api.analytics.dashboard, { companyId, membershipId: hiddenMembershipId })).rejects.toThrow("outside your analytics scope");
    await expect(t.withIdentity(identity("employee")).query(api.analytics.dashboard, { companyId, branchId: branchAId })).rejects.toThrow("not available");
  });
});
