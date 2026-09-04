/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { Capability } from "../src/lib/permissions";

const modules = import.meta.glob("./**/*.ts");

export function identity(key: string, email = `${key.toLowerCase()}@example.com`, emailVerified = true) {
  return {
    tokenIdentifier: `clerk|${key}`,
    subject: key,
    issuer: "https://clerk.test",
    email: email.toLowerCase(),
    emailVerified,
    name: key,
    givenName: key,
    familyName: "User",
  };
}

export type AuthzFixture = Awaited<ReturnType<typeof createAuthzFixture>>;

export async function createAuthzFixture() {
  const t = convexTest(schema, modules);
  const now = Date.now();

  const data = await t.run(async (ctx) => {
    // Company A
    const companyA = await ctx.db.insert("companies", { name: "Company A", createdAt: now });
    const branchA1 = await ctx.db.insert("branches", { companyId: companyA, name: "Branch A1", order: 0, createdAt: now, updatedAt: now });
    const branchA2 = await ctx.db.insert("branches", { companyId: companyA, name: "Branch A2", order: 1, createdAt: now, updatedAt: now });
    const deptA1 = await ctx.db.insert("departments", { companyId: companyA, branchId: branchA1, name: "Dept A1", order: 0, createdAt: now, updatedAt: now });
    const deptA2 = await ctx.db.insert("departments", { companyId: companyA, branchId: branchA2, name: "Dept A2", order: 1, createdAt: now, updatedAt: now });

    // Users & Memberships in Company A
    const adminUser = await ctx.db.insert("appUsers", { clerkSubject: "clerk|adminA", email: "admina@example.com", firstName: "Admin", secondName: "A", createdAt: now, updatedAt: now });
    const adminM = await ctx.db.insert("companyMemberships", { companyId: companyA, userId: adminUser, role: "Admin", active: true, createdAt: now, updatedAt: now });

    const managerUser = await ctx.db.insert("appUsers", { clerkSubject: "clerk|managerA", email: "managera@example.com", firstName: "Manager", secondName: "A", createdAt: now, updatedAt: now });
    const managerM = await ctx.db.insert("companyMemberships", { companyId: companyA, userId: managerUser, role: "Manager", active: true, createdAt: now, updatedAt: now });

    const employee1User = await ctx.db.insert("appUsers", { clerkSubject: "clerk|employeeA1", email: "employeea1@example.com", firstName: "Employee", secondName: "A1", createdAt: now, updatedAt: now });
    const employee1M = await ctx.db.insert("companyMemberships", { companyId: companyA, userId: employee1User, role: "Employee", active: true, createdAt: now, updatedAt: now });

    const employee2User = await ctx.db.insert("appUsers", { clerkSubject: "clerk|employeeA2", email: "employeea2@example.com", firstName: "Employee", secondName: "A2", createdAt: now, updatedAt: now });
    const employee2M = await ctx.db.insert("companyMemberships", { companyId: companyA, userId: employee2User, role: "Employee", active: true, createdAt: now, updatedAt: now });

    const inactiveUser = await ctx.db.insert("appUsers", { clerkSubject: "clerk|inactiveA", email: "inactivea@example.com", firstName: "Inactive", secondName: "A", createdAt: now, updatedAt: now });
    const inactiveM = await ctx.db.insert("companyMemberships", { companyId: companyA, userId: inactiveUser, role: "Employee", active: false, createdAt: now, updatedAt: now });

    // Assignments for Employees
    await ctx.db.insert("userBranchAssignments", { companyId: companyA, membershipId: employee1M, branchId: branchA1 });
    await ctx.db.insert("userDepartmentAssignments", { companyId: companyA, membershipId: employee1M, departmentId: deptA1 });

    await ctx.db.insert("userBranchAssignments", { companyId: companyA, membershipId: employee2M, branchId: branchA2 });
    await ctx.db.insert("userDepartmentAssignments", { companyId: companyA, membershipId: employee2M, departmentId: deptA2 });

    // Scopes for Manager (manages branchA1, deptA1, and employee1M)
    await ctx.db.insert("managerBranchScopes", { companyId: companyA, managerMembershipId: managerM, branchId: branchA1, updatedAt: now });
    await ctx.db.insert("managerDepartmentScopes", { companyId: companyA, managerMembershipId: managerM, departmentId: deptA1, updatedAt: now });
    await ctx.db.insert("managerUserScopes", { companyId: companyA, managerMembershipId: managerM, userMembershipId: employee1M, updatedAt: now });

    // Company B (Isolation)
    const companyB = await ctx.db.insert("companies", { name: "Company B", createdAt: now });
    const branchB1 = await ctx.db.insert("branches", { companyId: companyB, name: "Branch B1", order: 0, createdAt: now, updatedAt: now });
    const deptB1 = await ctx.db.insert("departments", { companyId: companyB, branchId: branchB1, name: "Dept B1", order: 0, createdAt: now, updatedAt: now });

    const adminBUser = await ctx.db.insert("appUsers", { clerkSubject: "clerk|adminB", email: "adminb@example.com", firstName: "Admin", secondName: "B", createdAt: now, updatedAt: now });
    const adminBM = await ctx.db.insert("companyMemberships", { companyId: companyB, userId: adminBUser, role: "Admin", active: true, createdAt: now, updatedAt: now });

    const employeeBUser = await ctx.db.insert("appUsers", { clerkSubject: "clerk|employeeB", email: "employeeb@example.com", firstName: "Employee", secondName: "B", createdAt: now, updatedAt: now });
    const employeeBM = await ctx.db.insert("companyMemberships", { companyId: companyB, userId: employeeBUser, role: "Employee", active: true, createdAt: now, updatedAt: now });

    return {
      companyA,
      branchA1,
      branchA2,
      deptA1,
      deptA2,
      adminUser,
      adminM,
      managerUser,
      managerM,
      employee1User,
      employee1M,
      employee2User,
      employee2M,
      inactiveUser,
      inactiveM,
      companyB,
      branchB1,
      deptB1,
      adminBUser,
      adminBM,
      employeeBUser,
      employeeBM,
    };
  });

  const asUser = (key: string, email?: string) => t.withIdentity(identity(key, email));

  const setOverride = async (
    companyId: Id<"companies">,
    membershipId: Id<"companyMemberships">,
    capability: Capability | string,
    effect: "allow" | "deny"
  ) => {
    await t.run(async (ctx) => {
      await ctx.db.insert("permissionOverrides", {
        companyId,
        membershipId,
        capability,
        effect,
        updatedAt: Date.now(),
      });
    });
  };

  return {
    t,
    ...data,
    asUser,
    setOverride,
  };
}
