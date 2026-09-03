import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { membershipCapabilities, requireCapability, requireMembership, scopedMembershipIds } from "./permissions";
import type { Capability } from "../src/lib/permissions";
import { currentJdCycle } from "./taskCycles";
import { recordMissedJdCycles } from "./tasks";
import { nextReference } from "./references";
import { normalizeEmail, nonEmpty } from "./validation";

const kindValidator = v.union(v.literal("jd"), v.literal("one_time"));
const sourceValidator = v.literal("cendro");
const recurrenceValidator = v.union(v.literal("daily"), v.literal("every_other_day"), v.literal("weekly"), v.literal("semimonthly"), v.literal("monthly"), v.literal("quarterly"), v.literal("semiannually"), v.literal("annually"));
const priorityValidator = v.union(v.literal("low"), v.literal("medium"), v.literal("high"));
const statusValidator = v.union(v.literal("due"), v.literal("in_progress"), v.literal("completed"));
const nullableString = v.union(v.string(), v.null());
const nullableNumber = v.union(v.number(), v.null());
const presentFieldValidator = v.union(v.literal("reference"), v.literal("title"), v.literal("description"), v.literal("recurrence"), v.literal("dueDate"), v.literal("priority"), v.literal("time"), v.literal("quantity"), v.literal("assignees"), v.literal("status"));
const draftValidator = v.object({
  rowKey: v.string(),
  sourceSheet: v.string(),
  sourceRow: v.number(),
  source: sourceValidator,
  kind: kindValidator,
  reference: nullableString,
  title: nullableString,
  description: nullableString,
  recurrence: v.union(recurrenceValidator, v.null()),
  dueDate: nullableNumber,
  priority: v.union(priorityValidator, v.null()),
  time: nullableString,
  quantity: nullableNumber,
  rawAssigneeText: v.string(),
  assigneeEmails: v.array(v.string()),
  status: v.union(statusValidator, v.null()),
  presentFields: v.array(presentFieldValidator),
  warnings: v.array(v.string()),
});
const reviewedRowValidator = v.object({
  draft: draftValidator,
  include: v.boolean(),
  expectedUpdatedAt: v.optional(v.number()),
  selectedAssigneeMembershipIds: v.union(v.array(v.id("companyMemberships")), v.null()),
});

const MAX_PREVIEW_ROWS = 500;
const MAX_COMMIT_ROWS = 25;
const MAX_IMPORT_BATCHES = Math.ceil(MAX_PREVIEW_ROWS / MAX_COMMIT_ROWS);

type TaskKind = "jd" | "one_time";
type ImportSource = "cendro";
type Ctx = QueryCtx | MutationCtx;
type Draft = {
  rowKey: string;
  sourceSheet: string;
  sourceRow: number;
  source: ImportSource;
  kind: TaskKind;
  reference: string | null;
  title: string | null;
  description: string | null;
  recurrence: "daily" | "every_other_day" | "weekly" | "semimonthly" | "monthly" | "quarterly" | "semiannually" | "annually" | null;
  dueDate: number | null;
  priority: "low" | "medium" | "high" | null;
  time: string | null;
  quantity: number | null;
  rawAssigneeText: string;
  assigneeEmails: string[];
  status: "due" | "in_progress" | "completed" | null;
  presentFields: string[];
  warnings: string[];
};
type ReviewedRow = { draft: Draft; include: boolean; expectedUpdatedAt?: number; selectedAssigneeMembershipIds: Id<"companyMemberships">[] | null };
type Task = Doc<"jdTasks"> | Doc<"oneTimeTasks">;
type ImportAuth = {
  caps: Set<Capability>;
  canCreate: boolean;
  canUpdate: boolean;
  membership: Doc<"companyMemberships">;
  scoped: Set<Id<"companyMemberships">>;
  assignable: Set<Id<"companyMemberships">>;
  membershipIdsByEmail: Map<string, Id<"companyMemberships">[]>;
};

