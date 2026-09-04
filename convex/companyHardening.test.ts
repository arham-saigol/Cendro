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
});
