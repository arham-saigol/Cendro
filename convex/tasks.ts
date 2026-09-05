import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { currentJdCycle, defaultTimeZone, elapsedJdCyclesSince } from "./taskCycles";
import { assertCanAssign, assertCanDeleteTask, assertCanUpdateTask, canViewTask, getManagedMembershipIds, memberFirstName, memberFullName, membershipCapabilities, requireCapability, requireMembership, scopedMembershipIds } from "./permissions";
import type { Capability } from "../src/lib/permissions";
import { nonEmpty } from "./validation";
import { nextReference } from "./references";

type ManualStatus = "due" | "in_progress" | "completed";
type TaskKind = "jd" | "one_time";
type Ctx = QueryCtx | MutationCtx;
type TaskVisibilityAuth = { caps: Set<Capability>; getScopedMembershipIds: () => Promise<Set<Id<"companyMemberships">>> };

const recurrenceValidator = v.union(v.literal("daily"), v.literal("every_other_day"), v.literal("weekly"), v.literal("semimonthly"), v.literal("monthly"), v.literal("quarterly"), v.literal("semiannually"), v.literal("annually"));
const priorityValidator = v.union(v.literal("low"), v.literal("medium"), v.literal("high"));
const statusValidator = v.union(v.literal("due"), v.literal("in_progress"), v.literal("completed"));
const jdFrequencyFilterValidator = v.union(v.literal("all"), v.literal("daily"), v.literal("every_other_day"), v.literal("weekly"), v.literal("semimonthly"), v.literal("monthly"), v.literal("quarterly"), v.literal("semiannually"), v.literal("annually"));
function statusLabel(status: ManualStatus | "overdue") { return status === "due" ? "Pending" : status === "in_progress" ? "In Progress" : status === "completed" ? "Completed" : "Overdue"; }
function cleanOptionalText(value?: string) { const text = value?.trim(); return text ? text : undefined; }
function cleanOptionalQuantity(value?: number) { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined; }
async function enrich(ctx: Ctx, ids: Id<"companyMemberships">[]) {
  const uniqueIds = Array.from(new Set(ids));
  const memberships = (await Promise.all(uniqueIds.map((id) => ctx.db.get(id)))).filter(Boolean) as Doc<"companyMemberships">[];
  const users = (await Promise.all(memberships.map((membership) => ctx.db.get(membership.userId)))).filter(Boolean) as Doc<"appUsers">[];
  const userById = new Map(users.map((user) => [user._id, user]));
  return memberships.flatMap((membership) => {
    const user = userById.get(membership.userId);
    if (!user) return [];
    const fName = memberFirstName(membership, user);
    const sName = membership.secondName !== undefined ? membership.secondName.trim() : (user.secondName?.trim() ?? "");
    const full = memberFullName(membership, user);
    return [{ membership: { _id: membership._id, role: membership.role }, user: { name: fName, firstName: fName, secondName: sName, fullName: full, email: user.email, imageUrl: user.imageUrl } }];
  });
}

async function taskVisibilityAuth(ctx: Ctx, companyId: Id<"companies">, membership: Doc<"companyMemberships">): Promise<TaskVisibilityAuth> {
  const caps = await membershipCapabilities(ctx, membership);
  let scoped: Promise<Set<Id<"companyMemberships">>> | undefined;
  return { caps, getScopedMembershipIds: () => scoped ??= getManagedMembershipIds(ctx, companyId, membership._id) };
}

async function visible(ctx: Ctx, companyId: Id<"companies">, membership: Doc<"companyMemberships">, task: Pick<Doc<"jdTasks"> | Doc<"oneTimeTasks">, "assigneeMembershipIds" | "createdByMembershipId">, kind: TaskKind, auth?: TaskVisibilityAuth) {
  const caps = auth?.caps ?? await membershipCapabilities(ctx, membership);
  const managedIds = auth ? await auth.getScopedMembershipIds() : undefined;
  return await canViewTask(ctx, companyId, membership, { companyId, assigneeMembershipIds: task.assigneeMembershipIds, createdByMembershipId: task.createdByMembershipId }, kind, caps, managedIds);
}

async function assertAssigneesInCompany(ctx: Ctx, companyId: Id<"companies">, assignees: Id<"companyMemberships">[]) {
  for (const id of assignees) {
    const membership = await ctx.db.get(id);
    if (!membership || membership.companyId !== companyId || !membership.active) throw new ConvexError("Assignee not found in this company.");
  }
}

function requireTaskAssignee(assignees: Id<"companyMemberships">[]) {
  if (assignees.length === 0) throw new ConvexError("Task assignee is required.");
  if (new Set(assignees).size !== assignees.length) throw new ConvexError("Duplicate assignees are not allowed.");
}

function updateAuthTargets(task: Pick<Doc<"jdTasks"> | Doc<"oneTimeTasks">, "assigneeMembershipIds" | "createdByMembershipId">) {
  return task.assigneeMembershipIds.length === 0 ? [task.createdByMembershipId] : task.assigneeMembershipIds;
}

async function canUpdateTask(
  ctx: Ctx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  task: Pick<Doc<"jdTasks"> | Doc<"oneTimeTasks">, "assigneeMembershipIds" | "createdByMembershipId">,
  kind: TaskKind,
  precomputedCaps?: Set<Capability>,
  precomputedManagedIds?: Set<Id<"companyMemberships">>
) {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, membership));
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  const targets = updateAuthTargets(task);
  if (caps.has(`${prefix}:update:any` as any)) return true;
  if (caps.has(`${prefix}:update:managed` as any)) {
    const scoped = precomputedManagedIds ?? (await getManagedMembershipIds(ctx, companyId, membership._id));
    if (targets.every((id) => scoped.has(id))) return true;
  }
  return Boolean(caps.has(`${prefix}:update:self` as any) && targets.includes(membership._id));
}

async function canDeleteTask(
  ctx: Ctx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  task: Pick<Doc<"jdTasks"> | Doc<"oneTimeTasks">, "assigneeMembershipIds" | "createdByMembershipId">,
  kind: TaskKind,
  precomputedCaps?: Set<Capability>,
  precomputedManagedIds?: Set<Id<"companyMemberships">>
) {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, membership));
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  const targets = updateAuthTargets(task);
  if (caps.has(`${prefix}:delete:any` as any)) return true;
  if (caps.has(`${prefix}:delete:managed` as any)) {
    const scoped = precomputedManagedIds ?? (await getManagedMembershipIds(ctx, companyId, membership._id));
    if (targets.every((id) => scoped.has(id))) return true;
  }
  return Boolean(caps.has(`${prefix}:delete:self` as any) && targets.includes(membership._id));
}


async function companyTimeZone(ctx: Ctx, companyId: Id<"companies">) {
  const company = await ctx.db.get(companyId);
  return company?.timeZone ?? defaultTimeZone;
}

async function currentJdCompletion(ctx: Ctx, taskId: Id<"jdTasks">, cycleStart: number) {
  return await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId).eq("cycleStart", cycleStart)).unique();
}

async function currentJdCycleRecord(ctx: Ctx, taskId: Id<"jdTasks">, cycleStart: number) {
  return await ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId).eq("cycleStart", cycleStart)).unique();
}

export async function recordMissedJdCycles(ctx: MutationCtx, task: Doc<"jdTasks">, now = Date.now(), timeZone?: string) {
  const { cycles, nextActiveAt } = elapsedJdCyclesSince(task.recurrence, task.cycleStartedAt, now, 200, timeZone ?? await companyTimeZone(ctx, task.companyId));
  for (const cycle of cycles) {
    const done = await currentJdCompletion(ctx, task._id, cycle.start);
    const recorded = await currentJdCycleRecord(ctx, task._id, cycle.start);
    if (!done && !recorded) await ctx.db.insert("jdTaskCycleRecords", { companyId: task.companyId, jdTaskId: task._id, cycleStart: cycle.start, cycleEnd: cycle.end, status: "missed", recordedAt: now });
  }
  if (cycles.length > 0) {
    await ctx.db.patch(task._id, { cycleStartedAt: nextActiveAt });
    task.cycleStartedAt = nextActiveAt;
  }
  return { cycles, nextActiveAt };
}

