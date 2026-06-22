/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const MESSAGE_HISTORY_LIMIT = 100;

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

  test("AI session list excludes drafts until they have messages", async () => {
    const { t, companyId } = await seed();
    const sessionId = await t.withIdentity(identity("admin")).mutation(api.aiChat.createSession, { companyId });

    await expect(t.withIdentity(identity("admin")).query(api.aiChat.listSessions, { companyId })).resolves.toEqual([]);

    await t.withIdentity(identity("admin")).mutation(api.aiChat.appendMessage, { companyId, sessionId, role: "user", content: "Hello" });

    const sessions = await t.withIdentity(identity("admin")).query(api.aiChat.listSessions, { companyId });
    expect(sessions.map((session) => session._id)).toEqual([sessionId]);
  });

  test("AI session list includes legacy sessions without hasMessages", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const sessionId = await t.run(async (ctx) => {
      const now = Date.now();
      const sessionId = await ctx.db.insert("aiChatSessions", { companyId, membershipId: adminMembershipId, createdAt: now, updatedAt: now });
      await ctx.db.insert("aiChatMessages", { sessionId, role: "user", content: "Legacy message", createdAt: now });
      return sessionId;
    });

    const sessions = await t.withIdentity(identity("admin")).query(api.aiChat.listSessions, { companyId });
    expect(sessions.map((session) => session._id)).toContain(sessionId);
  });

  test("AI message history returns the newest bounded window", async () => {
    const { t, companyId } = await seed();
    const sessionId = await t.withIdentity(identity("admin")).mutation(api.aiChat.createSession, { companyId });
    await t.run(async (ctx) => {
      const now = Date.now() - 10_000;
      for (let i = 0; i < MESSAGE_HISTORY_LIMIT; i += 1) await ctx.db.insert("aiChatMessages", { sessionId, role: "user", content: `Old ${i}`, createdAt: now + i });
      await ctx.db.patch(sessionId, { hasMessages: true, updatedAt: now });
    });

    await t.withIdentity(identity("admin")).mutation(api.aiChat.appendMessage, { companyId, sessionId, role: "user", content: "Latest prompt" });

    const messages = await t.withIdentity(identity("admin")).query(api.aiChat.listMessages, { companyId, sessionId });
    expect(messages).toHaveLength(MESSAGE_HISTORY_LIMIT);
    expect(messages.map((message) => message.content)).toContain("Latest prompt");
    expect(messages.at(-1)?.content).toBe("Latest prompt");
  });

  test("AI session list returns recently updated sessions beyond the first 50 created", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const ids = [];
      for (let i = 0; i < 60; i += 1) ids.push(await ctx.db.insert("aiChatSessions", { companyId, membershipId: adminMembershipId, hasMessages: true, createdAt: now + i, updatedAt: now + i }));
      await ctx.db.patch(ids[0], { updatedAt: now + 10_000 });
      return ids;
    });

    const sessions = await t.withIdentity(identity("admin")).query(api.aiChat.listSessions, { companyId });
    expect(sessions).toHaveLength(50);
    expect(sessions[0]?._id).toBe(ids[0]);
    expect(sessions.map((session) => session._id)).toContain(ids[59]);
  });

  test("deleting an AI session removes all of its messages", async () => {
    const { t, companyId } = await seed();
    const sessionId = await t.withIdentity(identity("admin")).mutation(api.aiChat.createSession, { companyId });
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 101; i += 1) await ctx.db.insert("aiChatMessages", { sessionId, role: "user", content: `Message ${i}`, createdAt: now + i });
      await ctx.db.patch(sessionId, { hasMessages: true, updatedAt: now });
    });

    vi.useFakeTimers();
    try {
      await t.withIdentity(identity("admin")).mutation(api.aiChat.deleteSession, { companyId, sessionId });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    const remaining = await t.run(async (ctx) => await ctx.db.query("aiChatMessages").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(200));
    expect(remaining).toHaveLength(0);
    const sessions = await t.withIdentity(identity("admin")).query(api.aiChat.listSessions, { companyId });
    expect(sessions.some((session) => session._id === sessionId)).toBe(false);
    await expect(t.withIdentity(identity("admin")).query(api.aiChat.listMessages, { companyId, sessionId })).rejects.toThrow("Chat session not found");
  });
});
