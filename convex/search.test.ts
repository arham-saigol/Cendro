/// <reference types="vite/client" />

import { readFileSync } from "node:fs";
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

    const byTitle = await f.asUser("adminA").query(api.tasks.searchJd, { companyId: f.companyA, query: "deep clean" });
    expect(byTitle.tasks.map((row) => row._id)).toEqual([jdTaskId]);
    const oneTimeByTitle = await f.asUser("adminA").query(api.tasks.searchOneTime, { companyId: f.companyA, query: "deep clean" });
    expect(oneTimeByTitle.tasks).toHaveLength(0);

    // Lowercase, missing separators, and stripped padding zeros all match.
    const byCode = await f.asUser("adminA").query(api.tasks.searchJd, { companyId: f.companyA, query: "jd-1" });
    expect(byCode.tasks.map((row) => row._id)).toContain(jdTaskId);

    const byCode2 = await f.asUser("adminA").query(api.tasks.searchOneTime, { companyId: f.companyA, query: "TSK1" });
    expect(byCode2.tasks.map((row) => row._id)).toContain(oneTimeTaskId);

    // The exact reference hits the index path directly.
    const exact = await f.asUser("adminA").query(api.tasks.searchJd, { companyId: f.companyA, query: "JD-001" });
    expect(exact.tasks.map((row) => row._id)).toContain(jdTaskId);
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

    const result = await f.asUser("employeeA1").query(api.tasks.searchJd, { companyId: f.companyA, query: "stock" });
    const ids = result.tasks.map((row) => row._id);
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

  test("Punctuation-only needles match nothing while partial padded codes still match", async () => {
    const f = await createAuthzFixture();

    const jdTaskId = await f.asUser("adminA").mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Polish glassware",
      recurrence: "daily",
      assigneeMembershipIds: [f.adminM],
    });
    await f.asUser("adminA").mutation(api.sops.create, {
      companyId: f.companyA,
      title: "Glassware guide",
      content: "Polish gently",
      scopeType: "company",
      branchIds: [],
      departmentIds: [],
      userMembershipIds: [],
    });

    // A key-less needle must not degenerate into a match-everything.
    const punctuation = await f.asUser("adminA").query(api.tasks.searchJd, { companyId: f.companyA, query: "--" });
    expect(punctuation.tasks).toHaveLength(0);
    const oneTimePunctuation = await f.asUser("adminA").query(api.tasks.searchOneTime, { companyId: f.companyA, query: "--" });
    expect(oneTimePunctuation.tasks).toHaveLength(0);
    const sopPunctuation = await f.asUser("adminA").query(api.sops.search, { companyId: f.companyA, query: "--" });
    expect(sopPunctuation.sops).toHaveLength(0);

    // A prefix of the stored spelling matches like the old substring check did.
    const partial = await f.asUser("adminA").query(api.tasks.searchJd, { companyId: f.companyA, query: "jd-00" });
    expect(partial.tasks.map((row) => row._id)).toContain(jdTaskId);
  });

  test("Normalized code probes reach rows beyond the scan ceiling", async () => {
    const f = await createAuthzFixture();

    const oldTaskId = await f.asUser("adminA").mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Legacy checklist",
      recurrence: "daily",
      assigneeMembershipIds: [f.adminM],
    });
    const oldSopId = await f.asUser("adminA").mutation(api.sops.create, {
      companyId: f.companyA,
      title: "Legacy SOP",
      content: "Old guidance",
      scopeType: "company",
      branchIds: [],
      departmentIds: [],
      userMembershipIds: [],
    });

    // 1,100 newer rows push both records past the 1,000-row scan ceiling.
    await f.t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 1_100; index += 1) {
        await ctx.db.insert("jdTasks", {
          companyId: f.companyA,
          reference: `JD-${1001 + index}`,
          title: "Filler task",
          recurrence: "daily",
          cycleStartedAt: now,
          status: "due",
          assigneeMembershipIds: [f.adminM],
          createdByMembershipId: f.adminM,
          createdAt: now + index,
          updatedAt: now + index,
        });
        await ctx.db.insert("sops", {
          companyId: f.companyA,
          reference: `SOP-${2000 + index}`,
          title: "Filler SOP",
          content: "filler",
          scopeType: "company",
          creatorMembershipId: f.adminM,
          updatedByMembershipId: f.adminM,
          createdAt: now + index,
          updatedAt: now + index,
        });
      }
    });

    const tasks = await f.asUser("adminA").query(api.tasks.searchJd, { companyId: f.companyA, query: "jd1" });
    expect(tasks.tasks.map((row) => row._id)).toContain(oldTaskId);

    const sops = await f.asUser("adminA").query(api.sops.search, { companyId: f.companyA, query: "sop1" });
    expect(sops.sops.map((row) => row._id)).toContain(oldSopId);

    // A sparse title match must remain cheap even after 1,100 unrelated rows.
    const measured = await f.asUser("adminA").query(async (ctx) => {
      const tasks = await ctx.runQuery(api.tasks.searchJd, { companyId: f.companyA, query: "legacy check" });
      const sops = await ctx.runQuery(api.sops.search, { companyId: f.companyA, query: "legacy" });
      const metrics = await ctx.meta.getTransactionMetrics();
      return { tasks, sops, reads: metrics.documentsRead.used, bytes: metrics.bytesRead.used };
    });
    expect(measured.tasks.tasks.map((row) => row._id)).toEqual([oldTaskId]);
    expect(measured.sops.sops.map((row) => row._id)).toEqual([oldSopId]);
    expect(measured.reads).toBeLessThan(50);
    expect(measured.bytes).toBeLessThan(64 * 1024);
    await expect(f.asUser("adminB").query(api.tasks.searchJd, { companyId: f.companyA, query: "legacy" })).rejects.toThrow("You do not have access");
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

    const result = await f.asUser("adminA").query(api.tasks.searchJd, { companyId: f.companyA, query: "repeat" });
    expect(result.tasks).toHaveLength(8);
    expect(result.truncated).toBe(true);
  });

  test("many inaccessible title matches remain bounded and disclose truncation", async () => {
    const f = await createAuthzFixture();
    const mine = await f.asUser("adminA").mutation(api.tasks.createJd, {
      companyId: f.companyA, title: "Restock pantry", recurrence: "daily", assigneeMembershipIds: [f.employee1M],
    });
    await f.t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 160; index += 1) {
        await ctx.db.insert("jdTasks", {
          companyId: f.companyA, reference: `JD-${1000 + index}`, title: "Restock pantry", recurrence: "daily",
          cycleStartedAt: now, status: "due", assigneeMembershipIds: [f.employee2M], createdByMembershipId: f.adminM,
          createdAt: now + index, updatedAt: now + index,
        });
      }
    });
    const measured = await f.asUser("employeeA1").query(async (ctx) => {
      const result = await ctx.runQuery(api.tasks.searchJd, { companyId: f.companyA, query: "restock" });
      return { result, reads: (await ctx.meta.getTransactionMetrics()).documentsRead.used };
    });
    expect(measured.result.tasks.every((task) => task._id === mine)).toBe(true);
    expect(measured.result.truncated).toBe(true);
    expect(measured.reads).toBeLessThan(150);
  });
});