async function jdState(ctx: Ctx, task: Doc<"jdTasks">, now = Date.now(), timeZone?: string) {
  const c = currentJdCycle(task.recurrence, now, timeZone ?? await companyTimeZone(ctx, task.companyId));
  const currentDone = await currentJdCompletion(ctx, task._id, c.start);
  const last = (await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_completedAt", (q) => q.eq("jdTaskId", task._id)).order("desc").take(1))[0];
  const status: ManualStatus = currentDone || (task.statusCycleStart === c.start && task.status === "completed") ? "completed" : task.statusCycleStart === c.start ? task.status : "due";
  return { status: statusLabel(status), rawStatus: status, isOverdue: false, currentCycleStart: c.start, currentCycleEnd: c.end, dueAt: c.end, lastCompletedAt: last?.completedAt ?? null };
}

function oneState(task: Doc<"oneTimeTasks">) {
  const isOverdue = Boolean(task.overdueAt) || Boolean(task.dueDate && task.status !== "completed" && task.dueDate < Date.now());
  const status: ManualStatus | "overdue" = isOverdue ? "overdue" : task.status;
  return { status: statusLabel(status), rawStatus: status, isOverdue, dueAt: task.dueDate ?? null, lastCompletedAt: task.completedAt ?? null };
}

async function getVisibleTask(ctx: Ctx, companyId: Id<"companies">, membership: Doc<"companyMemberships">, taskType: TaskKind, taskId: string) {
  const normalized = taskType === "jd" ? ctx.db.normalizeId("jdTasks", taskId) : ctx.db.normalizeId("oneTimeTasks", taskId);
  if (!normalized) throw new ConvexError("Task not found.");
  const task = await ctx.db.get(normalized);
  if (!task || task.companyId !== companyId || !(await visible(ctx, companyId, membership, task, taskType))) throw new ConvexError("Task not found.");
  return { normalized, task };
}

async function logTaskActivity(ctx: MutationCtx, args: { companyId: Id<"companies">; taskType: TaskKind; taskId: string; actorMembershipId: Id<"companyMemberships">; event: "created" | "status_changed"; fromStatus?: ManualStatus; toStatus?: ManualStatus; createdAt?: number }) {
  await ctx.db.insert("taskActivityLogs", { companyId: args.companyId, taskType: args.taskType, taskId: args.taskId, actorMembershipId: args.actorMembershipId, event: args.event, ...(args.fromStatus ? { fromStatus: args.fromStatus } : {}), ...(args.toStatus ? { toStatus: args.toStatus } : {}), createdAt: args.createdAt ?? Date.now() });
}

async function enrichedJd(ctx: Ctx, task: Doc<"jdTasks">, timeZone?: string, canUpdate?: boolean, canDelete?: boolean) {
  return {
    ...task,
    state: await jdState(ctx, task, Date.now(), timeZone),
    assignees: await enrich(ctx, task.assigneeMembershipIds),
    ...(canUpdate !== undefined ? { canUpdate } : {}),
    ...(canDelete !== undefined ? { canDelete } : {}),
  };
}
async function enrichedOneTime(ctx: Ctx, task: Doc<"oneTimeTasks">, canUpdate?: boolean, canDelete?: boolean) {
  return {
    ...task,
    state: oneState(task),
    assignees: await enrich(ctx, task.assigneeMembershipIds),
    ...(canUpdate !== undefined ? { canUpdate } : {}),
    ...(canDelete !== undefined ? { canDelete } : {}),
  };
}
function matchesSearch(task: { title: string; reference: string }, search?: string) {
  const needle = search?.trim().toLowerCase();
  if (!needle) return true;
  return task.title.toLowerCase().includes(needle) || task.reference.toLowerCase().includes(needle);
}

export const listJdRows = query({
  args: { companyId: v.id("companies"), search: v.optional(v.string()), frequency: v.optional(jdFrequencyFilterValidator), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.any()),
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership);
    const page = await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").paginate(args.paginationOpts);
    const rows = [];
    const managedIds = await auth.getScopedMembershipIds();
    for (const task of page.page) {
      if (args.frequency && args.frequency !== "all" && task.recurrence !== args.frequency) continue;
      if (!matchesSearch(task, args.search)) continue;
      if (await visible(ctx, args.companyId, membership, task, "jd", auth)) {
        const canUpdate = await canUpdateTask(ctx, args.companyId, membership, task, "jd", auth.caps, managedIds);
        const canDelete = await canDeleteTask(ctx, args.companyId, membership, task, "jd", auth.caps, managedIds);
        rows.push(await enrichedJd(ctx, task, undefined, canUpdate, canDelete));
      }
    }
    return { ...page, page: rows };
  },
});

export const exportRows = query({
  args: { companyId: v.id("companies"), kind: v.union(v.literal("jd"), v.literal("one_time")), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const capability: Capability = args.kind === "jd" ? "tasks:jd:export" : "tasks:one_time:export";
    const { membership, company } = await requireCapability(ctx, args.companyId, capability);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership);
    const scoped = await scopedMembershipIds(ctx, args.companyId, membership, auth.caps, args.kind === "jd" ? "tasks:jd:view:any" : "tasks:one_time:view:any");
    if (args.kind === "jd") {
      const page = await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("asc").paginate(args.paginationOpts);
      const rows = [];
      for (const task of page.page) if (await visible(ctx, args.companyId, membership, task, "jd", auth)) {
        const visibleAssigneeIds = task.assigneeMembershipIds.filter((id) => scoped.has(id));
        const assignees = await enrich(ctx, visibleAssigneeIds);
        const state = await jdState(ctx, task, Date.now(), company.timeZone);
        rows.push({ reference: task.reference, title: task.title, description: task.description ?? null, notes: task.notes ?? null, recurrence: task.recurrence, time: task.time ?? null, quantity: task.quantity ?? null, assigneeEmails: assignees.map((row) => row.user.email).join("; "), status: state.status });
      }
      return { ...page, page: rows };
    }
    const page = await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("asc").paginate(args.paginationOpts);
    const rows = [];
    for (const task of page.page) if (await visible(ctx, args.companyId, membership, task, "one_time", auth)) {
      const visibleAssigneeIds = task.assigneeMembershipIds.filter((id) => scoped.has(id));
      const assignees = await enrich(ctx, visibleAssigneeIds);
      const state = oneState(task);
      rows.push({ reference: task.reference, title: task.title, description: task.description ?? null, notes: task.notes ?? null, dueDate: task.dueDate ?? null, priority: task.priority, time: task.time ?? null, quantity: task.quantity ?? null, assigneeEmails: assignees.map((row) => row.user.email).join("; "), status: state.status });
    }
    return { ...page, page: rows };
  },
});

export const listOneTimeRows = query({
  args: { companyId: v.id("companies"), search: v.optional(v.string()), priority: v.optional(v.union(v.literal("all"), priorityValidator)), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.any()),
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership);
    const page = await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").paginate(args.paginationOpts);
    const rows = [];
    const managedIds = await auth.getScopedMembershipIds();
    for (const task of page.page) {
      if (args.priority && args.priority !== "all" && task.priority !== args.priority) continue;
      if (!matchesSearch(task, args.search)) continue;
      if (await visible(ctx, args.companyId, membership, task, "one_time", auth)) {
        const canUpdate = await canUpdateTask(ctx, args.companyId, membership, task, "one_time", auth.caps, managedIds);
        const canDelete = await canDeleteTask(ctx, args.companyId, membership, task, "one_time", auth.caps, managedIds);
        rows.push(await enrichedOneTime(ctx, task, canUpdate, canDelete));
      }
    }
    return { ...page, page: rows };
  },
});

export const personalFilterOptions = query({
  args: { companyId: v.id("companies"), kind: v.union(v.literal("jd"), v.literal("one_time")) },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    if (args.kind === "jd") {
      const tasks = await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500);
      const values = new Set<string>();
      for (const t of tasks) {
        if (t.assigneeMembershipIds.includes(membership._id)) values.add(t.recurrence);
      }
      return { values: Array.from(values) };
    } else {
      const tasks = await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500);
      const values = new Set<string>();
      for (const t of tasks) {
        if (t.assigneeMembershipIds.includes(membership._id)) values.add(t.priority);
      }
      return { values: Array.from(values) };
    }
  },
});

