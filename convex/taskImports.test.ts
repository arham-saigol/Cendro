/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { currentJdCycle, defaultTimeZone } from "./taskCycles";

const modules = import.meta.glob("./**/*.ts");

function identity(key: string, email = `${key}@example.com`) {
  return { tokenIdentifier: `clerk|${key}`, subject: key, issuer: "https://clerk.test", email, name: key };
}

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const companyId = await ctx.db.insert("companies", { name: "Acme", createdAt: now });
    const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", createdAt: now, updatedAt: now });
    const employeeUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|employee", email: "employee@example.com", firstName: "Employee", createdAt: now, updatedAt: now });
    const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
    const employeeMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: employeeUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
    return { companyId, adminMembershipId, employeeMembershipId };
  });
  return { t, ...ids };
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    rowKey: "JD Tasks:2", sourceSheet: "JD Tasks", sourceRow: 2, source: "cendro" as const, kind: "jd" as const,
    reference: "JD-001", title: "Opening checklist", description: null, notes: null, recurrence: "daily" as const, dueDate: null, priority: null,
    time: null, quantity: null, rawAssigneeText: "admin@example.com", assigneeEmails: ["admin@example.com"], status: null, presentFields: ["reference", "title", "recurrence", "assignees"] as ("reference" | "title" | "recurrence" | "assignees" | "status" | "notes")[],
    warnings: [], ...overrides,
  };
}

