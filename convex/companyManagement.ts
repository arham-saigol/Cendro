import { ConvexError, v } from "convex/values";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { membershipCapabilities, requireCapability } from "./permissions";
import { capabilities, defaultRoleCapabilities, type Capability, type Role } from "../src/lib/permissions";
import { nonEmpty, normalizeEmail } from "./validation";

const roleValidator = v.union(v.literal("Admin"), v.literal("Manager"), v.literal("Employee"));
const invitationOverrideValidator = v.object({ capability: v.string(), effect: v.union(v.literal("allow"), v.literal("deny")) });
const permissionDraftOverrideValidator = v.object({ capability: v.string(), effect: v.union(v.literal("allow"), v.literal("deny"), v.literal("inherit")) });

async function assertBranch(ctx: any, companyId: Id<"companies">, branchId: Id<"branches">) {
  const branch = await ctx.db.get(branchId);
  if (!branch || branch.companyId !== companyId) throw new ConvexError("Branch not found.");
  return branch;
}
async function assertDepartment(ctx: any, companyId: Id<"companies">, departmentId: Id<"departments">) {
  const department = await ctx.db.get(departmentId);
  if (!department || department.companyId !== companyId) throw new ConvexError("Department not found.");
  return department;
}
async function assertMembership(ctx: any, companyId: Id<"companies">, membershipId: Id<"companyMemberships">) {
  const membership = await ctx.db.get(membershipId);
  if (!membership || membership.companyId !== companyId) throw new ConvexError("User not found in this company.");
  return membership;
}
function unique<T>(items: T[]) { return Array.from(new Set(items)); }
function assertSameIdSet<T>(actual: T[], expected: T[], message: string) {
  if (new Set(actual).size !== actual.length || actual.length !== expected.length) throw new ConvexError(message);
  const expectedSet = new Set(expected);
  if (actual.some((id) => !expectedSet.has(id))) throw new ConvexError(message);
}
function firstName(user: Doc<"appUsers">) { return user.firstName.trim() || user.email; }
function fullName(user: Doc<"appUsers">) { return [firstName(user), user.secondName?.trim()].filter(Boolean).join(" ") || user.email; }

async function validatePermissionOverrides(overrides: { capability: string }[], requireAll = false) {
  const seen = new Set<string>();
  for (const override of overrides) {
    if (!capabilities.includes(override.capability as Capability)) throw new ConvexError("Unknown permission.");
    if (seen.has(override.capability)) throw new ConvexError("Duplicate permission override.");
    seen.add(override.capability);
  }
  if (requireAll && seen.size !== capabilities.length) throw new ConvexError("Permission draft is incomplete.");
}

async function managerScope(ctx: any, managerMembershipId: Id<"companyMemberships">) {
  const branchIds = (await ctx.db.query("managerBranchScopes").withIndex("by_manager", (q: any) => q.eq("managerMembershipId", managerMembershipId)).take(500)).map((row: any) => row.branchId);
  const departmentIds = (await ctx.db.query("managerDepartmentScopes").withIndex("by_manager", (q: any) => q.eq("managerMembershipId", managerMembershipId)).take(500)).map((row: any) => row.departmentId);
  const userMembershipIds = (await ctx.db.query("managerUserScopes").withIndex("by_manager", (q: any) => q.eq("managerMembershipId", managerMembershipId)).take(500)).map((row: any) => row.userMembershipId);
  return { branchIds, departmentIds, userMembershipIds };
}

