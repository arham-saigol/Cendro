/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { createAuthzFixture, type AuthzFixture } from "./authz.fixture";

async function createCompanySop(f: AuthzFixture, title: string, content = "Body") {
  return await f.asUser("adminA").mutation(api.sops.create, {
    companyId: f.companyA,
    title,
    content,
    scopeType: "company",
    branchIds: [],
    departmentIds: [],
    userMembershipIds: [],
  });
}

describe("SOP list preferences", () => {
  test("defaults lazily, persists a custom order, and keeps that order while field sorting", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const first = await createCompanySop(f, "First procedure");
    const second = await createCompanySop(f, "Second procedure");

    await expect(admin.query(api.sops.getListPreference, { companyId: f.companyA })).resolves.toEqual({
      sort: { mode: "default" },
      customOrder: null,
      revision: 0,
      updatedAt: null,
    });

    const saved = await admin.mutation(api.sops.saveListOrder, {
      companyId: f.companyA,
      orderedIds: [second, first],
      expectedRevision: 0,
    });
    expect(saved).toMatchObject({
      sort: { mode: "custom" },
      customOrder: [second, first],
      revision: 1,
    });

    const fieldSort = await admin.mutation(api.sops.setListSort, {
      companyId: f.companyA,
      sort: { mode: "field", field: "title", direction: "asc" },
      expectedRevision: 1,
    });
    expect(fieldSort).toMatchObject({
      sort: { mode: "field", field: "title", direction: "asc" },
      customOrder: [second, first],
      revision: 2,
    });

    await expect(admin.query(api.sops.getListPreference, { companyId: f.companyA })).resolves.toMatchObject({
      sort: { mode: "field", field: "title", direction: "asc" },
      customOrder: [second, first],
      revision: 2,
    });
  });

  test("scopes preferences by member and company", async () => {
    const f = await createAuthzFixture();
    const sop = await createCompanySop(f, "Shared procedure");

    await f.asUser("adminA").mutation(api.sops.saveListOrder, {
      companyId: f.companyA,
      orderedIds: [sop],
      expectedRevision: 0,
    });

    await expect(f.asUser("employeeA1").query(api.sops.getListPreference, { companyId: f.companyA })).resolves.toMatchObject({
      revision: 0,
      sort: { mode: "default" },
      customOrder: null,
    });
    await expect(f.asUser("adminB").query(api.sops.getListPreference, { companyId: f.companyB })).resolves.toMatchObject({
      revision: 0,
      sort: { mode: "default" },
      customOrder: null,
    });
    await expect(f.asUser("inactiveA").query(api.sops.getListPreference, { companyId: f.companyA })).rejects.toThrow("access to this company");
  });

  test("lets a read-only member organize the SOPs they can view", async () => {
    const f = await createAuthzFixture();
    const companySop = await createCompanySop(f, "Company policy");
    const hiddenSop = await f.asUser("adminA").mutation(api.sops.create, {
      companyId: f.companyA,
      title: "Branch 2 policy",
      content: "Body",
      scopeType: "branch",
      branchIds: [f.branchA2],
      departmentIds: [],
      userMembershipIds: [],
    });

    await expect(f.asUser("employeeA1").mutation(api.sops.saveListOrder, {
      companyId: f.companyA,
      orderedIds: [companySop],
      expectedRevision: 0,
    })).resolves.toMatchObject({
      sort: { mode: "custom" },
      customOrder: [companySop],
      revision: 1,
    });

    await expect(f.asUser("employeeA1").mutation(api.sops.saveListOrder, {
      companyId: f.companyA,
      orderedIds: [hiddenSop],
      expectedRevision: 1,
    })).rejects.toThrow("SOP not found.");
  });

  test("rejects duplicate, oversized, deleted, foreign, and stale saves", async () => {
    const f = await createAuthzFixture();
    const adminA = f.asUser("adminA");
    const adminB = f.asUser("adminB");
    const sop = await createCompanySop(f, "Kept procedure");
    const deleted = await createCompanySop(f, "Deleted procedure");
    const foreign = await adminB.mutation(api.sops.create, {
      companyId: f.companyB,
      title: "Foreign procedure",
      content: "Body",
      scopeType: "company",
      branchIds: [],
      departmentIds: [],
      userMembershipIds: [],
    });
    await adminA.mutation(api.sops.remove, { companyId: f.companyA, sopId: deleted });

    await expect(adminA.mutation(api.sops.saveListOrder, {
      companyId: f.companyA,
      orderedIds: [sop, sop],
      expectedRevision: 0,
    })).rejects.toThrow("duplicate");
    await expect(adminA.mutation(api.sops.saveListOrder, {
      companyId: f.companyA,
      orderedIds: Array.from({ length: 2_001 }, () => sop),
      expectedRevision: 0,
    })).rejects.toThrow("at most 2000");
    await expect(adminA.mutation(api.sops.saveListOrder, {
      companyId: f.companyA,
      orderedIds: [deleted],
      expectedRevision: 0,
    })).rejects.toThrow("SOP not found.");
    await expect(adminA.mutation(api.sops.saveListOrder, {
      companyId: f.companyA,
      orderedIds: [foreign],
      expectedRevision: 0,
    })).rejects.toThrow("SOP not found.");

    const saved = await adminA.mutation(api.sops.saveListOrder, {
      companyId: f.companyA,
      orderedIds: [sop],
      expectedRevision: 0,
    });
    expect(saved.revision).toBe(1);
    await expect(adminA.mutation(api.sops.saveListOrder, {
      companyId: f.companyA,
      orderedIds: [sop],
      expectedRevision: 0,
    })).rejects.toThrow("was updated");
    await expect(adminA.mutation(api.sops.setListSort, {
      companyId: f.companyA,
      sort: { mode: "default" },
      expectedRevision: 0,
    })).rejects.toThrow("was updated");
  });

  test("leaves SOP content, timestamps, authorship, and audit events unchanged", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const first = await createCompanySop(f, "First procedure", "Original body");
    const second = await createCompanySop(f, "Second procedure");
    const before = await admin.query(api.sops.get, { companyId: f.companyA, sopId: first });

    await admin.mutation(api.sops.saveListOrder, {
      companyId: f.companyA,
      orderedIds: [second, first],
      expectedRevision: 0,
    });

    const after = await admin.query(api.sops.get, { companyId: f.companyA, sopId: first });
    expect(after).toMatchObject({
      title: before.title,
      content: "Original body",
      updatedAt: before.updatedAt,
      createdAt: before.createdAt,
      updatedByMembershipId: before.updatedByMembershipId,
    });
    expect(await f.t.run((ctx) => ctx.db.query("auditEvents").take(10))).toEqual([]);
  });
});
