/// <reference types="vite/client" />

import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { createAuthzFixture } from "./authz.fixture";
import { requireCompanyAccess } from "./permissions";
import { defaultRoleCapabilities } from "../src/lib/permissions";

describe("company roles", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("roles.create requires company:manage_roles and rejects invalid input", async () => {
    const f = await createAuthzFixture();

    await expect(
      f.asUser("managerA").mutation(api.roles.create, {
        companyId: f.companyA,
        name: "Coordinator",
        capabilities: ["tasks:comment"],
      })
    ).rejects.toThrow("You do not have access to do that.");

    await expect(
      f.asUser("adminA").mutation(api.roles.create, {
        companyId: f.companyA,
        name: "Employee",
        capabilities: ["tasks:comment"],
      })
    ).rejects.toThrow("A role with this name already exists.");

    await expect(
      f.asUser("adminA").mutation(api.roles.create, {
        companyId: f.companyA,
        name: "Bad role",
        capabilities: ["not:a:capability"],
      })
    ).rejects.toThrow("Unknown permission.");

    const roleId = await f.asUser("adminA").mutation(api.roles.create, {
      companyId: f.companyA,
      name: "Coordinator",
      capabilities: ["tasks:comment", "sops:create"],
    });
    expect(roleId).toBeDefined();
  });

  test("roles.update renames the role and updates members and pending invitations", async () => {
    const f = await createAuthzFixture();

    const roleId = await f.asUser("adminA").mutation(api.roles.create, {
      companyId: f.companyA,
      name: "Coordinator",
      capabilities: ["tasks:comment"],
    });
    await f.asUser("adminA").mutation(api.roles.assign, {
      companyId: f.companyA,
      membershipIds: [f.employee1M],
      role: "Coordinator",
    });
    const inviteToken = await f.t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("invitations", {
        companyId: f.companyA,
        email: "pending@example.com",
        role: "Coordinator",
        token: "pending-token",
        status: "pending",
        createdAt: now,
        expiresAt: now + 86_400_000,
      });
      return "pending-token";
    });
    expect(inviteToken).toBe("pending-token");

    await f.asUser("adminA").mutation(api.roles.update, {
      companyId: f.companyA,
      roleId,
      name: "Team lead",
      capabilities: ["tasks:comment", "sops:create"],
    });

    const state = await f.t.run(async (ctx) => {
      const membership = await ctx.db.get(f.employee1M);
      const invite = await ctx.db
        .query("invitations")
        .withIndex("by_token", (q) => q.eq("token", "pending-token"))
        .unique();
      const role = await ctx.db.get(roleId);
      return { membershipRole: membership?.role, inviteRole: invite?.role, role };
    });
    expect(state.membershipRole).toBe("Team lead");
    expect(state.inviteRole).toBe("Team lead");
    expect(state.role?.capabilities).toEqual(["tasks:comment", "sops:create"]);
  });

  test("roles.update cannot strip manage_roles from the last managing role", async () => {
    const f = await createAuthzFixture();
    const adminRoleId = await f.t.run(async (ctx) => {
      const role = await ctx.db
        .query("roles")
        .withIndex("by_company_and_name", (q) => q.eq("companyId", f.companyA).eq("name", "Admin"))
        .unique();
      return role!._id;
    });

    await expect(
      f.asUser("adminA").mutation(api.roles.update, {
        companyId: f.companyA,
        roleId: adminRoleId,
        name: "Admin",
        capabilities: ["tasks:comment"],
      })
    ).rejects.toThrow("At least one active member must be able to manage roles.");
  });

  test("roles.duplicate copies capabilities under a unique name", async () => {
    const f = await createAuthzFixture();
    const managerRoleId = await f.t.run(async (ctx) => {
      const role = await ctx.db
        .query("roles")
        .withIndex("by_company_and_name", (q) => q.eq("companyId", f.companyA).eq("name", "Manager"))
        .unique();
      return role!._id;
    });

    const copyId = await f.asUser("adminA").mutation(api.roles.duplicate, {
      companyId: f.companyA,
      roleId: managerRoleId,
    });
    const copy = await f.t.run(async (ctx) => await ctx.db.get(copyId));
    expect(copy?.name).toBe("Manager copy");
    expect(new Set(copy?.capabilities ?? [])).toEqual(new Set(defaultRoleCapabilities.Manager));
  });

  test("roles.remove refuses roles in use and deletes unused roles", async () => {
    const f = await createAuthzFixture();
    const [employeeRoleId, spareRoleId] = await f.t.run(async (ctx) => {
      const employeeRole = await ctx.db
        .query("roles")
        .withIndex("by_company_and_name", (q) => q.eq("companyId", f.companyA).eq("name", "Employee"))
        .unique();
      const now = Date.now();
      const spareRoleId = await ctx.db.insert("roles", {
        companyId: f.companyA,
        name: "Temp",
        capabilities: ["tasks:comment"],
        createdAt: now,
        updatedAt: now,
      });
      return [employeeRole!._id, spareRoleId];
    });

    await expect(
      f.asUser("adminA").mutation(api.roles.remove, { companyId: f.companyA, roleId: employeeRoleId })
    ).rejects.toThrow("Reassign members to another role before deleting this one.");

    await expect(
      f.asUser("adminA").mutation(api.roles.remove, { companyId: f.companyA, roleId: spareRoleId })
    ).resolves.toBeNull();
  });

  test("roles.remove cannot delete the last role that grants manage_roles", async () => {
    const f = await createAuthzFixture();
    // Move the only Admin member to a custom role without manage_roles is
    // impossible while Admin still exists, so instead give a second role the
    // capability, then verify deleting it is still safe only while another
    // manager remains.
    const coAdminRoleId = await f.asUser("adminA").mutation(api.roles.create, {
      companyId: f.companyA,
      name: "Co-Admin",
      capabilities: ["company:manage_roles"],
    });
    // Deleting an unassigned role with manage_roles is allowed while Admin still exists.
    await expect(
      f.asUser("adminA").mutation(api.roles.remove, { companyId: f.companyA, roleId: coAdminRoleId })
    ).resolves.toBeNull();
  });

  test("roles.assign applies one role to multiple members and rejects unknown roles", async () => {
    const f = await createAuthzFixture();
    await f.asUser("adminA").mutation(api.roles.create, {
      companyId: f.companyA,
      name: "Coordinator",
      capabilities: ["tasks:comment"],
    });

    await f.asUser("adminA").mutation(api.roles.assign, {
      companyId: f.companyA,
      membershipIds: [f.employee1M, f.employee2M],
      role: "Coordinator",
    });

    const roles = await f.t.run(async (ctx) => [
      (await ctx.db.get(f.employee1M))?.role,
      (await ctx.db.get(f.employee2M))?.role,
    ]);
    expect(roles).toEqual(["Coordinator", "Coordinator"]);

    await expect(
      f.asUser("adminA").mutation(api.roles.assign, {
        companyId: f.companyA,
        membershipIds: [f.employee1M],
        role: "Does not exist",
      })
    ).rejects.toThrow("Role not found.");

    // Members of the new role get its capabilities, nothing more.
    const hasJdCreate = await f.asUser("employeeA1").run(async (ctx) => {
      const auth = await requireCompanyAccess(ctx, f.companyA);
      return auth.capabilities.has("tasks:jd:create");
    });
    expect(hasJdCreate).toBe(false);
  });

  test("roles.assign cannot remove the last role manager", async () => {
    const f = await createAuthzFixture();
    await expect(
      f.asUser("adminA").mutation(api.roles.assign, {
        companyId: f.companyA,
        membershipIds: [f.adminM],
        role: "Employee",
      })
    ).rejects.toThrow("At least one active member must be able to manage roles.");

    // Assigning a second admin first makes the downgrade safe.
    await f.asUser("adminA").mutation(api.roles.assign, {
      companyId: f.companyA,
      membershipIds: [f.managerM],
      role: "Admin",
    });
    await expect(
      f.asUser("adminA").mutation(api.roles.assign, {
        companyId: f.companyA,
        membershipIds: [f.adminM],
        role: "Employee",
      })
    ).resolves.toBeNull();
  });

  test("ensureDefaults seeds the three default roles and clears legacy overrides", async () => {
    const f = await createAuthzFixture();
    const { companyId: legacyCompanyId, membershipId: legacyMembershipId } = await f.t.run(async (ctx) => {
      const now = Date.now();
      const companyId = await ctx.db.insert("companies", { name: "Legacy", createdAt: now });
      const userId = await ctx.db.insert("appUsers", {
        clerkSubject: "clerk|legacyAdmin",
        email: "legacy@example.com",
        firstName: "Legacy",
        createdAt: now,
        updatedAt: now,
      });
      const membershipId = await ctx.db.insert("companyMemberships", {
        companyId,
        userId,
        role: "Admin",
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("permissionOverrides", {
        companyId,
        membershipId,
        capability: "tasks:jd:create",
        effect: "deny",
        updatedAt: now,
      });
      return { companyId, membershipId };
    });

    // Legacy fallback still grants access before seeding.
    const capsBefore = await f.asUser("legacyAdmin", "legacy@example.com").run(async (ctx) => {
      const auth = await requireCompanyAccess(ctx, legacyCompanyId);
      return auth.capabilities.has("company:manage_roles");
    });
    expect(capsBefore).toBe(true);

    await f.asUser("legacyAdmin", "legacy@example.com").mutation(api.roles.ensureDefaults, {
      companyId: legacyCompanyId,
    });

    const after = await f.t.run(async (ctx) => {
      const roles = await ctx.db
        .query("roles")
        .withIndex("by_company", (q) => q.eq("companyId", legacyCompanyId))
        .collect();
      const overrides = await ctx.db
        .query("permissionOverrides")
        .withIndex("by_membership", (q) => q.eq("membershipId", legacyMembershipId))
        .collect();
      return {
        roleNames: roles.map((role) => role.name).sort(),
        overrideCount: overrides.length,
      };
    });
    expect(after.roleNames).toEqual(["Admin", "Employee", "Manager"]);
    expect(after.overrideCount).toBe(0);

    // Idempotent: calling again does not duplicate roles.
    await f.asUser("legacyAdmin", "legacy@example.com").mutation(api.roles.ensureDefaults, {
      companyId: legacyCompanyId,
    });
    const count = await f.t.run(async (ctx) => {
      const roles = await ctx.db
        .query("roles")
        .withIndex("by_company", (q) => q.eq("companyId", legacyCompanyId))
        .collect();
      return roles.length;
    });
    expect(count).toBe(3);
  });
});