export const getJd = query({
  args: { companyId: v.id("companies"), taskId: v.id("jdTasks") },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId || !(await visible(ctx, args.companyId, membership, task, "jd"))) throw new ConvexError("Task not found.");
    const canUpdate = await canUpdateTask(ctx, args.companyId, membership, task, "jd");
    const canDelete = await canDeleteTask(ctx, args.companyId, membership, task, "jd");
    return { task: await enrichedJd(ctx, task, undefined, canUpdate, canDelete), canUpdate, canDelete };
  },
});

export const createJd = mutation({
  args: { companyId: v.id("companies"), title: v.string(), description: v.optional(v.string()), notes: v.optional(v.string()), time: v.optional(v.string()), quantity: v.optional(v.number()), recurrence: recurrenceValidator, assigneeMembershipIds: v.array(v.id("companyMemberships")) },
  handler: async (ctx, args) => {
    const { membership, user, company } = await requireCapability(ctx, args.companyId, "tasks:jd:create");
    const title = nonEmpty(args.title, "Task title");
    requireTaskAssignee(args.assigneeMembershipIds);
    await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds);
    await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "jd");
    const now = Date.now();
    const reference = await nextReference(ctx, args.companyId, "jd");
    const id = await ctx.db.insert("jdTasks", { companyId: args.companyId, reference, title, description: cleanOptionalText(args.description), notes: cleanOptionalText(args.notes), time: cleanOptionalText(args.time), quantity: cleanOptionalQuantity(args.quantity), recurrence: args.recurrence, cycleStartedAt: now, status: "due", statusCycleStart: currentJdCycle(args.recurrence, now, company.timeZone).start, assigneeMembershipIds: args.assigneeMembershipIds, createdByMembershipId: membership._id, createdAt: now, updatedAt: now });
    await logTaskActivity(ctx, { companyId: args.companyId, taskType: "jd", taskId: id, actorMembershipId: membership._id, event: "created", createdAt: now });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "jd_task.create", targetType: "jdTask", targetId: id, createdAt: now });
    return id;
  },
});

export const updateJd = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("jdTasks"), title: v.string(), description: v.optional(v.string()), notes: v.optional(v.string()), time: v.optional(v.string()), quantity: v.optional(v.number()), recurrence: recurrenceValidator, assigneeMembershipIds: v.array(v.id("companyMemberships")) },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId) throw new ConvexError("Task not found.");
    await assertCanUpdateTask(ctx, args.companyId, membership, updateAuthTargets(task), "jd");
    requireTaskAssignee(args.assigneeMembershipIds);
    await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds);
    const assigneesChanged = task.assigneeMembershipIds.length !== args.assigneeMembershipIds.length || args.assigneeMembershipIds.some((id) => !task.assigneeMembershipIds.includes(id));
    if (assigneesChanged && args.assigneeMembershipIds.length) await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "jd");
    const now = Date.now();
    const timeZone = await companyTimeZone(ctx, args.companyId);
    await recordMissedJdCycles(ctx, task, now, timeZone);
    const nextCycleStart = currentJdCycle(args.recurrence, now, timeZone).start;
    const nextTask = { ...task };
    nextTask.title = nonEmpty(args.title, "Task title");
    const desc = cleanOptionalText(args.description);
    if (desc === undefined) delete nextTask.description;
    else nextTask.description = desc;
    const n = cleanOptionalText(args.notes);
    if (n === undefined) delete nextTask.notes;
    else nextTask.notes = n;
    const t = cleanOptionalText(args.time);
    if (t === undefined) delete nextTask.time;
    else nextTask.time = t;
    const q = cleanOptionalQuantity(args.quantity);
    if (q === undefined) delete nextTask.quantity;
    else nextTask.quantity = q;
    nextTask.recurrence = args.recurrence;
    nextTask.assigneeMembershipIds = args.assigneeMembershipIds;
    if (args.recurrence !== task.recurrence) {
      nextTask.cycleStartedAt = nextCycleStart;
      nextTask.status = "due";
      nextTask.statusCycleStart = nextCycleStart;
    }
    nextTask.updatedAt = now;
    await ctx.db.replace(args.taskId, nextTask);
    return null;
  },
});

export const updateJdText = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("jdTasks"), title: v.optional(v.string()), description: v.optional(v.string()), notes: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.title === undefined && args.description === undefined && args.notes === undefined) return null;
    const { membership } = await requireMembership(ctx, args.companyId);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId) throw new ConvexError("Task not found.");
    await assertCanUpdateTask(ctx, args.companyId, membership, updateAuthTargets(task), "jd");
    const nextTask = { ...task };
    if (args.title !== undefined) nextTask.title = nonEmpty(args.title, "Task title");
    if (args.description !== undefined) {
      const desc = cleanOptionalText(args.description);
      if (desc === undefined) delete nextTask.description;
      else nextTask.description = desc;
    }
    if (args.notes !== undefined) {
      const notes = cleanOptionalText(args.notes);
      if (notes === undefined) delete nextTask.notes;
      else nextTask.notes = notes;
    }
    nextTask.updatedAt = Date.now();
    await ctx.db.replace(args.taskId, nextTask);
    return null;
  },
});

export const updateJdFields = mutation({
  args: {
    companyId: v.id("companies"),
    taskId: v.id("jdTasks"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    notes: v.optional(v.string()),
    time: v.optional(v.string()),
    quantity: v.optional(v.union(v.number(), v.null())),
    recurrence: v.optional(recurrenceValidator),
    assigneeMembershipIds: v.optional(v.array(v.id("companyMemberships"))),
  },
  handler: async (ctx, args) => {
    const hasUpdate = args.title !== undefined || args.description !== undefined || args.notes !== undefined || args.time !== undefined || args.quantity !== undefined || args.recurrence !== undefined || args.assigneeMembershipIds !== undefined;
    if (!hasUpdate) return null;
    const { membership } = await requireMembership(ctx, args.companyId);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId) throw new ConvexError("Task not found.");
    await assertCanUpdateTask(ctx, args.companyId, membership, updateAuthTargets(task), "jd");
    if (args.assigneeMembershipIds !== undefined) {
      requireTaskAssignee(args.assigneeMembershipIds);
      await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds);
      const assigneesChanged = task.assigneeMembershipIds.length !== args.assigneeMembershipIds.length || args.assigneeMembershipIds.some((id) => !task.assigneeMembershipIds.includes(id));
      if (assigneesChanged) await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "jd");
    }
    const now = Date.now();
    const timeZone = await companyTimeZone(ctx, args.companyId);
    await recordMissedJdCycles(ctx, task, now, timeZone);
    const nextCycleStart = args.recurrence !== undefined ? currentJdCycle(args.recurrence, now, timeZone).start : undefined;
    const nextTask = { ...task };
    if (args.title !== undefined) nextTask.title = nonEmpty(args.title, "Task title");
    if (args.description !== undefined) {
      const desc = cleanOptionalText(args.description);
      if (desc === undefined) delete nextTask.description;
      else nextTask.description = desc;
    }
    if (args.notes !== undefined) {
      const notes = cleanOptionalText(args.notes);
      if (notes === undefined) delete nextTask.notes;
      else nextTask.notes = notes;
    }
    if (args.time !== undefined) {
      const t = cleanOptionalText(args.time);
      if (t === undefined) delete nextTask.time;
      else nextTask.time = t;
    }
    if (args.quantity !== undefined) {
      const q = args.quantity === null ? undefined : cleanOptionalQuantity(args.quantity);
      if (q === undefined) delete nextTask.quantity;
      else nextTask.quantity = q;
    }
    if (args.recurrence !== undefined) {
      nextTask.recurrence = args.recurrence;
      if (args.recurrence !== task.recurrence) {
        nextTask.cycleStartedAt = nextCycleStart!;
        nextTask.status = "due";
        nextTask.statusCycleStart = nextCycleStart;
      }
    }
    if (args.assigneeMembershipIds !== undefined) nextTask.assigneeMembershipIds = args.assigneeMembershipIds;
    nextTask.updatedAt = now;
    await ctx.db.replace(args.taskId, nextTask);
    return null;
  },
});

