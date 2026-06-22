import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertCanAssign, assertCanUpdateTask, membershipCapabilities, requireCapability, requireMembership, scopedMembershipIds } from "./permissions";
import { nonEmpty } from "./validation";

type Rec = Doc<"jdTasks">["recurrence"];
const day = 86_400_000;
function sod(ms: number) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addM(ms: number, m: number) { const d = new Date(ms); d.setMonth(d.getMonth() + m); return d.getTime(); }
function next(s: number, r: Rec) {
  switch (r) {
    case "daily": return s + day;
    case "every_other_day": return s + 2 * day;
    case "weekly": return s + 7 * day;
    case "every_two_weeks": return s + 14 * day;
    case "monthly": return addM(s, 1);
    case "semiannually": return addM(s, 6);
    case "annually": return addM(s, 12);
  }
}
function cycle(startDate: number, r: Rec, now = Date.now()) { let start = sod(startDate); let end = next(start, r); while (end <= now) { start = end; end = next(start, r); } return { start, end }; }
function prevCycle(startDate: number, r: Rec) { const c = cycle(startDate, r); let prev = sod(startDate); let end = next(prev, r); while (end < c.start) { prev = end; end = next(prev, r); } return c.start === sod(startDate) ? null : { start: prev, end: c.start }; }

async function enrich(ctx: any, ids: Id<"companyMemberships">[]) {
  const uniqueIds = Array.from(new Set(ids));
  const memberships = (await Promise.all(uniqueIds.map((id) => ctx.db.get(id)))).filter(Boolean) as Doc<"companyMemberships">[];
  const users = (await Promise.all(memberships.map((membership) => ctx.db.get(membership.userId)))).filter(Boolean) as Doc<"appUsers">[];
  const userById = new Map(users.map((user) => [user._id, user]));
  return memberships.flatMap((membership) => {
    const user = userById.get(membership.userId);
    return user ? [{ membership: { _id: membership._id, role: membership.role }, user: { name: user.name, email: user.email } }] : [];
  });
}

async function visible(ctx: any, companyId: Id<"companies">, m: Doc<"companyMemberships">, assignees: Id<"companyMemberships">[]) {
  const scoped = await scopedMembershipIds(ctx, companyId, m);
  return assignees.some((id) => scoped.has(id));
}

async function assertAssigneesInCompany(ctx: any, companyId: Id<"companies">, assignees: Id<"companyMemberships">[]) {
  if (!assignees.length) throw new ConvexError("At least one assignee is required.");
  for (const id of assignees) {
    const membership = await ctx.db.get(id);
    if (!membership || membership.companyId !== companyId || !membership.active) throw new ConvexError("Assignee not found in this company.");
  }
}

async function jdState(ctx: any, t: Doc<"jdTasks">) {
  const c = cycle(t.startDate, t.recurrence);
  const p = prevCycle(t.startDate, t.recurrence);
  const currentDone = await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q: any) => q.eq("jdTaskId", t._id).eq("cycleStart", c.start)).unique();
  const prevDone = p ? await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q: any) => q.eq("jdTaskId", t._id).eq("cycleStart", p.start)).unique() : null;
  const last = (await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_completedAt", (q: any) => q.eq("jdTaskId", t._id)).order("desc").take(1))[0];
  return { status: currentDone ? "Done" : p && !prevDone ? "Overdue" : "Due", currentCycleStart: c.start, currentCycleEnd: c.end, dueAt: c.end, lastCompletedAt: last?.completedAt ?? null };
}
function oneState(t: Doc<"oneTimeTasks">) { if (t.completedAt) return "Done"; if (t.dueDate < Date.now()) return "Overdue"; if (sod(t.dueDate) === sod(Date.now())) return "Due today"; return "Upcoming"; }

async function getVisibleTask(ctx: any, companyId: Id<"companies">, membership: Doc<"companyMemberships">, taskType: "jd" | "one_time", taskId: string) {
  const normalized = taskType === "jd" ? ctx.db.normalizeId("jdTasks", taskId) : ctx.db.normalizeId("oneTimeTasks", taskId);
  if (!normalized) throw new ConvexError("Task not found.");
  const task = await ctx.db.get(normalized);
  if (!task || task.companyId !== companyId || !(await visible(ctx, companyId, membership, task.assigneeMembershipIds))) throw new ConvexError("Task not found.");
  return { normalized, task };
}