describe("search scan helpers stream instead of paginating", () => {
  // Convex allows only one `.paginate()` call per function execution; a second
  // call — sequential or parallel — throws at runtime. convex-test does not
  // enforce that rule, so the helpers that scan until they fill a result limit
  // are pinned here to the `scanUntil` streaming path: reintroducing
  // `.paginate()` in any of these bodies crashes on a real deployment while
  // still passing every convex-test case above.
  // Slices the source from each occurrence of `marker` to the next top-level
  // declaration (a keyword at column 0). Function bodies are indented, so this
  // needs no string or brace parsing. The last slice for a name is its
  // implementation — overload signatures slice to the next signature.
  const slicesOf = (file: string, marker: string): string[] => {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const nextDecl = /\n(?:export |async function |function |const |interface |type |\/\/|\/\*)/;
    const slices: string[] = [];
    for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + marker.length)) {
      const rest = source.slice(at);
      const bound = rest.slice(marker.length).search(nextDecl);
      slices.push(rest.slice(0, bound === -1 ? undefined : bound + marker.length));
    }
    return slices;
  };

  const sites: [file: string, marker: string][] = [
    ["tasks.ts", "async function searchTasksOfKind("],
    ["sops.ts", "async function filteredSopRows("],
    ["sops.ts", "async function visibleContentMatches("],
    ["sops.ts", "export const search = query("],
    ["sops.ts", "export const aiListSops = query("],
  ];

  for (const [file, marker] of sites) {
    test(`${marker} in ${file} uses scanUntil and never .paginate()`, () => {
      const slices = slicesOf(file, marker);
      expect(slices.length).toBeGreaterThan(0);
      const body = slices.at(-1)!;
      expect(body).toContain("scanUntil(");
      expect(body).not.toContain(".paginate(");
    });
  }
});
