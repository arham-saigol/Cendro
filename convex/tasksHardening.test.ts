/// <reference types="vite/client" />

import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createAuthzFixture, type AuthzFixture } from "./authz.fixture";
import { defaultRoleCapabilities } from "../src/lib/permissions";

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
    const claimId = await f.t.run(async (ctx) =>
      ctx.db.insert("taskUploadClaims", { companyId: f.companyA, membershipId: f.adminM, storageId, createdAt: Date.now() })
    );

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
        claimId,
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
        claimId,
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
        claimId,
      })
    ).rejects.toThrow("This file is already attached.");
  });

  // Base64, matching the sha256 encoding Convex records on _storage docs.
  async function sha256Of(content: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    return btoa(String.fromCharCode(...new Uint8Array(digest)));
  }

  // Uploads through the claim-bound endpoint, like a real client small-file
  // upload: POST the bytes under the claim's upload secret, get a bound blob.
  async function endpointUpload(f: AuthzFixture, opts: { claimId: string; secret: string | null; body: BodyInit; contentType?: string; headers?: Record<string, string> }) {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.secret !== null) headers.Authorization = `Bearer ${opts.secret}`;
    if (opts.contentType) headers["Content-Type"] = opts.contentType;
    return f.t.fetch(`/task-uploads?claimId=${encodeURIComponent(opts.claimId)}`, { method: "POST", headers, body: opts.body });
  }

  test("Claim-bound upload endpoint stores and binds the exact uploaded blob", async () => {
    const f = await createAuthzFixture();

    const { claimId, uploadSecret } = await f.asUser("adminA").mutation(api.tasks.generateAttachmentUploadUrl, { companyId: f.companyA });

    // The endpoint mints the claim -> blob binding itself.
    const response = await endpointUpload(f, { claimId, secret: uploadSecret, body: "orphan", contentType: "text/plain" });
    expect(response.status).toBe(200);
    const { storageId } = await response.json() as { storageId: Id<"_storage"> };
    expect(await f.t.run(async (ctx) => (await ctx.db.get(claimId))?.storageId)).toBe(storageId);
    const metadata = await f.t.run(async (ctx) => ctx.db.system.get("_storage", storageId));
    expect(metadata?.size).toBe(6);

    // A claim is only usable by the member it was issued to, in its company.
    await expect(
      f.asUser("adminB").mutation(api.tasks.bindUploadClaim, { companyId: f.companyB, claimId, storageId })
    ).rejects.toThrow("Upload claim not found.");
    await expect(
      f.asUser("adminB").mutation(api.tasks.deleteOrphanedUpload, { companyId: f.companyB, claimId })
    ).rejects.toThrow("Upload claim not found.");

    // Rebinding to another blob is refused; confirming the bound blob is fine.
    const otherStorageId = await f.t.run(async (ctx) => ctx.storage.store(new Blob(["other"], { type: "text/plain" })));
    await expect(
      f.asUser("adminA").mutation(api.tasks.bindUploadClaim, { companyId: f.companyA, claimId, storageId: otherStorageId })
    ).rejects.toThrow("Upload claim is already bound.");
    await expect(
      f.asUser("adminA").mutation(api.tasks.bindUploadClaim, { companyId: f.companyA, claimId, storageId })
    ).resolves.toBeNull();

    // Cleanup deletes the bound unreferenced blob and consumes the claim.
    await expect(
      f.asUser("adminA").mutation(api.tasks.deleteOrphanedUpload, { companyId: f.companyA, claimId })
    ).resolves.toBeNull();
    expect(await f.t.run(async (ctx) => ctx.db.system.get("_storage", storageId))).toBeNull();
    expect(await f.t.run(async (ctx) => ctx.db.get(claimId))).toBeNull();
    expect(await f.t.run(async (ctx) => ctx.db.system.get("_storage", otherStorageId))).not.toBeNull();
  });

  test("Upload endpoint rejects missing, wrong, and consumed claims without leaking blobs", async () => {
    const f = await createAuthzFixture();

    const { claimId, uploadSecret } = await f.asUser("adminA").mutation(api.tasks.generateAttachmentUploadUrl, { companyId: f.companyA });

    // No credential and the wrong credential are refused, and nothing the
    // request stored is left behind.
    expect((await endpointUpload(f, { claimId, secret: null, body: "no-secret" })).status).toBe(400);
    expect((await endpointUpload(f, { claimId, secret: "wrong-secret", body: "bad-secret" })).status).toBe(403);
    expect(await f.t.run(async (ctx) => (await ctx.db.get(claimId))?.storageId ?? null)).toBeNull();
    expect(await f.t.run(async (ctx) => ctx.db.system.query("_storage").collect())).toHaveLength(0);

    // The real upload binds the claim; a second upload on the consumed claim
    // is refused and leaves the original blob in place.
    const response = await endpointUpload(f, { claimId, secret: uploadSecret, body: "first", contentType: "text/plain" });
    expect(response.status).toBe(200);
    const { storageId } = await response.json() as { storageId: Id<"_storage"> };
    expect((await endpointUpload(f, { claimId, secret: uploadSecret, body: "second" })).status).toBe(403);
    const remaining = await f.t.run(async (ctx) => ctx.db.system.query("_storage").collect());
    expect(remaining.map((row) => row._id)).toEqual([storageId]);
  });

  test("Cross-company pending-upload claim cannot adopt another tenant's blob", async () => {
    const f = await createAuthzFixture();

    // Company B uploads through the claim-bound endpoint and has not attached
    // the blob yet — the attacker's window in the reported repro.
    const { claimId: claimB, uploadSecret: secretB } = await f.asUser("adminB").mutation(api.tasks.generateAttachmentUploadUrl, { companyId: f.companyB });
    const uploadResponse = await endpointUpload(f, { claimId: claimB, secret: secretB, body: "victim-blob", contentType: "text/plain" });
    expect(uploadResponse.status).toBe(200);
    const { storageId: victimStorageId } = await uploadResponse.json() as { storageId: Id<"_storage"> };

    // Company A knows the storage id. Its own claim can never name B's blob:
    // the blob already has a live claim, and A's claim declared no digest.
    const { claimId: claimA } = await f.asUser("adminA").mutation(api.tasks.generateAttachmentUploadUrl, { companyId: f.companyA });
    await expect(
      f.asUser("adminA").mutation(api.tasks.bindUploadClaim, { companyId: f.companyA, claimId: claimA, storageId: victimStorageId })
    ).rejects.toThrow();

    // Even a claim that declared B's content digest cannot steal a bound blob.
    const victimSha256 = await sha256Of("victim-blob");
    const { claimId: claimA2 } = await f.asUser("adminA").mutation(api.tasks.generateAttachmentUploadUrl, { companyId: f.companyA, sha256: victimSha256, size: 11 });
    await expect(
      f.asUser("adminA").mutation(api.tasks.bindUploadClaim, { companyId: f.companyA, claimId: claimA2, storageId: victimStorageId })
    ).rejects.toThrow("Uploaded file is already claimed.");

    // The reported repro ends with deleteOrphanedUpload(A claim): it now only
    // ever touches A's own blob — B's pending upload survives intact.
    await expect(
      f.asUser("adminA").mutation(api.tasks.deleteOrphanedUpload, { companyId: f.companyA, claimId: claimA })
    ).resolves.toBeNull();
    await expect(
      f.asUser("adminA").mutation(api.tasks.deleteOrphanedUpload, { companyId: f.companyA, claimId: claimA2 })
    ).resolves.toBeNull();
    expect(await f.t.run(async (ctx) => ctx.db.system.get("_storage", victimStorageId))).not.toBeNull();

    // And B's pending upload completes normally: attachment consumes the claim.
    const taskB = await f.asUser("adminB").mutation(api.tasks.createJd, { companyId: f.companyB, title: "B task", recurrence: "daily", assigneeMembershipIds: [f.adminBM] });
    await expect(
      f.asUser("adminB").mutation(api.tasks.addAttachment, {
        companyId: f.companyB,
        taskType: "jd",
        taskId: taskB,
        storageId: victimStorageId,
        fileName: "victim.txt",
        contentType: "text/plain",
        size: 11,
        claimId: claimB,
      })
    ).resolves.toBeDefined();
    expect(await f.t.run(async (ctx) => ctx.db.get(claimB))).toBeNull();
  });

  test("Digest-declared claims bind only the matching blob", async () => {
    const f = await createAuthzFixture();

    // The large-file path: the claim declares the blob's digest up front.
    const content = "large-file-content";
    const sha256 = await sha256Of(content);
    const { claimId } = await f.asUser("adminA").mutation(api.tasks.generateAttachmentUploadUrl, { companyId: f.companyA, sha256, size: content.length });
    const storageId = await f.t.run(async (ctx) => ctx.storage.store(new Blob([content], { type: "text/plain" })));

    // A mismatched digest never binds — a storage id alone proves nothing.
    const foreignStorageId = await f.t.run(async (ctx) => ctx.storage.store(new Blob(["other-content"], { type: "text/plain" })));
    await expect(
      f.asUser("adminA").mutation(api.tasks.bindUploadClaim, { companyId: f.companyA, claimId, storageId: foreignStorageId })
    ).rejects.toThrow("Uploaded file does not match this claim.");
    const wrongSizeClaim = await f.asUser("adminA").mutation(api.tasks.generateAttachmentUploadUrl, { companyId: f.companyA, sha256, size: content.length + 1 });
    await expect(
      f.asUser("adminA").mutation(api.tasks.bindUploadClaim, { companyId: f.companyA, claimId: wrongSizeClaim.claimId, storageId })
    ).rejects.toThrow("Uploaded file does not match this claim.");

    // A claim minted after the blob already existed can never bind it — the
    // declared digest must genuinely precede the upload.
    const staleStorageId = await f.t.run(async (ctx) => ctx.storage.store(new Blob(["pre-existing"], { type: "text/plain" })));
    const staleSha256 = await sha256Of("pre-existing");
    const lateClaimId = await f.t.run(async (ctx) =>
      ctx.db.insert("taskUploadClaims", { companyId: f.companyA, membershipId: f.adminM, expectedSha256: staleSha256, expectedSize: 12, createdAt: Date.now() + 60_000 })
    );
    await expect(
      f.asUser("adminA").mutation(api.tasks.bindUploadClaim, { companyId: f.companyA, claimId: lateClaimId, storageId: staleStorageId })
    ).rejects.toThrow("Uploaded file does not match this claim.");

    // The blob the claim's own upload produced binds and cleans up normally.
    await expect(
      f.asUser("adminA").mutation(api.tasks.bindUploadClaim, { companyId: f.companyA, claimId, storageId })
    ).resolves.toBeNull();
    await expect(
      f.asUser("adminA").mutation(api.tasks.deleteOrphanedUpload, { companyId: f.companyA, claimId })
    ).resolves.toBeNull();
    expect(await f.t.run(async (ctx) => ctx.db.system.get("_storage", storageId))).toBeNull();
    expect(await f.t.run(async (ctx) => ctx.db.system.get("_storage", foreignStorageId))).not.toBeNull();
  });

  test("A failed bind can still be reclaimed — but only by the claim's declared digest", async () => {
    const f = await createAuthzFixture();

    // The upload POST succeeded and bindUploadClaim failed transiently: the
    // claim has no storageId, so cleanup needs the caller's supplied id —
    // accepted only under the same proof bindUploadClaim requires.
    const content = "bind-failure-content";
    const sha256 = await sha256Of(content);
    const { claimId } = await f.asUser("adminA").mutation(api.tasks.generateAttachmentUploadUrl, { companyId: f.companyA, sha256, size: content.length });
    const storageId = await f.t.run(async (ctx) => ctx.storage.store(new Blob([content], { type: "text/plain" })));

    await expect(
      f.asUser("adminA").mutation(api.tasks.deleteOrphanedUpload, { companyId: f.companyA, claimId, storageId })
    ).resolves.toBeNull();
    expect(await f.t.run(async (ctx) => ctx.db.system.get("_storage", storageId))).toBeNull();
    expect(await f.t.run(async (ctx) => ctx.db.get(claimId))).toBeNull();

    // A mismatched blob refuses, leaving the foreign file and the claim both
    // untouched — the claimant can retry with its own blob's real id.
    const content2 = "second-file";
    const { claimId: claim2 } = await f.asUser("adminA").mutation(api.tasks.generateAttachmentUploadUrl, { companyId: f.companyA, sha256: await sha256Of(content2), size: content2.length });
    const foreignId = await f.t.run(async (ctx) => ctx.storage.store(new Blob(["someone-elses"], { type: "text/plain" })));
    await expect(
      f.asUser("adminA").mutation(api.tasks.deleteOrphanedUpload, { companyId: f.companyA, claimId: claim2, storageId: foreignId })
    ).rejects.toThrow("Uploaded file does not match this claim.");
    expect(await f.t.run(async (ctx) => ctx.db.system.get("_storage", foreignId))).not.toBeNull();
    expect(await f.t.run(async (ctx) => ctx.db.get(claim2))).not.toBeNull();
  });

  test("bindUploadClaim refuses a blob that is already attached", async () => {
    const f = await createAuthzFixture();

    const jdTaskId = await f.asUser("adminA").mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Attach target",
      recurrence: "daily",
      assigneeMembershipIds: [f.adminM],
    });
    const content = "already-attached";
    const attachedStorageId = await f.t.run(async (ctx) => ctx.storage.store(new Blob([content], { type: "text/plain" })));
    const attachClaimId = await f.t.run(async (ctx) =>
      ctx.db.insert("taskUploadClaims", { companyId: f.companyA, membershipId: f.adminM, storageId: attachedStorageId, createdAt: Date.now() })
    );
    await f.asUser("adminA").mutation(api.tasks.addAttachment, {
      companyId: f.companyA,
      taskType: "jd",
      taskId: jdTaskId,
      storageId: attachedStorageId,
      fileName: "attached.txt",
      contentType: "text/plain",
      size: 16,
      claimId: attachClaimId,
    });

    // A digest-matching claim minted later still cannot bind a blob another
    // attachment already references — attachment state is the final word.
    const { claimId } = await f.asUser("adminA").mutation(api.tasks.generateAttachmentUploadUrl, { companyId: f.companyA, sha256: await sha256Of(content), size: content.length });
    await expect(
      f.asUser("adminA").mutation(api.tasks.bindUploadClaim, { companyId: f.companyA, claimId, storageId: attachedStorageId })
    ).rejects.toThrow("Uploaded file is already attached.");
  });

  test("Orphan cleanup deletes only the claim's bound blob and never a referenced one", async () => {
    const f = await createAuthzFixture();

    // The failed-attach path reclaims by binding the blob first — cleanup only
    // ever touches the blob the caller's own claim names.
    const { claimId, uploadSecret } = await f.asUser("adminA").mutation(api.tasks.generateAttachmentUploadUrl, { companyId: f.companyA });
    const uploadResponse = await endpointUpload(f, { claimId, secret: uploadSecret, body: "late-bind", contentType: "text/plain" });
    expect(uploadResponse.status).toBe(200);
    const { storageId } = await uploadResponse.json() as { storageId: Id<"_storage"> };

    await expect(
      f.asUser("adminA").mutation(api.tasks.deleteOrphanedUpload, { companyId: f.companyA, claimId })
    ).resolves.toBeNull();
    expect(await f.t.run(async (ctx) => ctx.db.get(claimId))).toBeNull();
    expect(await f.t.run(async (ctx) => ctx.db.system.get("_storage", storageId))).toBeNull();

    // An unbound claim carries no blob reference — deleting it consumes the
    // claim but leaves every unattached blob alone.
    const strayStorageId = await f.t.run(async (ctx) => ctx.storage.store(new Blob(["stray"], { type: "text/plain" })));
    const unboundClaimId = await f.t.run(async (ctx) =>
      ctx.db.insert("taskUploadClaims", { companyId: f.companyA, membershipId: f.adminM, createdAt: Date.now() })
    );
    await expect(
      f.asUser("adminA").mutation(api.tasks.deleteOrphanedUpload, { companyId: f.companyA, claimId: unboundClaimId })
    ).resolves.toBeNull();
    expect(await f.t.run(async (ctx) => ctx.db.system.get("_storage", strayStorageId))).not.toBeNull();

    // A blob already recorded as an attachment is never reclaimed.
    const jdTaskId = await f.asUser("adminA").mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Attach target",
      recurrence: "daily",
      assigneeMembershipIds: [f.adminM],
    });
    const attachedStorageId = await f.t.run(async (ctx) => ctx.storage.store(new Blob(["attached"], { type: "text/plain" })));
    const attachClaimId = await f.t.run(async (ctx) =>
      ctx.db.insert("taskUploadClaims", { companyId: f.companyA, membershipId: f.adminM, storageId: attachedStorageId, createdAt: Date.now() })
    );
    await f.asUser("adminA").mutation(api.tasks.addAttachment, {
      companyId: f.companyA,
      taskType: "jd",
      taskId: jdTaskId,
      storageId: attachedStorageId,
      fileName: "attached.txt",
      contentType: "text/plain",
      size: 8,
      claimId: attachClaimId,
    });
    const attachedClaimId = await f.t.run(async (ctx) =>
      ctx.db.insert("taskUploadClaims", { companyId: f.companyA, membershipId: f.adminM, storageId: attachedStorageId, createdAt: Date.now() })
    );
    await expect(
      f.asUser("adminA").mutation(api.tasks.deleteOrphanedUpload, { companyId: f.companyA, claimId: attachedClaimId })
    ).resolves.toBeNull();
    expect(await f.t.run(async (ctx) => ctx.db.system.get("_storage", attachedStorageId))).not.toBeNull();
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
    const emp1ClaimId = await f.t.run(async (ctx) =>
      ctx.db.insert("taskUploadClaims", { companyId: f.companyA, membershipId: f.employee1M, storageId: storageId1, createdAt: Date.now() })
    );
    const emp1AttachmentId = await f.asUser("employeeA1").mutation(api.tasks.addAttachment, {
      companyId: f.companyA,
      taskType: "one_time",
      taskId,
      storageId: storageId1,
      fileName: "emp1.txt",
      contentType: "text/plain",
      size: 9,
      claimId: emp1ClaimId,
    });

    // Admin adds an attachment
    const adminClaimId = await f.t.run(async (ctx) =>
      ctx.db.insert("taskUploadClaims", { companyId: f.companyA, membershipId: f.adminM, storageId: storageId2, createdAt: Date.now() })
    );
    const adminAttachmentId = await f.asUser("adminA").mutation(api.tasks.addAttachment, {
      companyId: f.companyA,
      taskType: "one_time",
      taskId,
      storageId: storageId2,
      fileName: "admin.txt",
      contentType: "text/plain",
      size: 10,
      claimId: adminClaimId,
    });

    // Employee 1 CANNOT delete their OWN attachment by default (disabled for Employee by default)
    await expect(
      f.asUser("employeeA1").mutation(api.tasks.deleteAttachment, {
        companyId: f.companyA,
        attachmentId: emp1AttachmentId,
      })
    ).rejects.toThrow("You do not have access to delete this attachment.");

    // With tasks:attachment:delete:own added to the Employee role, Employee 1 can delete their own attachment
    await f.setRoleCapabilities(f.companyA, "Employee", [...defaultRoleCapabilities.Employee, "tasks:attachment:delete:own"]);

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

  test("assignees can update task status without update capabilities", async () => {
    const f = await createAuthzFixture();

    const jdTaskId = await f.asUser("adminA").mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Daily Standup",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M],
    });
    const oneTimeTaskId = await f.asUser("adminA").mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "File paperwork",
      priority: "medium",
      assigneeMembershipIds: [f.employee1M],
    });

    // Strip every task update capability from the Employee role.
    await f.setRoleCapabilities(f.companyA, "Employee", [
      "tasks:jd:view:self",
      "tasks:one_time:view:self",
    ]);

    const employee = f.asUser("employeeA1");
    await expect(employee.mutation(api.tasks.updateJdStatus, { companyId: f.companyA, taskId: jdTaskId, status: "in_progress" })).resolves.toBeNull();
    await expect(employee.mutation(api.tasks.completeJd, { companyId: f.companyA, taskId: jdTaskId })).resolves.toBeNull();
    await expect(employee.mutation(api.tasks.updateOneTimeStatus, { companyId: f.companyA, taskId: oneTimeTaskId, status: "in_progress" })).resolves.toBeNull();
    await expect(employee.mutation(api.tasks.completeOneTime, { companyId: f.companyA, taskId: oneTimeTaskId })).resolves.toBeNull();
  });

  test("status updates stay closed to non-assignees without update access", async () => {
    const f = await createAuthzFixture();

    const jdTaskId = await f.asUser("adminA").mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Daily Standup",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M],
    });
    const oneTimeTaskId = await f.asUser("adminA").mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "File paperwork",
      priority: "medium",
      assigneeMembershipIds: [f.employee1M],
    });
    // Legacy row with no assignees: the assignee grant must not leak to it.
    const unassignedTaskId = await f.t.run(async (ctx) =>
      ctx.db.insert("oneTimeTasks", {
        companyId: f.companyA,
        reference: "TSK-900",
        title: "Legacy unassigned",
        priority: "low",
        status: "due",
        assigneeMembershipIds: [],
        createdByMembershipId: f.adminM,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    // Employee 2 has update:self but is not an assignee on any of these.
    const other = f.asUser("employeeA2");
    await expect(other.mutation(api.tasks.updateJdStatus, { companyId: f.companyA, taskId: jdTaskId, status: "in_progress" })).rejects.toThrow("You cannot update this task.");
    await expect(other.mutation(api.tasks.updateOneTimeStatus, { companyId: f.companyA, taskId: oneTimeTaskId, status: "completed" })).rejects.toThrow("You cannot update this task.");
    await expect(other.mutation(api.tasks.completeOneTime, { companyId: f.companyA, taskId: oneTimeTaskId })).rejects.toThrow("You cannot update this task.");
    await expect(other.mutation(api.tasks.updateOneTimeStatus, { companyId: f.companyA, taskId: unassignedTaskId, status: "completed" })).rejects.toThrow("You cannot update this task.");

    // Update-permission holders keep working on tasks they do not own.
    await expect(f.asUser("adminA").mutation(api.tasks.updateJdStatus, { companyId: f.companyA, taskId: jdTaskId, status: "completed" })).resolves.toBeNull();
    await expect(f.asUser("adminA").mutation(api.tasks.updateOneTimeStatus, { companyId: f.companyA, taskId: unassignedTaskId, status: "completed" })).resolves.toBeNull();
  });
});


