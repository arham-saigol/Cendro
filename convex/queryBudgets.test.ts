/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function identity(key: string, email = `${key}@example.com`) {
  return { tokenIdentifier: `clerk|${key}`, subject: key, issuer: "https://clerk.test", email, name: key };
}

describe("WP-07: Query budgets and silent incompleteness prevention", () => {
  test("501 tasks detect overflow via limit + 1 and mark dashboard and metrics as truncated/incomplete", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    const { companyId, adminM } = await t.run(async (ctx) => {
      const companyId = await ctx.db.insert("companies", { name: "Budget Corp", createdAt: now });
      const adminUser = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", createdAt: now, updatedAt: now });
      const adminM = await ctx.db.insert("companyMemberships", { companyId, userId: adminUser, role: "Admin", active: true, createdAt: now, updatedAt: now });

      // Exactly at the cap is still a complete report.
      for (let i = 1; i <= 500; i++) {
        await ctx.db.insert("oneTimeTasks", {
          companyId,
          reference: `TASK-${i}`,
          title: `Task ${i}`,
          priority: "medium",
          status: "due",
          assigneeMembershipIds: [adminM],
          createdByMembershipId: adminM,
          createdAt: now + i,
          updatedAt: now + i,
        });
      }

      return { companyId, adminM };
    });

    const completeDash = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId });
    expect(completeDash.isTruncated).toBe(false);
    expect(completeDash.reportState).toBe("complete");

    await t.run(async (ctx) => {
      await ctx.db.insert("oneTimeTasks", {
        companyId,
        reference: "TASK-501",
        title: "Task 501",
        priority: "medium",
        status: "due",
        assigneeMembershipIds: [adminM],
        createdByMembershipId: adminM,
        createdAt: now + 501,
        updatedAt: now + 501,
      });
    });

    // 1. Dashboard query MUST report incomplete/truncated state.
    const dash = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId });
    expect(dash.isTruncated).toBe(true);
    expect(dash.reportState).toBe("incomplete");
    expect(dash.limitations.dataTruncated).toBe(true);
    expect(dash.metrics.isTruncated).toBe(true);

    // 2. aiSummary query MUST report incomplete/truncated state
    const aiSum = await t.withIdentity(identity("admin")).query(api.analytics.aiSummary, { companyId });
    expect(aiSum.isTruncated).toBe(true);
    expect(aiSum.isComplete).toBe(false);

    const performance = await t.withIdentity(identity("admin")).query(api.aiWorkspace.performanceSummary, { companyId });
    expect(performance.isTruncated).toBe(true);
    expect(performance.isComplete).toBe(false);
  });

  test("user beyond the first 500 is discoverable by authorized picker when searched", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    const { companyId, targetUserM } = await t.run(async (ctx) => {
      const companyId = await ctx.db.insert("companies", { name: "Big Corp", createdAt: now });
      const adminUser = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", createdAt: now, updatedAt: now });
      await ctx.db.insert("companyMemberships", { companyId, userId: adminUser, role: "Admin", active: true, createdAt: now, updatedAt: now });

      // Insert 500 other members
      for (let i = 1; i <= 500; i++) {
        const u = await ctx.db.insert("appUsers", { clerkSubject: `clerk|user${i}`, email: `user${i}@example.com`, firstName: `User${i}`, createdAt: now, updatedAt: now });
        await ctx.db.insert("companyMemberships", { companyId, userId: u, role: "Employee", active: true, createdAt: now, updatedAt: now });
      }

      // Member 501: special unique name
      const targetUser = await ctx.db.insert("appUsers", {
        clerkSubject: "clerk|target501",
        email: "zoebeyond@example.com",
        firstName: "Zoe",
        secondName: "Beyond",
        createdAt: now,
        updatedAt: now,
      });
      const targetUserM = await ctx.db.insert("companyMemberships", { companyId, userId: targetUser, role: "Employee", active: true, createdAt: now, updatedAt: now });

      return { companyId, targetUserM };
    });

    // Admin searches for "Zoe" in assignableUsers
    const results = await t.withIdentity(identity("admin")).query(api.tasks.assignableUsers, {
      companyId,
      kind: "one_time",
      search: "Zoe",
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.membership._id === targetUserM)).toBe(true);
    expect(results.find((r) => r.membership._id === targetUserM)?.user.fullName).toBe("Zoe Beyond");
  });

  test("companyManagement.overview detects truncated membership list when >500 members", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    const { companyId } = await t.run(async (ctx) => {
      const companyId = await ctx.db.insert("companies", { name: "Mega Corp", createdAt: now });
      const adminUser = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", createdAt: now, updatedAt: now });
      await ctx.db.insert("companyMemberships", { companyId, userId: adminUser, role: "Admin", active: true, createdAt: now, updatedAt: now });

      for (let i = 1; i <= 501; i++) {
        const u = await ctx.db.insert("appUsers", { clerkSubject: `clerk|emp${i}`, email: `emp${i}@example.com`, firstName: `Emp${i}`, createdAt: now, updatedAt: now });
        await ctx.db.insert("companyMemberships", { companyId, userId: u, role: "Employee", active: true, createdAt: now, updatedAt: now });
      }

      return { companyId };
    });

    const ov = await t.withIdentity(identity("admin")).query(api.companyManagement.overview, { companyId });
    expect(ov.isTruncated).toBe(true);
    expect(ov.truncated?.users).toBe(true);
  });

  test("manager branch-scope overflow marks analytics summaries incomplete", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    const { companyId } = await t.run(async (ctx) => {
      const companyId = await ctx.db.insert("companies", { name: "Scoped Corp", createdAt: now });
      const managerUser = await ctx.db.insert("appUsers", { clerkSubject: "clerk|manager", email: "manager@example.com", firstName: "Manager", createdAt: now, updatedAt: now });
      const managerMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: managerUser, role: "Manager", active: true, createdAt: now, updatedAt: now });
      const branchId = await ctx.db.insert("branches", { companyId, name: "Operations", order: 0, createdAt: now, updatedAt: now });
      await ctx.db.insert("managerBranchScopes", { companyId, managerMembershipId, branchId, updatedAt: now });

      for (let i = 1; i <= 501; i++) {
        const userId = await ctx.db.insert("appUsers", { clerkSubject: `clerk|scoped${i}`, email: `scoped${i}@example.com`, firstName: `Scoped${i}`, createdAt: now, updatedAt: now });
        const membershipId = await ctx.db.insert("companyMemberships", { companyId, userId, role: "Employee", active: true, createdAt: now, updatedAt: now });
        await ctx.db.insert("userBranchAssignments", { companyId, membershipId, branchId });
      }

      return { companyId };
    });

    const summary = await t.withIdentity(identity("manager")).query(api.analytics.summary, { companyId });
    expect(summary.isTruncated).toBe(true);
    expect(summary.isComplete).toBe(false);
  });
});