function prefix(kind: TaskKind) { return kind === "jd" ? "JD" : "TSK"; }
function capabilityPrefix(kind: TaskKind) { return kind === "jd" ? "tasks:jd" : "tasks:one_time"; }
function cleanText(value: string | null) { const text = value?.trim() ?? ""; return text || undefined; }
function normalizedReference(value: string | null) { return value?.trim().toUpperCase() ?? ""; }
function hasField(draft: Draft, field: string) { return draft.presentFields.includes(field); }
function hasAssigneeValue(draft: Draft) { return draft.assigneeEmails.length > 0 || draft.rawAssigneeText.trim().length > 0; }
function fail(message: string): never { throw new ConvexError(message); }

async function fingerprintRows(rows: ReviewedRow[]) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(rows)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseReference(reference: string | null, kind: TaskKind) {
  const normalized = normalizedReference(reference);
  if (!normalized) return { value: null as string | null };
  const valid = kind === "jd"
    ? /^JD-\d{3,}$/.test(normalized)
    : /^(?:TSK|OT)-\d{3,}$/.test(normalized);
  if (!valid) return { value: normalized, error: `Code must match ${prefix(kind)}-001.` };
  return { value: normalized };
}

function validateReference(reference: string | null, kind: TaskKind) {
  const parsed = parseReference(reference, kind);
  if (parsed.error) fail(parsed.error);
  return parsed.value;
}

function capabilitiesForImport(caps: Set<Capability>, kind: TaskKind) {
  const p = capabilityPrefix(kind);
  const canCreate = caps.has(`${p}:create` as Capability);
  const canUpdate = caps.has(`${p}:update:any` as Capability) || caps.has(`${p}:update:managed` as Capability) || caps.has(`${p}:update:self` as Capability);
  return { canCreate, canUpdate };
}

async function buildImportAuth(ctx: Ctx, companyId: Id<"companies">, membership: Doc<"companyMemberships">, kind: TaskKind) {
  const caps = await membershipCapabilities(ctx, membership);
  const p = capabilityPrefix(kind);
  const needsScope = caps.has(`${p}:update:managed` as Capability) || caps.has(`${p}:assign:managed` as Capability);
  const scoped = needsScope ? await scopedMembershipIds(ctx, companyId, membership) : new Set<Id<"companyMemberships">>([membership._id]);
  let assignable: Set<Id<"companyMemberships">>;
  if (caps.has(`${p}:assign:any` as Capability)) {
    const memberships = await ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(500);
    assignable = new Set(memberships.filter((row) => row.active).map((row) => row._id));
  } else if (caps.has(`${p}:assign:managed` as Capability)) assignable = new Set(scoped);
  else if (caps.has(`${p}:assign:self` as Capability)) assignable = new Set([membership._id]);
  else assignable = new Set();

  const membershipIdsByEmail = new Map<string, Id<"companyMemberships">[]>();
  for (const membershipId of assignable) {
    const candidate = await ctx.db.get(membershipId);
    if (!candidate || candidate.companyId !== companyId || !candidate.active) continue;
    const user = await ctx.db.get(candidate.userId);
    if (!user) continue;
    const email = normalizeEmail(user.email);
    membershipIdsByEmail.set(email, [...(membershipIdsByEmail.get(email) ?? []), membershipId]);
  }
  return { ...capabilitiesForImport(caps, kind), caps, membership, scoped, assignable, membershipIdsByEmail } satisfies ImportAuth;
}

async function taskByReference(ctx: Ctx, companyId: Id<"companies">, kind: TaskKind, reference: string) {
  return kind === "jd"
    ? await ctx.db.query("jdTasks").withIndex("by_companyId_and_reference", (q) => q.eq("companyId", companyId).eq("reference", reference)).unique()
    : await ctx.db.query("oneTimeTasks").withIndex("by_companyId_and_reference", (q) => q.eq("companyId", companyId).eq("reference", reference)).unique();
}