type OverrideChange = { membershipId: Id<"companyMemberships">; capability: Capability; effect: "allow" | "deny" | "inherit" };
async function effectiveCapsAfter(ctx: any, membership: Doc<"companyMemberships">, nextRole?: Role, overrides: OverrideChange[] = []) {
  const allowed = new Set<Capability>(defaultRoleCapabilities[nextRole ?? membership.role]);
  const changes = overrides.filter((override) => override.membershipId === membership._id);
  const rows = await ctx.db.query("permissionOverrides").withIndex("by_membership", (q: any) => q.eq("membershipId", membership._id)).take(500);
  for (const row of rows) {
    if (!capabilities.includes(row.capability as Capability)) continue;
    if (changes.some((override) => override.capability === row.capability)) continue;
    row.effect === "allow" ? allowed.add(row.capability as Capability) : allowed.delete(row.capability as Capability);
  }
  for (const override of changes) if (override.effect !== "inherit") override.effect === "allow" ? allowed.add(override.capability) : allowed.delete(override.capability);
  return allowed;
}
async function assertPermissionManagerRemains(ctx: any, companyId: Id<"companies">, changedMembershipId: Id<"companyMemberships">, nextRole?: Role, override?: OverrideChange | OverrideChange[]) {
  const overrides = override ? Array.isArray(override) ? override : [override] : [];
  const memberships = await ctx.db.query("companyMemberships").withIndex("by_company", (q: any) => q.eq("companyId", companyId)).take(500);
  for (const membership of memberships) {
    if (!membership.active) continue;
    const caps = await effectiveCapsAfter(ctx, membership, membership._id === changedMembershipId ? nextRole : undefined, overrides);
    if (caps.has("company:manage_permissions")) return;
  }
  throw new ConvexError("At least one active member must be able to manage permissions.");
}

async function assertPermissionManagerRemainsAfterActiveChanges(ctx: any, companyId: Id<"companies">, activeChanges: Map<Id<"companyMemberships">, boolean>) {
  const memberships = await ctx.db.query("companyMemberships").withIndex("by_company", (q: any) => q.eq("companyId", companyId)).take(500);
  for (const membership of memberships) {
    const active = activeChanges.get(membership._id) ?? membership.active;
    if (!active) continue;
    const caps = await membershipCapabilities(ctx, membership);
    if (caps.has("company:manage_permissions")) return;
  }
  throw new ConvexError("At least one active member must be able to manage permissions.");
}

