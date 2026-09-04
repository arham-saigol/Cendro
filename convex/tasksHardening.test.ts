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

    // Employee 1 CAN delete their OWN attachment
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
});
