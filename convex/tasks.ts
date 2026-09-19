import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { currentJdCycle, defaultTimeZone, elapsedJdCyclesSince, nextJdCycleStart, type JdRecurrence } from "./taskCycles";
import { activeCompanyMembershipIds, assertCanAssign, assertCanDeleteTask, assertCanUpdateTask, canViewTask, getManagedMembershipIds, hasAllManagedMemberships, hasAnyManagedMembership, memberFirstName, memberFullName, membershipCapabilities, requireCapability, requireMembership, scanManagedMembershipIds, scopedMembershipIds } from "./permissions";
import type { Capability } from "../src/lib/permissions";
import { nonEmpty } from "./validation";
import { DEFAULT_QUERY_LIMIT, takeWithOverflow } from "./queryLimits";
import { ASSIGNEE_SEARCH_MAX_LENGTH } from "../src/lib/assignee-search";
import { nextReference } from "./references";
import {
  assertTaskListSort,
  taskListPreferenceResultValidator,
  taskListSortValidator,
  taskListTaskTypeValidator,
} from "./taskListPreferences";

type ManualStatus = "due" | "in_progress" | "completed";
type TaskKind = "jd" | "one_time";
type Ctx = QueryCtx | MutationCtx;
type TaskVisibilityAuth = {
  caps: Set<Capability>;
  /**
   * Lazily resolved managed scope, shared by every check in this invocation.
   * `complete` is true only when the bounded scope read was not truncated, so
   * a complete set can answer membership checks without per-target fallbacks.
   */
  getManagedScope: () => Promise<{ ids: Set<Id<"companyMemberships">>; complete: boolean }>;
};

const recurrenceValidator = v.union(v.literal("daily"), v.literal("every_other_day"), v.literal("weekly"), v.literal("semimonthly"), v.literal("monthly"), v.literal("quarterly"), v.literal("semiannually"), v.literal("annually"));
const priorityValidator = v.union(v.literal("low"), v.literal("medium"), v.literal("high"));
const statusValidator = v.union(v.literal("due"), v.literal("in_progress"), v.literal("completed"));
const jdFrequencyFilterValidator = v.union(v.literal("all"), v.literal("daily"), v.literal("every_other_day"), v.literal("weekly"), v.literal("semimonthly"), v.literal("monthly"), v.literal("quarterly"), v.literal("semiannually"), v.literal("annually"));
const TASK_LIST_ORDER_LIMIT = 2_000;
const TASK_LIST_ORDER_MAX_SERIALIZED_BYTES = 128 * 1024;
const TASK_LIST_ORDER_KEY_MAX_LENGTH = 512;
const ASSIGNABLE_USER_INITIAL_LIMIT = DEFAULT_QUERY_LIMIT;
const ASSIGNABLE_USER_SEARCH_MIN_LENGTH = 3;
const ASSIGNABLE_USER_SEARCH_SCAN_LIMIT = 1_000;
const ASSIGNABLE_USER_SEARCH_RESULT_LIMIT = 50;
const ASSIGNABLE_USER_SEARCH_USER_BATCH_SIZE = 50;
const taskListOrderKeyPattern = /^(?:0|-[1-9]\d*|[1-9]\d*)\/[1-9]\d*$/;
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
  let scope: Promise<{ ids: Set<Id<"companyMemberships">>; complete: boolean }> | undefined;
  return {
    caps,
    getManagedScope: () => scope ??= (async () => {
      let complete = true;
      const ids = await getManagedMembershipIds(ctx, companyId, membership._id, () => { complete = false; });
      return { ids, complete };
    })(),
  };
}

async function visible(ctx: Ctx, companyId: Id<"companies">, membership: Doc<"companyMemberships">, task: Pick<Doc<"jdTasks"> | Doc<"oneTimeTasks">, "assigneeMembershipIds" | "createdByMembershipId">, kind: TaskKind, auth?: TaskVisibilityAuth) {
  if (!auth) {
    return await canViewTask(ctx, companyId, membership, { companyId, assigneeMembershipIds: task.assigneeMembershipIds, createdByMembershipId: task.createdByMembershipId }, kind);
  }
  const caps = auth.caps;
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (caps.has(`${prefix}:view:any` as Capability)) return true;
  const targets = task.assigneeMembershipIds.length > 0 ? task.assigneeMembershipIds : [task.createdByMembershipId];
  if (caps.has(`${prefix}:view:managed` as Capability)) {
    const scope = await auth.getManagedScope();
    if (targets.some((id) => scope.ids.has(id))) return true;
    // A truncated scope is not authoritative, so fall back to per-target checks.
    if (!scope.complete && await hasAnyManagedMembership(ctx, companyId, membership._id, targets, scope.ids)) return true;
  }
  if (caps.has(`${prefix}:view:self` as Capability)) {
    if (targets.includes(membership._id) || task.createdByMembershipId === membership._id) return true;
  }
  return false;
}

/** Assignees the viewer may see: all active members for company-wide viewers, otherwise the shared managed scope. */
async function displayScopedMembershipIds(ctx: Ctx, companyId: Id<"companies">, auth: TaskVisibilityAuth, anyCapability: Capability) {
  if (auth.caps.has(anyCapability)) return await activeCompanyMembershipIds(ctx, companyId);
  return (await auth.getManagedScope()).ids;
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
  auth?: TaskVisibilityAuth,
) {
  const caps = auth?.caps ?? (await membershipCapabilities(ctx, membership));
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  const targets = updateAuthTargets(task);
  if (caps.has(`${prefix}:update:any` as any)) return true;
  if (caps.has(`${prefix}:update:managed` as any)) {
    const scope = auth ? await auth.getManagedScope() : { ids: await getManagedMembershipIds(ctx, companyId, membership._id), complete: false };
    // A complete scope is authoritative; otherwise fall back to per-target checks.
    if (scope.complete ? targets.every((id) => scope.ids.has(id)) : await hasAllManagedMemberships(ctx, companyId, membership._id, targets, scope.ids)) return true;
  }
  return Boolean(caps.has(`${prefix}:update:self` as any) && targets.includes(membership._id));
}

// Status moves with the assignee, not the permission system: anyone assigned
// can always change it. Everyone else needs normal task update access.
async function assertCanUpdateTaskStatus(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  task: Pick<Doc<"jdTasks"> | Doc<"oneTimeTasks">, "assigneeMembershipIds" | "createdByMembershipId">,
  kind: TaskKind
) {
  if (task.assigneeMembershipIds.includes(membership._id)) return;
  await assertCanUpdateTask(ctx, companyId, membership, updateAuthTargets(task), kind);
}

async function canDeleteTask(
  ctx: Ctx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  task: Pick<Doc<"jdTasks"> | Doc<"oneTimeTasks">, "assigneeMembershipIds" | "createdByMembershipId">,
  kind: TaskKind,
  auth?: TaskVisibilityAuth,
) {
  const caps = auth?.caps ?? (await membershipCapabilities(ctx, membership));
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  const targets = updateAuthTargets(task);
  if (caps.has(`${prefix}:delete:any` as any)) return true;
  if (caps.has(`${prefix}:delete:managed` as any)) {
    const scope = auth ? await auth.getManagedScope() : { ids: await getManagedMembershipIds(ctx, companyId, membership._id), complete: false };
    if (scope.complete ? targets.every((id) => scope.ids.has(id)) : await hasAllManagedMemberships(ctx, companyId, membership._id, targets, scope.ids)) return true;
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
    // Legacy tasks predate jdTaskCompletions; their only completed-cycle signal
    // is the status pair stamped when the cycle was current.
    const markedDone = task.status === "completed" && task.statusCycleStart === cycle.start;
    const recorded = await currentJdCycleRecord(ctx, task._id, cycle.start);
    if (done) continue;
    if (markedDone) {
      // Persist the stamped completion before cycleStartedAt advances past the
      // cycle, or the dashboard loses it once the stamp moves on. A missed
      // record for the same cycle is wrong history, so remove it rather than
      // leave a completed cycle listed as missed.
      if (recorded) await ctx.db.delete(recorded._id);
      await ctx.db.insert("jdTaskCompletions", { companyId: task.companyId, jdTaskId: task._id, cycleStart: cycle.start, cycleEnd: cycle.end, completedAt: cycle.end });
    } else if (!recorded) {
      await ctx.db.insert("jdTaskCycleRecords", { companyId: task.companyId, jdTaskId: task._id, cycleStart: cycle.start, cycleEnd: cycle.end, status: "missed", recordedAt: now });
    }
  }
  if (cycles.length > 0) {
    await ctx.db.patch(task._id, { cycleStartedAt: nextActiveAt });
    task.cycleStartedAt = nextActiveAt;
  }
  return { cycles, nextActiveAt };
}