export const listJd = query({
  args: { companyId: v.id("companies"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    // Visibility is scoped asynchronously after database pagination, so a page may contain fewer visible rows than requested; continuation tokens still advance correctly.
    const page = await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").paginate(args.paginationOpts);
    const rows = [];
    for (const t of page.page) if (await visible(ctx, args.companyId, membership, t.assigneeMembershipIds)) rows.push({ ...t, state: await jdState(ctx, t), assignees: await enrich(ctx, t.assigneeMembershipIds) });
    return { ...page, page: rows };
  },
});

export const getJd = query({ args: { companyId: v.id("companies"), taskId: v.id("jdTasks") }, handler: async (ctx, args) => { const { membership } = await requireMembership(ctx, args.companyId); const t = await ctx.db.get(args.taskId); if (!t || t.companyId !== args.companyId || !(await visible(ctx, args.companyId, membership, t.assigneeMembershipIds))) throw new ConvexError("Task not found."); return { task: { ...t, state: await jdState(ctx, t), assignees: await enrich(ctx, t.assigneeMembershipIds) } }; } });

export const createJd = mutation({
  args: { companyId: v.id("companies"), title: v.string(), description: v.optional(v.string()), time: v.optional(v.string()), count: v.optional(v.number()), recurrence: v.union(v.literal("daily"), v.literal("every_other_day"), v.literal("weekly"), v.literal("every_two_weeks"), v.literal("monthly"), v.literal("semiannually"), v.literal("annually")), startDate: v.number(), assigneeMembershipIds: v.array(v.id("companyMemberships")), priority: v.union(v.literal("low"), v.literal("medium"), v.literal("high")) },
  handler: async (ctx, args) => { const { membership, user } = await requireCapability(ctx, args.companyId, "tasks:jd:create"); const title = nonEmpty(args.title, "Title"); await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds); await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "jd"); const now = Date.now(); const id = await ctx.db.insert("jdTasks", { ...args, title, description: args.description?.trim(), createdByMembershipId: membership._id, createdAt: now, updatedAt: now }); await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "jd_task.create", targetType: "jdTask", targetId: id, createdAt: now }); return id; },
});

export const completeJd = mutation({ args: { companyId: v.id("companies"), taskId: v.id("jdTasks"), note: v.optional(v.string()) }, handler: async (ctx, args) => { const { membership } = await requireMembership(ctx, args.companyId); const t = await ctx.db.get(args.taskId); if (!t || t.companyId !== args.companyId) throw new ConvexError("Task not found."); await assertCanUpdateTask(ctx, args.companyId, membership, t.assigneeMembershipIds, "jd"); const c = cycle(t.startDate, t.recurrence); const existing = await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", args.taskId).eq("cycleStart", c.start)).unique(); if (existing) return null; const note = args.note === undefined || args.note.trim() === "" ? undefined : nonEmpty(args.note, "Note"); return await ctx.db.insert("jdTaskCompletions", { companyId: args.companyId, jdTaskId: args.taskId, cycleStart: c.start, completedByMembershipId: membership._id, completedAt: Date.now(), note }); } });

export const listOneTime = query({
  args: { companyId: v.id("companies"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    // Visibility is scoped asynchronously after database pagination, so a page may contain fewer visible rows than requested; continuation tokens still advance correctly.
    const page = await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").paginate(args.paginationOpts);
    const rows = [];
    for (const t of page.page) if (await visible(ctx, args.companyId, membership, t.assigneeMembershipIds)) rows.push({ ...t, state: oneState(t), assignees: await enrich(ctx, t.assigneeMembershipIds) });
    return { ...page, page: rows };
  },
});

export const getOneTime = query({ args: { companyId: v.id("companies"), taskId: v.id("oneTimeTasks") }, handler: async (ctx, args) => { const { membership } = await requireMembership(ctx, args.companyId); const t = await ctx.db.get(args.taskId); if (!t || t.companyId !== args.companyId || !(await visible(ctx, args.companyId, membership, t.assigneeMembershipIds))) throw new ConvexError("Task not found."); return { task: { ...t, state: oneState(t), assignees: await enrich(ctx, t.assigneeMembershipIds) } }; } });

export const createOneTime = mutation({
  args: { companyId: v.id("companies"), title: v.string(), description: v.optional(v.string()), dueDate: v.number(), assigneeMembershipIds: v.array(v.id("companyMemberships")), priority: v.union(v.literal("low"), v.literal("medium"), v.literal("high")) },
  handler: async (ctx, args) => { const { membership, user } = await requireCapability(ctx, args.companyId, "tasks:one_time:create"); const title = nonEmpty(args.title, "Title"); await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds); await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "one_time"); const now = Date.now(); const id = await ctx.db.insert("oneTimeTasks", { ...args, title, description: args.description?.trim(), createdByMembershipId: membership._id, createdAt: now, updatedAt: now }); await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "one_time_task.create", targetType: "oneTimeTask", targetId: id, createdAt: now }); return id; },
});

