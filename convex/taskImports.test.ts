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
    reference: null, title: "Opening checklist", description: null, recurrence: "daily" as const, dueDate: null, priority: null,
    time: null, quantity: null, rawAssigneeText: "admin@example.com", assigneeEmails: ["admin@example.com"], status: null, presentFields: ["title", "recurrence", "assignees"] as ("title" | "recurrence" | "assignees" | "status")[],
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
    expect(first).toMatchObject({ created: 1, updated: 0, taskReferences: ["JD-0001"] });
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
      companyId, kind: "jd", drafts: [draft({ quantity: null, presentFields: ["title", "recurrence", "quantity", "assignees"], warnings: ["Quantity must be a positive number."] })],
    });
    expect(preview.rows[0]).toMatchObject({ operation: "blocked", errors: ["Quantity must be a positive number."] });
  });

  test("unrecognized status is rejected during preview and validation", async () => {
    const { t, companyId } = await seed();
    const preview = await t.withIdentity(identity("admin")).query(api.taskImports.previewTaskImport, {
      companyId, kind: "jd", drafts: [draft({ status: null, presentFields: ["title", "recurrence", "assignees", "status"], warnings: ['Status "Typo" is not recognized (use Pending, In Progress, or Completed).'] })],
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
    const { companyId, managerMembershipId, empAMembershipId, empBMembershipId } = await t.run(async (ctx) => {
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
      companyId, kind: "jd", drafts: [draft({ rawAssigneeText: "empa@example.com", assigneeEmails: ["empa@example.com"] })],
    });
    expect(validPreview.rows[0].operation).toBe("create");
    expect(validPreview.rows[0].proposedAssigneeMembershipIds).toEqual([empAMembershipId]);

    // Manager preview with Branch B employee (outside scope) fails to resolve assignee
    const outOfScopePreview = await manager.query(api.taskImports.previewTaskImport, {
      companyId, kind: "jd", drafts: [draft({ rawAssigneeText: "empb@example.com", assigneeEmails: ["empb@example.com"] })],
    });
    expect(outOfScopePreview.rows[0].operation).toBe("blocked");
    expect(outOfScopePreview.rows[0].errors).toContain("New tasks need at least one resolved assignee.");
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
});
