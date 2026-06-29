/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { currentJdCycle } from "./taskCycles";

const modules = import.meta.glob("./**/*.ts");

function identity(key: string, email = `${key}@example.com`) {
  return { tokenIdentifier: `clerk|${key}`, subject: key, issuer: "https://clerk.test", email, name: key };
}

function utc(year: number, month: number, day: number, hour = 0, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute);
}

async function seedCompany(timeZone = "UTC") {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const companyId = await ctx.db.insert("companies", { name: "Acme", timeZone, createdAt: now });
    const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", secondName: "", createdAt: now, updatedAt: now });
    const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
    return { companyId, adminMembershipId };
  });
  return { t, ...ids };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("JD task cycle behavior", () => {
  test("weekly JD task created on Thursday uses the fixed Monday-to-Monday cycle", async () => {
    vi.setSystemTime(utc(2026, 6, 25, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();

    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });

    expect(detail.task.state.rawStatus).toBe("due");
    expect(detail.task.state.currentCycleStart).toBe(utc(2026, 6, 22));
    expect(detail.task.state.currentCycleEnd).toBe(utc(2026, 6, 29));
  });

  test("weekly JD task rolls into the next Monday cycle and resets to not started", async () => {
    vi.setSystemTime(utc(2026, 6, 25, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.tasks.updateJdStatus, { companyId, taskId, status: "in_progress" });

    vi.setSystemTime(utc(2026, 6, 29));
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });

    expect(detail.task.state.rawStatus).toBe("due");
    expect(detail.task.state.status).toBe("Not Started");
    expect(detail.task.state.currentCycleStart).toBe(utc(2026, 6, 29));
  });

  test("daily JD task rolls over at midnight and resets to not started", async () => {
    vi.setSystemTime(utc(2026, 6, 26, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Daily check", description: "", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.tasks.updateJdStatus, { companyId, taskId, status: "in_progress" });

    vi.setSystemTime(utc(2026, 6, 27));
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });

    expect(detail.task.state.rawStatus).toBe("due");
    expect(detail.task.state.currentCycleStart).toBe(utc(2026, 6, 27));
  });

  test("missed previous JD cycle is recorded historically but current task is not overdue", async () => {
    vi.setSystemTime(utc(2026, 6, 25, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.tasks.updateJdStatus, { companyId, taskId, status: "in_progress" });

    vi.setSystemTime(utc(2026, 6, 29));
    await t.withIdentity(identity("admin")).mutation(api.tasks.updateJd, { companyId, taskId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    const rows = await t.withIdentity(identity("admin")).query(api.tasks.listJdRows, { companyId, frequency: "weekly" });
    const records = await t.withIdentity(identity("admin")).query(api.tasks.listJdCycleRecords, { companyId, taskId });

    expect(detail.task.state.rawStatus).toBe("due");
    expect(detail.task.state.isOverdue).toBe(false);
    expect(rows.find((row) => row._id === taskId)?.state.rawStatus).toBe("due");
    expect(records).toMatchObject([{ cycleStart: utc(2026, 6, 22), cycleEnd: utc(2026, 6, 29), status: "missed" }]);
  });

  test("completed previous JD cycle starts the new current cycle as not started", async () => {
    vi.setSystemTime(utc(2026, 6, 25, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.tasks.completeJd, { companyId, taskId });

    vi.setSystemTime(utc(2026, 6, 29));
    await t.withIdentity(identity("admin")).mutation(api.tasks.updateJd, { companyId, taskId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    const records = await t.withIdentity(identity("admin")).query(api.tasks.listJdCycleRecords, { companyId, taskId });

    expect(detail.task.state.rawStatus).toBe("due");
    expect(records).toEqual([]);
  });

  test("one-time task can still become overdue", async () => {
    vi.setSystemTime(utc(2026, 6, 26, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "One-time", description: "", dueDate: utc(2026, 6, 26, 13), assigneeMembershipIds: [adminMembershipId], priority: "medium" });

    vi.setSystemTime(utc(2026, 6, 26, 14));
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getOneTime, { companyId, taskId });

    expect(detail.task.state.rawStatus).toBe("overdue");
    expect(detail.task.state.isOverdue).toBe(true);
  });
});

describe("fixed JD calendar cycle boundaries", () => {
  test("monthly, six-month, and yearly boundaries use the selected time zone", () => {
    expect(currentJdCycle("monthly", utc(2026, 6, 15, 9), "UTC")).toEqual({ start: utc(2026, 6, 1), end: utc(2026, 7, 1) });
    expect(currentJdCycle("semiannually", utc(2026, 6, 30, 23, 59), "UTC")).toEqual({ start: utc(2026, 1, 1), end: utc(2026, 7, 1) });
    expect(currentJdCycle("semiannually", utc(2026, 7, 1), "UTC")).toEqual({ start: utc(2026, 7, 1), end: utc(2027, 1, 1) });
    expect(currentJdCycle("annually", utc(2026, 12, 31, 23, 59), "UTC")).toEqual({ start: utc(2026, 1, 1), end: utc(2027, 1, 1) });
  });

  test("missing company/browser time zone falls back to GMT+5", () => {
    expect(currentJdCycle("daily", utc(2026, 6, 27))).toEqual({ start: utc(2026, 6, 26, 19), end: utc(2026, 6, 27, 19) });
  });
});
