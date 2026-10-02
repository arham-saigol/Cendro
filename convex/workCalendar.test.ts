/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

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
    const employeeUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|employee", email: "employee@example.com", firstName: "Employee", secondName: "", createdAt: now, updatedAt: now });
    const employeeMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: employeeUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
    return { companyId, adminMembershipId, employeeMembershipId };
  });
  return { t, ...ids };
}

async function missedCycleStarts(t: Awaited<ReturnType<typeof seedCompany>>["t"], taskId: Id<"jdTasks">) {
  const records = await t.run(async (ctx) =>
    await ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect()
  );
  return records.map((record) => record.cycleStart).sort();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("work calendar settings", () => {
  test("defaults to Monday through Saturday with no holidays", async () => {
    const { t, companyId } = await seedCompany();
    const calendar = await t.withIdentity(identity("admin")).query(api.workCalendar.get, { companyId });
    expect(calendar.workingDays).toEqual([1, 2, 3, 4, 5, 6]);
    expect(calendar.holidays).toEqual([]);
  });

  test("admin can set working days and manage holidays; employee cannot", async () => {
    const { t, companyId } = await seedCompany();
    await t.withIdentity(identity("admin")).mutation(api.workCalendar.setWorkingDays, { companyId, workingDays: [0, 1, 2, 3, 4, 5] });
    const holidayId = await t.withIdentity(identity("admin")).mutation(api.workCalendar.addHoliday, { companyId, name: "Office closed", startDate: "2026-12-24", endDate: "2026-12-31" });

    const calendar = await t.withIdentity(identity("admin")).query(api.workCalendar.get, { companyId });
    expect(calendar.workingDays).toEqual([0, 1, 2, 3, 4, 5]);
    expect(calendar.holidays).toEqual([{ _id: holidayId, name: "Office closed", startDate: "2026-12-24", endDate: "2026-12-31" }]);

    await t.withIdentity(identity("admin")).mutation(api.workCalendar.removeHoliday, { companyId, holidayId });
    expect((await t.withIdentity(identity("admin")).query(api.workCalendar.get, { companyId })).holidays).toEqual([]);

    await expect(
      t.withIdentity(identity("employee")).mutation(api.workCalendar.setWorkingDays, { companyId, workingDays: [1] })
    ).rejects.toThrow();
    await expect(
      t.withIdentity(identity("employee")).mutation(api.workCalendar.addHoliday, { companyId, name: "Nope", startDate: "2026-01-01", endDate: "2026-01-01" })
    ).rejects.toThrow();
    await expect(
      t.withIdentity(identity("admin")).mutation(api.workCalendar.setWorkingDays, { companyId, workingDays: [] })
    ).rejects.toThrow();
  });
});

describe("JD tasks on a work calendar", () => {
  test("daily task skips Sundays: no missed occurrence and no overdue record for the off day", async () => {
    // Jan 2 2026 is a Friday; Jan 3 Sat, Jan 4 Sun, Jan 5 Mon. Default calendar
    // makes Sunday a non-working day.
    vi.setSystemTime(utc(2026, 1, 2, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Daily check", description: "", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });

    vi.setSystemTime(utc(2026, 1, 5, 12));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Friday and Saturday elapsed as ordinary misses; the Sunday cycle never
    // existed as an occurrence, so it produces no record.
    expect(await missedCycleStarts(t, taskId)).toEqual([utc(2026, 1, 2), utc(2026, 1, 3)]);
  });

  test("every-other-day task skips a non-working due date and keeps its two-day cadence", async () => {
    // dayIndex(2026-01-03) is even, so the 2-day windows are [Jan3-Jan4],
    // [Jan5-Jan6], … and [Jan3-Jan4] is due Sunday Jan 4 → skipped.
    vi.setSystemTime(utc(2026, 1, 1, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Alternate check", description: "", recurrence: "every_other_day", assigneeMembershipIds: [adminMembershipId] });

    vi.setSystemTime(utc(2026, 1, 7, 12));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // [Jan1-Jan2] due Fri, [Jan3-Jan4] due Sun (skipped), [Jan5-Jan6] due Tue.
    // The cadence is untouched: missed records sit on the unchanged grid.
    expect(await missedCycleStarts(t, taskId)).toEqual([utc(2026, 1, 1), utc(2026, 1, 5)]);
  });

  test("weekly task due on Sunday is due at the end of the next working day", async () => {
    // Weekly cycles are Monday-anchored: [Mon Jan 19 → Mon Jan 26) is due
    // Sunday Jan 25, which shifts to the end of Monday Jan 26.
    vi.setSystemTime(utc(2026, 1, 22, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });

    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    expect(detail.task.state.currentCycleStart).toBe(utc(2026, 1, 19));
    expect(detail.task.state.dueAt).toBe(utc(2026, 1, 27));

    // The cycle has grid-ended but its shifted deadline is still pending, so
    // nothing is missed yet.
    vi.setSystemTime(utc(2026, 1, 26, 12));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await missedCycleStarts(t, taskId)).toEqual([]);

    // Once the shifted deadline passes, the miss is recorded under the
    // unchanged grid key with the shifted deadline as its stored end.
    vi.setSystemTime(utc(2026, 1, 27, 12));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const records = await t.run(async (ctx) =>
      await ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect()
    );
    expect(records).toMatchObject([{ cycleStart: utc(2026, 1, 19), cycleEnd: utc(2026, 1, 27), status: "missed" }]);
  });

  test("a holiday moves the shifted due date further to the next working day", async () => {
    vi.setSystemTime(utc(2026, 1, 22, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.workCalendar.addHoliday, { companyId, name: "Founders' day", startDate: "2026-01-26", endDate: "2026-01-26" });

    // Due Sunday Jan 25 → Monday Jan 26 is a holiday → due end of Tuesday Jan 27.
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    expect(detail.task.state.dueAt).toBe(utc(2026, 1, 28));
  });

  test("completing a daily task on Sunday counts toward Monday's occurrence", async () => {
    vi.setSystemTime(utc(2026, 1, 2, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Daily check", description: "", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });

    vi.setSystemTime(utc(2026, 1, 4, 12));
    await t.withIdentity(identity("admin")).mutation(api.tasks.completeJd, { companyId, taskId });

    // On the skipped Sunday, the effective current occurrence is Monday's, so
    // the completion is recorded against that cycle start.
    const completions = await t.run(async (ctx) =>
      await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect()
    );
    expect(completions).toMatchObject([{ cycleStart: utc(2026, 1, 5) }]);

    vi.setSystemTime(utc(2026, 1, 7, 12));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Fri and Sat missed, Sun skipped, Mon completed via the off-day click,
    // Tue elapsed untouched — a genuine miss.
    expect(await missedCycleStarts(t, taskId)).toEqual([utc(2026, 1, 2), utc(2026, 1, 3), utc(2026, 1, 6)]);
  });

  test("one-time tasks ignore the calendar entirely", async () => {
    vi.setSystemTime(utc(2026, 1, 2, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, {
      companyId,
      title: "One-off",
      description: "",
      priority: "medium",
      dueDate: utc(2026, 1, 4), // Sunday — explicitly chosen, must not move.
      assigneeMembershipIds: [adminMembershipId],
    });
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getOneTime, { companyId, taskId });
    expect(detail.task.dueDate).toBe(utc(2026, 1, 4));
  });
});