async function clearUserManagementRows(ctx: any, membershipId: Id<"companyMemberships">) {
  for (const row of await ctx.db.query("userBranchAssignments").withIndex("by_membership", (q: any) => q.eq("membershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
  for (const row of await ctx.db.query("userDepartmentAssignments").withIndex("by_membership", (q: any) => q.eq("membershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
  for (const row of await ctx.db.query("managerBranchScopes").withIndex("by_manager", (q: any) => q.eq("managerMembershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
  for (const row of await ctx.db.query("managerDepartmentScopes").withIndex("by_manager", (q: any) => q.eq("managerMembershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
  for (const row of await ctx.db.query("managerUserScopes").withIndex("by_manager", (q: any) => q.eq("managerMembershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
  for (const row of await ctx.db.query("managerUserScopes").withIndex("by_user", (q: any) => q.eq("userMembershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
  for (const row of await ctx.db.query("permissionOverrides").withIndex("by_membership", (q: any) => q.eq("membershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
}

export const overview = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "company:manage_permissions");
    const company = await ctx.db.get(args.companyId);
    if (!company || company.deletedAt) throw new ConvexError("Company not found.");
    const branches = (await ctx.db.query("branches").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
    const departments = (await ctx.db.query("departments").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
    const ms = await ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500);
    const users = [];
    for (const m of ms) {
      const user = await ctx.db.get(m.userId);
      const branchIds = (await ctx.db.query("userBranchAssignments").withIndex("by_membership", (q) => q.eq("membershipId", m._id)).take(500)).map((a) => a.branchId);
      const departmentIds = (await ctx.db.query("userDepartmentAssignments").withIndex("by_membership", (q) => q.eq("membershipId", m._id)).take(500)).map((a) => a.departmentId);
      const scope = await managerScope(ctx, m._id);
      const overrides = await ctx.db.query("permissionOverrides").withIndex("by_membership", (q) => q.eq("membershipId", m._id)).take(500);
      if (user) users.push({ membership: { _id: m._id, role: m.role, active: m.active, createdAt: m.createdAt }, user: { _id: user._id, name: fullName(user), firstName: firstName(user), secondName: user.secondName ?? "", email: user.email }, branchIds, departmentIds, scope, overrides: overrides.map((o) => ({ _id: o._id, capability: o.capability, effect: o.effect })) });
    }
    const invitations = await ctx.db.query("invitations").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").take(100);
    return {
      company: { _id: company._id, name: company.name },
      currentMembership: { _id: membership._id, role: membership.role, active: membership.active, createdAt: membership.createdAt },
      branches: branches.map((b) => ({ _id: b._id, name: b.name, order: b.order })),
      departments: departments.map((d) => ({ _id: d._id, branchId: d.branchId, name: d.name, order: d.order })),
      users,
      invitations: invitations.map((i) => ({ _id: i._id, email: i.email, role: i.role, status: i.status, createdAt: i.createdAt, expiresAt: i.expiresAt, branchIds: i.branchIds ?? [], departmentIds: i.departmentIds ?? [], managedBranchIds: i.managedBranchIds ?? [], managedDepartmentIds: i.managedDepartmentIds ?? [], managedUserMembershipIds: i.managedUserMembershipIds ?? [], permissionOverrides: i.permissionOverrides ?? [] })),
      capabilities,
    };
  },
});

export const updateCompanyName = mutation({
  args: { companyId: v.id("companies"), name: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireCapability(ctx, args.companyId, "company:manage_settings");
    const company = await ctx.db.get(args.companyId);
    if (!company || company.deletedAt) throw new ConvexError("Company not found.");
    const name = nonEmpty(args.name, "Company name");
    await ctx.db.patch(args.companyId, { name });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "company.update", targetType: "company", targetId: args.companyId, createdAt: Date.now() });
  },
});

export const createBranch = mutation({ args: { companyId: v.id("companies"), name: v.string() }, handler: async (ctx, args) => { const { user } = await requireCapability(ctx, args.companyId, "company:manage_branches"); const now = Date.now(); const count = (await ctx.db.query("branches").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500)).length; const id = await ctx.db.insert("branches", { companyId: args.companyId, name: nonEmpty(args.name, "Branch name"), order: count, createdAt: now, updatedAt: now }); await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "branch.create", targetType: "branch", targetId: id, createdAt: now }); return id; } });
export const deleteBranch = mutation({ args: { companyId: v.id("companies"), branchId: v.id("branches") }, handler: async (ctx, args) => { const { user } = await requireCapability(ctx, args.companyId, "company:manage_branches"); await assertBranch(ctx, args.companyId, args.branchId); const deps = await ctx.db.query("departments").withIndex("by_branch", (q) => q.eq("branchId", args.branchId)).take(1); if (deps.length) throw new ConvexError("Delete departments under this branch first."); const assignments = await ctx.db.query("userBranchAssignments").withIndex("by_branch", (q) => q.eq("branchId", args.branchId)).take(1); if (assignments.length) throw new ConvexError("Remove user branch assignments before deleting this branch."); const scopes = await ctx.db.query("managerBranchScopes").withIndex("by_branch", (q) => q.eq("branchId", args.branchId)).take(1); if (scopes.length) throw new ConvexError("Remove managed scopes before deleting this branch."); const sopScopes = await ctx.db.query("sopBranchScopes").withIndex("by_branch", (q) => q.eq("branchId", args.branchId)).take(1); if (sopScopes.length) throw new ConvexError("Remove SOP scopes before deleting this branch."); await ctx.db.delete(args.branchId); await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "branch.delete", targetType: "branch", targetId: args.branchId, createdAt: Date.now() }); } });
export const createDepartment = mutation({ args: { companyId: v.id("companies"), branchId: v.id("branches"), name: v.string() }, handler: async (ctx, args) => { const { user } = await requireCapability(ctx, args.companyId, "company:manage_departments"); await assertBranch(ctx, args.companyId, args.branchId); const now = Date.now(); const count = (await ctx.db.query("departments").withIndex("by_branch", (q) => q.eq("branchId", args.branchId)).take(500)).length; const id = await ctx.db.insert("departments", { companyId: args.companyId, branchId: args.branchId, name: nonEmpty(args.name, "Department name"), order: count, createdAt: now, updatedAt: now }); await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "department.create", targetType: "department", targetId: id, createdAt: now }); return id; } });
export const deleteDepartment = mutation({ args: { companyId: v.id("companies"), departmentId: v.id("departments") }, handler: async (ctx, args) => { const { user } = await requireCapability(ctx, args.companyId, "company:manage_departments"); await assertDepartment(ctx, args.companyId, args.departmentId); const assignments = await ctx.db.query("userDepartmentAssignments").withIndex("by_department", (q) => q.eq("departmentId", args.departmentId)).take(1); if (assignments.length) throw new ConvexError("Remove user department assignments before deleting this department."); const scopes = await ctx.db.query("managerDepartmentScopes").withIndex("by_department", (q) => q.eq("departmentId", args.departmentId)).take(1); if (scopes.length) throw new ConvexError("Remove managed scopes before deleting this department."); const sopScopes = await ctx.db.query("sopDepartmentScopes").withIndex("by_department", (q) => q.eq("departmentId", args.departmentId)).take(1); if (sopScopes.length) throw new ConvexError("Remove SOP scopes before deleting this department."); await ctx.db.delete(args.departmentId); await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "department.delete", targetType: "department", targetId: args.departmentId, createdAt: Date.now() }); } });

export const reorderBranches = mutation({
  args: { companyId: v.id("companies"), orderedBranchIds: v.array(v.id("branches")) },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "company:manage_branches");
    const currentBranches = await ctx.db.query("branches").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500);
    assertSameIdSet(args.orderedBranchIds, currentBranches.map((branch) => branch._id), "Branch order is stale. Refresh and try again.");

    const branchesById = new Map(currentBranches.map((branch) => [branch._id, branch]));
    const now = Date.now();
    for (let i = 0; i < args.orderedBranchIds.length; i++) {
      const branch = branchesById.get(args.orderedBranchIds[i]);
      if (!branch) throw new ConvexError("Branch order is stale. Refresh and try again.");
      await ctx.db.patch(branch._id, { order: i, updatedAt: now });
    }
  },
});

export const moveDepartment = mutation({
  args: { companyId: v.id("companies"), departmentId: v.id("departments"), toBranchId: v.id("branches"), orderedDepartmentIds: v.array(v.id("departments")) },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "company:manage_departments");
    const department = await assertDepartment(ctx, args.companyId, args.departmentId);
    await assertBranch(ctx, args.companyId, args.toBranchId);

    const currentDestinationDepartments = await ctx.db.query("departments").withIndex("by_branch", (q) => q.eq("branchId", args.toBranchId)).take(500);
    const currentDestinationIds = currentDestinationDepartments.map((dep) => dep._id);
    const expectedDestinationIds = currentDestinationIds.includes(department._id) ? currentDestinationIds : [...currentDestinationIds, department._id];
    assertSameIdSet(args.orderedDepartmentIds, expectedDestinationIds, "Department order is stale. Refresh and try again.");

    const orderedDepartments: Doc<"departments">[] = [];
    for (const departmentId of args.orderedDepartmentIds) {
      const dep = await assertDepartment(ctx, args.companyId, departmentId);
      if (dep._id !== department._id && dep.branchId !== args.toBranchId) throw new ConvexError("Department order is stale. Refresh and try again.");
      orderedDepartments.push(dep);
    }

    const now = Date.now();
    for (let i = 0; i < orderedDepartments.length; i++) {
      await ctx.db.patch(orderedDepartments[i]._id, { branchId: args.toBranchId, order: i, updatedAt: now });
    }

    if (department.branchId !== args.toBranchId) {
      const sourceDepartments = (await ctx.db.query("departments").withIndex("by_branch", (q) => q.eq("branchId", department.branchId)).take(500)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
      for (let i = 0; i < sourceDepartments.length; i++) await ctx.db.patch(sourceDepartments[i]._id, { order: i, updatedAt: now });
    }
  },
});
export const setUserRole = mutation({
  args: { companyId: v.id("companies"), membershipId: v.id("companyMemberships"), role: roleValidator },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "company:manage_permissions");
    await assertMembership(ctx, args.companyId, args.membershipId);
    const inheritAll = capabilities.map((capability) => ({ membershipId: args.membershipId, capability, effect: "inherit" as const }));
    await assertPermissionManagerRemains(ctx, args.companyId, args.membershipId, args.role, inheritAll);
    await ctx.db.patch(args.membershipId, { role: args.role, updatedAt: Date.now() });
    for (const row of await ctx.db.query("permissionOverrides").withIndex("by_membership", (q) => q.eq("membershipId", args.membershipId)).take(500)) await ctx.db.delete(row._id);
  },
});

export const setUserActive = mutation({
  args: { companyId: v.id("companies"), membershipId: v.id("companyMemberships"), active: v.boolean() },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "company:manage_users");
    const membership = await assertMembership(ctx, args.companyId, args.membershipId);
    if (membership.active === args.active) return null;
    await assertPermissionManagerRemainsAfterActiveChanges(ctx, args.companyId, new Map([[args.membershipId, args.active]]));
    await ctx.db.patch(args.membershipId, { active: args.active, updatedAt: Date.now() });
    return null;
  },
});

