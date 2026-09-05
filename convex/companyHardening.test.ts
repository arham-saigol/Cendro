/// <reference types="vite/client" />

import { beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { createAuthzFixture, identity } from "./authz.fixture";

describe("company management & invitation hardening", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("User without company:manage_permissions cannot invite non-Employee or grant scopes/overrides", async () => {
    const f = await createAuthzFixture();

    // Manager A has company:invite_users but NOT company:manage_permissions
    await f.setOverride(f.companyA, f.managerM, "company:invite_users", "allow");

    await expect(
      f.asUser("managerA").mutation(internal.companyManagement.createInvitationRecord, {
        companyId: f.companyA,
        email: "newmanager@example.com",
        role: "Manager",
      })
    ).rejects.toThrow("You cannot invite non-Employees.");

    await expect(
      f.asUser("managerA").mutation(internal.companyManagement.createInvitationRecord, {
        companyId: f.companyA,
        email: "newadmin@example.com",
        role: "Admin",
      })
    ).rejects.toThrow("You cannot invite non-Employees.");

    await expect(
      f.asUser("managerA").mutation(internal.companyManagement.createInvitationRecord, {
        companyId: f.companyA,
        email: "newemployee@example.com",
        role: "Employee",
        managedBranchIds: [f.branchA1],
      })
    ).rejects.toThrow("You cannot grant managed scopes or permission overrides.");

    // Admin CAN invite Manager or Employee with scopes
    const res = await f.asUser("adminA").mutation(internal.companyManagement.createInvitationRecord, {
      companyId: f.companyA,
      email: "newmanager@example.com",
      role: "Manager",
      managedBranchIds: [f.branchA1],
    });
    expect(res.token).toBeDefined();
  });

  test("Cannot invite a user who is already an active member of the company", async () => {
    const f = await createAuthzFixture();

    await expect(
      f.asUser("adminA").mutation(internal.companyManagement.createInvitationRecord, {
        companyId: f.companyA,
        email: "employeeA1@example.com",
        role: "Employee",
      })
    ).rejects.toThrow("A user with this email is already an active member of this company.");
  });

  test("Reissuing invitation replaces previous pending record and invalidates old token", async () => {
    const f = await createAuthzFixture();

    const first = await f.asUser("adminA").mutation(internal.companyManagement.createInvitationRecord, {
      companyId: f.companyA,
      email: "joinme@example.com",
      role: "Employee",
    });

    const second = await f.asUser("adminA").mutation(internal.companyManagement.createInvitationRecord, {
      companyId: f.companyA,
      email: "joinme@example.com",
      role: "Employee",
    });

    expect(first.token).not.toBe(second.token);

    // Old token is rejected
    await expect(
      f.t.withIdentity(identity("joinme", "joinme@example.com", true)).mutation(api.invitations.accept, {
        token: first.token,
      })
    ).rejects.toThrow("Invitation not found.");

    // New token succeeds
    await expect(
      f.t.withIdentity(identity("joinme", "joinme@example.com", true)).mutation(api.invitations.accept, {
        token: second.token,
      })
    ).resolves.toBeDefined();
  });

  test("Accepting invitation requires emailVerified === true", async () => {
    const f = await createAuthzFixture();

    const invite = await f.asUser("adminA").mutation(internal.companyManagement.createInvitationRecord, {
      companyId: f.companyA,
      email: "unverified@example.com",
      role: "Employee",
    });

    // Unverified email
    await expect(
      f.t.withIdentity(identity("unverified", "unverified@example.com", false)).mutation(api.invitations.accept, {
        token: invite.token,
      })
    ).rejects.toThrow("Email verification is required to accept an invitation.");
  });

  test("Deactivating member clears active scopes and writes audit event", async () => {
    const f = await createAuthzFixture();

    await f.asUser("adminA").mutation(api.companyManagement.setUserActive, {
      companyId: f.companyA,
      membershipId: f.employee1M,
      active: false,
    });

    const branchAssignments = await f.t.run(async (ctx) => {
      return await ctx.db
        .query("userBranchAssignments")
        .withIndex("by_membership", (q) => q.eq("membershipId", f.employee1M))
        .collect();
    });
    expect(branchAssignments.length).toBe(0);

    const auditEvent = await f.t.run(async (ctx) => {
      return await ctx.db
        .query("auditEvents")
        .withIndex("by_company", (q) => q.eq("companyId", f.companyA))
        .filter((q) => q.eq(q.field("action"), "member.deactivate"))
        .first();
    });
    expect(auditEvent).not.toBeNull();
  });

  test("Sole permission manager cannot be deactivated or downgraded", async () => {
    const f = await createAuthzFixture();

    // Try to deactivate sole admin
    await expect(
      f.asUser("adminA").mutation(api.companyManagement.setUserActive, {
        companyId: f.companyA,
        membershipId: f.adminM,
        active: false,
      })
    ).rejects.toThrow("At least one active member must be able to manage permissions.");

    // Try to downgrade sole admin to Employee
    await expect(
      f.asUser("adminA").mutation(api.companyManagement.setUserRole, {
        companyId: f.companyA,
        membershipId: f.adminM,
        role: "Employee",
      })
    ).rejects.toThrow("At least one active member must be able to manage permissions.");
  });

  test("Reissuing invitation revokes matching pending records even with over 500 invitations in the company", async () => {
    const f = await createAuthzFixture();

    const targetEmail = "crowded@example.com";
    const now = Date.now();

    // Insert an initial pending invitation for targetEmail
    const oldInvite = await f.asUser("adminA").mutation(internal.companyManagement.createInvitationRecord, {
      companyId: f.companyA,
      email: targetEmail,
      role: "Employee",
    });

    // Seed 510 dummy pending invitations for companyA so the old invite is well outside an initial 500-item scan
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 510; i++) {
        await ctx.db.insert("invitations", {
          companyId: f.companyA,
          email: `dummy${i}@example.com`,
          role: "Employee",
          token: `dummy-token-${i}`,
          status: "pending",
          expiresAt: now + 86400000,
          createdAt: now,
        });
      }
    });

    // Reissue an invitation for targetEmail
    const newInvite = await f.asUser("adminA").mutation(internal.companyManagement.createInvitationRecord, {
      companyId: f.companyA,
      email: targetEmail,
      role: "Employee",
    });

    // Old token must be revoked
    await expect(
      f.t.withIdentity(identity("crowded", targetEmail, true)).mutation(api.invitations.accept, {
        token: oldInvite.token,
      })
    ).rejects.toThrow("Invitation not found.");

    // New token must succeed
    await expect(
      f.t.withIdentity(identity("crowded", targetEmail, true)).mutation(api.invitations.accept, {
        token: newInvite.token,
      })
    ).resolves.toBeDefined();
  });

  test("Deactivating member preserves permission overrides, and non-permission-admin cannot reactivate a member with manage_permissions", async () => {
    const f = await createAuthzFixture();

    // Give employee1M an override: company:manage_permissions
    await f.setOverride(f.companyA, f.employee1M, "company:manage_permissions", "allow");

    // Deactivate employee1M
    await f.asUser("adminA").mutation(api.companyManagement.setUserActive, {
      companyId: f.companyA,
      membershipId: f.employee1M,
      active: false,
    });

    // Verify permission overrides are STILL preserved
    const overrides = await f.t.run(async (ctx) => {
      return await ctx.db
        .query("permissionOverrides")
        .withIndex("by_membership", (q) => q.eq("membershipId", f.employee1M))
        .collect();
    });
    expect(overrides.length).toBe(1);
    expect(overrides[0].capability).toBe("company:manage_permissions");

    // Give managerA company:manage_users so managerA can activate/deactivate regular users
    await f.setOverride(f.companyA, f.managerM, "company:manage_users", "allow");

    // Manager A does NOT have company:manage_permissions, so trying to reactivate employee1M (who holds company:manage_permissions override) must fail
    await expect(
      f.asUser("managerA").mutation(api.companyManagement.setUserActive, {
        companyId: f.companyA,
        membershipId: f.employee1M,
        active: true,
      })
    ).rejects.toThrow("You do not have access to activate a permission administrator.");

    // Admin A (who has company:manage_permissions) CAN reactivate employee1M
    await expect(
      f.asUser("adminA").mutation(api.companyManagement.setUserActive, {
        companyId: f.companyA,
        membershipId: f.employee1M,
        active: true,
      })
    ).resolves.toBeNull();
  });

  test("clearUserManagementRows deletes all matching rows across multiple batches", async () => {
    const f = await createAuthzFixture();

    // Insert 505 managerUserScopes rows for managerM
    await f.t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 505; i++) {
        await ctx.db.insert("managerUserScopes", {
          companyId: f.companyA,
          managerMembershipId: f.managerM,
          userMembershipId: f.employee1M,
          updatedAt: now,
        });
      }
    });

    const countBefore = await f.t.run(async (ctx) => {
      const rows = await ctx.db
        .query("managerUserScopes")
        .withIndex("by_manager", (q) => q.eq("managerMembershipId", f.managerM))
        .collect();
      return rows.length;
    });
    expect(countBefore).toBeGreaterThan(500);

    // Remove managerM via removeUsers (which calls clearUserManagementRows)
    await f.asUser("adminA").mutation(api.companyManagement.removeUsers, {
      companyId: f.companyA,
      membershipIds: [f.managerM],
    });

    const countAfter = await f.t.run(async (ctx) => {
      const rows = await ctx.db
        .query("managerUserScopes")
        .withIndex("by_manager", (q) => q.eq("managerMembershipId", f.managerM))
        .collect();
      return rows.length;
    });
    expect(countAfter).toBe(0);
  });
});