/**
 * Converts the legacy {status, statusCycleStart} completion stamp into a real
 * completion row before the stamp is overwritten, so deferred catch-up cannot
 * record the stamped cycle as missed. Bounded to one stamped cycle.
 */
async function preserveJdCompletionStamp(ctx: MutationCtx, task: Doc<"jdTasks">, currentCycleStart: number, timeZone: string) {
  if (task.status !== "completed" || task.statusCycleStart === undefined || task.statusCycleStart >= currentCycleStart) return;
  const stampedStart = task.statusCycleStart;
  const [existingCompletion, existingRecord] = await Promise.all([
    currentJdCompletion(ctx, task._id, stampedStart),
    currentJdCycleRecord(ctx, task._id, stampedStart),
  ]);
  if (existingCompletion) return;
  if (existingRecord) await ctx.db.delete(existingRecord._id);
  const stampedEnd = nextJdCycleStart(stampedStart, task.recurrence, timeZone);
  await ctx.db.insert("jdTaskCompletions", { companyId: task.companyId, jdTaskId: task._id, cycleStart: stampedStart, cycleEnd: stampedEnd, completedAt: stampedEnd });
}

/**
 * Runs full missed-cycle catch-up off the interactive path. Cheap to call: it
 * only schedules work when cycles actually elapsed since cycleStartedAt. When
 * the caller is about to replace the task's recurrence, pass the old schedule
 * as `schedule` so the deferred run reconstructs the old grid — by the time it
 * executes, the task document already carries the new recurrence.
 */
function scheduleMissedJdCycleCatchUp(ctx: MutationCtx, task: Doc<"jdTasks">, currentCycleStart: number, schedule?: { recurrence: JdRecurrence; cycleStartedAt: number }) {
  if (task.cycleStartedAt < currentCycleStart) {
    return ctx.scheduler.runAfter(0, internal.tasks.catchUpMissedJdCycles, { taskId: task._id, schedule });
  }
}

async function jdState(ctx: Ctx, task: Doc<"jdTasks">, now = Date.now(), timeZone?: string) {
  const c = currentJdCycle(task.recurrence, now, timeZone ?? await companyTimeZone(ctx, task.companyId));
  const currentDone = await currentJdCompletion(ctx, task._id, c.start);
  const status: ManualStatus = currentDone || (task.statusCycleStart === c.start && task.status === "completed") ? "completed" : task.statusCycleStart === c.start ? task.status : "due";
  return { status: statusLabel(status), rawStatus: status, isOverdue: false, currentCycleStart: c.start, currentCycleEnd: c.end, dueAt: c.end };
}

function oneState(task: Doc<"oneTimeTasks">) {
  const isOverdue = Boolean(task.overdueAt) || Boolean(task.dueDate && task.status !== "completed" && task.dueDate < Date.now());
  const status: ManualStatus | "overdue" = isOverdue ? "overdue" : task.status;
  return { status: statusLabel(status), rawStatus: status, isOverdue, dueAt: task.dueDate ?? null };
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

async function enrichedJd(ctx: Ctx, task: Doc<"jdTasks">, timeZone?: string, canUpdate?: boolean, canDelete?: boolean, scopedMembershipIds?: Set<Id<"companyMemberships">>, customOrderKey?: string) {
  const visibleAssigneeIds = scopedMembershipIds ? task.assigneeMembershipIds.filter((id) => scopedMembershipIds.has(id)) : task.assigneeMembershipIds;
  return {
    ...task,
    state: await jdState(ctx, task, Date.now(), timeZone),
    assignees: await enrich(ctx, visibleAssigneeIds),
    ...(canUpdate !== undefined ? { canUpdate } : {}),
    ...(canDelete !== undefined ? { canDelete } : {}),
    ...(customOrderKey ? { customOrderKey } : {}),
  };
}
async function enrichedOneTime(ctx: Ctx, task: Doc<"oneTimeTasks">, canUpdate?: boolean, canDelete?: boolean, scopedMembershipIds?: Set<Id<"companyMemberships">>, customOrderKey?: string) {
  const visibleAssigneeIds = scopedMembershipIds ? task.assigneeMembershipIds.filter((id) => scopedMembershipIds.has(id)) : task.assigneeMembershipIds;
  return {
    ...task,
    state: oneState(task),
    assignees: await enrich(ctx, visibleAssigneeIds),
    ...(canUpdate !== undefined ? { canUpdate } : {}),
    ...(canDelete !== undefined ? { canDelete } : {}),
    ...(customOrderKey ? { customOrderKey } : {}),
  };
}
function matchesSearch(task: { title: string; reference: string }, search?: string) {
  const needle = search?.trim().toLowerCase();
  if (!needle) return true;
  return task.title.toLowerCase().includes(needle) || task.reference.toLowerCase().includes(needle);
}

async function filterAssignableUsersBySearch(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  memberships: Doc<"companyMemberships">[],
  search: string,
) {
  const needle = search.toLowerCase();
  const matches: Id<"companyMemberships">[] = [];
  const activeMemberships = memberships.filter(
    (membership) => membership.companyId === companyId && membership.active,
  );
  for (let start = 0; start < activeMemberships.length; start += ASSIGNABLE_USER_SEARCH_USER_BATCH_SIZE) {
    const batch = activeMemberships.slice(start, start + ASSIGNABLE_USER_SEARCH_USER_BATCH_SIZE);
    const users = await Promise.all(batch.map((membership) => ctx.db.get(membership.userId)));
    for (let index = 0; index < batch.length; index += 1) {
      const membership = batch[index];
      const user = users[index];
      if (!user) continue;
      const searchable = `${memberFullName(membership, user)} ${user.email} ${membership.role}`.toLowerCase();
      if (!searchable.includes(needle)) continue;
      matches.push(membership._id);
      if (matches.length > ASSIGNABLE_USER_SEARCH_RESULT_LIMIT) {
        return {
          ids: matches.slice(0, ASSIGNABLE_USER_SEARCH_RESULT_LIMIT),
          isTruncated: true,
        };
      }
    }
  }
  return { ids: matches, isTruncated: false };
}

async function loadMembershipsById(ctx: QueryCtx, ids: Id<"companyMemberships">[]) {
  const memberships: Doc<"companyMemberships">[] = [];
  for (let start = 0; start < ids.length; start += ASSIGNABLE_USER_SEARCH_USER_BATCH_SIZE) {
    const batch = await Promise.all(
      ids.slice(start, start + ASSIGNABLE_USER_SEARCH_USER_BATCH_SIZE).map((id) => ctx.db.get(id)),
    );
    for (const membership of batch) if (membership) memberships.push(membership);
  }
  return memberships;
}

async function assignableUsersResult(
  ctx: QueryCtx,
  ids: Id<"companyMemberships">[],
  isTruncated: boolean,
) {
  return { users: await enrich(ctx, ids), isTruncated };
}

async function getTaskListPreference(
  ctx: Ctx,
  companyId: Id<"companies">,
  membershipId: Id<"companyMemberships">,
  taskType: TaskKind,
) {
  return await ctx.db
    .query("taskListPreferences")
    .withIndex("by_companyId_and_membershipId_and_taskType", (q) =>
      q.eq("companyId", companyId).eq("membershipId", membershipId).eq("taskType", taskType),
    )
    .unique();
}

function taskListPreferenceResult(
  taskType: TaskKind,
  preference: Doc<"taskListPreferences"> | null,
) {
  if (taskType === "jd") {
    return {
      taskType: "jd" as const,
      sort: preference?.sort ?? { mode: "default" as const },
      customOrder: preference?.taskType === "jd" ? preference.customOrder ?? null : null,
      ...(preference?.orderFormat ? { orderFormat: preference.orderFormat } : {}),
      revision: preference?.revision ?? 0,
      updatedAt: preference?.updatedAt ?? null,
    };
  }
  return {
    taskType: "one_time" as const,
    sort: preference?.sort ?? { mode: "default" as const },
    customOrder: preference?.taskType === "one_time" ? preference.customOrder ?? null : null,
    ...(preference?.orderFormat ? { orderFormat: preference.orderFormat } : {}),
    revision: preference?.revision ?? 0,
    updatedAt: preference?.updatedAt ?? null,
  };
}

function assertExpectedPreferenceRevision(
  preference: Doc<"taskListPreferences"> | null,
  expectedRevision: number,
) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new ConvexError("Task list preference revision is invalid.");
  }
  if ((preference?.revision ?? 0) !== expectedRevision) {
    throw new ConvexError("Task list preference was updated. Refresh and try again.");
  }
}

