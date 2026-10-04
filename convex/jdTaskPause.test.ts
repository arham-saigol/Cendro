import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { createAuthzFixture } from "./authz.fixture";
import { defaultRoleCapabilities } from "../src/lib/permissions";

const utc = (day: number, hour = 12) => Date.UTC(2026, 5, day, hour);
const paginationOpts = { numItems: 100, cursor: null };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(utc(1)); });
afterEach(() => { vi.useRealTimers(); });

test("pause preserves history and suppresses discovery, counts and cycles; resume skips suspended deadlines on the working calendar", async () => {
  const f = await createAuthzFixture();
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.companyA, { timeZone: "UTC" });
    await ctx.db.insert("companyCalendars", { companyId: f.companyA, workingDays: [1, 2, 3, 4, 5], updatedAt: utc(1) });
  });
  const admin = f.asUser("adminA");
  const companyId = f.companyA;
  const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Daily check", recurrence: "daily", assigneeMembershipIds: [f.employee1M] });
  await admin.mutation(api.tasks.completeJd, { companyId, taskId, note: "Keep this history" });
  await admin.mutation(api.tasks.addComment, { companyId, taskType: "jd", taskId, body: "Keep this discussion" });
  vi.setSystemTime(utc(3));
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: true });
  // Retrying pause must not add events or advance the suspension timestamp.
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: true });
  expect((await admin.query(api.tasks.listJdRows, { companyId, paginationOpts })).page).toEqual([]);
  const paused = await admin.query(api.tasks.listJdRows, { companyId, paused: true, paginationOpts });
  expect(paused.page).toMatchObject([{ _id: taskId, canResume: true, state: { status: "Paused", dueAt: null, isOverdue: false } }]);
  expect((await admin.query(api.analytics.summary, { companyId })).jdTaskCount).toBe(0);
  expect((await admin.query(api.tasks.searchJd, { companyId, query: "Daily" })).tasks).toEqual([]);
  expect((await admin.query(api.tasks.exportRows, { companyId, kind: "jd", paginationOpts })).page).toEqual([]);
  expect((await admin.query(api.tasks.aiListVisible, { companyId, kind: "jd", status: "all", limit: 30 })).rows).toEqual([]);
  await expect(f.asUser("employeeA1").mutation(api.tasks.completeJd, { companyId, taskId })).rejects.toThrow("Resume this task");
  const pausedDashboard = await admin.query(api.analytics.dashboard, { companyId, now: utc(3), range: { preset: "custom", startDate: "2026-06-01", endDate: "2026-06-30" } });
  expect(pausedDashboard.jd).toMatchObject({ due: 0, overdue: 0 });
  vi.setSystemTime(utc(20)); // Saturday: next working occurrence is Monday June 22.
  await f.t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
  await f.t.mutation(internal.tasks.catchUpMissedJdCycles, { taskId });
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: false });
  // Even the pre-pause scheduled work executing after resume is frozen at June 3.
  await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
  let records = await admin.query(api.tasks.listJdCycleRecords, { companyId, taskId });
  expect(records.map((row) => row.cycleStart)).toEqual([utc(2, 0)]);
  const detail = await admin.query(api.tasks.getJd, { companyId, taskId });
  expect(detail.task).toMatchObject({ cycleStartedAt: utc(22, 0), state: { currentCycleStart: utc(22, 0), rawStatus: "due", isOverdue: false } });
  expect(detail.task.pausedAt).toBeUndefined();
  expect((await admin.query(api.tasks.listComments, { companyId, taskType: "jd", taskId, paginationOpts })).page[0].body).toBe("Keep this discussion");
  const completions = await f.t.run((ctx) => ctx.db.query("jdTaskCompletions").collect());
  expect(completions).toMatchObject([{ jdTaskId: taskId, cycleStart: utc(1, 0), note: "Keep this history" }]);
  vi.setSystemTime(utc(23));
  await f.t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
  records = await admin.query(api.tasks.listJdCycleRecords, { companyId, taskId });
  expect(records.map((row) => row.cycleStart)).toEqual([utc(22, 0), utc(2, 0)]);
  const events = await f.t.run((ctx) => ctx.db.query("taskActivityLogs").collect());
  expect(events.filter((event) => event.event === "paused")).toHaveLength(1);
  expect(events.filter((event) => event.event === "resumed")).toHaveLength(1);
});

