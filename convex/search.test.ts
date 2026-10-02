/// <reference types="vite/client" />

import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { createAuthzFixture } from "./authz.fixture";

describe("command palette search", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("Admin finds JD and one-time tasks by title and by forgiving reference match", async () => {
    const f = await createAuthzFixture();

    const jdTaskId = await f.asUser("adminA").mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Deep clean fryer",
      recurrence: "daily",
      assigneeMembershipIds: [f.adminM],
    });
    const oneTimeTaskId = await f.asUser("adminA").mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "File annual report",
      priority: "high",
      dueDate: Date.now() + 86_400_000,
      assigneeMembershipIds: [f.adminM],
    });
    // Same needle in another company must not leak into Company A results.
    await f.asUser("adminB").mutation(api.tasks.createJd, {
      companyId: f.companyB,
      title: "Deep clean fryer",
      recurrence: "daily",
      assigneeMembershipIds: [f.adminBM],
    });

    const jdRef = await f.t.run(async (ctx) => (await ctx.db.get(jdTaskId))!.reference);
    const oneTimeRef = await f.t.run(async (ctx) => (await ctx.db.get(oneTimeTaskId))!.reference);
    expect(jdRef).toBe("JD-001");
    expect(oneTimeRef).toBe("TSK-001");

    const byTitle = await f.asUser("adminA").query(api.tasks.search, { companyId: f.companyA, query: "deep clean" });
    expect(byTitle.jdTasks.map((row) => row._id)).toEqual([jdTaskId]);
    expect(byTitle.oneTimeTasks).toHaveLength(0);

    // Lowercase, missing separators, and stripped padding zeros all match.
    const byCode = await f.asUser("adminA").query(api.tasks.search, { companyId: f.companyA, query: "jd-1" });
    expect(byCode.jdTasks.map((row) => row._id)).toContain(jdTaskId);

    const byCode2 = await f.asUser("adminA").query(api.tasks.search, { companyId: f.companyA, query: "TSK1" });
    expect(byCode2.oneTimeTasks.map((row) => row._id)).toContain(oneTimeTaskId);

    // The exact reference hits the index path directly.
    const exact = await f.asUser("adminA").query(api.tasks.search, { companyId: f.companyA, query: "JD-001" });
    expect(exact.jdTasks.map((row) => row._id)).toContain(jdTaskId);
  });

  test("Employee search only returns tasks visible to them", async () => {
    const f = await createAuthzFixture();

    const mine = await f.asUser("adminA").mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Stock shelves",
      recurrence: "weekly",
      assigneeMembershipIds: [f.employee1M],
    });
    const notMine = await f.asUser("adminA").mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Stock office supplies",
      recurrence: "weekly",
      assigneeMembershipIds: [f.employee2M],
    });

    const result = await f.asUser("employeeA1").query(api.tasks.search, { companyId: f.companyA, query: "stock" });
    const ids = result.jdTasks.map((row) => row._id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(notMine);
  });

  test("SOP search matches title and reference and respects scope visibility", async () => {
    const f = await createAuthzFixture();

    const companySopId = await f.asUser("adminA").mutation(api.sops.create, {
      companyId: f.companyA,
      title: "Opening checklist",
      content: "Turn on lights",
      scopeType: "company",
      branchIds: [],
      departmentIds: [],
      userMembershipIds: [],
    });
    const otherBranchSopId = await f.asUser("adminA").mutation(api.sops.create, {
      companyId: f.companyA,
      title: "Branch 2 checklist",
      content: "Lock the back door",
      scopeType: "branch",
      branchIds: [f.branchA2],
      departmentIds: [],
      userMembershipIds: [],
    });

    const sopRef = await f.t.run(async (ctx) => (await ctx.db.get(companySopId))!.reference);
    expect(sopRef).toBe("SOP-001");

    const byTitle = await f.asUser("employeeA1").query(api.sops.search, { companyId: f.companyA, query: "checklist" });
    const ids = byTitle.sops.map((row) => row._id);
    expect(ids).toContain(companySopId);
    expect(ids).not.toContain(otherBranchSopId);

    const byCode = await f.asUser("employeeA1").query(api.sops.search, { companyId: f.companyA, query: "sop 1" });
    expect(byCode.sops.map((row) => row._id)).toContain(companySopId);
  });

  test("Result limit reports truncation instead of silently dropping matches", async () => {
    const f = await createAuthzFixture();

    for (let index = 0; index < 9; index += 1) {
      await f.asUser("adminA").mutation(api.tasks.createJd, {
        companyId: f.companyA,
        title: `Repeat task ${index + 1}`,
        recurrence: "daily",
        assigneeMembershipIds: [f.adminM],
      });
    }

    const result = await f.asUser("adminA").query(api.tasks.search, { companyId: f.companyA, query: "repeat" });
    expect(result.jdTasks).toHaveLength(8);
    expect(result.truncated).toBe(true);
  });
});
