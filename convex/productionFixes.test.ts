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
    await ctx.db.insert("permissionOverrides", { companyId, membershipId: employeeMembershipId, capability: "tasks:one_time:create", effect: "allow", updatedAt: Date.now() });
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

  test("self-assignment works even without assign capabilities", async () => {
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