export const removeUsers = mutation({
  args: { companyId: v.id("companies"), membershipIds: v.array(v.id("companyMemberships")) },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "company:manage_users");
    const membershipIds = unique(args.membershipIds);
    for (const membershipId of membershipIds) await assertMembership(ctx, args.companyId, membershipId);
    await assertPermissionManagerRemainsAfterActiveChanges(ctx, args.companyId, new Map(membershipIds.map((membershipId) => [membershipId, false])));
    const now = Date.now();
    for (const membershipId of membershipIds) {
      await clearUserManagementRows(ctx, membershipId);
      await ctx.db.patch(membershipId, { active: false, updatedAt: now });
    }
    return null;
  },
});

export const setAssignments = mutation({
  args: { companyId: v.id("companies"), membershipId: v.id("companyMemberships"), branchIds: v.array(v.id("branches")), departmentIds: v.array(v.id("departments")) },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "company:manage_users");
    await assertMembership(ctx, args.companyId, args.membershipId);
    const branchIds = unique(args.branchIds);
    const departmentIds = unique(args.departmentIds);
    for (const branchId of branchIds) await assertBranch(ctx, args.companyId, branchId);
    for (const departmentId of departmentIds) await assertDepartment(ctx, args.companyId, departmentId);
    for (const r of await ctx.db.query("userBranchAssignments").withIndex("by_membership", (q) => q.eq("membershipId", args.membershipId)).take(500)) await ctx.db.delete(r._id);
    for (const r of await ctx.db.query("userDepartmentAssignments").withIndex("by_membership", (q) => q.eq("membershipId", args.membershipId)).take(500)) await ctx.db.delete(r._id);
    for (const branchId of branchIds) await ctx.db.insert("userBranchAssignments", { companyId: args.companyId, membershipId: args.membershipId, branchId });
    for (const departmentId of departmentIds) await ctx.db.insert("userDepartmentAssignments", { companyId: args.companyId, membershipId: args.membershipId, departmentId });
  },
});