test("pause and resume permissions are independent, scoped on every row and atomic across tenants", async () => {
  const f = await createAuthzFixture();
  const admin = f.asUser("adminA"), manager = f.asUser("managerA");
  const companyId = f.companyA;
  const create = (assigneeMembershipIds: typeof f.employee1M[]) => admin.mutation(api.tasks.createJd, { companyId, title: "Check", recurrence: "weekly", assigneeMembershipIds });
  const own = await create([f.employee1M]), outside = await create([f.employee2M]), shared = await create([f.employee1M, f.employee2M]);
  const foreign = await f.asUser("adminB").mutation(api.tasks.createJd, { companyId: f.companyB, title: "Other tenant", recurrence: "weekly", assigneeMembershipIds: [f.employeeBM] });
  const pause = (taskIds: typeof own[], paused = true) => manager.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds, paused });
  await expect(pause([own])).rejects.toThrow("access");
  await f.setRoleCapabilities(companyId, "Manager", [...defaultRoleCapabilities.Manager, "tasks:jd:pause", "tasks:jd:view:any"]);
  for (const forbidden of [outside, shared, foreign]) {
    await expect(pause([own, forbidden])).rejects.toThrow();
    expect((await admin.query(api.tasks.getJd, { companyId, taskId: own })).task.pausedAt).toBeUndefined();
  }
  await pause([own]);
  const rows = await manager.query(api.tasks.listJdRows, { companyId, paused: true, paginationOpts });
  expect(rows.page).toMatchObject([{ _id: own, canPause: true, canResume: false }]);
  await expect(pause([own], false)).rejects.toThrow("access");
  await f.setRoleCapabilities(companyId, "Manager", [...defaultRoleCapabilities.Manager, "tasks:jd:resume"]);
  await expect(pause([outside])).rejects.toThrow("access");
  await pause([own], false);
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [own, outside], paused: true });
  // The paused filter keeps the viewer's existing managed/self visibility.
  expect((await manager.query(api.tasks.listJdRows, { companyId, paused: true, paginationOpts })).page.map((row) => row._id)).toEqual([own]);
  expect((await f.asUser("employeeA2").query(api.tasks.listJdRows, { companyId, paused: true, paginationOpts })).page.map((row) => row._id)).toEqual([outside]);
  await expect(pause([own, own], false)).rejects.toThrow("unique");
});

test("release backfill enables lifecycle defaults only for untouched Admin roles", async () => {
  const f = await createAuthzFixture();
  const previous = defaultRoleCapabilities.Admin.filter((cap) => cap !== "tasks:jd:pause" && cap !== "tasks:jd:resume");
  await f.setRoleCapabilities(f.companyA, "Admin", previous);
  await f.setRoleCapabilities(f.companyB, "Admin", ["tasks:jd:view:any"]);
  expect(await f.t.mutation(internal.roles.enableJdLifecycleDefaults, {})).toBe(1);
  expect(await f.t.mutation(internal.roles.enableJdLifecycleDefaults, {})).toBe(0);
  expect((await f.asUser("adminA").query(api.tasks.listJdRows, { companyId: f.companyA, paused: true, paginationOpts })).page).toEqual([]);
  const caps = await f.t.run(async (ctx) => (await ctx.db.query("roles").withIndex("by_company_and_name", (q) => q.eq("companyId", f.companyA).eq("name", "Admin")).unique())!.capabilities);
  expect(caps).toEqual(expect.arrayContaining(["tasks:jd:pause", "tasks:jd:resume"]));
  const customized = await f.t.run(async (ctx) => (await ctx.db.query("roles").withIndex("by_company_and_name", (q) => q.eq("companyId", f.companyB).eq("name", "Admin")).unique())!.capabilities);
  expect(customized).toEqual(["tasks:jd:view:any"]);
});

test("same-cycle resume and recurrence edits while paused never erase completions", async () => {
  const f = await createAuthzFixture();
  const admin = f.asUser("adminA"), companyId = f.companyA;
  await f.t.run(async (ctx) => {
    await ctx.db.patch(companyId, { timeZone: "UTC" });
    await ctx.db.insert("companyCalendars", { companyId, workingDays: [0, 1, 2, 3, 4, 5, 6], updatedAt: utc(1) });
  });
  const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Review", recurrence: "weekly", assigneeMembershipIds: [f.employee1M] });
  await admin.mutation(api.tasks.completeJd, { companyId, taskId });
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: true });
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: false });
  expect((await admin.query(api.tasks.getJd, { companyId, taskId })).task.state.rawStatus).toBe("completed");
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: true });
  await admin.mutation(api.tasks.updateJdFields, { companyId, taskId, recurrence: "monthly" });
  await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
  expect(await f.t.run((ctx) => ctx.db.query("jdTaskCompletions").collect())).toMatchObject([{ retiredAt: expect.any(Number) }]);
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: false });
  expect((await admin.query(api.tasks.getJd, { companyId, taskId })).task.state.rawStatus).toBe("due");
  // A new completion can coexist with the preserved old-grid completion at
  // the same start, and analytics must not merge the two schedules.
  vi.setSystemTime(utc(30));
  const dashboard = await admin.query(api.analytics.dashboard, { companyId, now: utc(30), range: { preset: "custom", startDate: "2026-06-01", endDate: "2026-06-30" } });
  expect(dashboard.jd).toMatchObject({ completed: 1, due: 2 });
  await admin.mutation(api.tasks.completeJd, { companyId, taskId });
  expect((await admin.query(api.tasks.getJd, { companyId, taskId })).task.state.rawStatus).toBe("completed");
  expect(await f.t.run((ctx) => ctx.db.query("jdTaskCompletions").collect())).toHaveLength(2);
});