function assertTaskListOrderInput(orderedIds: string[]) {
  if (orderedIds.length > TASK_LIST_ORDER_LIMIT) {
    throw new ConvexError(`Task list order can contain at most ${TASK_LIST_ORDER_LIMIT} tasks.`);
  }
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new ConvexError("Task list order contains duplicate task IDs.");
  }
  if (JSON.stringify(orderedIds).length > TASK_LIST_ORDER_MAX_SERIALIZED_BYTES) {
    throw new ConvexError("Task list order is too large to save.");
  }
}

function assertTaskListOrderKey(orderKey: string) {
  if (orderKey.length > TASK_LIST_ORDER_KEY_MAX_LENGTH || !taskListOrderKeyPattern.test(orderKey)) {
    throw new ConvexError("Task list order position is invalid.");
  }
}

async function validateTaskListOrder(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  taskType: "jd",
  orderedIds: string[],
): Promise<Id<"jdTasks">[]>;
async function validateTaskListOrder(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  taskType: "one_time",
  orderedIds: string[],
): Promise<Id<"oneTimeTasks">[]>;
async function validateTaskListOrder(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  taskType: TaskKind,
  orderedIds: string[],
) {
  const auth = await taskVisibilityAuth(ctx, companyId, membership);
  if (taskType === "jd") {
    const normalized: Id<"jdTasks">[] = [];
    for (const rawId of orderedIds) {
      const id = ctx.db.normalizeId("jdTasks", rawId);
      if (!id) throw new ConvexError("Task not found.");
      const task = await ctx.db.get(id);
      if (!task || task.companyId !== companyId || !(await visible(ctx, companyId, membership, task, "jd", auth))) {
        throw new ConvexError("Task not found.");
      }
      normalized.push(id);
    }
    return normalized;
  }

  const normalized: Id<"oneTimeTasks">[] = [];
  for (const rawId of orderedIds) {
    const id = ctx.db.normalizeId("oneTimeTasks", rawId);
    if (!id) throw new ConvexError("Task not found.");
    const task = await ctx.db.get(id);
    if (!task || task.companyId !== companyId || !(await visible(ctx, companyId, membership, task, "one_time", auth))) {
      throw new ConvexError("Task not found.");
    }
    normalized.push(id);
  }
  return normalized;
}

async function applyTaskListOrderKeyUpdates(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  taskType: TaskKind,
  orderKeyUpdates: { taskId: string; orderKey: string }[],
  now: number,
) {
  const taskIds = taskType === "jd"
    ? await validateTaskListOrder(ctx, companyId, membership, "jd", orderKeyUpdates.map(({ taskId }) => taskId))
    : await validateTaskListOrder(ctx, companyId, membership, "one_time", orderKeyUpdates.map(({ taskId }) => taskId));
  const entries = await ctx.db
    .query("taskListOrderEntries")
    .withIndex("by_companyId_and_membershipId_and_taskType_and_taskId", (q) =>
      q.eq("companyId", companyId).eq("membershipId", membership._id).eq("taskType", taskType),
    )
    .take(TASK_LIST_ORDER_LIMIT + 1);
  const entryByTaskId = new Map(entries.map((entry) => [entry.taskId, entry]));
  const missingEntryCount = taskIds.filter((taskId) => !entryByTaskId.has(taskId)).length;
  if (entries.length + missingEntryCount > TASK_LIST_ORDER_LIMIT) {
    throw new ConvexError("Task list order is too large to save.");
  }

  // This only supports older clients, but a full legacy rebalance can contain 2,000 writes.
  for (let start = 0; start < taskIds.length; start += 100) {
    const writes: Promise<unknown>[] = [];
    for (let index = start; index < Math.min(start + 100, taskIds.length); index += 1) {
      const taskId = taskIds[index];
      const { orderKey } = orderKeyUpdates[index];
      const entry = entryByTaskId.get(taskId);
      if (entry) {
        writes.push(ctx.db.patch(entry._id, { orderKey, updatedAt: now }));
      } else if (taskType === "jd") {
        writes.push(ctx.db.insert("taskListOrderEntries", {
          companyId,
          membershipId: membership._id,
          taskType: "jd",
          taskId: taskId as Id<"jdTasks">,
          orderKey,
          updatedAt: now,
        }));
      } else {
        writes.push(ctx.db.insert("taskListOrderEntries", {
          companyId,
          membershipId: membership._id,
          taskType: "one_time",
          taskId: taskId as Id<"oneTimeTasks">,
          orderKey,
          updatedAt: now,
        }));
      }
    }
    await Promise.all(writes);
  }
}

/** Loads every custom-order entry for the list in one indexed read instead of one lookup per row. */
async function taskListOrderKeyMap(ctx: Ctx, companyId: Id<"companies">, membershipId: Id<"companyMemberships">, taskType: TaskKind) {
  const entries = await ctx.db
    .query("taskListOrderEntries")
    .withIndex("by_companyId_and_membershipId_and_taskType_and_taskId", (q) =>
      q.eq("companyId", companyId).eq("membershipId", membershipId).eq("taskType", taskType),
    )
    .take(TASK_LIST_ORDER_LIMIT + 1);
  return new Map(entries.map((entry) => [entry.taskId, entry.orderKey]));
}

export const listJdRows = query({
  args: { companyId: v.id("companies"), search: v.optional(v.string()), frequency: v.optional(jdFrequencyFilterValidator), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.any()),
  handler: async (ctx, args) => {
    const { membership, company } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership);
    const [scoped, preference] = await Promise.all([
      displayScopedMembershipIds(ctx, args.companyId, auth, "tasks:jd:view:any"),
      getTaskListPreference(ctx, args.companyId, membership._id, "jd"),
    ]);
    const page = await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").paginate(args.paginationOpts);
    const candidates = page.page.filter((task) =>
      (!args.frequency || args.frequency === "all" || task.recurrence === args.frequency) && matchesSearch(task, args.search),
    );
    const visibleFlags = await Promise.all(candidates.map((task) => visible(ctx, args.companyId, membership, task, "jd", auth)));
    const visibleTasks = candidates.filter((_, index) => visibleFlags[index]);

    // Enrich the whole page at once: unique assignees are fetched in a single
    // batched pass and per-row state reads run concurrently instead of serially.
    const now = Date.now();
    const timeZone = company.timeZone ?? defaultTimeZone;
    const includeCustomOrderKeys = preference && preference.orderFormat !== "vector";
    const assigneeRows = await enrich(ctx, visibleTasks.flatMap((task) => task.assigneeMembershipIds.filter((id) => scoped.has(id))));
    const assigneeById = new Map(assigneeRows.map((row) => [row.membership._id, row]));
    const [states, updates, deletes, orderKeys] = await Promise.all([
      Promise.all(visibleTasks.map((task) => jdState(ctx, task, now, timeZone))),
      Promise.all(visibleTasks.map((task) => canUpdateTask(ctx, args.companyId, membership, task, "jd", auth))),
      Promise.all(visibleTasks.map((task) => canDeleteTask(ctx, args.companyId, membership, task, "jd", auth))),
      includeCustomOrderKeys ? taskListOrderKeyMap(ctx, args.companyId, membership._id, "jd") : Promise.resolve(null),
    ]);
    const rows = visibleTasks.map((task, index) => ({
      ...task,
      state: states[index],
      assignees: task.assigneeMembershipIds.filter((id) => scoped.has(id)).flatMap((id) => assigneeById.get(id) ?? []),
      canUpdate: updates[index],
      canDelete: deletes[index],
      ...(orderKeys?.get(task._id) ? { customOrderKey: orderKeys.get(task._id) } : {}),
    }));
    return { ...page, page: rows };
  },
});

