/// <reference types="vite/client" />

import { beforeEach, describe, expect, test, vi } from "vitest";
import { createAuthzFixture } from "./authz.fixture";
import {
  requireCompanyAccess,
  assertCanUpdateTask,
  assertCanDeleteTask,
  canViewTask,
  assertPermissionManagerRemains,
  assertPlatformAdmin,
} from "./permissions";

describe("backend permissions hardening", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("requireCompanyAccess throws for unauthenticated, nonexistent, inactive, or cross-company users", async () => {
    const f = await createAuthzFixture();

    // Unauthenticated
    await expect(
      f.t.run(async (ctx) => {
        await requireCompanyAccess(ctx, f.companyA);
      })
    ).rejects.toThrow("Please sign in.");

    // User with no membership in company
    await expect(
      f.asUser("adminB").run(async (ctx) => {
        await requireCompanyAccess(ctx, f.companyA);
      })
    ).rejects.toThrow("You do not have access to this company.");

    // Inactive user
    await expect(
      f.asUser("inactiveA").run(async (ctx) => {
        await requireCompanyAccess(ctx, f.companyA);
      })
    ).rejects.toThrow("You do not have access to this company.");

    // Successful access
    const { companyId, role, hasJdCreate } = await f.asUser("adminA").run(async (ctx) => {
      const auth = await requireCompanyAccess(ctx, f.companyA);
      return {
        companyId: auth.company._id,
        role: auth.membership.role,
        hasJdCreate: auth.capabilities.has("tasks:jd:create"),
      };
    });
    expect(companyId).toBe(f.companyA);
    expect(role).toBe("Admin");
    expect(hasJdCreate).toBe(true);
  });

  test("deny override strips capability even for Admin", async () => {
    const f = await createAuthzFixture();
    await f.setOverride(f.companyA, f.adminM, "tasks:jd:create", "deny");

    const { hasJdCreate, hasOneTimeCreate } = await f.asUser("adminA").run(async (ctx) => {
      const auth = await requireCompanyAccess(ctx, f.companyA);
      return {
        hasJdCreate: auth.capabilities.has("tasks:jd:create"),
        hasOneTimeCreate: auth.capabilities.has("tasks:one_time:create"),
      };
    });
    expect(hasJdCreate).toBe(false);
    expect(hasOneTimeCreate).toBe(true);
  });

  test("duplicate allow and deny override ensures deny wins deterministically", async () => {
    const f = await createAuthzFixture();
    // Insert allow then deny
    await f.setOverride(f.companyA, f.employee1M, "tasks:jd:create", "allow");
    await f.setOverride(f.companyA, f.employee1M, "tasks:jd:create", "deny");

    const { hasJdCreate } = await f.asUser("employeeA1").run(async (ctx) => {
      const auth = await requireCompanyAccess(ctx, f.companyA);
      return { hasJdCreate: auth.capabilities.has("tasks:jd:create") };
    });
    expect(hasJdCreate).toBe(false);
  });

  test("Employee can update own assigned task but cannot delete it", async () => {
    const f = await createAuthzFixture();

    // Employee updating assigned task -> allowed
    await expect(
      f.asUser("employeeA1").run(async (ctx) => {
        const auth = await requireCompanyAccess(ctx, f.companyA);
        await assertCanUpdateTask(ctx, f.companyA, auth.membership, [f.employee1M], "jd", auth.capabilities);
      })
    ).resolves.toBeNull();

    // Employee deleting assigned task -> rejected with forbidden error!
    await expect(
      f.asUser("employeeA1").run(async (ctx) => {
        const auth = await requireCompanyAccess(ctx, f.companyA);
        await assertCanDeleteTask(ctx, f.companyA, auth.membership, [f.employee1M], "jd", auth.capabilities);
      })
    ).rejects.toThrow("You do not have access to delete this task.");
  });

  test("Manager can update and delete task within managed scope, but not outside managed scope", async () => {
    const f = await createAuthzFixture();

    // employee1M is in manager's managed scope -> update & delete allowed
    await expect(
      f.asUser("managerA").run(async (ctx) => {
        const auth = await requireCompanyAccess(ctx, f.companyA);
        await assertCanUpdateTask(ctx, f.companyA, auth.membership, [f.employee1M], "jd", auth.capabilities);
        await assertCanDeleteTask(ctx, f.companyA, auth.membership, [f.employee1M], "jd", auth.capabilities);
      })
    ).resolves.toBeNull();

    // employee2M is NOT in manager's managed scope -> rejected!
    await expect(
      f.asUser("managerA").run(async (ctx) => {
        const auth = await requireCompanyAccess(ctx, f.companyA);
        await assertCanUpdateTask(ctx, f.companyA, auth.membership, [f.employee2M], "jd", auth.capabilities);
      })
    ).rejects.toThrow("You cannot update this task.");

    await expect(
      f.asUser("managerA").run(async (ctx) => {
        const auth = await requireCompanyAccess(ctx, f.companyA);
        await assertCanDeleteTask(ctx, f.companyA, auth.membership, [f.employee2M], "jd", auth.capabilities);
      })
    ).rejects.toThrow("You do not have access to delete this task.");
  });

  test("task view policy respects scope and cross-company boundary", async () => {
    const f = await createAuthzFixture();

    // Task in Company A assigned to employee 1
    const taskA1 = {
      companyId: f.companyA,
      assigneeMembershipIds: [f.employee1M],
      createdByMembershipId: f.adminM,
    };

    // Visible to employee1
    const visibleToEmp1 = await f.asUser("employeeA1").run(async (ctx) => {
      const auth = await requireCompanyAccess(ctx, f.companyA);
      return await canViewTask(ctx, f.companyA, auth.membership, taskA1, "jd", auth.capabilities);
    });
    expect(visibleToEmp1).toBe(true);

    // Invisible to employee2 (not assigned, not created)
    const visibleToEmp2 = await f.asUser("employeeA2").run(async (ctx) => {
      const auth = await requireCompanyAccess(ctx, f.companyA);
      return await canViewTask(ctx, f.companyA, auth.membership, taskA1, "jd", auth.capabilities);
    });
    expect(visibleToEmp2).toBe(false);

    // Cross-company task is always invisible
    const taskB = {
      companyId: f.companyB,
      assigneeMembershipIds: [f.employeeBM],
      createdByMembershipId: f.adminBM,
    };
    const visibleCrossCompany = await f.asUser("employeeA1").run(async (ctx) => {
      const auth = await requireCompanyAccess(ctx, f.companyA);
      return await canViewTask(ctx, f.companyA, auth.membership, taskB, "jd", auth.capabilities);
    });
    expect(visibleCrossCompany).toBe(false);
  });

  test("assertPermissionManagerRemains prevents removing the last permission manager", async () => {
    const f = await createAuthzFixture();

    // Denying manage_permissions on sole admin in company A throws!
    await expect(
      f.t.run(async (ctx) => {
        await assertPermissionManagerRemains(
          ctx,
          f.companyA,
          f.adminM,
          undefined,
          { membershipId: f.adminM, capability: "company:manage_permissions", effect: "deny" }
        );
      })
    ).rejects.toThrow("At least one active member must be able to manage permissions.");
  });

  test("assertPlatformAdmin uses Clerk user IDs and fails closed on email", () => {
    process.env.PLATFORM_ADMIN_CLERK_USER_IDS = "user_clerk_123,user_clerk_456";

    // Matching subject -> allowed
    expect(() =>
      assertPlatformAdmin({
        tokenIdentifier: "clerk|user_clerk_123",
        subject: "user_clerk_123",
        issuer: "https://clerk.test",
        email: "other@example.com",
      } as any)
    ).not.toThrow();

    // Non-matching subject even with matching email -> rejected!
    expect(() =>
      assertPlatformAdmin({
        tokenIdentifier: "clerk|user_imposter",
        subject: "user_imposter",
        issuer: "https://clerk.test",
        email: "owner@example.com",
      } as any)
    ).toThrow("You do not have access to this.");
  });
});
