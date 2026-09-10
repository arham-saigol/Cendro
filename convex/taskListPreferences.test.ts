/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createAuthzFixture } from "./authz.fixture";

describe("task list preferences", () => {
  test("converts legacy keys even from field sorting and prevents an old client from overwriting the vector", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const ids: Id<"jdTasks">[] = [];
    for (const title of ["A", "B", "C", "D"]) {
      ids.push(await admin.mutation(api.tasks.createJd, {
        companyId: f.companyA, title, recurrence: "daily", assigneeMembershipIds: [f.adminM],
      }));
    }
    await admin.mutation(api.tasks.moveListOrderTask, {
      companyId: f.companyA, taskType: "jd", taskId: ids[2], orderKey: "-1024/1", expectedRevision: 0,
    });
    await admin.mutation(api.tasks.setListSort, {
      companyId: f.companyA, taskType: "jd", sort: { mode: "field", field: "title", direction: "desc" }, expectedRevision: 1,
    });
    const legacyRows = await admin.query(api.tasks.listJdRows, {
      companyId: f.companyA, paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(legacyRows.page.find((row) => row._id === ids[2])?.customOrderKey).toBe("-1024/1");
    const desired = [ids[0], ids[3], ids[2], ids[1]];
    await admin.mutation(api.tasks.saveListOrder, {
      companyId: f.companyA, taskType: "jd", orderedIds: desired, expectedRevision: 2,
    });
    await expect(admin.mutation(api.tasks.moveListOrderTask, {
      companyId: f.companyA, taskType: "jd", taskId: ids[0], orderKey: "9999/1", expectedRevision: 3,
    })).rejects.toThrow("Reload");
    await expect(admin.mutation(api.tasks.saveListOrder, {
      companyId: f.companyA, taskType: "jd", orderedIds: ids, expectedRevision: 2,
    })).rejects.toThrow("was updated");
    await expect(admin.query(api.tasks.getListPreference, {
      companyId: f.companyA, taskType: "jd",
    })).resolves.toMatchObject({ customOrder: desired, orderFormat: "vector", revision: 3 });
    const rows = await admin.query(api.tasks.listJdRows, {
      companyId: f.companyA, paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(rows.page.every((row) => row.customOrderKey === undefined)).toBe(true);
    const preferenceId = await f.t.run(async (ctx) => (await ctx.db.query("taskListPreferences").first())!._id);
    await f.t.mutation(internal.tasks.cleanupLegacyListOrder, { preferenceId });
    expect(await f.t.run((ctx) => ctx.db.query("taskListOrderEntries").take(1))).toEqual([]);
  });
  test("defaults lazily, persists a custom order, and keeps that order while field sorting", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const first = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "First task",
      recurrence: "daily",
      assigneeMembershipIds: [f.adminM],
    });
    const second = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Second task",
      recurrence: "weekly",
      assigneeMembershipIds: [f.adminM],
    });

    await expect(admin.query(api.tasks.getListPreference, {
      companyId: f.companyA,
      taskType: "jd",
    })).resolves.toEqual({
      taskType: "jd",
      sort: { mode: "default" },
      customOrder: null,
      revision: 0,
      updatedAt: null,
    });

    const saved = await admin.mutation(api.tasks.saveListOrder, {
      companyId: f.companyA,
      taskType: "jd",
      orderedIds: [second, first],
      expectedRevision: 0,
    });
    expect(saved).toMatchObject({
      taskType: "jd",
      sort: { mode: "custom" },
      customOrder: [second, first],
      revision: 1,
    });

    const fieldSort = await admin.mutation(api.tasks.setListSort, {
      companyId: f.companyA,
      taskType: "jd",
      sort: { mode: "field", field: "code", direction: "asc" },
      expectedRevision: 1,
    });
    expect(fieldSort).toMatchObject({
      sort: { mode: "field", field: "code", direction: "asc" },
      customOrder: [second, first],
      revision: 2,
    });

    await expect(admin.query(api.tasks.getListPreference, {
      companyId: f.companyA,
      taskType: "jd",
    })).resolves.toMatchObject({
      sort: { mode: "field", field: "code", direction: "asc" },
      customOrder: [second, first],
      revision: 2,
    });
  });

  test("scopes preferences by user, company, and task type", async () => {
    const f = await createAuthzFixture();
    const adminA = f.asUser("adminA");
    const task = await adminA.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Company A one-time task",
      priority: "high",
      assigneeMembershipIds: [f.adminM],
    });

    await adminA.mutation(api.tasks.saveListOrder, {
      companyId: f.companyA,
      taskType: "one_time",
      orderedIds: [task],
      expectedRevision: 0,
    });

    await expect(f.asUser("employeeA1").query(api.tasks.getListPreference, {
      companyId: f.companyA,
      taskType: "one_time",
    })).resolves.toMatchObject({ revision: 0, sort: { mode: "default" }, customOrder: null });
    await expect(adminA.query(api.tasks.getListPreference, {
      companyId: f.companyA,
      taskType: "jd",
    })).resolves.toMatchObject({ revision: 0, sort: { mode: "default" }, customOrder: null });
    await expect(f.asUser("adminB").query(api.tasks.getListPreference, {
      companyId: f.companyB,
      taskType: "one_time",
    })).resolves.toMatchObject({ revision: 0, sort: { mode: "default" }, customOrder: null });
  });

  test("updates every compacted custom-order key in one move", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const first = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "First task",
      recurrence: "daily",
      assigneeMembershipIds: [f.adminM],
    });
    const second = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Second task",
      recurrence: "weekly",
      assigneeMembershipIds: [f.adminM],
    });

    await expect(admin.mutation(api.tasks.moveListOrderTask, {
      companyId: f.companyA,
      taskType: "jd",
      taskId: second,
      orderKey: "1024/1",
      rebalancedOrderKeys: [{ taskId: first, orderKey: "0/1" }],
      expectedRevision: 0,
    })).rejects.toThrow("Task list order position is invalid.");

    await expect(admin.mutation(api.tasks.moveListOrderTask, {
      companyId: f.companyA,
      taskType: "jd",
      taskId: second,
      orderKey: "1024/1",
      rebalancedOrderKeys: [
        { taskId: first, orderKey: "0/1" },
        { taskId: second, orderKey: "512/1" },
      ],
      expectedRevision: 0,
    })).rejects.toThrow("Task list order position is invalid.");

    await expect(admin.mutation(api.tasks.moveListOrderTask, {
      companyId: f.companyA,
      taskType: "jd",
      taskId: second,
      orderKey: "1024/1",
      rebalancedOrderKeys: [
        { taskId: first, orderKey: "0/1" },
        { taskId: second, orderKey: "1/0" },
      ],
      expectedRevision: 0,
    })).rejects.toThrow("Task list order position is invalid.");

    await expect(admin.mutation(api.tasks.moveListOrderTask, {
      companyId: f.companyA,
      taskType: "jd",
      taskId: second,
      orderKey: "1024/1",
      rebalancedOrderKeys: [
        { taskId: first, orderKey: "0/1" },
        { taskId: second, orderKey: "1024/1" },
      ],
      expectedRevision: 0,
    })).resolves.toMatchObject({ sort: { mode: "custom" }, revision: 1 });

    const rows = await admin.query(api.tasks.listJdRows, {
      companyId: f.companyA,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(rows.page).toEqual(expect.arrayContaining([
      expect.objectContaining({ _id: first, customOrderKey: "0/1" }),
      expect.objectContaining({ _id: second, customOrderKey: "1024/1" }),
    ]));
  });

  test("validates the saved vector and rejects stale writes without changing state", async () => {
    const f = await createAuthzFixture();
    const adminA = f.asUser("adminA");
    const adminB = f.asUser("adminB");
    const jd = await adminA.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Visible JD",
      recurrence: "daily",
      assigneeMembershipIds: [f.adminM],
    });
    const oneTime = await adminA.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Wrong task type",
      priority: "low",
      assigneeMembershipIds: [f.adminM],
    });
    const foreign = await adminB.mutation(api.tasks.createJd, {
      companyId: f.companyB,
      title: "Foreign JD",
      recurrence: "daily",
      assigneeMembershipIds: [f.adminBM],
    });

    const initial = await adminA.mutation(api.tasks.saveListOrder, {
      companyId: f.companyA,
      taskType: "jd",
      orderedIds: [jd],
      expectedRevision: 0,
    });
    expect(initial.revision).toBe(1);

    await expect(adminA.mutation(api.tasks.setListSort, {
      companyId: f.companyA,
      taskType: "jd",
      sort: { mode: "field", field: "priority", direction: "asc" },
      expectedRevision: 1,
    })).rejects.toThrow("not available");
    await expect(adminA.mutation(api.tasks.saveListOrder, {
      companyId: f.companyA,
      taskType: "jd",
      orderedIds: [jd, jd],
      expectedRevision: 1,
    })).rejects.toThrow("duplicate");
    await expect(adminA.mutation(api.tasks.saveListOrder, {
      companyId: f.companyA,
      taskType: "jd",
      orderedIds: [oneTime],
      expectedRevision: 1,
    })).rejects.toThrow("Task not found");
    await expect(adminA.mutation(api.tasks.saveListOrder, {
      companyId: f.companyA,
      taskType: "jd",
      orderedIds: [foreign],
      expectedRevision: 1,
    })).rejects.toThrow("Task not found");
    await expect(adminA.mutation(api.tasks.saveListOrder, {
      companyId: f.companyA,
      taskType: "jd",
      orderedIds: Array.from({ length: 2_001 }, () => jd),
      expectedRevision: 1,
    })).rejects.toThrow("at most 2000");

    const firstWrite = await adminA.mutation(api.tasks.setListSort, {
      companyId: f.companyA,
      taskType: "jd",
      sort: { mode: "field", field: "title", direction: "asc" },
      expectedRevision: 1,
    });
    expect(firstWrite.revision).toBe(2);
    await expect(adminA.mutation(api.tasks.setListSort, {
      companyId: f.companyA,
      taskType: "jd",
      sort: { mode: "default" },
      expectedRevision: 1,
    })).rejects.toThrow("was updated");

    await expect(adminA.query(api.tasks.getListPreference, {
      companyId: f.companyA,
      taskType: "jd",
    })).resolves.toMatchObject({
      revision: 2,
      sort: { mode: "field", field: "title", direction: "asc" },
      customOrder: [jd],
    });
  });

  test("allows a visible read-only task member to organize a personal list", async () => {
    const f = await createAuthzFixture();
    const task = await f.asUser("adminA").mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Employee task",
      priority: "medium",
      assigneeMembershipIds: [f.employee1M],
    });
    await f.setOverride(f.companyA, f.employee1M, "tasks:one_time:update:self", "deny");

    await expect(f.asUser("employeeA1").mutation(api.tasks.saveListOrder, {
      companyId: f.companyA,
      taskType: "one_time",
      orderedIds: [task],
      expectedRevision: 0,
    })).resolves.toMatchObject({
      sort: { mode: "custom" },
      customOrder: [task],
      revision: 1,
    });

    await expect(f.asUser("inactiveA").query(api.tasks.getListPreference, {
      companyId: f.companyA,
      taskType: "one_time",
    })).rejects.toThrow("access to this company");
  });

  test("allows a manager to organize a task visible through a partial assignment scope", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const task = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Shared scoped task",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M, f.employee2M],
    });
    const hiddenTask = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Unmanaged task",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee2M],
    });

    await expect(f.asUser("managerA").mutation(api.tasks.saveListOrder, {
      companyId: f.companyA,
      taskType: "jd",
      orderedIds: [hiddenTask],
      expectedRevision: 0,
    })).rejects.toThrow("Task not found");

    await expect(f.asUser("managerA").mutation(api.tasks.saveListOrder, {
      companyId: f.companyA,
      taskType: "jd",
      orderedIds: [task],
      expectedRevision: 0,
    })).resolves.toMatchObject({
      sort: { mode: "custom" },
      customOrder: [task],
      revision: 1,
    });
  });
});