function taskCanUpdate(auth: ImportAuth, task: Task, kind: TaskKind) {
  const p = capabilityPrefix(kind);
  if (auth.caps.has(`${p}:update:any` as Capability)) return true;
  const targets = task.assigneeMembershipIds.length ? task.assigneeMembershipIds : [task.createdByMembershipId];
  if (auth.caps.has(`${p}:update:managed` as Capability) && targets.every((id) => auth.scoped.has(id))) return true;
  return auth.caps.has(`${p}:update:self` as Capability) && targets.includes(auth.membership._id);
}

function validateDraftValues(row: Draft, kind: TaskKind) {
  const errors = row.warnings.filter((warning) => /^(Quantity must|Numeric due dates|Ambiguous due date|Due date must|Invalid (spreadsheet )?date|Invalid due date|Formula-like text|Frequency is not|Priority is not|Status ")/.test(warning));
  if (row.kind !== kind) errors.push("Wrong task kind.");
  if (!row.rowKey.trim() || row.rowKey.length > 200 || !row.sourceSheet.trim() || row.sourceSheet.length > 200 || !Number.isInteger(row.sourceRow) || row.sourceRow < 1 || row.sourceRow > 1_000_000) errors.push("Import row source is invalid.");
  if (row.reference !== null && row.reference.length > 200) errors.push("Reference is too long.");
  if (hasField(row, "title") && !row.title?.trim()) errors.push("Task title is required.");
  if (row.title !== null && row.title.length > 500) errors.push("Title is too long.");
  if (row.description !== null && row.description.length > 20_000) errors.push("Description is too long.");
  if (row.time !== null && row.time.length > 200) errors.push("Time is too long.");
  if (row.quantity !== null && (!Number.isFinite(row.quantity) || row.quantity <= 0)) errors.push("Quantity must be a positive number.");
  if (row.presentFields.length > 9 || new Set(row.presentFields).size !== row.presentFields.length) errors.push("Import row contains invalid field markers.");
  if (row.reference !== null && !hasField(row, "reference")) errors.push("Reference was not marked as present in the source.");
  if (row.rawAssigneeText.length > 2_000 || row.assigneeEmails.length > 50 || row.assigneeEmails.some((email) => email.length > 320)) errors.push("Assignee data is too large.");
  if (row.warnings.length > 20 || row.warnings.some((warning) => warning.length > 500)) errors.push("Import warnings are too large.");
  if (hasAssigneeValue(row) && row.assigneeEmails.length === 0) errors.push("Assignee text needs an exact email address or manual selection.");
  if (hasAssigneeValue(row) && !hasField(row, "assignees")) errors.push("Assignee data was not marked as present in the source.");
  if (kind === "jd" && (row.dueDate !== null || hasField(row, "dueDate") || row.priority !== null || hasField(row, "priority"))) errors.push("JD rows contain one-time task fields.");
  if (kind === "one_time" && (row.recurrence !== null || hasField(row, "recurrence"))) errors.push("One-time rows contain a recurrence.");
  if (kind === "jd" && row.recurrence === null && hasField(row, "recurrence")) errors.push("Frequency is required and must be valid.");
  if (kind === "one_time" && row.priority === null && hasField(row, "priority")) errors.push("Priority is required and must be valid.");
  if (hasField(row, "status") && row.status === null) errors.push("Status is not recognized.");
  if (kind === "one_time" && row.dueDate !== null && !Number.isFinite(row.dueDate)) errors.push("Due date is invalid.");
  return errors;
}

function resolveAssignees(auth: ImportAuth, draft: Draft, selected: Id<"companyMemberships">[] | null, existing: Task | null) {
  const hints: string[] = [];
  const autoMatched: Id<"companyMemberships">[] = [];
  for (const email of draft.assigneeEmails) {
    let normalized: string;
    try { normalized = normalizeEmail(email); } catch { hints.push(email); continue; }
    const matches = auth.membershipIdsByEmail.get(normalized) ?? [];
    if (matches.length !== 1) hints.push(email);
    else autoMatched.push(matches[0]);
  }
  const proposed = selected ?? (hasAssigneeValue(draft) ? autoMatched : existing?.assigneeMembershipIds ?? []);
  const unique = Array.from(new Set(proposed));
  const errors: string[] = [];
  if (selected && unique.some((id) => !auth.assignable.has(id))) errors.push("One or more selected assignees are outside your assignable scope.");
  if (selected && unique.length === 0) errors.push("Tasks need at least one assignee.");
  if (!selected && hasAssigneeValue(draft) && hints.length > 0) errors.push("Review unresolved assignee hints before importing.");
  if (!selected && hasAssigneeValue(draft) && unique.length === 0 && !existing) errors.push("New tasks need at least one resolved assignee.");
  return { membershipIds: unique, hints, errors };
}

export const previewTaskImport = query({
  args: { companyId: v.id("companies"), kind: kindValidator, drafts: v.array(draftValidator) },
  handler: async (ctx, args) => {
    if (args.drafts.length > MAX_PREVIEW_ROWS) fail(`Imports may contain at most ${MAX_PREVIEW_ROWS} task rows.`);
    const capability: Capability = args.kind === "jd" ? "tasks:jd:create" : "tasks:one_time:create";
    const { membership } = await requireCapability(ctx, args.companyId, capability);
    const auth = await buildImportAuth(ctx, args.companyId, membership, args.kind);
    const duplicateRefs = new Set<string>();
    const seenRefs = new Set<string>();
    const duplicateRowKeys = new Set<string>();
    const seenRowKeys = new Set<string>();
    for (const draft of args.drafts) {
      const reference = normalizedReference(draft.reference);
      if (reference && seenRefs.has(reference)) duplicateRefs.add(reference);
      if (reference) seenRefs.add(reference);
      if (seenRowKeys.has(draft.rowKey)) duplicateRowKeys.add(draft.rowKey);
      seenRowKeys.add(draft.rowKey);
    }
    const rows = [];
    for (const draft of args.drafts) {
      const errors = [...validateDraftValues(draft, args.kind)];
      const warnings = [...draft.warnings];
      let operation: "create" | "update" | "blocked" = "blocked";
      let task: Task | null = null;
      const referenceParsed = parseReference(draft.reference, args.kind);
      const reference = referenceParsed.value;
      if (referenceParsed.error) errors.push(referenceParsed.error);
      if (reference && duplicateRefs.has(reference)) errors.push("Duplicate reference in workbook.");
      if (duplicateRowKeys.has(draft.rowKey)) errors.push("Duplicate source row in workbook.");
      if (reference) {
        const candidateTask = await taskByReference(ctx, args.companyId, args.kind, reference);
        if (!candidateTask || !taskCanUpdate(auth, candidateTask, args.kind)) errors.push("Reference is unavailable or not updatable.");
        else {
          task = candidateTask;
          operation = "update";
          if (args.kind === "one_time") {
            const oneTime = task as Doc<"oneTimeTasks">;
            const isOverdue = Boolean(oneTime.overdueAt) || Boolean(oneTime.dueDate && oneTime.status !== "completed" && oneTime.dueDate < Date.now());
            if (isOverdue && hasField(draft, "status") && draft.status !== "due") errors.push("Overdue tasks are locked and cannot be changed back.");
          }
        }
      } else if (auth.canCreate) operation = "create";
      else errors.push("You do not have create permission for this task kind.");
      const assignees = resolveAssignees(auth, draft, null, task);
      errors.push(...assignees.errors);
      if (operation === "create" && assignees.membershipIds.length === 0) errors.push("New tasks need at least one assignee.");
      if (hasAssigneeValue(draft) && assignees.hints.length > 0) warnings.push(`Unresolved assignee hints: ${assignees.hints.join(", ")}`);
      if (operation === "create" && !draft.title?.trim()) errors.push("Title is required for new tasks.");
      if (operation === "create" && args.kind === "jd" && !draft.recurrence) errors.push("Frequency is required for new JD tasks.");
      if (operation === "create" && args.kind === "one_time" && !draft.priority) errors.push("Priority is required for new one-time tasks.");
      if (args.kind === "jd" && task && draft.recurrence && draft.recurrence !== (task as Doc<"jdTasks">).recurrence) warnings.push("Changing recurrence resets the active JD cycle and status.");
      if (args.kind === "one_time" && draft.dueDate !== null && draft.dueDate < Date.now() && (!task || task.status !== "completed")) warnings.push("This task will be overdue immediately.");
      rows.push({ rowKey: draft.rowKey, sourceSheet: draft.sourceSheet, sourceRow: draft.sourceRow, operation: errors.length > 0 ? "blocked" : operation, reference: reference ?? null, draft, current: task ? editableSnapshot(task, args.kind) : null, proposedAssigneeMembershipIds: assignees.membershipIds, unresolvedAssigneeHints: assignees.hints, errors, warnings, include: errors.length === 0 });
    }
    return { rows, canCreate: auth.canCreate, canUpdate: auth.canUpdate };
  },
});

function editableSnapshot(task: Task, kind: TaskKind) {
  return kind === "jd"
    ? { reference: task.reference, title: task.title, description: task.description ?? null, recurrence: (task as Doc<"jdTasks">).recurrence, time: task.time ?? null, quantity: task.quantity ?? null, assigneeMembershipIds: task.assigneeMembershipIds, updatedAt: task.updatedAt }
    : { reference: task.reference, title: task.title, description: task.description ?? null, dueDate: (task as Doc<"oneTimeTasks">).dueDate ?? null, priority: (task as Doc<"oneTimeTasks">).priority, time: task.time ?? null, quantity: task.quantity ?? null, assigneeMembershipIds: task.assigneeMembershipIds, updatedAt: task.updatedAt };
}

async function validateCommitRow(ctx: MutationCtx, companyId: Id<"companies">, kind: TaskKind, auth: ImportAuth, row: ReviewedRow) {
  const draft = row.draft;
  const reference = validateReference(draft.reference, kind);
  const task = reference ? await taskByReference(ctx, companyId, kind, reference) : null;
  if (reference && (!task || !taskCanUpdate(auth, task, kind))) fail("One or more import rows became unavailable. Re-preview and try again.");
  if (task && (row.expectedUpdatedAt === undefined || task.updatedAt !== row.expectedUpdatedAt)) fail("One or more import rows changed since preview. Re-preview and try again.");
  if (!reference && !auth.canCreate) fail("Create permission changed. Re-preview and try again.");
  const errors = validateDraftValues(draft, kind);
  if (errors.length) fail(errors[0]);
  if (kind === "one_time" && task && hasField(draft, "status") && draft.status !== "due") {
    const oneTime = task as Doc<"oneTimeTasks">;
    const isOverdue = Boolean(oneTime.overdueAt) || Boolean(oneTime.dueDate && oneTime.status !== "completed" && oneTime.dueDate < Date.now());
    if (isOverdue) fail("Overdue tasks are locked and cannot be changed back.");
  }
  const resolved = resolveAssignees(auth, draft, row.selectedAssigneeMembershipIds, task);
  if (resolved.errors.length) fail(resolved.errors[0]);
  if (!task && !draft.title?.trim()) fail("New tasks need a title.");
  if (!task && kind === "jd" && !draft.recurrence) fail("New JD tasks need a frequency.");
  if (!task && kind === "one_time" && !draft.priority) fail("New one-time tasks need a priority.");
  if (!task && resolved.membershipIds.length === 0) fail("New tasks need an assignee.");
  const assigneePatchRequested = row.selectedAssigneeMembershipIds !== null || hasAssigneeValue(draft);
  if (assigneePatchRequested && resolved.membershipIds.length === 0) fail("Tasks need at least one assignee.");
  return { draft, task, assigneeMembershipIds: resolved.membershipIds, assigneePatchRequested };
}

export const commitTaskImportBatch = mutation({
  args: { companyId: v.id("companies"), kind: kindValidator, importKey: v.string(), batchKey: v.string(), source: sourceValidator, rows: v.array(reviewedRowValidator) },
  handler: async (ctx, args) => {
    if (args.rows.length === 0 || args.rows.length > MAX_COMMIT_ROWS) fail(`Import batches must contain 1-${MAX_COMMIT_ROWS} rows.`);
    if (!args.importKey.trim() || !args.batchKey.trim() || args.importKey.length > 200 || args.batchKey.length > 200) fail("Import keys are invalid.");
    const capability: Capability = args.kind === "jd" ? "tasks:jd:create" : "tasks:one_time:create";
    const { membership, user, company } = await requireCapability(ctx, args.companyId, capability);
    const requestFingerprint = await fingerprintRows(args.rows);
    const existingReceipt = await ctx.db.query("taskImportBatches").withIndex("by_companyId_and_importKey_and_batchKey", (q) => q.eq("companyId", args.companyId).eq("importKey", args.importKey).eq("batchKey", args.batchKey)).unique();
    if (existingReceipt) {
      if (existingReceipt.actorMembershipId !== membership._id || existingReceipt.kind !== args.kind || existingReceipt.source !== args.source) fail("Import receipt is not available.");
      if (existingReceipt.requestFingerprint !== requestFingerprint) fail("Import batch key was already used for different rows. Re-preview and try again.");
      return existingReceipt.result;
    }
    if (args.rows.some((row) => row.draft.source !== args.source || row.draft.kind !== args.kind)) fail("Import source or task kind changed. Re-preview and try again.");
    const includedRows = args.rows.filter((row) => row.include);
    if (includedRows.length === 0) fail("Import batches need at least one included row.");
    const rowKeys = includedRows.map((row) => row.draft.rowKey);
    if (new Set(rowKeys).size !== rowKeys.length) fail("Import batch contains duplicate source rows.");
    const references = includedRows.map((row) => validateReference(row.draft.reference, args.kind)).filter((reference): reference is string => reference !== null);
    if (new Set(references).size !== references.length) fail("Import batch contains duplicate task references.");
    const priorReceipts = await ctx.db.query("taskImportBatches").withIndex("by_companyId_and_importKey", (q) => q.eq("companyId", args.companyId).eq("importKey", args.importKey)).take(MAX_IMPORT_BATCHES + 1);
    if (priorReceipts.length > MAX_IMPORT_BATCHES || priorReceipts.some((receipt) => receipt.actorMembershipId !== membership._id || receipt.kind !== args.kind || receipt.source !== args.source)) fail("Import key is not available.");
    const priorReferences = new Set(priorReceipts.flatMap((receipt) => receipt.result.taskReferences));
    if (references.some((reference) => priorReferences.has(reference))) fail("Import contains a task reference that was already committed.");

    const auth = await buildImportAuth(ctx, args.companyId, membership, args.kind);
    const prepared = [];
    for (const row of includedRows) prepared.push(await validateCommitRow(ctx, args.companyId, args.kind, auth, row));
    let created = 0;
    let updated = 0;
    const taskReferences: string[] = [];
    for (const item of prepared) {
      const now = Date.now();
      if (item.task) {
        if (args.kind === "jd") {
          const task = item.task as Doc<"jdTasks">;
          const recurrence = hasField(item.draft, "recurrence") && item.draft.recurrence ? item.draft.recurrence : task.recurrence;
          const currentCycle = currentJdCycle(recurrence, now, company.timeZone);
          const nextCycleStart = recurrence !== task.recurrence ? currentCycle.start : undefined;
          await recordMissedJdCycles(ctx, task, now, company.timeZone);
          const rolled = await ctx.db.get(task._id);
          if (!rolled) fail("One or more import rows became unavailable. Re-preview and try again.");
          const activeCycleStart = nextCycleStart ?? currentCycle.start;
          const previousDone = await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", task._id).eq("cycleStart", activeCycleStart)).unique();
          const previousStatus = previousDone || (rolled.statusCycleStart === activeCycleStart && rolled.status === "completed") ? "completed" : rolled.statusCycleStart === activeCycleStart ? rolled.status : "due";
          const targetStatus = hasField(item.draft, "status") && item.draft.status ? item.draft.status : undefined;
          if (targetStatus) {
            const currentDone = previousDone;
            if (targetStatus === "completed" && !currentDone) {
              await ctx.db.insert("jdTaskCompletions", { companyId: args.companyId, jdTaskId: task._id, cycleStart: activeCycleStart, completedByMembershipId: membership._id, completedAt: now });
            } else if (targetStatus !== "completed" && currentDone) {
              await ctx.db.delete(currentDone._id);
            }
          }
          const nextTask = { ...rolled };
          if (hasField(item.draft, "title")) nextTask.title = nonEmpty(item.draft.title ?? "", "Task title");
          if (hasField(item.draft, "description")) {
            const desc = cleanText(item.draft.description);
            if (desc === undefined) delete nextTask.description;
            else nextTask.description = desc;
          }
          if (hasField(item.draft, "time")) {
            const t = cleanText(item.draft.time);
            if (t === undefined) delete nextTask.time;
            else nextTask.time = t;
          }
          if (hasField(item.draft, "quantity")) {
            if (item.draft.quantity === null || item.draft.quantity === undefined) delete nextTask.quantity;
            else nextTask.quantity = item.draft.quantity;
          }
          if (hasField(item.draft, "recurrence") && item.draft.recurrence) nextTask.recurrence = item.draft.recurrence;
          if (item.assigneePatchRequested) nextTask.assigneeMembershipIds = item.assigneeMembershipIds;
          if (targetStatus) {
            nextTask.status = targetStatus;
            nextTask.statusCycleStart = activeCycleStart;
          }
          if (nextCycleStart !== undefined) {
            nextTask.cycleStartedAt = nextCycleStart;
            if (!targetStatus) {
              nextTask.status = "due";
              nextTask.statusCycleStart = nextCycleStart;
            }
          }
          nextTask.updatedAt = now;
          await ctx.db.replace(task._id, nextTask);
          if (previousStatus !== nextTask.status) {
            await ctx.db.insert("taskActivityLogs", { companyId: args.companyId, taskType: "jd", taskId: task._id, actorMembershipId: membership._id, event: "status_changed", fromStatus: previousStatus, toStatus: nextTask.status, createdAt: now });
          }
        } else {
          const task = item.task as Doc<"oneTimeTasks">;
          const wasOverdue = Boolean(task.overdueAt) || Boolean(task.dueDate && task.status !== "completed" && task.dueDate < now);
          const targetStatus = hasField(item.draft, "status") && item.draft.status && !wasOverdue ? item.draft.status : undefined;
          const previousStatus = task.status;
          const nextTask = { ...task };
          if (hasField(item.draft, "title")) nextTask.title = nonEmpty(item.draft.title ?? "", "Task title");
          if (hasField(item.draft, "description")) {
            const desc = cleanText(item.draft.description);
            if (desc === undefined) delete nextTask.description;
            else nextTask.description = desc;
          }
          if (hasField(item.draft, "dueDate")) {
            if (item.draft.dueDate === null || item.draft.dueDate === undefined) delete nextTask.dueDate;
            else nextTask.dueDate = item.draft.dueDate;
          }
          if (hasField(item.draft, "priority") && item.draft.priority) nextTask.priority = item.draft.priority;
          if (hasField(item.draft, "time")) {
            const t = cleanText(item.draft.time);
            if (t === undefined) delete nextTask.time;
            else nextTask.time = t;
          }
          if (hasField(item.draft, "quantity")) {
            if (item.draft.quantity === null || item.draft.quantity === undefined) delete nextTask.quantity;
            else nextTask.quantity = item.draft.quantity;
          }
          if (item.assigneePatchRequested) nextTask.assigneeMembershipIds = item.assigneeMembershipIds;
          if (targetStatus) {
            nextTask.status = targetStatus;
            if (targetStatus === "completed") {
              nextTask.completedAt = task.completedAt ?? now;
              nextTask.completedByMembershipId = task.completedByMembershipId ?? membership._id;
            } else {
              delete nextTask.completedAt;
              delete nextTask.completedByMembershipId;
            }
          }
          if (wasOverdue) nextTask.overdueAt = task.overdueAt ?? now;
          nextTask.updatedAt = now;
          await ctx.db.replace(task._id, nextTask);
          if (targetStatus && previousStatus !== targetStatus) {
            await ctx.db.insert("taskActivityLogs", { companyId: args.companyId, taskType: "one_time", taskId: task._id, actorMembershipId: membership._id, event: "status_changed", fromStatus: previousStatus, toStatus: targetStatus, createdAt: now });
          }
        }
        updated += 1;
        taskReferences.push(item.task.reference);
      } else {
        const reference = await nextReference(ctx, args.companyId, args.kind);
        if (args.kind === "jd") {
          const cycle = currentJdCycle(item.draft.recurrence!, now, company.timeZone);
          const initialStatus = hasField(item.draft, "status") && item.draft.status ? item.draft.status : "due";
          const id = await ctx.db.insert("jdTasks", { companyId: args.companyId, reference, title: nonEmpty(item.draft.title ?? "", "Task title"), description: cleanText(item.draft.description), time: cleanText(item.draft.time), quantity: item.draft.quantity ?? undefined, recurrence: item.draft.recurrence!, cycleStartedAt: now, status: initialStatus, statusCycleStart: cycle.start, assigneeMembershipIds: item.assigneeMembershipIds, createdByMembershipId: membership._id, createdAt: now, updatedAt: now });
          if (initialStatus === "completed") {
            await ctx.db.insert("jdTaskCompletions", { companyId: args.companyId, jdTaskId: id, cycleStart: cycle.start, completedByMembershipId: membership._id, completedAt: now });
          }
          await ctx.db.insert("taskActivityLogs", { companyId: args.companyId, taskType: "jd", taskId: id, actorMembershipId: membership._id, event: "created", createdAt: now });
        } else {
          const initialStatus = hasField(item.draft, "status") && item.draft.status ? item.draft.status : "due";
          const id = await ctx.db.insert("oneTimeTasks", { companyId: args.companyId, reference, title: nonEmpty(item.draft.title ?? "", "Task title"), description: cleanText(item.draft.description), dueDate: item.draft.dueDate ?? undefined, time: cleanText(item.draft.time), quantity: item.draft.quantity ?? undefined, assigneeMembershipIds: item.assigneeMembershipIds, createdByMembershipId: membership._id, priority: item.draft.priority!, status: initialStatus, completedAt: initialStatus === "completed" ? now : undefined, completedByMembershipId: initialStatus === "completed" ? membership._id : undefined, createdAt: now, updatedAt: now });
          await ctx.db.insert("taskActivityLogs", { companyId: args.companyId, taskType: "one_time", taskId: id, actorMembershipId: membership._id, event: "created", createdAt: now });
        }
        created += 1;
        taskReferences.push(reference);
      }
    }
    const result = { created, updated, skipped: args.rows.length - includedRows.length, failed: 0, taskReferences };
    await ctx.db.insert("taskImportBatches", { companyId: args.companyId, actorMembershipId: membership._id, kind: args.kind, importKey: args.importKey, batchKey: args.batchKey, source: args.source, requestFingerprint, result, createdAt: Date.now() });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "task_import.batch", targetType: "taskImportBatch", metadata: { importKey: args.importKey, source: args.source, kind: args.kind, createCount: created, updateCount: updated, taskReferences }, createdAt: Date.now() });
    return result;
  },
});