async function setJdStatus(ctx: MutationCtx, companyId: Id<"companies">, taskId: Id<"jdTasks">, status: ManualStatus, note?: string) {
  const { membership } = await requireMembership(ctx, companyId);
  const task = await ctx.db.get(taskId);
  if (!task || task.companyId !== companyId) throw new ConvexError("Task not found.");
  await assertCanUpdateTask(ctx, companyId, membership, updateAuthTargets(task), "jd");
  const now = Date.now();
  const timeZone = await companyTimeZone(ctx, companyId);
  await recordMissedJdCycles(ctx, task, now, timeZone);
  const state = await jdState(ctx, task, now, timeZone);
  const previousStatus = state.rawStatus;
  const existing = await currentJdCompletion(ctx, taskId, state.currentCycleStart);
  if (status === "completed") {
    if (!existing) await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId: taskId, cycleStart: state.currentCycleStart, completedByMembershipId: membership._id, completedAt: now, note: cleanOptionalText(note) });
  } else if (existing) {
    await ctx.db.delete(existing._id);
  }
  await ctx.db.patch(taskId, { status, statusCycleStart: state.currentCycleStart, updatedAt: now });
  if (previousStatus !== status) await logTaskActivity(ctx, { companyId, taskType: "jd", taskId, actorMembershipId: membership._id, event: "status_changed", fromStatus: previousStatus, toStatus: status, createdAt: now });
}

export const updateJdStatus = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("jdTasks"), status: statusValidator },
  handler: async (ctx, args) => { await setJdStatus(ctx, args.companyId, args.taskId, args.status); return null; },
});

export const completeJd = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("jdTasks"), note: v.optional(v.string()) },
  handler: async (ctx, args) => { await setJdStatus(ctx, args.companyId, args.taskId, "completed", args.note); return null; },
});

export const listJdCycleRecords = query({
  args: { companyId: v.id("companies"), taskId: v.id("jdTasks") },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId || !(await visible(ctx, args.companyId, membership, task, "jd"))) throw new ConvexError("Task not found.");
    return await ctx.db.query("jdTaskCycleRecords").withIndex("by_task", (q) => q.eq("jdTaskId", args.taskId)).order("desc").take(100);
  },
});

export const recordMissedJdCyclesBatch = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("jdTasks").paginate({ numItems: 10, cursor: args.cursor ?? null });
    for (const task of page.page) await recordMissedJdCycles(ctx, task);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.tasks.recordMissedJdCyclesBatch, { cursor: page.continueCursor });
    return page.page.length;
  },
});

export const clearMissedJdCyclesBatch = internalMutation({
  args: {
    companyId: v.optional(v.id("companies")),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const page = args.companyId
      ? await ctx.db
          .query("jdTaskCycleRecords")
          .withIndex("by_company", (q) => q.eq("companyId", args.companyId!))
          .paginate({ numItems: 250, cursor: args.cursor ?? null })
      : await ctx.db
          .query("jdTaskCycleRecords")
          .paginate({ numItems: 250, cursor: args.cursor ?? null });

    for (const record of page.page) {
      await ctx.db.delete(record._id);
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.tasks.clearMissedJdCyclesBatch, {
        companyId: args.companyId,
        cursor: page.continueCursor,
      });
    }
    return { deleted: page.page.length, isDone: page.isDone };
  },
});

export const resetJdTaskCyclesBatch = internalMutation({
  args: {
    companyId: v.optional(v.id("companies")),
    now: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const page = args.companyId
      ? await ctx.db
          .query("jdTasks")
          .withIndex("by_company", (q) => q.eq("companyId", args.companyId!))
          .paginate({ numItems: 100, cursor: args.cursor ?? null })
      : await ctx.db
          .query("jdTasks")
          .paginate({ numItems: 100, cursor: args.cursor ?? null });

    for (const task of page.page) {
      const timeZone = await companyTimeZone(ctx, task.companyId);
      const current = currentJdCycle(task.recurrence, now, timeZone);
      await ctx.db.patch(task._id, {
        cycleStartedAt: current.start,
        statusCycleStart: current.start,
        status: "due",
        updatedAt: now,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.tasks.resetJdTaskCyclesBatch, {
        companyId: args.companyId,
        now,
        cursor: page.continueCursor,
      });
    } else {
      await ctx.scheduler.runAfter(0, internal.tasks.clearMissedJdCyclesBatch, {
        companyId: args.companyId,
      });
    }
    return { reset: page.page.length, isDone: page.isDone };
  },
});

export const resetAndClearMissedJdCycles = internalMutation({
  args: {
    companyId: v.optional(v.id("companies")),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, internal.tasks.resetJdTaskCyclesBatch, {
      companyId: args.companyId,
      now: args.now ?? Date.now(),
    });
    return { status: "scheduled" };
  },
});

export const countMissedJdCycles = internalQuery({
  args: {
    companyId: v.optional(v.id("companies")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const max = Math.min(args.limit ?? 5000, 5000);
    const records = args.companyId
      ? await ctx.db
          .query("jdTaskCycleRecords")
          .withIndex("by_company", (q) => q.eq("companyId", args.companyId!))
          .take(max + 1)
      : await ctx.db.query("jdTaskCycleRecords").take(max + 1);
    const hasMore = records.length > max;
    return { count: hasMore ? max : records.length, hasMore };
  },
});

export const getOneTime = query({
  args: { companyId: v.id("companies"), taskId: v.id("oneTimeTasks") },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId || !(await visible(ctx, args.companyId, membership, task, "one_time"))) throw new ConvexError("Task not found.");
    const canUpdate = await canUpdateTask(ctx, args.companyId, membership, task, "one_time");
    const canDelete = await canDeleteTask(ctx, args.companyId, membership, task, "one_time");
    return { task: await enrichedOneTime(ctx, task, canUpdate, canDelete), canUpdate, canDelete };
  },
});

export const createOneTime = mutation({
  args: { companyId: v.id("companies"), title: v.string(), description: v.optional(v.string()), notes: v.optional(v.string()), dueDate: v.optional(v.number()), time: v.optional(v.string()), quantity: v.optional(v.number()), assigneeMembershipIds: v.array(v.id("companyMemberships")), priority: priorityValidator },
  handler: async (ctx, args) => {
    const { membership, user } = await requireCapability(ctx, args.companyId, "tasks:one_time:create");
    const title = nonEmpty(args.title, "Task title");
    requireTaskAssignee(args.assigneeMembershipIds);
    await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds);
    await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "one_time");
    const now = Date.now();
    const reference = await nextReference(ctx, args.companyId, "one_time");
    const id = await ctx.db.insert("oneTimeTasks", { companyId: args.companyId, reference, title, description: cleanOptionalText(args.description), notes: cleanOptionalText(args.notes), dueDate: args.dueDate, time: cleanOptionalText(args.time), quantity: cleanOptionalQuantity(args.quantity), assigneeMembershipIds: args.assigneeMembershipIds, createdByMembershipId: membership._id, priority: args.priority, status: "due", createdAt: now, updatedAt: now });
    await logTaskActivity(ctx, { companyId: args.companyId, taskType: "one_time", taskId: id, actorMembershipId: membership._id, event: "created", createdAt: now });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "one_time_task.create", targetType: "oneTimeTask", targetId: id, createdAt: now });
    return id;
  },
});

export const updateOneTime = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("oneTimeTasks"), title: v.string(), description: v.optional(v.string()), notes: v.optional(v.string()), dueDate: v.optional(v.number()), time: v.optional(v.string()), quantity: v.optional(v.number()), assigneeMembershipIds: v.array(v.id("companyMemberships")), priority: priorityValidator },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId) throw new ConvexError("Task not found.");
    await assertCanUpdateTask(ctx, args.companyId, membership, updateAuthTargets(task), "one_time");
    requireTaskAssignee(args.assigneeMembershipIds);
    await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds);
    const assigneesChanged = task.assigneeMembershipIds.length !== args.assigneeMembershipIds.length || args.assigneeMembershipIds.some((id) => !task.assigneeMembershipIds.includes(id));
    if (assigneesChanged && args.assigneeMembershipIds.length) await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "one_time");
    const state = oneState(task);
    const nextTask = { ...task };
    nextTask.title = nonEmpty(args.title, "Task title");
    const desc = cleanOptionalText(args.description);
    if (desc === undefined) delete nextTask.description;
    else nextTask.description = desc;
    const n = cleanOptionalText(args.notes);
    if (n === undefined) delete nextTask.notes;
    else nextTask.notes = n;
    if (args.dueDate === undefined) delete nextTask.dueDate;
    else nextTask.dueDate = args.dueDate;
    const t = cleanOptionalText(args.time);
    if (t === undefined) delete nextTask.time;
    else nextTask.time = t;
    const q = cleanOptionalQuantity(args.quantity);
    if (q === undefined) delete nextTask.quantity;
    else nextTask.quantity = q;
    nextTask.assigneeMembershipIds = args.assigneeMembershipIds;
    nextTask.priority = args.priority;
    if (state.isOverdue && !nextTask.overdueAt) nextTask.overdueAt = Date.now();
    nextTask.updatedAt = Date.now();
    await ctx.db.replace(args.taskId, nextTask);
    return null;
  },
});

