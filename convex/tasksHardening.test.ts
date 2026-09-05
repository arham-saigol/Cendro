/// <reference types="vite/client" />

import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { createAuthzFixture } from "./authz.fixture";

describe("task authorization hardening", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("Employee cannot delete assigned JD or one-time task", async () => {
    const f = await createAuthzFixture();

    // Admin creates JD task assigned to employee 1
    const jdTaskId = await f.asUser("adminA").mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Clean Kitchen",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M],
    });

    // Admin creates One-time task assigned to employee 1
    const oneTimeTaskId = await f.asUser("adminA").mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "File taxes",
      priority: "medium",
      dueDate: Date.now() + 86_400_000,
      assigneeMembershipIds: [f.employee1M],
    });

    // Employee 1 can update note
    await expect(
      f.asUser("employeeA1").mutation(api.tasks.updateJdFields, {
        companyId: f.companyA,
        taskId: jdTaskId,
        notes: "Started cleaning",
      })
    ).resolves.toBeNull();

    // Employee 1 CANNOT delete JD task
    await expect(
      f.asUser("employeeA1").mutation(api.tasks.deleteJd, {
        companyId: f.companyA,
        taskId: jdTaskId,
      })
    ).rejects.toThrow("You do not have access to delete this task.");

    // Employee 1 CANNOT delete one-time task
    await expect(
      f.asUser("employeeA1").mutation(api.tasks.deleteOneTime, {
        companyId: f.companyA,
        taskId: oneTimeTaskId,
      })
    ).rejects.toThrow("You do not have access to delete this task.");
  });

  test("Attachment cannot be claimed twice or across companies", async () => {
    const f = await createAuthzFixture();

    const jdTaskId = await f.asUser("adminA").mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Daily Audit",
      recurrence: "daily",
      assigneeMembershipIds: [f.adminM],
    });

    const jdTaskBId = await f.asUser("adminB").mutation(api.tasks.createJd, {
      companyId: f.companyB,
      title: "Company B Task",
      recurrence: "daily",
      assigneeMembershipIds: [f.adminBM],
    });

    // Generate a mock storage ID by storing a blob in Convex storage
    const storageId = await f.t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["test-attachment-content"], { type: "text/plain" }));
    });

    // Company A attaches the file
    await expect(
      f.asUser("adminA").mutation(api.tasks.addAttachment, {
        companyId: f.companyA,
        taskType: "jd",
        taskId: jdTaskId,
        storageId,
        fileName: "audit.txt",
        contentType: "text/plain",
        size: 23,
      })
    ).resolves.toBeDefined();

    // Company A attaching the SAME storageId again -> rejected!
    await expect(
      f.asUser("adminA").mutation(api.tasks.addAttachment, {
        companyId: f.companyA,
        taskType: "jd",
        taskId: jdTaskId,
        storageId,
        fileName: "duplicate.txt",
        contentType: "text/plain",
        size: 23,
      })
    ).rejects.toThrow("This file is already attached.");

    // Company B trying to attach the SAME storageId -> rejected!
    await expect(
      f.asUser("adminB").mutation(api.tasks.addAttachment, {
        companyId: f.companyB,
        taskType: "jd",
        taskId: jdTaskBId,
        storageId,
        fileName: "cross-company-stolen.txt",
        contentType: "text/plain",
        size: 23,
      })
    ).rejects.toThrow("This file is already attached.");
  });

  test("Attachment deletion distinguishes own attachment from moderation", async () => {
    const f = await createAuthzFixture();

    const taskId = await f.asUser("adminA").mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Task with attachments",
      priority: "low",
      assigneeMembershipIds: [f.employee1M],
    });

    const storageId1 = await f.t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["emp1-file"], { type: "text/plain" }));
    });
    const storageId2 = await f.t.run(async (ctx) => {
      return await ctx.storage.store(new Blob(["admin-file"], { type: "text/plain" }));
    });

    // Employee 1 adds an attachment
    const emp1AttachmentId = await f.asUser("employeeA1").mutation(api.tasks.addAttachment, {
      companyId: f.companyA,
      taskType: "one_time",
      taskId,
      storageId: storageId1,
      fileName: "emp1.txt",
      contentType: "text/plain",
      size: 9,
    });

    // Admin adds an attachment
    const adminAttachmentId = await f.asUser("adminA").mutation(api.tasks.addAttachment, {
      companyId: f.companyA,
      taskType: "one_time",
      taskId,
      storageId: storageId2,
      fileName: "admin.txt",
      contentType: "text/plain",
      size: 10,
    });

    // Employee 1 CANNOT delete their OWN attachment by default (disabled for Employee by default)
    await expect(
      f.asUser("employeeA1").mutation(api.tasks.deleteAttachment, {
        companyId: f.companyA,
        attachmentId: emp1AttachmentId,
      })
    ).rejects.toThrow("You do not have access to delete this attachment.");

    // With explicit allow override for tasks:attachment:delete:own, Employee 1 can delete their own attachment
    await f.t.run(async (ctx) => {
      await ctx.db.insert("permissionOverrides", {
        companyId: f.companyA,
        membershipId: f.employee1M,
        capability: "tasks:attachment:delete:own",
        effect: "allow",
        updatedAt: Date.now(),
      });
    });

    await expect(
      f.asUser("employeeA1").mutation(api.tasks.deleteAttachment, {
        companyId: f.companyA,
        attachmentId: emp1AttachmentId,
      })
    ).resolves.toBeNull();

    // Employee 1 CANNOT delete Admin's attachment (needs delete:any moderation)
    await expect(
      f.asUser("employeeA1").mutation(api.tasks.deleteAttachment, {
        companyId: f.companyA,
        attachmentId: adminAttachmentId,
      })
    ).rejects.toThrow("You do not have access to moderate attachments.");

    // Manager (manages employee 1 and can update this task) CAN delete Admin's attachment because Manager has delete:any
    await expect(
      f.asUser("managerA").mutation(api.tasks.deleteAttachment, {
        companyId: f.companyA,
        attachmentId: adminAttachmentId,
      })
    ).resolves.toBeNull();
  });

  test("Export requires export capability and redacts unmanaged co-assignees", async () => {
    const f = await createAuthzFixture();

    // Task co-assigned to Employee 1 (managed by Manager) and Employee 2 (NOT managed by Manager)
    await f.asUser("adminA").mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Shared Project",
      recurrence: "weekly",
      assigneeMembershipIds: [f.employee1M, f.employee2M],
    });

    // Employee without export capability cannot export
    await expect(
      f.asUser("employeeA1").query(api.tasks.exportRows, {
        companyId: f.companyA,
        kind: "jd",
        paginationOpts: { cursor: null, numItems: 50 },
      })
    ).rejects.toThrow("You do not have access to do that.");

    // Manager has export capability
    const exportResult = await f.asUser("managerA").query(api.tasks.exportRows, {
      companyId: f.companyA,
      kind: "jd",
      paginationOpts: { cursor: null, numItems: 50 },
    });
    expect(exportResult.page.length).toBe(1);
    // Employee 2 should be redacted from the exported assigneeEmails!
    const row = exportResult.page[0];
    expect(row.assigneeEmails).toContain("employeea1@example.com");
    expect(row.assigneeEmails).not.toContain("employeea2@example.com");
  });

  test("Task rows and detail return server-computed canUpdate and canDelete flags", async () => {
    const f = await createAuthzFixture();

    const jdTaskId = await f.asUser("adminA").mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Daily Store Check",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M],
    });

    const oneTimeTaskId = await f.asUser("adminA").mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Fix lighting",
      priority: "high",
      assigneeMembershipIds: [f.employee1M],
    });

    // Employee view on JD task
    const empJdDetail = await f.asUser("employeeA1").query(api.tasks.getJd, {
      companyId: f.companyA,
      taskId: jdTaskId,
    });
    expect(empJdDetail.canUpdate).toBe(true);
    expect(empJdDetail.canDelete).toBe(false);

    const empJdRows = await f.asUser("employeeA1").query(api.tasks.listJdRows, {
      companyId: f.companyA,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    const empJdRow = empJdRows.page.find((r) => r._id === jdTaskId);
    expect(empJdRow?.canUpdate).toBe(true);
    expect(empJdRow?.canDelete).toBe(false);

    // Employee view on One-time task
    const empOneTimeDetail = await f.asUser("employeeA1").query(api.tasks.getOneTime, {
      companyId: f.companyA,
      taskId: oneTimeTaskId,
    });
    expect(empOneTimeDetail.canUpdate).toBe(true);
    expect(empOneTimeDetail.canDelete).toBe(false);

    const empOneTimeRows = await f.asUser("employeeA1").query(api.tasks.listOneTimeRows, {
      companyId: f.companyA,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    const empOneTimeRow = empOneTimeRows.page.find((r) => r._id === oneTimeTaskId);
    expect(empOneTimeRow?.canUpdate).toBe(true);
    expect(empOneTimeRow?.canDelete).toBe(false);

    // Admin view on JD task
    const adminJdDetail = await f.asUser("adminA").query(api.tasks.getJd, {
      companyId: f.companyA,
      taskId: jdTaskId,
    });
    expect(adminJdDetail.canUpdate).toBe(true);
    expect(adminJdDetail.canDelete).toBe(true);

    const adminJdRows = await f.asUser("adminA").query(api.tasks.listJdRows, {
      companyId: f.companyA,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    const adminJdRow = adminJdRows.page.find((r) => r._id === jdTaskId);
    expect(adminJdRow?.canUpdate).toBe(true);
    expect(adminJdRow?.canDelete).toBe(true);
  });

  test("shared tasks filter assignees through caller's permitted scope in list and detail queries", async () => {
    const f = await createAuthzFixture();

    // In Company A: managerA manages employee1M, but does NOT manage employee2M.
    // Create shared JD and One-time tasks assigned to both employee1M and employee2M.
    const jdTaskId = await f.asUser("adminA").mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Shared Kitchen Duty",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M, f.employee2M],
    });

    const oneTimeTaskId = await f.asUser("adminA").mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Shared Sprint Review",
      priority: "medium",
      dueDate: Date.now() + 86_400_000,
      assigneeMembershipIds: [f.employee1M, f.employee2M],
    });

    // 1. Manager view: manager manages employee1M, so has row-level visibility,
    // but employee2M is outside manager's scope.
    const managerJdDetail = await f.asUser("managerA").query(api.tasks.getJd, {
      companyId: f.companyA,
      taskId: jdTaskId,
    });
    expect(managerJdDetail.task.assignees).toHaveLength(1);
    expect(managerJdDetail.task.assignees[0].membership._id).toBe(f.employee1M);
    expect(managerJdDetail.task.assignees.some((a) => a.membership._id === f.employee2M)).toBe(false);

    const managerJdRows = await f.asUser("managerA").query(api.tasks.listJdRows, {
      companyId: f.companyA,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    const managerJdRow = managerJdRows.page.find((r) => r._id === jdTaskId);
    expect(managerJdRow).toBeDefined();
    expect(managerJdRow?.assignees).toHaveLength(1);
    expect(managerJdRow?.assignees[0].membership._id).toBe(f.employee1M);
    expect(managerJdRow?.assignees.some((a) => a.membership._id === f.employee2M)).toBe(false);

    const managerOneTimeDetail = await f.asUser("managerA").query(api.tasks.getOneTime, {
      companyId: f.companyA,
      taskId: oneTimeTaskId,
    });
    expect(managerOneTimeDetail.task.assignees).toHaveLength(1);
    expect(managerOneTimeDetail.task.assignees[0].membership._id).toBe(f.employee1M);
    expect(managerOneTimeDetail.task.assignees.some((a) => a.membership._id === f.employee2M)).toBe(false);

    const managerOneTimeRows = await f.asUser("managerA").query(api.tasks.listOneTimeRows, {
      companyId: f.companyA,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    const managerOneTimeRow = managerOneTimeRows.page.find((r) => r._id === oneTimeTaskId);
    expect(managerOneTimeRow).toBeDefined();
    expect(managerOneTimeRow?.assignees).toHaveLength(1);
    expect(managerOneTimeRow?.assignees[0].membership._id).toBe(f.employee1M);
    expect(managerOneTimeRow?.assignees.some((a) => a.membership._id === f.employee2M)).toBe(false);

    // 2. Admin view: admin has view:any capability, sees both assignees
    const adminJdDetail = await f.asUser("adminA").query(api.tasks.getJd, {
      companyId: f.companyA,
      taskId: jdTaskId,
    });
    expect(adminJdDetail.task.assignees).toHaveLength(2);

    const adminOneTimeDetail = await f.asUser("adminA").query(api.tasks.getOneTime, {
      companyId: f.companyA,
      taskId: oneTimeTaskId,
    });
    expect(adminOneTimeDetail.task.assignees).toHaveLength(2);

    // 3. Employee 1 view: sees self, does not see employee 2
    const emp1JdDetail = await f.asUser("employeeA1").query(api.tasks.getJd, {
      companyId: f.companyA,
      taskId: jdTaskId,
    });
    expect(emp1JdDetail.task.assignees).toHaveLength(1);
    expect(emp1JdDetail.task.assignees[0].membership._id).toBe(f.employee1M);

    // 4. Employee 2 view: sees self, does not see employee 1
    const emp2JdDetail = await f.asUser("employeeA2").query(api.tasks.getJd, {
      companyId: f.companyA,
      taskId: jdTaskId,
    });
    expect(emp2JdDetail.task.assignees).toHaveLength(1);
    expect(emp2JdDetail.task.assignees[0].membership._id).toBe(f.employee2M);
  });
});