export const exportRows = query({
  args: { companyId: v.id("companies"), kind: v.union(v.literal("jd"), v.literal("one_time")), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const capability: Capability = args.kind === "jd" ? "tasks:jd:export" : "tasks:one_time:export";
    const { membership, company } = await requireCapability(ctx, args.companyId, capability);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership);
    const scoped = await displayScopedMembershipIds(ctx, args.companyId, auth, args.kind === "jd" ? "tasks:jd:view:any" : "tasks:one_time:view:any");
    if (args.kind === "jd") {
      const page = await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("asc").paginate(args.paginationOpts);
      const visibleFlags = await Promise.all(page.page.map((task) => visible(ctx, args.companyId, membership, task, "jd", auth)));
      const visibleTasks = page.page.filter((_, index) => visibleFlags[index]);
      const now = Date.now();
      const timeZone = company.timeZone ?? defaultTimeZone;
      const assigneeRows = await enrich(ctx, visibleTasks.flatMap((task) => task.assigneeMembershipIds.filter((id) => scoped.has(id))));
      const assigneeById = new Map(assigneeRows.map((row) => [row.membership._id, row]));
      const states = await Promise.all(visibleTasks.map((task) => jdState(ctx, task, now, timeZone)));
      const rows = visibleTasks.map((task, index) => ({ reference: task.reference, title: task.title, description: task.description ?? null, notes: task.notes ?? null, recurrence: task.recurrence, time: task.time ?? null, quantity: task.quantity ?? null, assigneeEmails: task.assigneeMembershipIds.filter((id) => scoped.has(id)).map((id) => assigneeById.get(id)?.user.email).filter(Boolean).join("; "), status: states[index].status }));
      return { ...page, page: rows };
    }
    const page = await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("asc").paginate(args.paginationOpts);
    const visibleFlags = await Promise.all(page.page.map((task) => visible(ctx, args.companyId, membership, task, "one_time", auth)));
    const visibleTasks = page.page.filter((_, index) => visibleFlags[index]);
    const assigneeRows = await enrich(ctx, visibleTasks.flatMap((task) => task.assigneeMembershipIds.filter((id) => scoped.has(id))));
    const assigneeById = new Map(assigneeRows.map((row) => [row.membership._id, row]));
    const rows = visibleTasks.map((task) => ({ reference: task.reference, title: task.title, description: task.description ?? null, notes: task.notes ?? null, dueDate: task.dueDate ?? null, priority: task.priority, time: task.time ?? null, quantity: task.quantity ?? null, assigneeEmails: task.assigneeMembershipIds.filter((id) => scoped.has(id)).map((id) => assigneeById.get(id)?.user.email).filter(Boolean).join("; "), status: oneState(task).status }));
    return { ...page, page: rows };
  },
});

export const listOneTimeRows = query({
  args: { companyId: v.id("companies"), search: v.optional(v.string()), priority: v.optional(v.union(v.literal("all"), priorityValidator)), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.any()),
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership);
    const [scoped, preference] = await Promise.all([
      displayScopedMembershipIds(ctx, args.companyId, auth, "tasks:one_time:view:any"),
      getTaskListPreference(ctx, args.companyId, membership._id, "one_time"),
    ]);
    const page = await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").paginate(args.paginationOpts);
    const candidates = page.page.filter((task) =>
      (!args.priority || args.priority === "all" || task.priority === args.priority) && matchesSearch(task, args.search),
    );
    const visibleFlags = await Promise.all(candidates.map((task) => visible(ctx, args.companyId, membership, task, "one_time", auth)));
    const visibleTasks = candidates.filter((_, index) => visibleFlags[index]);

    const includeCustomOrderKeys = preference && preference.orderFormat !== "vector";
    const assigneeRows = await enrich(ctx, visibleTasks.flatMap((task) => task.assigneeMembershipIds.filter((id) => scoped.has(id))));
    const assigneeById = new Map(assigneeRows.map((row) => [row.membership._id, row]));
    const [updates, deletes, orderKeys] = await Promise.all([
      Promise.all(visibleTasks.map((task) => canUpdateTask(ctx, args.companyId, membership, task, "one_time", auth))),
      Promise.all(visibleTasks.map((task) => canDeleteTask(ctx, args.companyId, membership, task, "one_time", auth))),
      includeCustomOrderKeys ? taskListOrderKeyMap(ctx, args.companyId, membership._id, "one_time") : Promise.resolve(null),
    ]);
    const rows = visibleTasks.map((task, index) => ({
      ...task,
      state: oneState(task),
      assignees: task.assigneeMembershipIds.filter((id) => scoped.has(id)).flatMap((id) => assigneeById.get(id) ?? []),
      canUpdate: updates[index],
      canDelete: deletes[index],
      ...(orderKeys?.get(task._id) ? { customOrderKey: orderKeys.get(task._id) } : {}),
    }));
    return { ...page, page: rows };
  },
});

export const getListPreference = query({
  args: {
    companyId: v.id("companies"),
    taskType: taskListTaskTypeValidator,
  },
  returns: taskListPreferenceResultValidator,
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const preference = await getTaskListPreference(ctx, args.companyId, membership._id, args.taskType);
    return taskListPreferenceResult(args.taskType, preference);
  },
});

export const setListSort = mutation({
  args: {
    companyId: v.id("companies"),
    taskType: taskListTaskTypeValidator,
    sort: taskListSortValidator,
    expectedRevision: v.number(),
  },
  returns: taskListPreferenceResultValidator,
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    assertTaskListSort(args.taskType, args.sort);
    const preference = await getTaskListPreference(ctx, args.companyId, membership._id, args.taskType);
    assertExpectedPreferenceRevision(preference, args.expectedRevision);
    const now = Date.now();
    const revision = args.expectedRevision + 1;
    let preferenceId: Id<"taskListPreferences">;

    if (preference) {
      await ctx.db.patch(preference._id, { sort: args.sort, revision, updatedAt: now });
      preferenceId = preference._id;
    } else if (args.taskType === "jd") {
      preferenceId = await ctx.db.insert("taskListPreferences", {
        companyId: args.companyId,
        membershipId: membership._id,
        taskType: "jd",
        sort: args.sort,
        revision,
        updatedAt: now,
      });
    } else {
      preferenceId = await ctx.db.insert("taskListPreferences", {
        companyId: args.companyId,
        membershipId: membership._id,
        taskType: "one_time",
        sort: args.sort,
        revision,
        updatedAt: now,
      });
    }

    const saved = await ctx.db.get(preferenceId);
    if (!saved) throw new ConvexError("Task list preference was not saved.");
    return taskListPreferenceResult(args.taskType, saved);
  },
});