describe("task import backend", () => {
  test("previews and commits a create, then returns the receipt on retry", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const preview = await admin.query(api.taskImports.previewTaskImport, { companyId, kind: "jd", drafts: [draft()] });
    expect(preview.rows[0]).toMatchObject({ operation: "create", proposedAssigneeMembershipIds: [adminMembershipId] });
    const args = { companyId, kind: "jd" as const, importKey: "import-1", batchKey: "batch-1", source: "cendro" as const, rows: [{ draft: draft(), include: true, selectedAssigneeMembershipIds: [adminMembershipId] }] };
    const first = await admin.mutation(api.taskImports.commitTaskImportBatch, args);
    const second = await admin.mutation(api.taskImports.commitTaskImportBatch, args);
    expect(first).toMatchObject({ created: 1, updated: 0, taskReferences: ["JD-001"] });
    expect(second).toEqual(first);
    await expect(admin.mutation(api.taskImports.commitTaskImportBatch, {
      ...args,
      rows: [{ ...args.rows[0], draft: draft({ title: "Different task" }) }],
    })).rejects.toThrow(/already used for different rows/);
    const tasks = await admin.query(api.tasks.listJdRows, { companyId, paginationOpts: { numItems: 10, cursor: null } });
    expect(tasks.page).toHaveLength(1);
  });

  test("applies imported JD status to the current cycle after older cycles elapsed", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Daily close", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    const oldCycleStart = currentJdCycle("daily", Date.now() - 3 * 86_400_000, defaultTimeZone).start;
    const expectedUpdatedAt = await t.run(async (ctx) => {
      const updatedAt = Date.now() + 1;
      await ctx.db.patch(taskId, { cycleStartedAt: oldCycleStart, statusCycleStart: oldCycleStart, status: "due", updatedAt });
      return updatedAt;
    });
    const task = await admin.query(api.tasks.getJd, { companyId, taskId });

    await admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId, kind: "jd", importKey: "import-current-cycle", batchKey: "batch-1", source: "cendro",
      rows: [{ include: true, expectedUpdatedAt, selectedAssigneeMembershipIds: null, draft: draft({ reference: task.task.reference, status: "completed", presentFields: ["reference", "status"], rawAssigneeText: "", assigneeEmails: [] }) }],
    });

    const updated = await admin.query(api.tasks.getJd, { companyId, taskId });
    expect(updated.task.state.rawStatus).toBe("completed");
    expect(updated.task.statusCycleStart).toBe(currentJdCycle("daily", Date.now(), defaultTimeZone).start);
  });

  test("status can be imported and blank assignees preserve updates", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Old", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    const task = await admin.query(api.tasks.getJd, { companyId, taskId });
    const result = await admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId, kind: "jd", importKey: "import-2", batchKey: "batch-1", source: "cendro",
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: draft({ rowKey: "JD Tasks:2", reference: task.task.reference, title: "New", status: "completed", presentFields: ["reference", "title", "assignees", "status"] }) }],
    });
    expect(result.updated).toBe(1);
    const updated = await admin.query(api.tasks.getJd, { companyId, taskId });
    expect(updated.task.title).toBe("New");
    expect(updated.task.assigneeMembershipIds).toEqual([adminMembershipId]);
    expect(updated.task.status).toBe("completed");
    const completions = await t.run(async (ctx) => await ctx.db.query("jdTaskCompletions").withIndex("by_task", (q) => q.eq("jdTaskId", taskId)).collect());
    expect(completions).toHaveLength(1);
    const logs = await t.run(async (ctx) => await ctx.db.query("taskActivityLogs").withIndex("by_task", (q) => q.eq("taskType", "jd").eq("taskId", taskId)).collect());
    expect(logs.some((l) => l.event === "status_changed" && l.fromStatus === "due" && l.toStatus === "completed")).toBe(true);
  });

  test("requires the preview version and rejects duplicate update references", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Old", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    const task = await admin.query(api.tasks.getJd, { companyId, taskId });
    const updateDraft = draft({ reference: task.task.reference, title: "New", presentFields: ["reference", "title"] });
    await expect(admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId, kind: "jd", importKey: "import-stale", batchKey: "batch-1", source: "cendro",
      rows: [{ include: true, selectedAssigneeMembershipIds: null, draft: updateDraft }],
    })).rejects.toThrow(/changed since preview/);
    await expect(admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId, kind: "jd", importKey: "import-duplicate", batchKey: "batch-1", source: "cendro",
      rows: [
        { include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: updateDraft },
        { include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: { ...updateDraft, rowKey: "JD Tasks:3" } },
      ],
    })).rejects.toThrow(/duplicate task references/);
  });

  test("updates preserve fields that were absent from the source", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Keep", description: "Keep description", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    const task = await admin.query(api.tasks.getJd, { companyId, taskId });
    await admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId, kind: "jd", importKey: "import-partial", batchKey: "batch-1", source: "cendro",
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: draft({ source: "cendro", reference: task.task.reference, title: "Ignored", description: "Ignored", recurrence: null, presentFields: ["reference"], rawAssigneeText: "", assigneeEmails: [] }) }],
    });
    const updated = await admin.query(api.tasks.getJd, { companyId, taskId });
    expect(updated.task).toMatchObject({ title: "Keep", description: "Keep description", recurrence: "weekly" });
  });

  test("a due-date import does not turn a completed one-time task overdue", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createOneTime, { companyId, title: "Filed", dueDate: Date.now() + 86_400_000, priority: "medium", assigneeMembershipIds: [adminMembershipId] });
    await admin.mutation(api.tasks.completeOneTime, { companyId, taskId });
    const task = await admin.query(api.tasks.getOneTime, { companyId, taskId });
    const oneTimeDraft = { ...draft(), rowKey: "One-Time Tasks:2", sourceSheet: "One-Time Tasks", kind: "one_time" as const, reference: task.task.reference, title: "Filed", recurrence: null, dueDate: Date.now() - 86_400_000, priority: "high" as const, status: "completed" as const, presentFields: ["reference", "dueDate", "priority", "status"] as ("reference" | "dueDate" | "priority" | "status")[], rawAssigneeText: "", assigneeEmails: [] };
    await admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId, kind: "one_time", importKey: "import-completed", batchKey: "batch-1", source: "cendro",
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: oneTimeDraft }],
    });
    const updated = await admin.query(api.tasks.getOneTime, { companyId, taskId });
    expect(updated.task.status).toBe("completed");
    expect(updated.task.overdueAt).toBeUndefined();
    expect(updated.task.state.rawStatus).toBe("completed");
  });

  test("invalid normalized workbook values stay blocked instead of clearing fields", async () => {
    const { t, companyId } = await seed();
    const preview = await t.withIdentity(identity("admin")).query(api.taskImports.previewTaskImport, {
      companyId, kind: "jd", drafts: [draft({ quantity: null, presentFields: ["reference", "title", "recurrence", "quantity", "assignees"], warnings: ["Quantity must be a positive number."] })],
    });
    expect(preview.rows[0]).toMatchObject({ operation: "blocked", errors: ["Quantity must be a positive number."] });
  });

  test("unrecognized status is rejected during preview and validation", async () => {
    const { t, companyId } = await seed();
    const preview = await t.withIdentity(identity("admin")).query(api.taskImports.previewTaskImport, {
      companyId, kind: "jd", drafts: [draft({ status: null, presentFields: ["reference", "title", "recurrence", "assignees", "status"], warnings: ['Status "Typo" is not recognized (use Pending, In Progress, or Completed).'] })],
    });
    expect(preview.rows[0].operation).toBe("blocked");
    expect(preview.rows[0].errors).toContain("Status is not recognized.");
  });

  test("an employee without create permission cannot call preview, commit, or export", async () => {
    const { t, companyId } = await seed();
    const employee = t.withIdentity(identity("employee"));
    await expect(employee.query(api.taskImports.previewTaskImport, { companyId, kind: "jd", drafts: [draft()] })).rejects.toThrow(/You do not have access/);
    await expect(employee.mutation(api.taskImports.commitTaskImportBatch, { companyId, kind: "jd", importKey: "k", batchKey: "b", source: "cendro", rows: [] })).rejects.toThrow();
    await expect(employee.query(api.tasks.exportRows, { companyId, kind: "jd", paginationOpts: { cursor: null, numItems: 50 } })).rejects.toThrow(/You do not have access/);
  });

  test("manager exportRows and imports are scoped to their managed branch", async () => {
    const t = convexTest(schema, modules);
    const { companyId, empAMembershipId, empBMembershipId } = await t.run(async (ctx) => {
      const now = Date.now();
      const companyId = await ctx.db.insert("companies", { name: "Scoped Corp", createdAt: now });
      const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", createdAt: now, updatedAt: now });
      const managerUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|manager", email: "manager@example.com", firstName: "Manager", createdAt: now, updatedAt: now });
      const empAUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|empa", email: "empa@example.com", firstName: "EmpA", createdAt: now, updatedAt: now });
      const empBUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|empb", email: "empb@example.com", firstName: "EmpB", createdAt: now, updatedAt: now });

      const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
      const managerMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: managerUserId, role: "Manager", active: true, createdAt: now, updatedAt: now });
      const empAMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: empAUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
      const empBMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: empBUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });

      const branchA = await ctx.db.insert("branches", { companyId, name: "Branch A", createdAt: now, updatedAt: now });
      const branchB = await ctx.db.insert("branches", { companyId, name: "Branch B", createdAt: now, updatedAt: now });

      await ctx.db.insert("managerBranchScopes", { companyId, managerMembershipId, branchId: branchA, updatedAt: now });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: empAMembershipId, branchId: branchA });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: empBMembershipId, branchId: branchB });

      return { companyId, adminMembershipId, managerMembershipId, empAMembershipId, empBMembershipId };
    });

    const admin = t.withIdentity(identity("admin"));
    const manager = t.withIdentity(identity("manager"));

    // Admin creates 2 JD tasks: one for Branch A employee, one for Branch B employee
    await admin.mutation(api.tasks.createJd, { companyId, title: "Branch A Task", recurrence: "daily", assigneeMembershipIds: [empAMembershipId] });
    await admin.mutation(api.tasks.createJd, { companyId, title: "Branch B Task", recurrence: "daily", assigneeMembershipIds: [empBMembershipId] });

    // Admin export gets all 2 tasks
    const adminExport = await admin.query(api.tasks.exportRows, { companyId, kind: "jd", paginationOpts: { cursor: null, numItems: 50 } });
    expect(adminExport.page).toHaveLength(2);

    // Manager export only gets the task in Branch A (their managed branch)
    const managerExport = await manager.query(api.tasks.exportRows, { companyId, kind: "jd", paginationOpts: { cursor: null, numItems: 50 } });
    expect(managerExport.page).toHaveLength(1);
    expect(managerExport.page[0].title).toBe("Branch A Task");

    // Manager preview with Branch A employee is valid
    const validPreview = await manager.query(api.taskImports.previewTaskImport, {
      companyId, kind: "jd", drafts: [draft({ reference: "JD-003", rawAssigneeText: "empa@example.com", assigneeEmails: ["empa@example.com"] })],
    });
    expect(validPreview.rows[0].operation).toBe("create");
    expect(validPreview.rows[0].proposedAssigneeMembershipIds).toEqual([empAMembershipId]);

    // Manager preview with Branch B employee (outside scope) fails to resolve assignee
    const outOfScopePreview = await manager.query(api.taskImports.previewTaskImport, {
      companyId, kind: "jd", drafts: [draft({ reference: "JD-004", rawAssigneeText: "empb@example.com", assigneeEmails: ["empb@example.com"] })],
    });
    expect(outOfScopePreview.rows[0].operation).toBe("blocked");
    expect(outOfScopePreview.rows[0].errors).toContain('Assignee "empb@example.com" is outside your assignable scope.');
  });

  test("preserves exported overdue status but rejects changing an overdue one-time task", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const pastDueDate = Date.now() - 3600_000;
    const taskId = await admin.mutation(api.tasks.createOneTime, { companyId, title: "Past Task", dueDate: pastDueDate, priority: "medium", assigneeMembershipIds: [adminMembershipId] });
    const task = await admin.query(api.tasks.getOneTime, { companyId, taskId });
    const exportedDraft = { ...draft(), rowKey: "One-Time Tasks:2", sourceSheet: "One-Time Tasks", kind: "one_time" as const, reference: task.task.reference, title: "Past Task", recurrence: null, dueDate: pastDueDate, priority: "medium" as const, status: "due" as const, presentFields: ["reference", "status"] as ("reference" | "status")[], rawAssigneeText: "", assigneeEmails: [] };

    const preview = await admin.query(api.taskImports.previewTaskImport, {
      companyId, kind: "one_time", drafts: [exportedDraft],
    });
    expect(preview.rows[0].operation).toBe("update");
    expect(preview.rows[0].errors).toEqual([]);
    await admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId, kind: "one_time", importKey: "import-overdue-roundtrip", batchKey: "batch-1", source: "cendro",
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: exportedDraft }],
    });

    const unchanged = await admin.query(api.tasks.getOneTime, { companyId, taskId });
    expect(unchanged.task.state.rawStatus).toBe("overdue");
    const changedStatusDraft = { ...exportedDraft, status: "completed" as const };

    await expect(admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId, kind: "one_time", importKey: "import-overdue", batchKey: "batch-1", source: "cendro",
      rows: [{ include: true, expectedUpdatedAt: unchanged.task.updatedAt, selectedAssigneeMembershipIds: null, draft: changedStatusDraft }],
    })).rejects.toThrow(/Overdue tasks are locked/);
  });

  test("records status_changed activity logs for one-time task imports", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const futureDueDate = Date.now() + 86_400_000;
    const taskId = await admin.mutation(api.tasks.createOneTime, { companyId, title: "Future Task", dueDate: futureDueDate, priority: "medium", assigneeMembershipIds: [adminMembershipId] });
    const task = await admin.query(api.tasks.getOneTime, { companyId, taskId });
    const statusDraft = { ...draft(), rowKey: "One-Time Tasks:2", sourceSheet: "One-Time Tasks", kind: "one_time" as const, reference: task.task.reference, title: "Future Task", recurrence: null, dueDate: futureDueDate, priority: "medium" as const, status: "completed" as const, presentFields: ["reference", "status"] as ("reference" | "status")[], rawAssigneeText: "", assigneeEmails: [] };

    await admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId, kind: "one_time", importKey: "import-ot-status", batchKey: "batch-1", source: "cendro",
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: statusDraft }],
    });

    const updated = await admin.query(api.tasks.getOneTime, { companyId, taskId });
    expect(updated.task.status).toBe("completed");
    const logs = await t.run(async (ctx) => await ctx.db.query("taskActivityLogs").withIndex("by_task", (q) => q.eq("taskType", "one_time").eq("taskId", taskId)).collect());
    expect(logs.some((l) => l.event === "status_changed" && l.fromStatus === "due" && l.toStatus === "completed")).toBe(true);
  });

  test("exportRows includes notes and imports preserve notes across create and update", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // 1. Create JD and One-time tasks with notes
    const jdId = await admin.mutation(api.tasks.createJd, { companyId, title: "JD with notes", notes: "Initial JD note", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    await admin.mutation(api.tasks.createOneTime, { companyId, title: "OT with notes", notes: "Initial OT note", priority: "high", dueDate: Date.now() + 86_400_000, assigneeMembershipIds: [adminMembershipId] });

    // 2. Verify exportRows includes notes
    const jdExport = await admin.query(api.tasks.exportRows, { companyId, kind: "jd", paginationOpts: { cursor: null, numItems: 50 } });
    expect(jdExport.page).toContainEqual(expect.objectContaining({ title: "JD with notes", notes: "Initial JD note" }));

    const otExport = await admin.query(api.tasks.exportRows, { companyId, kind: "one_time", paginationOpts: { cursor: null, numItems: 50 } });
    expect(otExport.page).toContainEqual(expect.objectContaining({ title: "OT with notes", notes: "Initial OT note" }));

    // 3. Create task via import with notes
    const importCreateRes = await admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId, kind: "jd", importKey: "import-notes-create", batchKey: "batch-1", source: "cendro",
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [adminMembershipId],
        draft: draft({
          reference: "JD-010",
          title: "Imported JD Task",
          notes: "Created via import",
          presentFields: ["reference", "title", "notes", "recurrence", "assignees"],
        }),
      }],
    });
    expect(importCreateRes.created).toBe(1);
    const createdTasks = await admin.query(api.tasks.listJdRows, { companyId, search: "Imported JD Task", paginationOpts: { numItems: 10, cursor: null } });
    expect(createdTasks.page[0].notes).toBe("Created via import");

    // 4. Update existing task notes via import
    const existingJd = await admin.query(api.tasks.getJd, { companyId, taskId: jdId });
    await admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId, kind: "jd", importKey: "import-notes-update", batchKey: "batch-1", source: "cendro",
      rows: [{
        include: true,
        expectedUpdatedAt: existingJd.task.updatedAt,
        selectedAssigneeMembershipIds: null,
        draft: draft({
          reference: existingJd.task.reference,
          title: existingJd.task.title,
          notes: "Updated JD note via import",
          presentFields: ["reference", "notes"],
          rawAssigneeText: "",
          assigneeEmails: [],
        }),
      }],
    });
    const updatedJd = await admin.query(api.tasks.getJd, { companyId, taskId: jdId });
    expect(updatedJd.task.notes).toBe("Updated JD note via import");
  });

  test("creates new task using imported task code if it does not exist and syncs counter", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // Preview import with non-existent code JD-050
    const preview = await admin.query(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-050", title: "Custom Code Task" })],
    });
    expect(preview.rows[0].operation).toBe("create");
    expect(preview.rows[0].reference).toBe("JD-050");

    // Commit import with non-existent code JD-050
    const commitRes = await admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId,
      kind: "jd",
      importKey: "custom-code-import",
      batchKey: "batch-1",
      source: "cendro",
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [adminMembershipId],
        draft: draft({ reference: "JD-050", title: "Custom Code Task" }),
      }],
    });
    expect(commitRes.created).toBe(1);
    expect(commitRes.taskReferences).toEqual(["JD-050"]);

    // Verify task exists with exact code JD-050
    const tasks = await admin.query(api.tasks.listJdRows, { companyId, paginationOpts: { numItems: 10, cursor: null } });
    expect(tasks.page[0].reference).toBe("JD-050");
    expect(tasks.page[0].title).toBe("Custom Code Task");

    // Verify that subsequent manual task creation via nextReference allocates JD-051, avoiding collision
    const nextManualId = await admin.mutation(api.tasks.createJd, {
      companyId,
      title: "Subsequent Manual Task",
      recurrence: "daily",
      assigneeMembershipIds: [adminMembershipId],
    });
    const nextManual = await admin.query(api.tasks.getJd, { companyId, taskId: nextManualId });
    expect(nextManual.task.reference).toBe("JD-051");
  });

  test("updates existing task when imported task code already exists", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // Create a task
    const taskId = await admin.mutation(api.tasks.createJd, {
      companyId,
      title: "Initial Title",
      recurrence: "daily",
      assigneeMembershipIds: [adminMembershipId],
    });
    const created = await admin.query(api.tasks.getJd, { companyId, taskId });
    expect(created.task.reference).toBe("JD-001");

    // Preview import with existing code JD-001
    const preview = await admin.query(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-001", title: "Updated via Import" })],
    });
    expect(preview.rows[0].operation).toBe("update");
    expect(preview.rows[0].reference).toBe("JD-001");

    // Commit update
    const commitRes = await admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId,
      kind: "jd",
      importKey: "update-existing-code",
      batchKey: "batch-1",
      source: "cendro",
      rows: [{
        include: true,
        expectedUpdatedAt: created.task.updatedAt,
        selectedAssigneeMembershipIds: [adminMembershipId],
        draft: draft({ reference: "JD-001", title: "Updated via Import" }),
      }],
    });
    expect(commitRes.updated).toBe(1);
    expect(commitRes.created).toBe(0);

    const updated = await admin.query(api.tasks.getJd, { companyId, taskId });
    expect(updated.task.title).toBe("Updated via Import");
    expect(updated.task.reference).toBe("JD-001");
  });

  test("validates required task code format and returns clear errors", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // Missing / empty task code
    const missingPreview = await admin.query(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: null, presentFields: ["title", "recurrence", "assignees"] })],
    });
    expect(missingPreview.rows[0].operation).toBe("blocked");
    expect(missingPreview.rows[0].errors).toContain("Task code is required and must match JD-001.");

    // Wrong prefix for JD (e.g. TSK-001)
    const wrongPrefixPreview = await admin.query(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "TSK-001" })],
    });
    expect(wrongPrefixPreview.rows[0].operation).toBe("blocked");
    expect(wrongPrefixPreview.rows[0].errors).toContain("Code must match JD-001.");

    // Wrong prefix for One-Time (e.g. JD-001)
    const oneTimeDraft = {
      ...draft(),
      rowKey: "One-Time Tasks:2",
      sourceSheet: "One-Time Tasks",
      kind: "one_time" as const,
      reference: "JD-001",
      recurrence: null,
      dueDate: Date.now() + 86400000,
      priority: "medium" as const,
      presentFields: ["reference", "title", "dueDate", "priority", "assignees"] as ("reference" | "title" | "dueDate" | "priority" | "assignees")[],
    };
    const wrongOneTimePrefix = await admin.query(api.taskImports.previewTaskImport, {
      companyId,
      kind: "one_time",
      drafts: [oneTimeDraft],
    });
    expect(wrongOneTimePrefix.rows[0].operation).toBe("blocked");
    expect(wrongOneTimePrefix.rows[0].errors).toContain("Code must match TSK-001.");

    // Invalid format (less than 3 digits, or non-numeric)
    const malformedPreview = await admin.query(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-1" })],
    });
    expect(malformedPreview.rows[0].operation).toBe("blocked");
    expect(malformedPreview.rows[0].errors).toContain("Code must match JD-001.");

    // Direct commit with invalid format throws
    await expect(admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId,
      kind: "jd",
      importKey: "invalid-code-commit",
      batchKey: "batch-1",
      source: "cendro",
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [adminMembershipId],
        draft: draft({ reference: "INVALID" }),
      }],
    })).rejects.toThrow(/Code must match JD-001/);
  });

  test("user without create permission cannot create task using new task code", async () => {
    const { t, companyId } = await seed();
    const { employeeMembershipId } = await t.run(async (ctx) => {
      const now = Date.now();
      const empUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|importer", email: "importer@example.com", firstName: "Importer", createdAt: now, updatedAt: now });
      const membershipId = await ctx.db.insert("companyMemberships", { companyId, userId: empUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
      // Grant tasks:jd:import override, but NOT tasks:jd:create
      await ctx.db.insert("permissionOverrides", { companyId, membershipId, capability: "tasks:jd:import", effect: "allow", updatedAt: now });
      return { employeeMembershipId: membershipId };
    });

    const importer = t.withIdentity(identity("importer"));

    // Preview non-existent code JD-999
    const preview = await importer.query(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-999", rawAssigneeText: "importer@example.com", assigneeEmails: ["importer@example.com"] })],
    });
    expect(preview.rows[0].operation).toBe("blocked");
    expect(preview.rows[0].errors).toContain("You do not have permission to create tasks for this task kind.");

    // Commit fails
    await expect(importer.mutation(api.taskImports.commitTaskImportBatch, {
      companyId,
      kind: "jd",
      importKey: "no-create-perm",
      batchKey: "batch-1",
      source: "cendro",
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [employeeMembershipId],
        draft: draft({ reference: "JD-999", rawAssigneeText: "importer@example.com", assigneeEmails: ["importer@example.com"] }),
      }],
    })).rejects.toThrow(/You do not have permission to create tasks for this task kind/);
  });

  test("user cannot update a task outside their permissions or use an existing task code outside their permissions", async () => {
    const t = convexTest(schema, modules);
    const { companyId, managerMembershipId, empAMembershipId, empBMembershipId, jdTaskBId } = await t.run(async (ctx) => {
      const now = Date.now();
      const companyId = await ctx.db.insert("companies", { name: "Branch Corp", createdAt: now });
      const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", createdAt: now, updatedAt: now });
      const managerUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|manager", email: "manager@example.com", firstName: "Manager", createdAt: now, updatedAt: now });
      const empAUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|empa", email: "empa@example.com", firstName: "EmpA", createdAt: now, updatedAt: now });
      const empBUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|empb", email: "empb@example.com", firstName: "EmpB", createdAt: now, updatedAt: now });

      const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
      const managerMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: managerUserId, role: "Manager", active: true, createdAt: now, updatedAt: now });
      const empAMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: empAUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
      const empBMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: empBUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });

      const branchA = await ctx.db.insert("branches", { companyId, name: "Branch A", createdAt: now, updatedAt: now });
      const branchB = await ctx.db.insert("branches", { companyId, name: "Branch B", createdAt: now, updatedAt: now });

      await ctx.db.insert("managerBranchScopes", { companyId, managerMembershipId, branchId: branchA, updatedAt: now });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: empAMembershipId, branchId: branchA });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: empBMembershipId, branchId: branchB });

      // Create a task assigned to Branch B employee
      const jdTaskBId = await ctx.db.insert("jdTasks", {
        companyId,
        reference: "JD-001",
        title: "Branch B Task",
        recurrence: "daily",
        cycleStartedAt: now,
        status: "due",
        statusCycleStart: now,
        assigneeMembershipIds: [empBMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: now,
        updatedAt: now,
      });

      return { companyId, managerMembershipId, empAMembershipId, empBMembershipId, jdTaskBId };
    });

    const manager = t.withIdentity(identity("manager"));

    // Manager (who has create permission, but only update:managed) tries to import code JD-001
    // JD-001 already exists for Branch B (outside manager's managed branch)
    const preview = await manager.query(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-001", title: "Hijack Task", rawAssigneeText: "empa@example.com", assigneeEmails: ["empa@example.com"] })],
    });

    // Operation must be BLOCKED, not create, not update
    expect(preview.rows[0].operation).toBe("blocked");
    expect(preview.rows[0].errors).toContain("Task code belongs to an existing task that you do not have permission to edit.");

    // Commit must fail
    await expect(manager.mutation(api.taskImports.commitTaskImportBatch, {
      companyId,
      kind: "jd",
      importKey: "hijack-attempt",
      batchKey: "batch-1",
      source: "cendro",
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: [empAMembershipId],
        draft: draft({ reference: "JD-001", title: "Hijack Task", rawAssigneeText: "empa@example.com", assigneeEmails: ["empa@example.com"] }),
      }],
    })).rejects.toThrow(/Task code belongs to an existing task that you do not have permission to edit/);

    // Verify task in Branch B is unchanged
    const originalTask = await t.run(async (ctx) => await ctx.db.get(jdTaskBId));
    expect(originalTask?.title).toBe("Branch B Task");
    expect(originalTask?.assigneeMembershipIds).toEqual([empBMembershipId]);
  });

  test("user cannot assign a task to someone outside their assignable scope", async () => {
    const t = convexTest(schema, modules);
    const { companyId, managerMembershipId, empAMembershipId, empBMembershipId } = await t.run(async (ctx) => {
      const now = Date.now();
      const companyId = await ctx.db.insert("companies", { name: "Branch Scope Corp", createdAt: now });
      const managerUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|mgr", email: "mgr@example.com", firstName: "Mgr", createdAt: now, updatedAt: now });
      const empAUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|userA", email: "usera@example.com", firstName: "UserA", createdAt: now, updatedAt: now });
      const empBUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|userB", email: "userb@example.com", firstName: "UserB", createdAt: now, updatedAt: now });

      const managerMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: managerUserId, role: "Manager", active: true, createdAt: now, updatedAt: now });
      const empAMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: empAUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
      const empBMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: empBUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });

      const branchA = await ctx.db.insert("branches", { companyId, name: "Branch A", createdAt: now, updatedAt: now });
      const branchB = await ctx.db.insert("branches", { companyId, name: "Branch B", createdAt: now, updatedAt: now });

      await ctx.db.insert("managerBranchScopes", { companyId, managerMembershipId, branchId: branchA, updatedAt: now });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: empAMembershipId, branchId: branchA });
      await ctx.db.insert("userBranchAssignments", { companyId, membershipId: empBMembershipId, branchId: branchB });

      return { companyId, managerMembershipId, empAMembershipId, empBMembershipId };
    });

    const manager = t.withIdentity(identity("mgr"));

    // Manager assigns to userb (in Branch B, outside scope)
    const preview = await manager.query(api.taskImports.previewTaskImport, {
      companyId,
      kind: "jd",
      drafts: [draft({ reference: "JD-001", rawAssigneeText: "userb@example.com", assigneeEmails: ["userb@example.com"] })],
    });
    expect(preview.rows[0].operation).toBe("blocked");
    expect(preview.rows[0].errors).toContain('Assignee "userb@example.com" is outside your assignable scope.');

    // Direct commit must also fail
    await expect(manager.mutation(api.taskImports.commitTaskImportBatch, {
      companyId,
      kind: "jd",
      importKey: "unassignable-attempt",
      batchKey: "batch-1",
      source: "cendro",
      rows: [{
        include: true,
        selectedAssigneeMembershipIds: null,
        draft: draft({ reference: "JD-001", rawAssigneeText: "userb@example.com", assigneeEmails: ["userb@example.com"] }),
      }],
    })).rejects.toThrow(/Assignee "userb@example.com" is outside your assignable scope/);
  });

  test("exported tasks preserve task codes and re-importing updates the existing tasks without creating duplicates", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));

    // Create 2 tasks
    await admin.mutation(api.tasks.createJd, { companyId, title: "Task 1", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    await admin.mutation(api.tasks.createJd, { companyId, title: "Task 2", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });

    // Export rows
    const exportResult = await admin.query(api.tasks.exportRows, { companyId, kind: "jd", paginationOpts: { cursor: null, numItems: 50 } });
    expect(exportResult.page).toHaveLength(2);
    expect(exportResult.page.map((p) => p.reference)).toEqual(["JD-001", "JD-002"]);

    // Re-import the exported rows with modified titles
    const drafts = exportResult.page.map((row, index) => draft({
      rowKey: `JD Tasks:${index + 2}`,
      reference: row.reference,
      title: `${row.title} (Updated)`,
      recurrence: "recurrence" in row ? row.recurrence : "daily",
      presentFields: ["reference", "title", "recurrence", "assignees"],
    }));

    const preview = await admin.query(api.taskImports.previewTaskImport, { companyId, kind: "jd", drafts });
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0].operation).toBe("update");
    expect(preview.rows[1].operation).toBe("update");

    await admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId,
      kind: "jd",
      importKey: "roundtrip-update",
      batchKey: "batch-1",
      source: "cendro",
      rows: preview.rows.map((r) => ({
        include: true,
        expectedUpdatedAt: r.current?.updatedAt,
        selectedAssigneeMembershipIds: [adminMembershipId],
        draft: r.draft,
      })),
    });

    // Verify still exactly 2 tasks, updated in place
    const tasks = await admin.query(api.tasks.listJdRows, { companyId, paginationOpts: { numItems: 10, cursor: null } });
    expect(tasks.page).toHaveLength(2);
    const titles = tasks.page.map((p) => p.title);
    expect(titles).toContain("Task 1 (Updated)");
    expect(titles).toContain("Task 2 (Updated)");
  });
});
