/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

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
    const tasks = await admin.query(api.tasks.listJdRows, { companyId });
    expect(tasks).toHaveLength(1);
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

  test("an employee without create permission cannot preview blank-reference creates", async () => {
    const { t, companyId } = await seed();
    await expect(t.withIdentity(identity("employee")).query(api.taskImports.previewTaskImport, { companyId, kind: "jd", drafts: [draft({ assigneeEmails: ["employee@example.com"], rawAssigneeText: "employee@example.com" })] })).resolves.toMatchObject({ rows: [{ operation: "blocked" }] });
  });

  test("rejects status imports for overdue one-time tasks during preview and commit", async () => {
    const { t, companyId, adminMembershipId } = await seed();
    const admin = t.withIdentity(identity("admin"));
    const pastDueDate = Date.now() - 3600_000;
    const taskId = await admin.mutation(api.tasks.createOneTime, { companyId, title: "Past Task", dueDate: pastDueDate, priority: "medium", assigneeMembershipIds: [adminMembershipId] });
    const task = await admin.query(api.tasks.getOneTime, { companyId, taskId });
    const statusDraft = { ...draft(), rowKey: "One-Time Tasks:2", sourceSheet: "One-Time Tasks", kind: "one_time" as const, reference: task.task.reference, title: "Past Task", recurrence: null, dueDate: pastDueDate, priority: "medium" as const, status: "completed" as const, presentFields: ["reference", "status"] as ("reference" | "status")[], rawAssigneeText: "", assigneeEmails: [] };

    const preview = await admin.query(api.taskImports.previewTaskImport, {
      companyId, kind: "one_time", drafts: [statusDraft],
    });
    expect(preview.rows[0].operation).toBe("blocked");
    expect(preview.rows[0].errors).toContain("Overdue tasks are locked and cannot be changed back.");

    await expect(admin.mutation(api.taskImports.commitTaskImportBatch, {
      companyId, kind: "one_time", importKey: "import-overdue", batchKey: "batch-1", source: "cendro",
      rows: [{ include: true, expectedUpdatedAt: task.task.updatedAt, selectedAssigneeMembershipIds: null, draft: statusDraft }],
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
