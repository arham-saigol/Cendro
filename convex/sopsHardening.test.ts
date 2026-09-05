/// <reference types="vite/client" />

import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { createAuthzFixture } from "./authz.fixture";

describe("SOP authorization hardening", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("Employee can only view company SOPs or SOPs scoped to them / their branch / department", async () => {
    const f = await createAuthzFixture();

    // Admin creates Company-wide SOP
    const companySopId = await f.asUser("adminA").mutation(api.sops.create, {
      companyId: f.companyA,
      title: "Company Safety Policy",
      content: "Always wear a helmet",
      scopeType: "company",
      branchIds: [],
      departmentIds: [],
      userMembershipIds: [],
    });

    // Admin creates Branch SOP for Branch 1 (Employee 1 is in Branch 1)
    const branch1SopId = await f.asUser("adminA").mutation(api.sops.create, {
      companyId: f.companyA,
      title: "Branch 1 Guidelines",
      content: "Lock the front door",
      scopeType: "branch",
      branchIds: [f.branchA1],
      departmentIds: [],
      userMembershipIds: [],
    });

    // Admin creates Branch SOP for Branch 2 (Employee 1 is NOT in Branch 2)
    const branch2SopId = await f.asUser("adminA").mutation(api.sops.create, {
      companyId: f.companyA,
      title: "Branch 2 Guidelines",
      content: "Lock the back door",
      scopeType: "branch",
      branchIds: [f.branchA2],
      departmentIds: [],
      userMembershipIds: [],
    });

    // Admin creates User SOP for Employee 2
    const user2SopId = await f.asUser("adminA").mutation(api.sops.create, {
      companyId: f.companyA,
      title: "Employee 2 Instructions",
      content: "Special duties",
      scopeType: "user",
      branchIds: [],
      departmentIds: [],
      userMembershipIds: [f.employee2M],
    });

    // Employee 1 CAN view Company SOP
    const companySop = await f.asUser("employeeA1").query(api.sops.get, {
      companyId: f.companyA,
      sopId: companySopId,
    });
    expect(companySop.title).toBe("Company Safety Policy");

    // Employee 1 CAN view Branch 1 SOP
    const branch1Sop = await f.asUser("employeeA1").query(api.sops.get, {
      companyId: f.companyA,
      sopId: branch1SopId,
    });
    expect(branch1Sop.title).toBe("Branch 1 Guidelines");

    // Employee 1 CANNOT view Branch 2 SOP (returns NOT_FOUND / throws)
    await expect(
      f.asUser("employeeA1").query(api.sops.get, {
        companyId: f.companyA,
        sopId: branch2SopId,
      })
    ).rejects.toThrow("SOP not found.");

    // Employee 1 CANNOT view Employee 2's user SOP
    await expect(
      f.asUser("employeeA1").query(api.sops.get, {
        companyId: f.companyA,
        sopId: user2SopId,
      })
    ).rejects.toThrow("SOP not found.");
  });

  test("Employee cannot delete any SOP", async () => {
    const f = await createAuthzFixture();

    const sopId = await f.asUser("adminA").mutation(api.sops.create, {
      companyId: f.companyA,
      title: "Company SOP",
      content: "Test",
      scopeType: "company",
      branchIds: [],
      departmentIds: [],
      userMembershipIds: [],
    });

    await expect(
      f.asUser("employeeA1").mutation(api.sops.remove, {
        companyId: f.companyA,
        sopId,
      })
    ).rejects.toThrow();
  });

  test("Manager can delete branch SOP in managed scope, but CANNOT delete company SOP", async () => {
    const f = await createAuthzFixture();

    const companySopId = await f.asUser("adminA").mutation(api.sops.create, {
      companyId: f.companyA,
      title: "Company SOP",
      content: "Test",
      scopeType: "company",
      branchIds: [],
      departmentIds: [],
      userMembershipIds: [],
    });

    const managedBranchSopId = await f.asUser("adminA").mutation(api.sops.create, {
      companyId: f.companyA,
      title: "Branch 1 SOP",
      content: "Test",
      scopeType: "branch",
      branchIds: [f.branchA1],
      departmentIds: [],
      userMembershipIds: [],
    });

    // Manager CANNOT delete Company SOP
    await expect(
      f.asUser("managerA").mutation(api.sops.remove, {
        companyId: f.companyA,
        sopId: companySopId,
      })
    ).rejects.toThrow();

    // Manager CAN delete Branch 1 SOP (within managed branch scope)
    await expect(
      f.asUser("managerA").mutation(api.sops.remove, {
        companyId: f.companyA,
        sopId: managedBranchSopId,
      })
    ).resolves.toBeNull();
  });

  test("Manager cannot transition SOP to company scope or unmanaged scope", async () => {
    const f = await createAuthzFixture();

    const branch1SopId = await f.asUser("managerA").mutation(api.sops.create, {
      companyId: f.companyA,
      title: "Manager Created SOP",
      content: "Content",
      scopeType: "branch",
      branchIds: [f.branchA1],
      departmentIds: [],
      userMembershipIds: [],
    });

    // Manager CANNOT update to company scope
    await expect(
      f.asUser("managerA").mutation(api.sops.updateScope, {
        companyId: f.companyA,
        sopId: branch1SopId,
        scopeType: "company",
        branchIds: [],
        departmentIds: [],
        userMembershipIds: [],
      })
    ).rejects.toThrow();

    // Manager CANNOT update to unmanaged branch 2
    await expect(
      f.asUser("managerA").mutation(api.sops.updateScope, {
        companyId: f.companyA,
        sopId: branch1SopId,
        scopeType: "branch",
        branchIds: [f.branchA2],
        departmentIds: [],
        userMembershipIds: [],
      })
    ).rejects.toThrow("You can only target branches in your managed scope.");
  });

  test("SOP DTOs return server-computed canUpdate and canDelete flags", async () => {
    const f = await createAuthzFixture();

    const companySopId = await f.asUser("adminA").mutation(api.sops.create, {
      companyId: f.companyA,
      title: "All Hands",
      content: "Annual meeting",
      scopeType: "company",
      branchIds: [],
      departmentIds: [],
      userMembershipIds: [],
    });

    const adminView = await f.asUser("adminA").query(api.sops.get, {
      companyId: f.companyA,
      sopId: companySopId,
    });
    expect(adminView.canUpdate).toBe(true);
    expect(adminView.canDelete).toBe(true);

    const employeeView = await f.asUser("employeeA1").query(api.sops.get, {
      companyId: f.companyA,
      sopId: companySopId,
    });
    expect(employeeView.canUpdate).toBe(false);
    expect(employeeView.canDelete).toBe(false);

    const managerView = await f.asUser("managerA").query(api.sops.get, {
      companyId: f.companyA,
      sopId: companySopId,
    });
    // Company SOP: Manager cannot update or delete company SOP
    expect(managerView.canUpdate).toBe(false);
    expect(managerView.canDelete).toBe(false);
  });

  test("Employee cannot view SOPs when sops:view:self is explicitly denied", async () => {
    const f = await createAuthzFixture();

    await f.asUser("adminA").mutation(api.sops.create, {
      companyId: f.companyA,
      title: "Company SOP",
      content: "Important SOP",
      scopeType: "company",
      branchIds: [],
      departmentIds: [],
      userMembershipIds: [],
    });

    // By default, employee can list rows
    const beforeRows = await f.asUser("employeeA1").query(api.sops.listRows, {
      companyId: f.companyA,
    });
    expect(beforeRows.length).toBe(1);

    const beforeList = await f.asUser("employeeA1").query(api.sops.list, {
      companyId: f.companyA,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(beforeList.page.length).toBe(1);

    // Explicitly deny sops:view:self for employeeA1
    await f.setOverride(f.companyA, f.employee1M, "sops:view:self", "deny");

    // Employee cannot list rows anymore
    const afterRows = await f.asUser("employeeA1").query(api.sops.listRows, {
      companyId: f.companyA,
    });
    expect(afterRows.length).toBe(0);

    const afterList = await f.asUser("employeeA1").query(api.sops.list, {
      companyId: f.companyA,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(afterList.page.length).toBe(0);
  });

  test("Task or analytics capabilities do not widen SOP managed scope or filter options", async () => {
    const f = await createAuthzFixture();

    // Grant managerA tasks:jd:view:any and analytics:view:company
    await f.setOverride(f.companyA, f.managerM, "tasks:jd:view:any", "allow");
    await f.setOverride(f.companyA, f.managerM, "analytics:view:company", "allow");

    // Get filter options for managerA
    const filters = await f.asUser("managerA").query(api.sops.filterOptions, {
      companyId: f.companyA,
    });

    // Manager should only see their managed branch (branchA1) and managed department (deptA1), NOT branchA2 or deptA2
    const branchIds = filters.branches.map((b) => b._id);
    expect(branchIds).toContain(f.branchA1);
    expect(branchIds).not.toContain(f.branchA2);

    const deptIds = filters.departments.map((d) => d._id);
    expect(deptIds).toContain(f.deptA1);
    expect(deptIds).not.toContain(f.deptA2);

    // Manager cannot create an SOP targeted to branchA2 (outside managed scope)
    await expect(
      f.asUser("managerA").mutation(api.sops.create, {
        companyId: f.companyA,
        title: "Unauthorized scope SOP",
        content: "Content",
        scopeType: "branch",
        branchIds: [f.branchA2],
        departmentIds: [],
        userMembershipIds: [],
      })
    ).rejects.toThrow("You can only target branches in your managed scope.");
  });
});