export const setManagerScope = mutation({
  args: { companyId: v.id("companies"), managerMembershipId: v.id("companyMemberships"), branchIds: v.array(v.id("branches")), departmentIds: v.array(v.id("departments")), userMembershipIds: v.array(v.id("companyMemberships")) },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "company:manage_permissions");
    await assertMembership(ctx, args.companyId, args.managerMembershipId);
    const branchIds = unique(args.branchIds);
    const departmentIds = unique(args.departmentIds);
    const userMembershipIds = unique(args.userMembershipIds).filter((id) => id !== args.managerMembershipId);
    for (const branchId of branchIds) await assertBranch(ctx, args.companyId, branchId);
    for (const departmentId of departmentIds) await assertDepartment(ctx, args.companyId, departmentId);
    for (const membershipId of userMembershipIds) await assertMembership(ctx, args.companyId, membershipId);
    for (const r of await ctx.db.query("managerBranchScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", args.managerMembershipId)).take(500)) await ctx.db.delete(r._id);
    for (const r of await ctx.db.query("managerDepartmentScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", args.managerMembershipId)).take(500)) await ctx.db.delete(r._id);
    for (const r of await ctx.db.query("managerUserScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", args.managerMembershipId)).take(500)) await ctx.db.delete(r._id);
    const updatedAt = Date.now();
    for (const branchId of branchIds) await ctx.db.insert("managerBranchScopes", { companyId: args.companyId, managerMembershipId: args.managerMembershipId, branchId, updatedAt });
    for (const departmentId of departmentIds) await ctx.db.insert("managerDepartmentScopes", { companyId: args.companyId, managerMembershipId: args.managerMembershipId, departmentId, updatedAt });
    for (const userMembershipId of userMembershipIds) await ctx.db.insert("managerUserScopes", { companyId: args.companyId, managerMembershipId: args.managerMembershipId, userMembershipId, updatedAt });
  },
});