export const completeOneTime = mutation({ args: { companyId: v.id("companies"), taskId: v.id("oneTimeTasks") }, handler: async (ctx, args) => { const { membership } = await requireMembership(ctx, args.companyId); const t = await ctx.db.get(args.taskId); if (!t || t.companyId !== args.companyId) throw new ConvexError("Task not found."); await assertCanUpdateTask(ctx, args.companyId, membership, t.assigneeMembershipIds, "one_time"); const now = Date.now(); await ctx.db.patch(args.taskId, { completedAt: now, completedByMembershipId: membership._id, updatedAt: now }); } });

export const listComments = query({
  args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => { const { membership } = await requireMembership(ctx, args.companyId); await getVisibleTask(ctx, args.companyId, membership, args.taskType, args.taskId); return await ctx.db.query("taskComments").withIndex("by_task", (q) => q.eq("taskType", args.taskType).eq("taskId", args.taskId)).order("desc").paginate(args.paginationOpts); },
});

export const addComment = mutation({ args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), body: v.string() }, handler: async (ctx, args) => { const { membership } = await requireCapability(ctx, args.companyId, "tasks:comment"); const { normalized } = await getVisibleTask(ctx, args.companyId, membership, args.taskType, args.taskId); const body = nonEmpty(args.body, "Comment"); return await ctx.db.insert("taskComments", { companyId: args.companyId, taskType: args.taskType, taskId: normalized, authorMembershipId: membership._id, body, createdAt: Date.now() }); } });

export const generateAttachmentUploadUrl = mutation({ args: { companyId: v.id("companies") }, handler: async (ctx, args) => { await requireCapability(ctx, args.companyId, "tasks:attachment:add"); return await ctx.storage.generateUploadUrl(); } });

export const addAttachment = mutation({
  args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), storageId: v.id("_storage"), fileName: v.string(), contentType: v.string(), size: v.number() },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "tasks:attachment:add");
    const { normalized } = await getVisibleTask(ctx, args.companyId, membership, args.taskType, args.taskId);
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (!metadata) throw new ConvexError("Uploaded file not found.");
    return await ctx.db.insert("taskAttachments", { companyId: args.companyId, taskType: args.taskType, taskId: normalized, storageId: args.storageId, fileName: nonEmpty(args.fileName, "File name"), contentType: metadata.contentType ?? args.contentType, size: metadata.size ?? args.size, createdByMembershipId: membership._id, createdAt: Date.now() });
  },
});

export const listAttachments = query({
  args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    await getVisibleTask(ctx, args.companyId, membership, args.taskType, args.taskId);
    const page = await ctx.db.query("taskAttachments").withIndex("by_task", (q) => q.eq("taskType", args.taskType).eq("taskId", args.taskId)).order("desc").paginate(args.paginationOpts);
    return { ...page, page: await Promise.all(page.page.map(async (row) => ({ ...row, url: await ctx.storage.getUrl(row.storageId) }))) };
  },
});

export const deleteAttachment = mutation({ args: { companyId: v.id("companies"), attachmentId: v.id("taskAttachments") }, handler: async (ctx, args) => { const { membership } = await requireCapability(ctx, args.companyId, "tasks:attachment:add"); const attachment = await ctx.db.get(args.attachmentId); if (!attachment || attachment.companyId !== args.companyId) throw new ConvexError("Attachment not found."); await getVisibleTask(ctx, args.companyId, membership, attachment.taskType, attachment.taskId); await ctx.storage.delete(attachment.storageId); await ctx.db.delete(args.attachmentId); } });

export const assignableUsers = query({
  args: { companyId: v.id("companies"), kind: v.union(v.literal("jd"), v.literal("one_time")) },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const caps = await membershipCapabilities(ctx, membership);
    const prefix = args.kind === "jd" ? "tasks:jd" : "tasks:one_time";
    if (!caps.has(`${prefix}:create` as any)) return [];
    let ids: Set<Id<"companyMemberships">>;
    if (caps.has(`${prefix}:assign:any` as any)) {
      const all = await ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500);
      ids = new Set(all.filter((m) => m.active).map((m) => m._id));
    } else if (caps.has(`${prefix}:assign:managed` as any)) {
      ids = await scopedMembershipIds(ctx, args.companyId, membership);
    } else {
      ids = new Set([membership._id]);
    }
    return await enrich(ctx, Array.from(ids));
  },
});