export const saveListOrder = mutation({
  args: {
    companyId: v.id("companies"),
    taskType: taskListTaskTypeValidator,
    orderedIds: v.array(v.string()),
    expectedRevision: v.number(),
  },
  returns: taskListPreferenceResultValidator,
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    assertTaskListOrderInput(args.orderedIds);
    const preference = await getTaskListPreference(ctx, args.companyId, membership._id, args.taskType);
    assertExpectedPreferenceRevision(preference, args.expectedRevision);
    const now = Date.now();
    const revision = args.expectedRevision + 1;
    let preferenceId: Id<"taskListPreferences">;

    if (args.taskType === "jd") {
      const customOrder = await validateTaskListOrder(ctx, args.companyId, membership, "jd", args.orderedIds);
      if (preference) {
        await ctx.db.patch(preference._id, { sort: { mode: "custom" }, customOrder, orderFormat: "vector", revision, updatedAt: now });
        preferenceId = preference._id;
      } else {
        preferenceId = await ctx.db.insert("taskListPreferences", {
          companyId: args.companyId,
          membershipId: membership._id,
          taskType: "jd",
          sort: { mode: "custom" },
          customOrder,
          orderFormat: "vector",
          revision,
          updatedAt: now,
        });
      }
    } else {
      const customOrder = await validateTaskListOrder(ctx, args.companyId, membership, "one_time", args.orderedIds);
      if (preference) {
        await ctx.db.patch(preference._id, { sort: { mode: "custom" }, customOrder, orderFormat: "vector", revision, updatedAt: now });
        preferenceId = preference._id;
      } else {
        preferenceId = await ctx.db.insert("taskListPreferences", {
          companyId: args.companyId,
          membershipId: membership._id,
          taskType: "one_time",
          sort: { mode: "custom" },
          customOrder,
          orderFormat: "vector",
          revision,
          updatedAt: now,
        });
      }
    }

    if (preference && preference.orderFormat !== "vector") {
      await ctx.scheduler.runAfter(0, internal.tasks.cleanupLegacyListOrder, { preferenceId });
    }
    const saved = await ctx.db.get(preferenceId);
    if (!saved) throw new ConvexError("Task list preference was not saved.");
    return taskListPreferenceResult(args.taskType, saved);
  },
});

// Converted preferences no longer read these entries. Keep legacy preferences intact.
export const cleanupLegacyListOrder = internalMutation({
  args: { preferenceId: v.id("taskListPreferences") },
  returns: v.null(),
  handler: async (ctx, { preferenceId }) => {
    const preference = await ctx.db.get(preferenceId);
    if (!preference || preference.orderFormat !== "vector") return null;
    const entries = await ctx.db.query("taskListOrderEntries")
      .withIndex("by_companyId_and_membershipId_and_taskType_and_taskId", (q) =>
        q.eq("companyId", preference.companyId)
          .eq("membershipId", preference.membershipId)
          .eq("taskType", preference.taskType))
      .take(100);
    for (const entry of entries) await ctx.db.delete(entry._id);
    if (entries.length === 100) {
      await ctx.scheduler.runAfter(0, internal.tasks.cleanupLegacyListOrder, { preferenceId });
    }
    return null;
  },
});

export const moveListOrderTask = mutation({
  args: {
    companyId: v.id("companies"),
    taskType: taskListTaskTypeValidator,
    taskId: v.string(),
    orderKey: v.string(),
    rebalancedOrderKeys: v.optional(v.array(v.object({ taskId: v.string(), orderKey: v.string() }))),
    expectedRevision: v.number(),
  },
  returns: taskListPreferenceResultValidator,
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const orderKeyUpdates = args.rebalancedOrderKeys ?? [{ taskId: args.taskId, orderKey: args.orderKey }];
    assertTaskListOrderInput(orderKeyUpdates.map(({ taskId }) => taskId));
    for (const { orderKey } of orderKeyUpdates) assertTaskListOrderKey(orderKey);
    if (!orderKeyUpdates.some(({ taskId, orderKey }) => taskId === args.taskId && orderKey === args.orderKey)) {
      throw new ConvexError("Task list order position is invalid.");
    }
    const preference = await getTaskListPreference(ctx, args.companyId, membership._id, args.taskType);
    if (preference?.orderFormat === "vector") {
      throw new ConvexError("Task ordering has been upgraded. Reload this page before reordering.");
    }
    assertExpectedPreferenceRevision(preference, args.expectedRevision);
    const now = Date.now();
    const revision = args.expectedRevision + 1;
    let preferenceId: Id<"taskListPreferences">;

    await applyTaskListOrderKeyUpdates(ctx, args.companyId, membership, args.taskType, orderKeyUpdates, now);
    if (args.taskType === "jd") {
      if (preference) {
        await ctx.db.patch(preference._id, { sort: { mode: "custom" }, revision, updatedAt: now });
        preferenceId = preference._id;
      } else {
        preferenceId = await ctx.db.insert("taskListPreferences", {
          companyId: args.companyId,
          membershipId: membership._id,
          taskType: "jd",
          sort: { mode: "custom" },
          revision,
          updatedAt: now,
        });
      }
    } else {
      if (preference) {
        await ctx.db.patch(preference._id, { sort: { mode: "custom" }, revision, updatedAt: now });
        preferenceId = preference._id;
      } else {
        preferenceId = await ctx.db.insert("taskListPreferences", {
          companyId: args.companyId,
          membershipId: membership._id,
          taskType: "one_time",
          sort: { mode: "custom" },
          revision,
          updatedAt: now,
        });
      }
    }

    const saved = await ctx.db.get(preferenceId);
    if (!saved) throw new ConvexError("Task list preference was not saved.");
    return taskListPreferenceResult(args.taskType, saved);
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
    const { membership, company } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId || !(await visible(ctx, args.companyId, membership, task, "jd", auth))) throw new ConvexError("Task not found.");
    const [canUpdate, canDelete, scoped] = await Promise.all([
      canUpdateTask(ctx, args.companyId, membership, task, "jd", auth),
      canDeleteTask(ctx, args.companyId, membership, task, "jd", auth),
      displayScopedMembershipIds(ctx, args.companyId, auth, "tasks:jd:view:any"),
    ]);
    return { task: await enrichedJd(ctx, task, company.timeZone ?? defaultTimeZone, canUpdate, canDelete, scoped), canUpdate, canDelete };
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
    // The stamp and cycleStartedAt live on the old recurrence's grid, so the
    // preservation/catch-up checks must use the old recurrence's current cycle.
    const oldCycleStart = currentJdCycle(task.recurrence, now, timeZone).start;
    await preserveJdCompletionStamp(ctx, task, oldCycleStart, timeZone);
    await scheduleMissedJdCycleCatchUp(ctx, task, oldCycleStart, args.recurrence !== task.recurrence ? { recurrence: task.recurrence, cycleStartedAt: task.cycleStartedAt } : undefined);
    const nextCycleStart = args.recurrence !== task.recurrence ? currentJdCycle(args.recurrence, now, timeZone).start : oldCycleStart;
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
    const currentCycleStart = currentJdCycle(task.recurrence, now, timeZone).start;
    await preserveJdCompletionStamp(ctx, task, currentCycleStart, timeZone);
    await scheduleMissedJdCycleCatchUp(ctx, task, currentCycleStart);
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
  await assertCanUpdateTaskStatus(ctx, companyId, membership, task, "jd");
  const now = Date.now();
  const timeZone = await companyTimeZone(ctx, companyId);
  const cycle = currentJdCycle(task.recurrence, now, timeZone);
  // Keep the click small: preserve the stamped cycle and schedule the full
  // historical catch-up instead of reconstructing up to 200 cycles inline.
  await preserveJdCompletionStamp(ctx, task, cycle.start, timeZone);
  await scheduleMissedJdCycleCatchUp(ctx, task, cycle.start);
  const existing = await currentJdCompletion(ctx, taskId, cycle.start);
  const previousStatus: ManualStatus = existing || (task.statusCycleStart === cycle.start && task.status === "completed") ? "completed" : task.statusCycleStart === cycle.start ? task.status : "due";
  if (status === "completed") {
    if (!existing) await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId: taskId, cycleStart: cycle.start, cycleEnd: cycle.end, completedByMembershipId: membership._id, completedAt: now, note: cleanOptionalText(note) });
  } else if (existing) {
    await ctx.db.delete(existing._id);
  }
  await ctx.db.patch(taskId, { status, statusCycleStart: cycle.start, updatedAt: now });
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
    return await ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", args.taskId)).order("desc").take(100);
  },
});