export const updateOneTimeText = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("oneTimeTasks"), title: v.optional(v.string()), description: v.optional(v.string()), notes: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.title === undefined && args.description === undefined && args.notes === undefined) return null;
    const { membership } = await requireMembership(ctx, args.companyId);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId) throw new ConvexError("Task not found.");
    await assertCanUpdateTask(ctx, args.companyId, membership, updateAuthTargets(task), "one_time");
    const nextTask = { ...task };
    if (args.title !== undefined) nextTask.title = nonEmpty(args.title, "Task title");
    if (args.description !== undefined) {
      const desc = cleanOptionalText(args.description);
      if (desc === undefined) delete nextTask.description;
      else nextTask.description = desc;
    }
    if (args.notes !== undefined) {
      const notes = cleanOptionalText(args.notes);
      if (notes === undefined) delete nextTask.notes;
      else nextTask.notes = notes;
    }
    nextTask.updatedAt = Date.now();
    await ctx.db.replace(args.taskId, nextTask);
    return null;
  },
});

export const updateOneTimeFields = mutation({
  args: {
    companyId: v.id("companies"),
    taskId: v.id("oneTimeTasks"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    notes: v.optional(v.string()),
    dueDate: v.optional(v.union(v.number(), v.null())),
    time: v.optional(v.string()),
    quantity: v.optional(v.union(v.number(), v.null())),
    assigneeMembershipIds: v.optional(v.array(v.id("companyMemberships"))),
    priority: v.optional(priorityValidator),
  },
  handler: async (ctx, args) => {
    const hasUpdate = args.title !== undefined || args.description !== undefined || args.notes !== undefined || args.dueDate !== undefined || args.time !== undefined || args.quantity !== undefined || args.assigneeMembershipIds !== undefined || args.priority !== undefined;
    if (!hasUpdate) return null;
    const { membership } = await requireMembership(ctx, args.companyId);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId) throw new ConvexError("Task not found.");
    await assertCanUpdateTask(ctx, args.companyId, membership, updateAuthTargets(task), "one_time");
    if (args.assigneeMembershipIds !== undefined) {
      requireTaskAssignee(args.assigneeMembershipIds);
      await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds);
      const assigneesChanged = task.assigneeMembershipIds.length !== args.assigneeMembershipIds.length || args.assigneeMembershipIds.some((id) => !task.assigneeMembershipIds.includes(id));
      if (assigneesChanged) await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "one_time");
    }
    const state = oneState(task);
    const nextTask = { ...task };
    if (args.title !== undefined) nextTask.title = nonEmpty(args.title, "Task title");
    if (args.description !== undefined) {
      const desc = cleanOptionalText(args.description);
      if (desc === undefined) delete nextTask.description;
      else nextTask.description = desc;
    }
    if (args.notes !== undefined) {
      const notes = cleanOptionalText(args.notes);
      if (notes === undefined) delete nextTask.notes;
      else nextTask.notes = notes;
    }
    if (args.dueDate !== undefined) {
      if (args.dueDate === null) delete nextTask.dueDate;
      else nextTask.dueDate = args.dueDate;
    }
    if (args.time !== undefined) {
      const t = cleanOptionalText(args.time);
      if (t === undefined) delete nextTask.time;
      else nextTask.time = t;
    }
    if (args.quantity !== undefined) {
      const q = args.quantity === null ? undefined : cleanOptionalQuantity(args.quantity);
      if (q === undefined) delete nextTask.quantity;
      else nextTask.quantity = q;
    }
    if (args.assigneeMembershipIds !== undefined) nextTask.assigneeMembershipIds = args.assigneeMembershipIds;
    if (args.priority !== undefined) nextTask.priority = args.priority;
    if (state.isOverdue && !nextTask.overdueAt) nextTask.overdueAt = Date.now();
    nextTask.updatedAt = Date.now();
    await ctx.db.replace(args.taskId, nextTask);
    return null;
  },
});

async function setOneTimeStatus(ctx: MutationCtx, companyId: Id<"companies">, taskId: Id<"oneTimeTasks">, status: ManualStatus) {
  const { membership } = await requireMembership(ctx, companyId);
  const task = await ctx.db.get(taskId);
  if (!task || task.companyId !== companyId) throw new ConvexError("Task not found.");
  await assertCanUpdateTask(ctx, companyId, membership, updateAuthTargets(task), "one_time");
  const state = oneState(task);
  if (state.isOverdue) {
    if (!task.overdueAt) await ctx.db.patch(taskId, { overdueAt: Date.now(), updatedAt: Date.now() });
    throw new ConvexError("Overdue tasks are locked and cannot be changed back.");
  }
  const now = Date.now();
  const previousStatus = state.rawStatus as ManualStatus;
  const nextTask = { ...task, status, updatedAt: now };
  if (status === "completed") {
    nextTask.completedAt = now;
    nextTask.completedByMembershipId = membership._id;
  } else {
    delete nextTask.completedAt;
    delete nextTask.completedByMembershipId;
  }
  await ctx.db.replace(taskId, nextTask);
  if (previousStatus !== status) await logTaskActivity(ctx, { companyId, taskType: "one_time", taskId, actorMembershipId: membership._id, event: "status_changed", fromStatus: previousStatus, toStatus: status, createdAt: now });
}

export const updateOneTimeStatus = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("oneTimeTasks"), status: statusValidator },
  handler: async (ctx, args) => { await setOneTimeStatus(ctx, args.companyId, args.taskId, args.status); return null; },
});

export const completeOneTime = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("oneTimeTasks") },
  handler: async (ctx, args) => { await setOneTimeStatus(ctx, args.companyId, args.taskId, "completed"); return null; },
});

async function purgeJdTask(ctx: MutationCtx, companyId: Id<"companies">, taskId: Id<"jdTasks">) {
  const { membership, user } = await requireMembership(ctx, companyId);
  const task = await ctx.db.get(taskId);
  if (!task || task.companyId !== companyId) throw new ConvexError("Task not found.");
  await assertCanDeleteTask(ctx, companyId, membership, updateAuthTargets(task), "jd");
  const completions = await ctx.db.query("jdTaskCompletions").withIndex("by_task", (q) => q.eq("jdTaskId", taskId)).collect();
  for (const completion of completions) await ctx.db.delete(completion._id);
  const cycleRecords = await ctx.db.query("jdTaskCycleRecords").withIndex("by_task", (q) => q.eq("jdTaskId", taskId)).collect();
  for (const cycleRecord of cycleRecords) await ctx.db.delete(cycleRecord._id);
  const comments = await ctx.db.query("taskComments").withIndex("by_task", (q) => q.eq("taskType", "jd").eq("taskId", taskId)).collect();
  for (const comment of comments) await ctx.db.delete(comment._id);
  const activityLogs = await ctx.db.query("taskActivityLogs").withIndex("by_task", (q) => q.eq("taskType", "jd").eq("taskId", taskId)).collect();
  for (const activityLog of activityLogs) await ctx.db.delete(activityLog._id);
  const attachments = await ctx.db.query("taskAttachments").withIndex("by_task", (q) => q.eq("taskType", "jd").eq("taskId", taskId)).collect();
  for (const attachment of attachments) { await ctx.storage.delete(attachment.storageId); await ctx.db.delete(attachment._id); }
  await ctx.db.delete(taskId);
  const now = Date.now();
  await ctx.db.insert("auditEvents", { companyId, actorUserId: user._id, action: "jd_task.delete", targetType: "jdTask", targetId: taskId, createdAt: now });
}