export const accessibleTasksForAi = query({ args: { companyId: v.id("companies"), overdueOnly: v.optional(v.boolean()) }, handler: async (ctx, args) => { const { membership } = await requireMembership(ctx, args.companyId); const out: any[] = []; for (const t of await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(100)) { if (await visible(ctx, args.companyId, membership, t.assigneeMembershipIds)) { const s = await jdState(ctx, t); if (!args.overdueOnly || s.status === "Overdue") out.push({ type: "JD", id: t._id, title: t.title, state: s.status, dueAt: s.dueAt }); } } for (const t of await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(100)) { if (await visible(ctx, args.companyId, membership, t.assigneeMembershipIds)) { const s = oneState(t); if (!args.overdueOnly || s === "Overdue") out.push({ type: "One-time", id: t._id, title: t.title, state: s, dueAt: t.dueDate }); } } return out.slice(0, 100); } });

async function aiAssignees(ctx: any, ids: Id<"companyMemberships">[]) {
  const rows = await enrich(ctx, ids);
  return rows.map((row: any) => ({ name: row.user.name ?? row.user.email, role: row.membership.role }));
}

async function aiJdRow(ctx: any, task: Doc<"jdTasks">) {
  const state = await jdState(ctx, task);
  return { kind: "jd" as const, id: task._id, title: task.title, description: task.description, status: state.status, dueAt: state.dueAt, priority: task.priority, recurrence: task.recurrence, assignees: await aiAssignees(ctx, task.assigneeMembershipIds) };
}

async function aiOneTimeRow(ctx: any, task: Doc<"oneTimeTasks">) {
  return { kind: "one_time" as const, id: task._id, title: task.title, description: task.description, status: oneState(task), dueAt: task.dueDate, priority: task.priority, assignees: await aiAssignees(ctx, task.assigneeMembershipIds) };
}

export const aiListVisible = query({
  args: { companyId: v.id("companies"), status: v.union(v.literal("all"), v.literal("due"), v.literal("overdue"), v.literal("done")), limit: v.number() },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const limit = Math.min(Math.max(Math.floor(args.limit), 1), 30);
    const out: any[] = [];
    const matches = (status: string) => args.status === "all" || (args.status === "overdue" ? status === "Overdue" : args.status === "done" ? status === "Done" : status !== "Done");
    const [jdTasks, oneTimeTasks] = await Promise.all([
      ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").take(100),
      ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").take(100),
    ]);
    const candidates = [];
    for (let i = 0; i < Math.max(jdTasks.length, oneTimeTasks.length); i += 1) {
      if (jdTasks[i]) candidates.push({ kind: "jd" as const, task: jdTasks[i] });
      if (oneTimeTasks[i]) candidates.push({ kind: "one_time" as const, task: oneTimeTasks[i] });
    }
    for (const candidate of candidates) {
      if (out.length >= limit) break;
      if (!(await visible(ctx, args.companyId, membership, candidate.task.assigneeMembershipIds))) continue;
      const row = candidate.kind === "jd" ? await aiJdRow(ctx, candidate.task) : await aiOneTimeRow(ctx, candidate.task);
      if (matches(row.status)) out.push(row);
    }
    return out;
  },
});

export const aiGetDetail = query({
  args: { companyId: v.id("companies"), kind: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string() },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const { task } = await getVisibleTask(ctx, args.companyId, membership, args.kind, args.taskId);
    const comments = await ctx.db.query("taskComments").withIndex("by_task", (q) => q.eq("taskType", args.kind).eq("taskId", task._id)).order("desc").take(5);
    const row = args.kind === "jd" ? await aiJdRow(ctx, task as Doc<"jdTasks">) : await aiOneTimeRow(ctx, task as Doc<"oneTimeTasks">);
    return { ...row, comments: comments.map((comment) => ({ body: comment.body, createdAt: comment.createdAt })) };
  },
});

export const aiAssignableUsers = query({
  args: { companyId: v.id("companies"), kind: v.union(v.literal("jd"), v.literal("one_time")) },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const caps = await membershipCapabilities(ctx, membership);
    const prefix = args.kind === "jd" ? "tasks:jd" : "tasks:one_time";
    if (!caps.has(`${prefix}:create` as any)) return [];
    let ids: Set<Id<"companyMemberships">>;
    if (caps.has(`${prefix}:assign:any` as any)) {
      const all = await ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500);
      ids = new Set(all.filter((m) => m.active).map((m) => m._id));
    } else if (caps.has(`${prefix}:assign:managed` as any)) {
      ids = await scopedMembershipIds(ctx, args.companyId, membership);
    } else {
      ids = new Set([membership._id]);
    }
    const rows = await enrich(ctx, Array.from(ids));
    return rows.map((row: any) => ({ membershipId: row.membership._id, name: row.user.name ?? row.user.email, email: row.user.email, role: row.membership.role }));
  },
});