export const setPermissionOverride = mutation({
  args: { companyId: v.id("companies"), membershipId: v.id("companyMemberships"), capability: v.string(), effect: v.union(v.literal("allow"), v.literal("deny"), v.literal("inherit")) },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "company:manage_permissions");
    await assertMembership(ctx, args.companyId, args.membershipId);
    if (!capabilities.includes(args.capability as any)) throw new ConvexError("Unknown permission.");
    await assertPermissionManagerRemains(ctx, args.companyId, args.membershipId, undefined, { membershipId: args.membershipId, capability: args.capability as Capability, effect: args.effect });
    const rows = await ctx.db.query("permissionOverrides").withIndex("by_membership", (q) => q.eq("membershipId", args.membershipId)).take(500);
    for (const row of rows.filter((r) => r.capability === args.capability)) await ctx.db.delete(row._id);
    if (args.effect !== "inherit") await ctx.db.insert("permissionOverrides", { companyId: args.companyId, membershipId: args.membershipId, capability: args.capability, effect: args.effect, updatedAt: Date.now() });
  },
});

export const setUserPermissions = mutation({
  args: {
    companyId: v.id("companies"),
    membershipId: v.id("companyMemberships"),
    role: roleValidator,
    branchIds: v.array(v.id("branches")),
    departmentIds: v.array(v.id("departments")),
    managedBranchIds: v.array(v.id("branches")),
    managedDepartmentIds: v.array(v.id("departments")),
    managedUserMembershipIds: v.array(v.id("companyMemberships")),
    permissionOverrides: v.array(permissionDraftOverrideValidator),
  },
  handler: async (ctx, args) => {
    const { capabilities: caps } = await requireCapability(ctx, args.companyId, "company:manage_permissions");
    if (!caps.has("company:manage_users")) throw new ConvexError("You do not have access to do that.");
    await assertMembership(ctx, args.companyId, args.membershipId);
    const branchIds = unique(args.branchIds);
    const departmentIds = unique(args.departmentIds);
    const managedBranchIds = unique(args.managedBranchIds);
    const managedDepartmentIds = unique(args.managedDepartmentIds);
    const managedUserMembershipIds = unique(args.managedUserMembershipIds).filter((id) => id !== args.membershipId);
    await validatePermissionOverrides(args.permissionOverrides, true);
    const overrideChanges = args.permissionOverrides.map((override) => ({ membershipId: args.membershipId, capability: override.capability as Capability, effect: override.effect }));
    await assertPermissionManagerRemains(ctx, args.companyId, args.membershipId, args.role, overrideChanges);
    for (const branchId of [...branchIds, ...managedBranchIds]) await assertBranch(ctx, args.companyId, branchId);
    for (const departmentId of [...departmentIds, ...managedDepartmentIds]) await assertDepartment(ctx, args.companyId, departmentId);
    for (const membershipId of managedUserMembershipIds) await assertMembership(ctx, args.companyId, membershipId);
    const now = Date.now();
    await ctx.db.patch(args.membershipId, { role: args.role, updatedAt: now });
    for (const r of await ctx.db.query("userBranchAssignments").withIndex("by_membership", (q) => q.eq("membershipId", args.membershipId)).take(500)) await ctx.db.delete(r._id);
    for (const r of await ctx.db.query("userDepartmentAssignments").withIndex("by_membership", (q) => q.eq("membershipId", args.membershipId)).take(500)) await ctx.db.delete(r._id);
    for (const branchId of branchIds) await ctx.db.insert("userBranchAssignments", { companyId: args.companyId, membershipId: args.membershipId, branchId });
    for (const departmentId of departmentIds) await ctx.db.insert("userDepartmentAssignments", { companyId: args.companyId, membershipId: args.membershipId, departmentId });
    for (const r of await ctx.db.query("managerBranchScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", args.membershipId)).take(500)) await ctx.db.delete(r._id);
    for (const r of await ctx.db.query("managerDepartmentScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", args.membershipId)).take(500)) await ctx.db.delete(r._id);
    for (const r of await ctx.db.query("managerUserScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", args.membershipId)).take(500)) await ctx.db.delete(r._id);
    for (const branchId of managedBranchIds) await ctx.db.insert("managerBranchScopes", { companyId: args.companyId, managerMembershipId: args.membershipId, branchId, updatedAt: now });
    for (const departmentId of managedDepartmentIds) await ctx.db.insert("managerDepartmentScopes", { companyId: args.companyId, managerMembershipId: args.membershipId, departmentId, updatedAt: now });
    for (const userMembershipId of managedUserMembershipIds) await ctx.db.insert("managerUserScopes", { companyId: args.companyId, managerMembershipId: args.membershipId, userMembershipId, updatedAt: now });
    for (const row of await ctx.db.query("permissionOverrides").withIndex("by_membership", (q) => q.eq("membershipId", args.membershipId)).take(500)) await ctx.db.delete(row._id);
    for (const override of args.permissionOverrides) if (override.effect !== "inherit") await ctx.db.insert("permissionOverrides", { companyId: args.companyId, membershipId: args.membershipId, capability: override.capability, effect: override.effect, updatedAt: now });
  },
});