async function purgeOneTimeTask(ctx: MutationCtx, companyId: Id<"companies">, taskId: Id<"oneTimeTasks">) {
  const { membership, user } = await requireMembership(ctx, companyId);
  const task = await ctx.db.get(taskId);
  if (!task || task.companyId !== companyId) throw new ConvexError("Task not found.");
  await assertCanDeleteTask(ctx, companyId, membership, updateAuthTargets(task), "one_time");
  const comments = await ctx.db.query("taskComments").withIndex("by_task", (q) => q.eq("taskType", "one_time").eq("taskId", taskId)).collect();
  for (const comment of comments) await ctx.db.delete(comment._id);
  const activityLogs = await ctx.db.query("taskActivityLogs").withIndex("by_task", (q) => q.eq("taskType", "one_time").eq("taskId", taskId)).collect();
  for (const activityLog of activityLogs) await ctx.db.delete(activityLog._id);
  const attachments = await ctx.db.query("taskAttachments").withIndex("by_task", (q) => q.eq("taskType", "one_time").eq("taskId", taskId)).collect();
  for (const attachment of attachments) { await ctx.storage.delete(attachment.storageId); await ctx.db.delete(attachment._id); }
  await ctx.db.delete(taskId);
  const now = Date.now();
  await ctx.db.insert("auditEvents", { companyId, actorUserId: user._id, action: "one_time_task.delete", targetType: "oneTimeTask", targetId: taskId, createdAt: now });
}

export const deleteJd = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("jdTasks") },
  handler: async (ctx, args) => { await purgeJdTask(ctx, args.companyId, args.taskId); return null; },
});

export const deleteJdBulk = mutation({
  args: { companyId: v.id("companies"), taskIds: v.array(v.id("jdTasks")) },
  handler: async (ctx, args) => { for (const taskId of args.taskIds) await purgeJdTask(ctx, args.companyId, taskId); return null; },
});

export const deleteOneTime = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("oneTimeTasks") },
  handler: async (ctx, args) => { await purgeOneTimeTask(ctx, args.companyId, args.taskId); return null; },
});

export const deleteOneTimeBulk = mutation({
  args: { companyId: v.id("companies"), taskIds: v.array(v.id("oneTimeTasks")) },
  handler: async (ctx, args) => { for (const taskId of args.taskIds) await purgeOneTimeTask(ctx, args.companyId, taskId); return null; },
});

export const listComments = query({
  args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    await getVisibleTask(ctx, args.companyId, membership, args.taskType, args.taskId);
    const page = await ctx.db.query("taskComments").withIndex("by_task", (q) => q.eq("taskType", args.taskType).eq("taskId", args.taskId)).order("desc").paginate(args.paginationOpts);
    const authors = await enrich(ctx, page.page.map((comment) => comment.authorMembershipId));
    const authorById = new Map(authors.map((author) => [author.membership._id, author]));
    return { ...page, page: page.page.map((comment) => ({ ...comment, author: authorById.get(comment.authorMembershipId) ?? null })) };
  },
});

export const listActivity = query({
  args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const { normalized } = await getVisibleTask(ctx, args.companyId, membership, args.taskType, args.taskId);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 50), 1), 100);
    const comments = await ctx.db.query("taskComments").withIndex("by_task", (q) => q.eq("taskType", args.taskType).eq("taskId", normalized)).order("desc").take(limit + 1);
    const logs = await ctx.db.query("taskActivityLogs").withIndex("by_task", (q) => q.eq("taskType", args.taskType).eq("taskId", normalized)).order("desc").take(limit + 1);
    const actors = await enrich(ctx, [...comments.map((comment) => comment.authorMembershipId), ...logs.map((log) => log.actorMembershipId)]);
    const actorById = new Map(actors.map((actor) => [actor.membership._id, actor]));
    const items = [
      ...comments.map((comment) => ({ kind: "comment" as const, _id: comment._id, body: comment.body, event: null, fromStatus: null, toStatus: null, actorMembershipId: comment.authorMembershipId, actor: actorById.get(comment.authorMembershipId) ?? null, createdAt: comment.createdAt })),
      ...logs.map((log) => ({ kind: "log" as const, _id: log._id, body: null, event: log.event, fromStatus: log.fromStatus ?? null, toStatus: log.toStatus ?? null, actorMembershipId: log.actorMembershipId, actor: actorById.get(log.actorMembershipId) ?? null, createdAt: log.createdAt })),
    ].sort((a, b) => b.createdAt - a.createdAt);
    return { items: items.slice(0, limit), hasMore: items.length > limit };
  },
});

export const addComment = mutation({ args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), body: v.string() }, handler: async (ctx, args) => { const { membership } = await requireCapability(ctx, args.companyId, "tasks:comment"); const { normalized } = await getVisibleTask(ctx, args.companyId, membership, args.taskType, args.taskId); const body = nonEmpty(args.body, "Comment"); return await ctx.db.insert("taskComments", { companyId: args.companyId, taskType: args.taskType, taskId: normalized, authorMembershipId: membership._id, body, createdAt: Date.now() }); } });

export const updateComment = mutation({ args: { companyId: v.id("companies"), commentId: v.id("taskComments"), body: v.string() }, handler: async (ctx, args) => { const { membership } = await requireCapability(ctx, args.companyId, "tasks:comment"); const comment = await ctx.db.get(args.commentId); if (!comment || comment.companyId !== args.companyId || comment.authorMembershipId !== membership._id) throw new ConvexError("Comment not found."); await getVisibleTask(ctx, args.companyId, membership, comment.taskType, comment.taskId); await ctx.db.patch(args.commentId, { body: nonEmpty(args.body, "Comment") }); return null; } });

export const deleteComment = mutation({ args: { companyId: v.id("companies"), commentId: v.id("taskComments") }, handler: async (ctx, args) => { const { membership } = await requireCapability(ctx, args.companyId, "tasks:comment"); const comment = await ctx.db.get(args.commentId); if (!comment || comment.companyId !== args.companyId || comment.authorMembershipId !== membership._id) throw new ConvexError("Comment not found."); await getVisibleTask(ctx, args.companyId, membership, comment.taskType, comment.taskId); await ctx.db.delete(args.commentId); return null; } });

export const generateAttachmentUploadUrl = mutation({ args: { companyId: v.id("companies") }, handler: async (ctx, args) => { await requireCapability(ctx, args.companyId, "tasks:attachment:add"); return await ctx.storage.generateUploadUrl(); } });

export const addAttachment = mutation({
  args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), storageId: v.id("_storage"), fileName: v.string(), contentType: v.string(), size: v.number() },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "tasks:attachment:add");
    const { normalized } = await getVisibleTask(ctx, args.companyId, membership, args.taskType, args.taskId);
    const existing = await ctx.db
      .query("taskAttachments")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .first();
    if (existing) throw new ConvexError("This file is already attached.");
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (!metadata) throw new ConvexError("Uploaded file not found.");
    return await ctx.db.insert("taskAttachments", { companyId: args.companyId, taskType: args.taskType, taskId: normalized, storageId: args.storageId, fileName: nonEmpty(args.fileName, "File name"), contentType: metadata.contentType ?? args.contentType, size: metadata.size ?? args.size, createdByMembershipId: membership._id, createdAt: Date.now() });
  },
});

export const listAttachments = query({
  args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const { normalized } = await getVisibleTask(ctx, args.companyId, membership, args.taskType, args.taskId);
    const page = await ctx.db.query("taskAttachments").withIndex("by_task", (q) => q.eq("taskType", args.taskType).eq("taskId", normalized)).order("desc").paginate(args.paginationOpts);
    return { ...page, page: await Promise.all(page.page.map(async (row) => ({ ...row, url: await ctx.storage.getUrl(row.storageId) }))) };
  },
});