/** Deferred per-task catch-up scheduled by interactive mutations. Idempotent. */
export const catchUpMissedJdCycles = internalMutation({
  args: { taskId: v.id("jdTasks"), schedule: v.optional(v.object({ recurrence: recurrenceValidator, cycleStartedAt: v.number() })) },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    if (args.schedule) {
      // The initiating mutation already replaced the task's recurrence and
      // cycleStartedAt, so the old grid only exists in this snapshot. The
      // legacy completion stamp was preserved synchronously, and the new
      // grid's cycleStartedAt must not move from here.
      const timeZone = await companyTimeZone(ctx, task.companyId);
      const now = Date.now();
      const { cycles, nextActiveAt } = elapsedJdCyclesSince(args.schedule.recurrence, args.schedule.cycleStartedAt, now, 200, timeZone);
      for (const cycle of cycles) {
        const [done, recorded] = await Promise.all([
          currentJdCompletion(ctx, task._id, cycle.start),
          currentJdCycleRecord(ctx, task._id, cycle.start),
        ]);
        if (!done && !recorded) {
          await ctx.db.insert("jdTaskCycleRecords", { companyId: task.companyId, jdTaskId: task._id, cycleStart: cycle.start, cycleEnd: cycle.end, status: "missed", recordedAt: now });
        }
      }
      // The batch cap may leave elapsed old-grid cycles unprocessed; continue
      // from the first unprocessed start so the tail of history is not lost.
      if (cycles.length === 200) {
        await ctx.scheduler.runAfter(0, internal.tasks.catchUpMissedJdCycles, {
          taskId: args.taskId,
          schedule: { recurrence: args.schedule.recurrence, cycleStartedAt: nextActiveAt },
        });
      }
      return null;
    }
    await recordMissedJdCycles(ctx, task);
    return null;
  },
});

export const recordMissedJdCyclesBatch = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const timeZones = new Map<Id<"companies">, Promise<string>>();
    const page = await ctx.db.query("jdTasks").paginate({ numItems: 10, cursor: args.cursor ?? null });
    for (const task of page.page) {
      // Skip the catch-up entirely when no cycle has elapsed for this task:
      // the cron scans every JD task hourly, so the common case must not
      // touch completion/cycle-record reads at all.
      const timeZone = await (timeZones.get(task.companyId) ?? timeZones.set(task.companyId, companyTimeZone(ctx, task.companyId)).get(task.companyId)!);
      if (currentJdCycle(task.recurrence, now, timeZone).start > task.cycleStartedAt) {
        await recordMissedJdCycles(ctx, task, now, timeZone);
      }
    }
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
          .withIndex("by_companyId_and_cycleEnd", (q) => q.eq("companyId", args.companyId!))
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
          .withIndex("by_companyId_and_cycleEnd", (q) => q.eq("companyId", args.companyId!))
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
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership);
    const task = await ctx.db.get(args.taskId);
    if (!task || task.companyId !== args.companyId || !(await visible(ctx, args.companyId, membership, task, "one_time", auth))) throw new ConvexError("Task not found.");
    const [canUpdate, canDelete, scoped] = await Promise.all([
      canUpdateTask(ctx, args.companyId, membership, task, "one_time", auth),
      canDeleteTask(ctx, args.companyId, membership, task, "one_time", auth),
      displayScopedMembershipIds(ctx, args.companyId, auth, "tasks:one_time:view:any"),
    ]);
    return { task: await enrichedOneTime(ctx, task, canUpdate, canDelete, scoped), canUpdate, canDelete };
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
  await assertCanUpdateTaskStatus(ctx, companyId, membership, task, "one_time");
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

const DELETE_RELATED_BATCH = 500;
const DELETE_BULK_TASK_LIMIT = 100;

/**
 * Deletes one batch of a task's related rows per call. Returns true while any
 * table still had rows for the task so the caller can re-schedule itself —
 * related-row volume is unbounded, so the purge must not live in a single
 * transaction. Idempotent: rows are keyed by taskId, so re-runs only pick up
 * what remains.
 */
async function deleteTaskRelatedBatch(ctx: MutationCtx, taskType: TaskKind, taskId: string): Promise<boolean> {
  const loaders: (() => Promise<{ _id: Id<"jdTaskCompletions" | "jdTaskCycleRecords" | "taskComments" | "taskActivityLogs" | "taskAttachments">; storageId?: Id<"_storage"> }[]>)[] = [];
  if (taskType === "jd") {
    const jdTaskId = taskId as Id<"jdTasks">;
    loaders.push(
      () => ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", jdTaskId)).take(DELETE_RELATED_BATCH),
      () => ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", jdTaskId)).take(DELETE_RELATED_BATCH),
    );
  }
  loaders.push(
    () => ctx.db.query("taskComments").withIndex("by_task", (q) => q.eq("taskType", taskType).eq("taskId", taskId)).take(DELETE_RELATED_BATCH),
    () => ctx.db.query("taskActivityLogs").withIndex("by_task", (q) => q.eq("taskType", taskType).eq("taskId", taskId)).take(DELETE_RELATED_BATCH),
    () => ctx.db.query("taskAttachments").withIndex("by_task", (q) => q.eq("taskType", taskType).eq("taskId", taskId)).take(DELETE_RELATED_BATCH),
  );
  for (const load of loaders) {
    const rows = await load();
    if (!rows.length) continue;
    for (const row of rows) {
      if (row.storageId) await ctx.storage.delete(row.storageId);
      await ctx.db.delete(row._id);
    }
    return true;
  }
  return false;
}

/**
 * Continues a task's related-row purge in a fresh transaction after the
 * initiating delete commits. Same pattern as aiChat.deleteSessionMessages.
 */
export const purgeTaskRelatedRows = internalMutation({
  args: { taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string() },
  handler: async (ctx, args) => {
    const more = await deleteTaskRelatedBatch(ctx, args.taskType, args.taskId);
    if (more) await ctx.scheduler.runAfter(0, internal.tasks.purgeTaskRelatedRows, args);
    return null;
  },
});

async function purgeJdTask(ctx: MutationCtx, companyId: Id<"companies">, taskId: Id<"jdTasks">) {
  const { membership, user } = await requireMembership(ctx, companyId);
  const task = await ctx.db.get(taskId);
  if (!task || task.companyId !== companyId) throw new ConvexError("Task not found.");
  await assertCanDeleteTask(ctx, companyId, membership, updateAuthTargets(task), "jd");
  // Deleting the task doc makes its related rows unreachable (all reads go
  // through task visibility); the scheduled purge reclaims them in batches.
  await ctx.db.delete(taskId);
  await ctx.scheduler.runAfter(0, internal.tasks.purgeTaskRelatedRows, { taskType: "jd", taskId });
  const now = Date.now();
  await ctx.db.insert("auditEvents", { companyId, actorUserId: user._id, action: "jd_task.delete", targetType: "jdTask", targetId: taskId, createdAt: now });
}

async function purgeOneTimeTask(ctx: MutationCtx, companyId: Id<"companies">, taskId: Id<"oneTimeTasks">) {
  const { membership, user } = await requireMembership(ctx, companyId);
  const task = await ctx.db.get(taskId);
  if (!task || task.companyId !== companyId) throw new ConvexError("Task not found.");
  await assertCanDeleteTask(ctx, companyId, membership, updateAuthTargets(task), "one_time");
  await ctx.db.delete(taskId);
  await ctx.scheduler.runAfter(0, internal.tasks.purgeTaskRelatedRows, { taskType: "one_time", taskId });
  const now = Date.now();
  await ctx.db.insert("auditEvents", { companyId, actorUserId: user._id, action: "one_time_task.delete", targetType: "oneTimeTask", targetId: taskId, createdAt: now });
}

export const deleteJd = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("jdTasks") },
  handler: async (ctx, args) => { await purgeJdTask(ctx, args.companyId, args.taskId); return null; },
});

export const deleteJdBulk = mutation({
  args: { companyId: v.id("companies"), taskIds: v.array(v.id("jdTasks")) },
  handler: async (ctx, args) => {
    if (args.taskIds.length > DELETE_BULK_TASK_LIMIT) throw new ConvexError(`Select at most ${DELETE_BULK_TASK_LIMIT} tasks to delete at once.`);
    for (const taskId of args.taskIds) await purgeJdTask(ctx, args.companyId, taskId);
    return null;
  },
});

export const deleteOneTime = mutation({
  args: { companyId: v.id("companies"), taskId: v.id("oneTimeTasks") },
  handler: async (ctx, args) => { await purgeOneTimeTask(ctx, args.companyId, args.taskId); return null; },
});

