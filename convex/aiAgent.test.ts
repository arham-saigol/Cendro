/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function identity(key: string, email = `${key}@example.com`) {
  return { tokenIdentifier: `clerk|${key}`, subject: key, issuer: "https://clerk.test", email, name: key };
}

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const companyId = await ctx.db.insert("companies", { name: "Acme", createdAt: now });
    const otherCompanyId = await ctx.db.insert("companies", { name: "Other", createdAt: now });
    const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", name: "Admin", createdAt: now, updatedAt: now });
    const managerUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|manager", email: "manager@example.com", name: "Manager", createdAt: now, updatedAt: now });
    const employeeUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|employee", email: "employee@example.com", name: "Employee", createdAt: now, updatedAt: now });
    const employee2UserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|employee2", email: "employee2@example.com", name: "Employee 2", createdAt: now, updatedAt: now });
    const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
    const otherAdminMembershipId = await ctx.db.insert("companyMemberships", { companyId: otherCompanyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
    const managerMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: managerUserId, role: "Manager", active: true, createdAt: now, updatedAt: now });
    const employeeMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: employeeUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
    const employee2MembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: employee2UserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
    await ctx.db.insert("managerUserScopes", { companyId, managerMembershipId, userMembershipId: employeeMembershipId, updatedAt: now });
    return { companyId, otherCompanyId, adminMembershipId, otherAdminMembershipId, managerMembershipId, employeeMembershipId, employee2MembershipId };
  });
  return { t, ...ids };
}

describe("AI agent Convex boundaries", () => {
  test("AI analytics are scoped by role", async () => {
    const seeded = await seed();
    const { t, companyId, adminMembershipId, employeeMembershipId, employee2MembershipId } = seeded;
    await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "Employee task", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [employeeMembershipId], priority: "medium" });
    await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "Hidden employee task", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [employee2MembershipId], priority: "medium" });
    await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "Admin task", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [adminMembershipId], priority: "medium" });

    await expect(t.withIdentity(identity("admin")).query(api.analytics.aiSummary, { companyId })).resolves.toMatchObject({ oneTimeTaskCount: 3 });
    await expect(t.withIdentity(identity("manager")).query(api.analytics.aiSummary, { companyId })).resolves.toMatchObject({ scopeSize: 2, oneTimeTaskCount: 1 });
    await expect(t.withIdentity(identity("employee")).query(api.analytics.aiSummary, { companyId })).resolves.toMatchObject({ scopeSize: 1, oneTimeTaskCount: 1 });
  });

  test("AI task and SOP reads stay in visible scope", async () => {
    const { t, companyId, adminMembershipId, employeeMembershipId, employee2MembershipId } = await seed();
    await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "Visible task", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [employeeMembershipId], priority: "medium" });
    await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "Hidden task", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [employee2MembershipId], priority: "medium" });
    await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Visible SOP", content: "Shared procedure", scopeType: "company", branchIds: [], departmentIds: [], userMembershipIds: [] });
    await t.withIdentity(identity("admin")).mutation(api.sops.create, { companyId, title: "Hidden SOP", content: "Private procedure", scopeType: "user", branchIds: [], departmentIds: [], userMembershipIds: [adminMembershipId] });

    const tasks = await t.withIdentity(identity("employee")).query(api.tasks.aiListVisible, { companyId, status: "all", limit: 10 });
    expect(tasks.map((task) => task.title)).toEqual(["Visible task"]);
    const sops = await t.withIdentity(identity("employee")).query(api.sops.aiSearch, { companyId, query: "procedure" });
    expect(sops.map((sop) => sop.title)).toEqual(["Visible SOP"]);
  });

  test("cross-company AI sessions and unauthorized writes fail", async () => {
    const { t, companyId, otherCompanyId, employeeMembershipId } = await seed();
    const sessionId = await t.withIdentity(identity("admin")).mutation(api.aiChat.createSession, { companyId });

    await expect(t.withIdentity(identity("admin")).query(api.aiChat.authorizeSessionForAgent, { companyId: otherCompanyId, sessionId })).rejects.toThrow("Chat session not found");
    await expect(t.withIdentity(identity("employee")).mutation(api.tasks.aiCreateOneTime, { companyId, title: "Nope", description: "", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [employeeMembershipId], priority: "medium" })).rejects.toThrow("access");
    await expect(t.withIdentity(identity("employee")).mutation(api.sops.aiCreate, { companyId, title: "Nope", content: "Body" })).rejects.toThrow("access");
  });
});