export const aiCreateOneTime = mutation({
  args: { companyId: v.id("companies"), title: v.string(), description: v.optional(v.string()), dueDate: v.number(), assigneeMembershipIds: v.array(v.id("companyMemberships")), priority: v.union(v.literal("low"), v.literal("medium"), v.literal("high")) },
  handler: async (ctx, args) => {
    const { membership, user } = await requireCapability(ctx, args.companyId, "tasks:one_time:create");
    const title = nonEmpty(args.title, "Title");
    await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds);
    await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "one_time");
    const now = Date.now();
    const id = await ctx.db.insert("oneTimeTasks", { ...args, title, description: args.description?.trim(), createdByMembershipId: membership._id, createdAt: now, updatedAt: now });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "one_time_task.create", targetType: "oneTimeTask", targetId: id, createdAt: now });
    const task = await ctx.db.get(id);
    if (!task) throw new ConvexError("Task not found.");
    return await aiOneTimeRow(ctx, task);
  },
});

export const aiCreateJd = mutation({
  args: { companyId: v.id("companies"), title: v.string(), description: v.optional(v.string()), recurrence: v.union(v.literal("daily"), v.literal("every_other_day"), v.literal("weekly"), v.literal("every_two_weeks"), v.literal("monthly"), v.literal("semiannually"), v.literal("annually")), startDate: v.number(), assigneeMembershipIds: v.array(v.id("companyMemberships")), priority: v.union(v.literal("low"), v.literal("medium"), v.literal("high")) },
  handler: async (ctx, args) => {
    const { membership, user } = await requireCapability(ctx, args.companyId, "tasks:jd:create");
    const title = nonEmpty(args.title, "Title");
    await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds);
    await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "jd");
    const now = Date.now();
    const id = await ctx.db.insert("jdTasks", { ...args, title, description: args.description?.trim(), createdByMembershipId: membership._id, createdAt: now, updatedAt: now });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "jd_task.create", targetType: "jdTask", targetId: id, createdAt: now });
    const task = await ctx.db.get(id);
    if (!task) throw new ConvexError("Task not found.");
    return await aiJdRow(ctx, task);
  },
});

export const aiComplete = mutation({
  args: { companyId: v.id("companies"), kind: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const { normalized, task } = await getVisibleTask(ctx, args.companyId, membership, args.kind, args.taskId);
    if (args.kind === "jd") {
      await assertCanUpdateTask(ctx, args.companyId, membership, (task as Doc<"jdTasks">).assigneeMembershipIds, "jd");
      const c = cycle((task as Doc<"jdTasks">).startDate, (task as Doc<"jdTasks">).recurrence);
      const existing = await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", normalized as Id<"jdTasks">).eq("cycleStart", c.start)).unique();
      if (!existing) await ctx.db.insert("jdTaskCompletions", { companyId: args.companyId, jdTaskId: normalized as Id<"jdTasks">, cycleStart: c.start, completedByMembershipId: membership._id, completedAt: Date.now(), note: args.note?.trim() || undefined });
      const updated = await ctx.db.get(normalized as Id<"jdTasks">);
      if (!updated) throw new ConvexError("Task not found.");
      return await aiJdRow(ctx, updated);
    }
    await assertCanUpdateTask(ctx, args.companyId, membership, (task as Doc<"oneTimeTasks">).assigneeMembershipIds, "one_time");
    const now = Date.now();
    await ctx.db.patch(normalized as Id<"oneTimeTasks">, { completedAt: now, completedByMembershipId: membership._id, updatedAt: now });
    const updated = await ctx.db.get(normalized as Id<"oneTimeTasks">);
    if (!updated) throw new ConvexError("Task not found.");
    return await aiOneTimeRow(ctx, updated);
  },
});

export const aiAddComment = mutation({
  args: { companyId: v.id("companies"), kind: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "tasks:comment");
    const { normalized } = await getVisibleTask(ctx, args.companyId, membership, args.kind, args.taskId);
    return await ctx.db.insert("taskComments", { companyId: args.companyId, taskType: args.kind, taskId: normalized, authorMembershipId: membership._id, body: nonEmpty(args.body, "Comment"), createdAt: Date.now() });
  },
});