export const deleteAttachment = mutation({
  args: { companyId: v.id("companies"), attachmentId: v.id("taskAttachments") },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const attachment = await ctx.db.get(args.attachmentId);
    if (!attachment || attachment.companyId !== args.companyId) throw new ConvexError("Attachment not found.");
    const { task } = await getVisibleTask(ctx, args.companyId, membership, attachment.taskType, attachment.taskId);
    const isOwner = attachment.createdByMembershipId === membership._id;
    if (isOwner) {
      if (!capabilities.has("tasks:attachment:delete:own")) throw new ConvexError("You do not have access to delete this attachment.");
    } else {
      if (!capabilities.has("tasks:attachment:delete:any")) throw new ConvexError("You do not have access to moderate attachments.");
      await assertCanUpdateTask(ctx, args.companyId, membership, updateAuthTargets(task), attachment.taskType);
    }
    await ctx.storage.delete(attachment.storageId);
    await ctx.db.delete(args.attachmentId);
    return null;
  },
});

export const assignableUsers = query({
  args: { companyId: v.id("companies"), kind: v.union(v.literal("jd"), v.literal("one_time")) },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const caps = await membershipCapabilities(ctx, membership);
    const prefix = args.kind === "jd" ? "tasks:jd" : "tasks:one_time";
    const canCreateOrUpdate = caps.has(`${prefix}:create` as any) || caps.has(`${prefix}:update:any` as any) || caps.has(`${prefix}:update:managed` as any) || caps.has(`${prefix}:update:self` as any);
    if (!canCreateOrUpdate) return [];
    let ids: Set<Id<"companyMemberships">>;
    if (caps.has(`${prefix}:assign:any` as any)) {
      const all = await ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500);
      ids = new Set(all.filter((m) => m.active).map((m) => m._id));
    } else if (caps.has(`${prefix}:assign:managed` as any)) {
      ids = await getManagedMembershipIds(ctx, args.companyId, membership._id);
    } else if (caps.has(`${prefix}:assign:self` as any)) {
      ids = new Set([membership._id]);
    } else {
      return [];
    }
    return await enrich(ctx, Array.from(ids));
  },
});

export const filterableAssignees = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const ids = await scopedMembershipIds(ctx, args.companyId, membership);
    return await enrich(ctx, Array.from(ids));
  },
});


async function aiAssignees(ctx: Ctx, ids: Id<"companyMemberships">[]) {
  const rows = await enrich(ctx, ids);
  return rows.map((row: any) => ({ name: row.user.fullName ?? row.user.email, role: row.membership.role }));
}

async function aiJdRow(ctx: Ctx, task: Doc<"jdTasks">) {
  const state = await jdState(ctx, task);
  return { kind: "jd" as const, id: task._id, title: task.title, description: task.description, notes: task.notes, status: state.status, dueAt: state.dueAt, recurrence: task.recurrence, quantity: task.quantity, time: task.time, assignees: await aiAssignees(ctx, task.assigneeMembershipIds) };
}

async function aiOneTimeRow(ctx: Ctx, task: Doc<"oneTimeTasks">) {
  const state = oneState(task);
  return { kind: "one_time" as const, id: task._id, title: task.title, description: task.description, notes: task.notes, status: state.status, dueAt: task.dueDate, priority: task.priority, quantity: task.quantity, time: task.time, assignees: await aiAssignees(ctx, task.assigneeMembershipIds) };
}

export const aiListVisible = query({
  args: { companyId: v.id("companies"), status: v.union(v.literal("all"), v.literal("due"), v.literal("overdue"), v.literal("done")), limit: v.number() },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership);
    const limit = Math.min(Math.max(Math.floor(args.limit), 1), 30);
    const out: any[] = [];
    const matches = (status: string) => args.status === "all" || (args.status === "overdue" ? status === "Overdue" : args.status === "done" ? status === "Completed" : status !== "Completed" && status !== "Overdue");
    const jdRows: any[] = [];
    for await (const task of ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc")) {
      if (!(await visible(ctx, args.companyId, membership, task, "jd", auth))) continue;
      const row = await aiJdRow(ctx, task);
      if (matches(row.status)) jdRows.push(row);
      if (jdRows.length >= limit) break;
    }
    const oneRows: any[] = [];
    for await (const task of ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc")) {
      if (!(await visible(ctx, args.companyId, membership, task, "one_time", auth))) continue;
      const row = await aiOneTimeRow(ctx, task);
      if (matches(row.status)) oneRows.push(row);
      if (oneRows.length >= limit) break;
    }
    for (let i = 0; i < Math.max(jdRows.length, oneRows.length) && out.length < limit; i += 1) {
      if (jdRows[i]) out.push(jdRows[i]);
      if (oneRows[i] && out.length < limit) out.push(oneRows[i]);
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
      ids = await getManagedMembershipIds(ctx, args.companyId, membership._id);
    } else if (caps.has(`${prefix}:assign:self` as any)) {
      ids = new Set([membership._id]);
    } else {
      return [];
    }
    const rows = await enrich(ctx, Array.from(ids));
    return rows.map((row: any) => ({ membershipId: row.membership._id, name: row.user.fullName ?? row.user.email, email: row.user.email, role: row.membership.role }));
  },
});

export const aiCreateOneTime = mutation({
  args: { companyId: v.id("companies"), title: v.string(), description: v.optional(v.string()), notes: v.optional(v.string()), dueDate: v.optional(v.number()), assigneeMembershipIds: v.array(v.id("companyMemberships")), priority: priorityValidator },
  handler: async (ctx, args) => {
    const { membership, user } = await requireCapability(ctx, args.companyId, "tasks:one_time:create");
    const title = nonEmpty(args.title, "Task title");
    requireTaskAssignee(args.assigneeMembershipIds);
    await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds);
    await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "one_time");
    const now = Date.now();
    const reference = await nextReference(ctx, args.companyId, "one_time");
    const id = await ctx.db.insert("oneTimeTasks", { companyId: args.companyId, reference, title, description: cleanOptionalText(args.description), notes: cleanOptionalText(args.notes), dueDate: args.dueDate, assigneeMembershipIds: args.assigneeMembershipIds, createdByMembershipId: membership._id, priority: args.priority, status: "due", createdAt: now, updatedAt: now });
    await logTaskActivity(ctx, { companyId: args.companyId, taskType: "one_time", taskId: id, actorMembershipId: membership._id, event: "created", createdAt: now });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "one_time_task.create", targetType: "oneTimeTask", targetId: id, createdAt: now });
    const task = await ctx.db.get(id);
    if (!task) throw new ConvexError("Task not found.");
    return await aiOneTimeRow(ctx, task);
  },
});