export const createInvitationRecord = internalMutation({
  args: { companyId: v.id("companies"), email: v.string(), role: roleValidator, branchIds: v.optional(v.array(v.id("branches"))), departmentIds: v.optional(v.array(v.id("departments"))), managedBranchIds: v.optional(v.array(v.id("branches"))), managedDepartmentIds: v.optional(v.array(v.id("departments"))), managedUserMembershipIds: v.optional(v.array(v.id("companyMemberships"))), permissionOverrides: v.optional(v.array(invitationOverrideValidator)) },
  handler: async (ctx, args) => {
    const { user, capabilities: caps } = await requireCapability(ctx, args.companyId, "company:invite_users");
    if (args.role === "Admin" && !caps.has("company:manage_permissions")) throw new ConvexError("You cannot invite Admins.");
    const branchIds = unique(args.branchIds ?? []);
    const departmentIds = unique(args.departmentIds ?? []);
    const managedBranchIds = unique(args.managedBranchIds ?? []);
    const managedDepartmentIds = unique(args.managedDepartmentIds ?? []);
    const managedUserMembershipIds = unique(args.managedUserMembershipIds ?? []);
    const permissionOverrides = args.permissionOverrides ?? [];
    if ((managedBranchIds.length || managedDepartmentIds.length || managedUserMembershipIds.length || permissionOverrides.length) && !caps.has("company:manage_permissions")) throw new ConvexError("You cannot grant managed scopes or permission overrides.");
    for (const branchId of [...branchIds, ...managedBranchIds]) await assertBranch(ctx, args.companyId, branchId);
    for (const departmentId of [...departmentIds, ...managedDepartmentIds]) await assertDepartment(ctx, args.companyId, departmentId);
    for (const membershipId of managedUserMembershipIds) await assertMembership(ctx, args.companyId, membershipId);
    await validatePermissionOverrides(permissionOverrides);
    const email = normalizeEmail(args.email);
    const now = Date.now();
    const existing = (await ctx.db.query("invitations").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500)).find((i) => i.email === email && i.status === "pending" && i.expiresAt > now);
    const patch = { role: args.role, branchIds, departmentIds, managedBranchIds, managedDepartmentIds, managedUserMembershipIds, permissionOverrides, expiresAt: now + 1_209_600_000 };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return { id: existing._id, token: existing.token };
    }
    const token = crypto.randomUUID();
    const id = await ctx.db.insert("invitations", { companyId: args.companyId, email, ...patch, token, status: "pending", invitedBy: user._id, createdAt: now });
    return { id, token };
  },
});

export const inviteUser = action({
  args: { companyId: v.id("companies"), email: v.string(), role: roleValidator, branchIds: v.optional(v.array(v.id("branches"))), departmentIds: v.optional(v.array(v.id("departments"))), managedBranchIds: v.optional(v.array(v.id("branches"))), managedDepartmentIds: v.optional(v.array(v.id("departments"))), managedUserMembershipIds: v.optional(v.array(v.id("companyMemberships"))), permissionOverrides: v.optional(v.array(invitationOverrideValidator)) },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const invite = await ctx.runMutation(internal.companyManagement.createInvitationRecord, args);
    await ctx.runAction(internal.email.sendInvitation, { companyId: args.companyId, invitationId: invite.id, email: args.email, role: args.role, token: invite.token });
    return { ok: true };
  },
});