export const deleteOneTimeBulk = mutation({
  args: { companyId: v.id("companies"), taskIds: v.array(v.id("oneTimeTasks")) },
  handler: async (ctx, args) => {
    if (args.taskIds.length > DELETE_BULK_TASK_LIMIT) throw new ConvexError(`Select at most ${DELETE_BULK_TASK_LIMIT} tasks to delete at once.`);
    for (const taskId of args.taskIds) await purgeOneTimeTask(ctx, args.companyId, taskId);
    return null;
  },
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

export const generateAttachmentUploadUrl = mutation({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "tasks:attachment:add");
    const claimId = await ctx.db.insert("taskUploadClaims", { companyId: args.companyId, membershipId: membership._id, createdAt: Date.now() });
    return { url: await ctx.storage.generateUploadUrl(), claimId };
  },
});

export const addAttachment = mutation({
  args: { companyId: v.id("companies"), taskType: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string(), storageId: v.id("_storage"), fileName: v.string(), contentType: v.string(), size: v.number(), claimId: v.optional(v.id("taskUploadClaims")) },
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
    const attachmentId = await ctx.db.insert("taskAttachments", { companyId: args.companyId, taskType: args.taskType, taskId: normalized, storageId: args.storageId, fileName: nonEmpty(args.fileName, "File name"), contentType: metadata.contentType ?? args.contentType, size: metadata.size ?? args.size, createdByMembershipId: membership._id, createdAt: Date.now() });
    // Consume the upload claim so it cannot later "clean up" this blob. A
    // claim bound to a different blob stays for the sweep to reclaim it.
    if (args.claimId) {
      const claim = await ctx.db.get(args.claimId);
      if (claim && claim.companyId === args.companyId && claim.membershipId === membership._id && claim.storageId === args.storageId) await ctx.db.delete(args.claimId);
    }
    return attachmentId;
  },
});

// Binds the blob produced by an upload POST to the claim issued with its URL.
// Binding is what makes the claim a single-use cleanup token: orphan cleanup
// can only ever delete this exact blob.
export const bindUploadClaim = mutation({
  args: { companyId: v.id("companies"), claimId: v.id("taskUploadClaims"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "tasks:attachment:add");
    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.companyId !== args.companyId || claim.membershipId !== membership._id) throw new ConvexError("Upload claim not found.");
    if (claim.storageId) {
      if (claim.storageId !== args.storageId) throw new ConvexError("Upload claim is already bound.");
      return null;
    }
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (!metadata) throw new ConvexError("Uploaded file not found.");
    await ctx.db.patch(args.claimId, { storageId: args.storageId });
    return null;
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

// Abandoned claims (failed uploads, closed tabs) are swept after the upload
// URL's lifetime ends; a claim that survives stays valid for reclaiming the
// caller's own orphan, so expiry must not strand an unreferenced blob.
const TASK_UPLOAD_CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

// Reclaims the bound blob when recording an upload as an attachment failed
// (e.g. the task was deleted mid-upload). The claim both proves the caller
// was issued this upload slot and names the only blob cleanup may delete,
// so a caller can never touch another tenant's pending upload. When the
// upload POST completed but bindUploadClaim never committed, the caller's
// storageId is bound here so the blob is never discarded unidentified.
export const deleteOrphanedUpload = mutation({
  args: { companyId: v.id("companies"), claimId: v.id("taskUploadClaims"), storageId: v.optional(v.id("_storage")) },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "tasks:attachment:add");
    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.companyId !== args.companyId || claim.membershipId !== membership._id) throw new ConvexError("Upload claim not found.");
    if (claim.storageId && args.storageId && claim.storageId !== args.storageId) throw new ConvexError("Upload claim is bound to a different file.");
    const blobId = claim.storageId ?? args.storageId;
    await ctx.db.delete(args.claimId);
    if (!blobId) return null;
    const [referenced, metadata] = await Promise.all([
      ctx.db.query("taskAttachments").withIndex("by_storageId", (q) => q.eq("storageId", blobId)).first(),
      ctx.db.system.get("_storage", blobId),
    ]);
    if (!referenced && metadata) await ctx.storage.delete(blobId);
    return null;
  },
});

// Abandoned claims (failed uploads, closed tabs) are reclaimed once the URL
// they guard could no longer have completed an upload anyway — including the
// bound blob when it was never attached.
export const sweepExpiredTaskUploadClaims = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - TASK_UPLOAD_CLAIM_TTL_MS;
    const page = await ctx.db.query("taskUploadClaims").order("asc").paginate({ numItems: 200, cursor: args.cursor ?? null });
    for (const claim of page.page) {
      // Rows scan in creation order — a fresh claim means the rest are fresh.
      if (claim.createdAt >= cutoff) return null;
      if (claim.storageId) {
        const referenced = await ctx.db
          .query("taskAttachments")
          .withIndex("by_storageId", (q) => q.eq("storageId", claim.storageId!))
          .first();
        if (!referenced) await ctx.storage.delete(claim.storageId);
      }
      await ctx.db.delete(claim._id);
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.tasks.sweepExpiredTaskUploadClaims, { cursor: page.continueCursor });
    return null;
  },
});