export const aiCreateJd = mutation({
  args: { companyId: v.id("companies"), title: v.string(), description: v.optional(v.string()), notes: v.optional(v.string()), recurrence: recurrenceValidator, assigneeMembershipIds: v.array(v.id("companyMemberships")) },
  handler: async (ctx, args) => {
    const { membership, user, company } = await requireCapability(ctx, args.companyId, "tasks:jd:create");
    const title = nonEmpty(args.title, "Task title");
    requireTaskAssignee(args.assigneeMembershipIds);
    await assertAssigneesInCompany(ctx, args.companyId, args.assigneeMembershipIds);
    await assertCanAssign(ctx, args.companyId, membership, args.assigneeMembershipIds, "jd");
    const now = Date.now();
    const reference = await nextReference(ctx, args.companyId, "jd");
    const id = await ctx.db.insert("jdTasks", { companyId: args.companyId, reference, title, description: cleanOptionalText(args.description), notes: cleanOptionalText(args.notes), recurrence: args.recurrence, cycleStartedAt: now, status: "due", statusCycleStart: currentJdCycle(args.recurrence, now, company.timeZone).start, assigneeMembershipIds: args.assigneeMembershipIds, createdByMembershipId: membership._id, createdAt: now, updatedAt: now });
    await logTaskActivity(ctx, { companyId: args.companyId, taskType: "jd", taskId: id, actorMembershipId: membership._id, event: "created", createdAt: now });
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
    const { normalized } = await getVisibleTask(ctx, args.companyId, membership, args.kind, args.taskId);
    if (args.kind === "jd") {
      await setJdStatus(ctx, args.companyId, normalized as Id<"jdTasks">, "completed", args.note);
      const updated = await ctx.db.get(normalized as Id<"jdTasks">);
      if (!updated) throw new ConvexError("Task not found.");
      return await aiJdRow(ctx, updated);
    }
    await setOneTimeStatus(ctx, args.companyId, normalized as Id<"oneTimeTasks">, "completed");
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

/**
 * Migrates a single batch of tasks for a given table (jdTasks or oneTimeTasks)
 * using cursor-based pagination to ensure transactions stay bounded.
 */
export const migrateTaskBatch = internalMutation({
  args: {
    table: v.union(v.literal("jdTasks"), v.literal("oneTimeTasks")),
    cursor: v.union(v.string(), v.null()),
    batchSize: v.number(),
    dryRun: v.boolean(),
    companyId: v.optional(v.id("companies")),
  },
  handler: async (ctx, args) => {
    const baseQuery = args.companyId
      ? ctx.db.query(args.table).withIndex("by_company", (q) => q.eq("companyId", args.companyId!))
      : ctx.db.query(args.table);

    const page = await baseQuery.paginate({ numItems: args.batchSize, cursor: args.cursor });
    let migrated = 0;
    const batchTargets = new Set<string>();
    const targets: Array<{ id: string; reference: string; targetRef: string; companyId: string }> = [];

    for (const task of page.page) {
      if (args.table === "jdTasks") {
        const match = /^JD-(\d+)$/i.exec(task.reference);
        if (match) {
          const num = parseInt(match[1], 10);
          const newRef = `JD-${String(num).padStart(3, "0")}`;
          if (task.reference !== newRef) {
            const key = `${task.companyId}:${newRef}`;
            if (batchTargets.has(key)) {
              throw new ConvexError(
                `Cannot migrate task ${task._id} (${task.reference}) to ${newRef}: target reference already exists in company ${task.companyId}.`
              );
            }
            const existing = await ctx.db
              .query("jdTasks")
              .withIndex("by_companyId_and_reference", (q) =>
                q.eq("companyId", task.companyId).eq("reference", newRef)
              )
              .first();
            if (existing && existing._id !== task._id) {
              throw new ConvexError(
                `Cannot migrate task ${task._id} (${task.reference}) to ${newRef}: target reference already exists in company ${task.companyId}.`
              );
            }
            batchTargets.add(key);
            targets.push({ id: task._id, reference: task.reference, targetRef: newRef, companyId: task.companyId });
            if (!args.dryRun) {
              await ctx.db.patch(task._id, { reference: newRef });
            }
            migrated += 1;
          }
        }
      } else {
        const match = /^(?:OT|TSK)-(\d+)$/i.exec(task.reference);
        if (match) {
          const num = parseInt(match[1], 10);
          const newRef = `TSK-${String(num).padStart(3, "0")}`;
          if (task.reference !== newRef) {
            const key = `${task.companyId}:${newRef}`;
            if (batchTargets.has(key)) {
              throw new ConvexError(
                `Cannot migrate task ${task._id} (${task.reference}) to ${newRef}: target reference already exists in company ${task.companyId}.`
              );
            }
            const existing = await ctx.db
              .query("oneTimeTasks")
              .withIndex("by_companyId_and_reference", (q) =>
                q.eq("companyId", task.companyId).eq("reference", newRef)
              )
              .first();
            if (existing && existing._id !== task._id) {
              throw new ConvexError(
                `Cannot migrate task ${task._id} (${task.reference}) to ${newRef}: target reference already exists in company ${task.companyId}.`
              );
            }
            batchTargets.add(key);
            targets.push({ id: task._id, reference: task.reference, targetRef: newRef, companyId: task.companyId });
            if (!args.dryRun) {
              await ctx.db.patch(task._id, { reference: newRef });
            }
            migrated += 1;
          }
        }
      }
    }

    return {
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      migrated,
      scanned: page.page.length,
      targets,
    };
  },
});

/**
 * Migrates existing task codes to the 3-digit format across all batches:
 * - JD tasks: "JD-0001" -> "JD-001"
 * - One-time tasks: "OT-0001" -> "TSK-001" (and normalizes 4-digit "TSK-0001" -> "TSK-001")
 *
 * Designed to handle any number of tasks on prod by running bounded batches.
 * Can be run via the Convex CLI:
 *   npx convex run tasks:migrateTaskCodes '{"dryRun": true}'   # preview changes
 *   npx convex run tasks:migrateTaskCodes '{"dryRun": false}'  # apply changes
 */
export const migrateTaskCodes = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    companyId: v.optional(v.id("companies")),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? false;
    const batchSize = Math.min(Math.max(args.batchSize ?? 250, 1), 1000);

    // Collision preflight across the whole run (dry-run pass that reserves computed targets)
    const reservedTargets = new Set<string>();
    let preflightJdMigrated = 0;
    let preflightOneTimeMigrated = 0;

    let jdCursor: string | null = null;
    let jdDone = false;
    while (!jdDone) {
      const batchResult: {
        continueCursor: string;
        isDone: boolean;
        migrated: number;
        targets: Array<{ id: string; reference: string; targetRef: string; companyId: string }>;
      } = await ctx.runMutation(internal.tasks.migrateTaskBatch, {
        table: "jdTasks",
        cursor: jdCursor,
        batchSize,
        dryRun: true,
        companyId: args.companyId,
      });
      for (const target of batchResult.targets) {
        const key = `${target.companyId}:${target.targetRef}`;
        if (reservedTargets.has(key)) {
          throw new ConvexError(
            `Cannot migrate task ${target.id} (${target.reference}) to ${target.targetRef}: target reference already exists in company ${target.companyId}.`
          );
        }
        reservedTargets.add(key);
      }
      preflightJdMigrated += batchResult.migrated;
      jdCursor = batchResult.continueCursor;
      jdDone = batchResult.isDone;
    }

    let oneTimeCursor: string | null = null;
    let oneTimeDone = false;
    while (!oneTimeDone) {
      const batchResult: {
        continueCursor: string;
        isDone: boolean;
        migrated: number;
        targets: Array<{ id: string; reference: string; targetRef: string; companyId: string }>;
      } = await ctx.runMutation(internal.tasks.migrateTaskBatch, {
        table: "oneTimeTasks",
        cursor: oneTimeCursor,
        batchSize,
        dryRun: true,
        companyId: args.companyId,
      });
      for (const target of batchResult.targets) {
        const key = `${target.companyId}:${target.targetRef}`;
        if (reservedTargets.has(key)) {
          throw new ConvexError(
            `Cannot migrate task ${target.id} (${target.reference}) to ${target.targetRef}: target reference already exists in company ${target.companyId}.`
          );
        }
        reservedTargets.add(key);
      }
      preflightOneTimeMigrated += batchResult.migrated;
      oneTimeCursor = batchResult.continueCursor;
      oneTimeDone = batchResult.isDone;
    }

    const totalMigratable = preflightJdMigrated + preflightOneTimeMigrated;
    if (dryRun) {
      return {
        dryRun: true,
        jdMigrated: preflightJdMigrated,
        oneTimeMigrated: preflightOneTimeMigrated,
        totalMigrated: totalMigratable,
      };
    }

    if (totalMigratable === 0) {
      return {
        dryRun: false,
        jdMigrated: 0,
        oneTimeMigrated: 0,
        totalMigrated: 0,
      };
    }

    // Real run: preflight passed with no collisions, safe to write
    let jdMigrated = 0;
    let oneTimeMigrated = 0;

    jdCursor = null;
    jdDone = false;
    while (!jdDone) {
      const batchResult: { continueCursor: string; isDone: boolean; migrated: number } =
        await ctx.runMutation(internal.tasks.migrateTaskBatch, {
          table: "jdTasks",
          cursor: jdCursor,
          batchSize,
          dryRun: false,
          companyId: args.companyId,
        });
      jdMigrated += batchResult.migrated;
      jdCursor = batchResult.continueCursor;
      jdDone = batchResult.isDone;
    }

    oneTimeCursor = null;
    oneTimeDone = false;
    while (!oneTimeDone) {
      const batchResult: { continueCursor: string; isDone: boolean; migrated: number } =
        await ctx.runMutation(internal.tasks.migrateTaskBatch, {
          table: "oneTimeTasks",
          cursor: oneTimeCursor,
          batchSize,
          dryRun: false,
          companyId: args.companyId,
        });
      oneTimeMigrated += batchResult.migrated;
      oneTimeCursor = batchResult.continueCursor;
      oneTimeDone = batchResult.isDone;
    }

    return {
      dryRun: false,
      jdMigrated,
      oneTimeMigrated,
      totalMigrated: jdMigrated + oneTimeMigrated,
    };
  },
});