export const assignableUsers = query({
  args: {
    companyId: v.id("companies"),
    kind: v.union(v.literal("jd"), v.literal("one_time")),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const caps = await membershipCapabilities(ctx, membership);
    const prefix = args.kind === "jd" ? "tasks:jd" : "tasks:one_time";
    const canCreateOrUpdate = caps.has(`${prefix}:create` as any) || caps.has(`${prefix}:update:any` as any) || caps.has(`${prefix}:update:managed` as any) || caps.has(`${prefix}:update:self` as any);
    if (!canCreateOrUpdate) return { users: [], isTruncated: false };

    const search = args.search?.trim();
    if (search && search.length < ASSIGNABLE_USER_SEARCH_MIN_LENGTH) {
      throw new ConvexError(`Enter at least ${ASSIGNABLE_USER_SEARCH_MIN_LENGTH} characters to search assignees.`);
    }
    if (search && search.length > ASSIGNEE_SEARCH_MAX_LENGTH) throw new ConvexError("Assignee search is too long.");

    if (caps.has(`${prefix}:assign:any` as any)) {
      if (search) {
        const candidates = await takeWithOverflow(
          (limit) => ctx.db
            .query("companyMemberships")
            .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
            .take(limit),
          ASSIGNABLE_USER_SEARCH_SCAN_LIMIT,
        );
        const matches = await filterAssignableUsersBySearch(ctx, args.companyId, candidates.rows, search);
        return await assignableUsersResult(ctx, matches.ids, candidates.isTruncated || matches.isTruncated);
      }

      const initial = await takeWithOverflow(
        (limit) => ctx.db
          .query("companyMemberships")
          .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
          .take(limit),
        ASSIGNABLE_USER_INITIAL_LIMIT,
      );
      return await assignableUsersResult(
        ctx,
        initial.rows.filter((candidate) => candidate.active).map((candidate) => candidate._id),
        initial.isTruncated,
      );
    }

    const canAssignManaged = caps.has(`${prefix}:assign:managed` as any);
    const canAssignSelf = caps.has(`${prefix}:assign:self` as any);
    if (!search) {
      if (canAssignManaged) {
        let isTruncated = false;
        const ids = await getManagedMembershipIds(ctx, args.companyId, membership._id, () => {
          isTruncated = true;
        });
        return await assignableUsersResult(ctx, Array.from(ids), isTruncated);
      }
      if (canAssignSelf) return await assignableUsersResult(ctx, [membership._id], false);
      return { users: [], isTruncated: false };
    }

    if (canAssignManaged) {
      const managedCandidates = await scanManagedMembershipIds(
        ctx,
        args.companyId,
        membership._id,
        ASSIGNABLE_USER_SEARCH_SCAN_LIMIT,
      );
      const candidates = await loadMembershipsById(ctx, managedCandidates.ids);
      const matches = await filterAssignableUsersBySearch(ctx, args.companyId, candidates, search);
      return await assignableUsersResult(ctx, matches.ids, managedCandidates.isTruncated || matches.isTruncated);
    }
    if (canAssignSelf) {
      const matches = await filterAssignableUsersBySearch(ctx, args.companyId, [membership], search);
      return await assignableUsersResult(ctx, matches.ids, matches.isTruncated);
    }
    return { users: [], isTruncated: false };
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


type AiAssignee = { name: string; role: string };

function visibleAssigneeIds(task: Doc<"jdTasks"> | Doc<"oneTimeTasks">, scopedMembershipIds?: Set<Id<"companyMemberships">>) {
  return scopedMembershipIds ? task.assigneeMembershipIds.filter((id) => scopedMembershipIds.has(id)) : task.assigneeMembershipIds;
}

function aiJdRow(task: Doc<"jdTasks">, state: { status: string; dueAt: number | null }, scopedMembershipIds: Set<Id<"companyMemberships">> | undefined, assignees: Map<Id<"companyMemberships">, AiAssignee>) {
  return { kind: "jd" as const, id: task._id, title: task.title, description: task.description, notes: task.notes, status: state.status, dueAt: state.dueAt, recurrence: task.recurrence, quantity: task.quantity, time: task.time, assignees: visibleAssigneeIds(task, scopedMembershipIds).map((id) => assignees.get(id)).filter(Boolean) };
}

function aiOneTimeRow(task: Doc<"oneTimeTasks">, state: { status: string; dueAt: number | null }, scopedMembershipIds: Set<Id<"companyMemberships">> | undefined, assignees: Map<Id<"companyMemberships">, AiAssignee>) {
  return { kind: "one_time" as const, id: task._id, title: task.title, description: task.description, notes: task.notes, status: state.status, dueAt: task.dueDate, priority: task.priority, quantity: task.quantity, time: task.time, assignees: visibleAssigneeIds(task, scopedMembershipIds).map((id) => assignees.get(id)).filter(Boolean) };
}

// Single-task wrapper for the mutation/detail paths — the list path batches
// assignee reads itself, so this only enriches the one task's assignees.
async function aiTaskRow(ctx: Ctx, kind: TaskKind, task: Doc<"jdTasks"> | Doc<"oneTimeTasks">, scopedMembershipIds?: Set<Id<"companyMemberships">>) {
  const assigneeRows = await enrich(ctx, visibleAssigneeIds(task, scopedMembershipIds));
  const assignees = new Map<Id<"companyMemberships">, AiAssignee>(assigneeRows.map((row) => [row.membership._id, { name: row.user.fullName ?? row.user.email, role: row.membership.role }]));
  if (kind === "jd") {
    const jdTask = task as Doc<"jdTasks">;
    return aiJdRow(jdTask, await jdState(ctx, jdTask), scopedMembershipIds, assignees);
  }
  return aiOneTimeRow(task as Doc<"oneTimeTasks">, oneState(task as Doc<"oneTimeTasks">), scopedMembershipIds, assignees);
}

// Source rows scanned per kind before giving up; enough that a sparse status
// or scoped-viewer match usually surfaces instead of silently coming back empty.
const AI_LIST_TASK_SCAN_LIMIT = 400;

export const aiListVisible = query({
  args: { companyId: v.id("companies"), status: v.union(v.literal("all"), v.literal("due"), v.literal("overdue"), v.literal("done")), limit: v.number() },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const auth = await taskVisibilityAuth(ctx, args.companyId, membership);
    const [scopedJd, scopedOneTime] = await Promise.all([
      displayScopedMembershipIds(ctx, args.companyId, auth, "tasks:jd:view:any"),
      displayScopedMembershipIds(ctx, args.companyId, auth, "tasks:one_time:view:any"),
    ]);
    const limit = Math.min(Math.max(Math.floor(args.limit), 1), 30);
    const matches = (status: string) => args.status === "all" || (args.status === "overdue" ? status === "Overdue" : args.status === "done" ? status === "Completed" : status !== "Completed" && status !== "Overdue");
    const now = Date.now();
    const timeZone = await companyTimeZone(ctx, args.companyId);
    // Keep paging source rows until the requested count is filled or the scan
    // budget runs out; `exhausted` reports whether matching rows may remain.
    // Enrichment is deferred: candidates are only visibility- and
    // state-checked here, and assignees load in one batch across all matches
    // so the scan budget also bounds total reads below transaction limits.
    const collect = async (kind: TaskKind, table: "jdTasks" | "oneTimeTasks") => {
      const matched: { task: Doc<"jdTasks"> | Doc<"oneTimeTasks">; state: { status: string; dueAt: number | null } }[] = [];
      let cursor: string | null = null;
      let scanned = 0;
      let exhausted = false;
      while (matched.length < limit && scanned < AI_LIST_TASK_SCAN_LIMIT) {
        const page = await ctx.db.query(table).withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").paginate({ cursor, numItems: Math.min(100, AI_LIST_TASK_SCAN_LIMIT - scanned) });
        scanned += page.page.length;
        const evaluated = await Promise.all(page.page.map(async (task) => {
          if (!(await visible(ctx, args.companyId, membership, task, kind, auth))) return null;
          const state = kind === "jd" ? await jdState(ctx, task as Doc<"jdTasks">, now, timeZone) : oneState(task as Doc<"oneTimeTasks">);
          return matches(state.status) ? { task, state } : null;
        }));
        for (const item of evaluated) if (item && matched.length < limit) matched.push(item);
        if (page.isDone) { exhausted = true; break; }
        cursor = page.continueCursor;
      }
      return { matched, exhausted };
    };
    const [jdScan, oneScan] = await Promise.all([
      collect("jd", "jdTasks"),
      collect("one_time", "oneTimeTasks"),
    ]);
    const merged: { kind: TaskKind; task: Doc<"jdTasks"> | Doc<"oneTimeTasks">; state: { status: string; dueAt: number | null } }[] = [];
    for (let i = 0; i < Math.max(jdScan.matched.length, oneScan.matched.length) && merged.length < limit; i += 1) {
      if (jdScan.matched[i]) merged.push({ kind: "jd", ...jdScan.matched[i] });
      if (oneScan.matched[i] && merged.length < limit) merged.push({ kind: "one_time", ...oneScan.matched[i] });
    }
    const assigneeRows = await enrich(ctx, merged.flatMap((item) => visibleAssigneeIds(item.task, item.kind === "jd" ? scopedJd : scopedOneTime)));
    const assignees = new Map<Id<"companyMemberships">, AiAssignee>(assigneeRows.map((row: any) => [row.membership._id, { name: row.user.fullName ?? row.user.email, role: row.membership.role }]));
    const rows = merged.map((item) =>
      item.kind === "jd"
        ? aiJdRow(item.task as Doc<"jdTasks">, item.state, scopedJd, assignees)
        : aiOneTimeRow(item.task as Doc<"oneTimeTasks">, item.state, scopedOneTime, assignees),
    );
    return { rows, truncated: !jdScan.exhausted || !oneScan.exhausted || jdScan.matched.length + oneScan.matched.length > rows.length };
  },
});

export const aiGetDetail = query({
  args: { companyId: v.id("companies"), kind: v.union(v.literal("jd"), v.literal("one_time")), taskId: v.string() },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const { task } = await getVisibleTask(ctx, args.companyId, membership, args.kind, args.taskId);
    const comments = await ctx.db.query("taskComments").withIndex("by_task", (q) => q.eq("taskType", args.kind).eq("taskId", task._id)).order("desc").take(5);
    const scoped = await scopedMembershipIds(ctx, args.companyId, membership, undefined, args.kind === "jd" ? "tasks:jd:view:any" : "tasks:one_time:view:any");
    const row = args.kind === "jd" ? await aiTaskRow(ctx, "jd", task as Doc<"jdTasks">, scoped) : await aiTaskRow(ctx, "one_time", task as Doc<"oneTimeTasks">, scoped);
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
    return await aiTaskRow(ctx, "one_time", task);
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
    return await aiTaskRow(ctx, "jd", task);
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
      return await aiTaskRow(ctx, "jd", updated);
    }
    await setOneTimeStatus(ctx, args.companyId, normalized as Id<"oneTimeTasks">, "completed");
    const updated = await ctx.db.get(normalized as Id<"oneTimeTasks">);
    if (!updated) throw new ConvexError("Task not found.");
    return await aiTaskRow(ctx, "one_time", updated);
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
