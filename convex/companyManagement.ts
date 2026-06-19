import { ConvexError, v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireCapability } from "./permissions";
import { capabilities } from "../src/lib/permissions";

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

export const overview = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "company:manage_permissions");
    const branches = await ctx.db.query("branches").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).collect();
    const departments = await ctx.db.query("departments").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).collect();
    const ms = await ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).collect();
    const users = [];
    for (const m of ms) {
      const user = await ctx.db.get(m.userId);
      const branchIds = (await ctx.db.query("userBranchAssignments").withIndex("by_membership", (q) => q.eq("membershipId", m._id)).collect()).map((a) => a.branchId);
      const departmentIds = (await ctx.db.query("userDepartmentAssignments").withIndex("by_membership", (q) => q.eq("membershipId", m._id)).collect()).map((a) => a.departmentId);
      const scope = await ctx.db.query("managerScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", m._id)).unique();
      const overrides = await ctx.db.query("permissionOverrides").withIndex("by_membership", (q) => q.eq("membershipId", m._id)).collect();
      if (user) users.push({ membership: { _id: m._id, role: m.role, active: m.active }, user: { _id: user._id, name: user.name, email: user.email }, branchIds, departmentIds, scope: scope ? { branchIds: scope.branchIds, departmentIds: scope.departmentIds, userMembershipIds: scope.userMembershipIds } : null, overrides: overrides.map((o) => ({ _id: o._id, capability: o.capability, effect: o.effect })) });
    }
    const invitations = await ctx.db.query("invitations").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).collect();
    return { currentMembership: { _id: membership._id, role: membership.role, active: membership.active }, branches: branches.map((b) => ({ _id: b._id, name: b.name })), departments: departments.map((d) => ({ _id: d._id, branchId: d.branchId, name: d.name })), users, invitations: invitations.map((i) => ({ _id: i._id, email: i.email, role: i.role, status: i.status, createdAt: i.createdAt, expiresAt: i.expiresAt })), capabilities };
  },
});

export const createBranch = mutation({ args: { companyId: v.id("companies"), name: v.string() }, handler: async (ctx, args) => { const { user } = await requireCapability(ctx, args.companyId, "company:manage_branches"); const now = Date.now(); const id = await ctx.db.insert("branches", { companyId: args.companyId, name: args.name.trim(), createdAt: now, updatedAt: now }); await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "branch.create", targetType: "branch", targetId: id, createdAt: now }); return id; } });
export const deleteBranch = mutation({ args: { companyId: v.id("companies"), branchId: v.id("branches") }, handler: async (ctx, args) => { const { user } = await requireCapability(ctx, args.companyId, "company:manage_branches"); await assertBranch(ctx, args.companyId, args.branchId); const deps = await ctx.db.query("departments").withIndex("by_branch", (q) => q.eq("branchId", args.branchId)).collect(); if (deps.length) throw new ConvexError("Delete departments under this branch first."); const assignments = await ctx.db.query("userBranchAssignments").withIndex("by_branch", (q) => q.eq("branchId", args.branchId)).collect(); if (assignments.length) throw new ConvexError("Remove user branch assignments before deleting this branch."); const scopes = await ctx.db.query("managerScopes").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).collect(); if (scopes.some((scope) => scope.branchIds.includes(args.branchId))) throw new ConvexError("Remove manager scopes before deleting this branch."); await ctx.db.delete(args.branchId); await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "branch.delete", targetType: "branch", targetId: args.branchId, createdAt: Date.now() }); } });
export const createDepartment = mutation({ args: { companyId: v.id("companies"), branchId: v.id("branches"), name: v.string() }, handler: async (ctx, args) => { const { user } = await requireCapability(ctx, args.companyId, "company:manage_departments"); await assertBranch(ctx, args.companyId, args.branchId); const now = Date.now(); const id = await ctx.db.insert("departments", { companyId: args.companyId, branchId: args.branchId, name: args.name.trim(), createdAt: now, updatedAt: now }); await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "department.create", targetType: "department", targetId: id, createdAt: now }); return id; } });
export const deleteDepartment = mutation({ args: { companyId: v.id("companies"), departmentId: v.id("departments") }, handler: async (ctx, args) => { await requireCapability(ctx, args.companyId, "company:manage_departments"); await assertDepartment(ctx, args.companyId, args.departmentId); const assignments = await ctx.db.query("userDepartmentAssignments").withIndex("by_department", (q) => q.eq("departmentId", args.departmentId)).collect(); if (assignments.length) throw new ConvexError("Remove user department assignments before deleting this department."); const scopes = await ctx.db.query("managerScopes").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).collect(); if (scopes.some((scope) => scope.departmentIds.includes(args.departmentId))) throw new ConvexError("Remove manager scopes before deleting this department."); await ctx.db.delete(args.departmentId); } });
export const setUserRole = mutation({ args: { companyId: v.id("companies"), membershipId: v.id("companyMemberships"), role: v.union(v.literal("Admin"), v.literal("Manager"), v.literal("Employee")) }, handler: async (ctx, args) => { await requireCapability(ctx, args.companyId, "company:manage_users"); const target = await assertMembership(ctx, args.companyId, args.membershipId); if (target.role === "Admin" && args.role !== "Admin") { let adminCount = 0; for await (const m of ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", args.companyId))) { if (m.active && m.role === "Admin") adminCount++; if (adminCount > 1) break; } if (adminCount <= 1) throw new ConvexError("A company must have at least one active Admin."); } await ctx.db.patch(args.membershipId, { role: args.role, updatedAt: Date.now() }); } });

export const setAssignments = mutation({
  args: { companyId: v.id("companies"), membershipId: v.id("companyMemberships"), branchIds: v.array(v.id("branches")), departmentIds: v.array(v.id("departments")) },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "company:manage_users");
    await assertMembership(ctx, args.companyId, args.membershipId);
    for (const branchId of args.branchIds) await assertBranch(ctx, args.companyId, branchId);
    for (const departmentId of args.departmentIds) await assertDepartment(ctx, args.companyId, departmentId);
    for (const r of await ctx.db.query("userBranchAssignments").withIndex("by_membership", (q) => q.eq("membershipId", args.membershipId)).collect()) await ctx.db.delete(r._id);
    for (const r of await ctx.db.query("userDepartmentAssignments").withIndex("by_membership", (q) => q.eq("membershipId", args.membershipId)).collect()) await ctx.db.delete(r._id);
    for (const branchId of args.branchIds) await ctx.db.insert("userBranchAssignments", { companyId: args.companyId, membershipId: args.membershipId, branchId });
    for (const departmentId of args.departmentIds) await ctx.db.insert("userDepartmentAssignments", { companyId: args.companyId, membershipId: args.membershipId, departmentId });
  },
});

export const setManagerScope = mutation({
  args: { companyId: v.id("companies"), managerMembershipId: v.id("companyMemberships"), branchIds: v.array(v.id("branches")), departmentIds: v.array(v.id("departments")), userMembershipIds: v.array(v.id("companyMemberships")) },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "company:manage_permissions");
    const manager = await assertMembership(ctx, args.companyId, args.managerMembershipId);
    if (manager.role !== "Manager") throw new ConvexError("Only managers can have manager scopes.");
    for (const branchId of args.branchIds) await assertBranch(ctx, args.companyId, branchId);
    for (const departmentId of args.departmentIds) await assertDepartment(ctx, args.companyId, departmentId);
    for (const membershipId of args.userMembershipIds) await assertMembership(ctx, args.companyId, membershipId);
    const existing = await ctx.db.query("managerScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", args.managerMembershipId)).unique();
    const val = { companyId: args.companyId, managerMembershipId: args.managerMembershipId, branchIds: args.branchIds, departmentIds: args.departmentIds, userMembershipIds: args.userMembershipIds, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, val); else await ctx.db.insert("managerScopes", val);
  },
});

export const setPermissionOverride = mutation({
  args: { companyId: v.id("companies"), membershipId: v.id("companyMemberships"), capability: v.string(), effect: v.union(v.literal("allow"), v.literal("deny"), v.literal("inherit")) },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "company:manage_permissions");
    await assertMembership(ctx, args.companyId, args.membershipId);
    if (!capabilities.includes(args.capability as any)) throw new ConvexError("Unknown permission.");
    const rows = await ctx.db.query("permissionOverrides").withIndex("by_membership", (q) => q.eq("membershipId", args.membershipId)).collect();
    for (const row of rows.filter((r) => r.capability === args.capability)) await ctx.db.delete(row._id);
    if (args.effect !== "inherit") await ctx.db.insert("permissionOverrides", { companyId: args.companyId, membershipId: args.membershipId, capability: args.capability, effect: args.effect, updatedAt: Date.now() });
  },
});

export const createInvitationRecord = mutation({ args: { companyId: v.id("companies"), email: v.string(), role: v.union(v.literal("Admin"), v.literal("Manager"), v.literal("Employee")), invitedBy: v.optional(v.id("appUsers")) }, handler: async (ctx, args) => { const { user, capabilities } = await requireCapability(ctx, args.companyId, "company:invite_users"); if (args.role === "Admin" && !capabilities.has("company:manage_permissions")) throw new ConvexError("You cannot invite Admins."); const email = args.email.toLowerCase(); const now = Date.now(); const existing = (await ctx.db.query("invitations").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).collect()).find((i) => i.email === email && i.role === args.role && i.status === "pending" && i.expiresAt > now); if (existing) return { id: existing._id, token: existing.token }; const token = crypto.randomUUID(); const id = await ctx.db.insert("invitations", { companyId: args.companyId, email, role: args.role, token, status: "pending", invitedBy: args.invitedBy ?? user._id, createdAt: now, expiresAt: now + 1_209_600_000 }); return { id, token }; } });
export const authorizeInvite = query({ args: { companyId: v.id("companies") }, handler: async (ctx, args) => { const { user } = await requireCapability(ctx, args.companyId, "company:invite_users"); return { userId: user._id }; } });
export const inviteUser = action({ args: { companyId: v.id("companies"), email: v.string(), role: v.union(v.literal("Admin"), v.literal("Manager"), v.literal("Employee")) }, handler: async (ctx, args): Promise<{ ok: boolean }> => { const auth = await ctx.runQuery(api.companyManagement.authorizeInvite, { companyId: args.companyId }); const invite = await ctx.runMutation(api.companyManagement.createInvitationRecord, { ...args, invitedBy: auth.userId as Id<"appUsers"> }); await ctx.runAction(internal.email.sendInvitation, { companyId: args.companyId, email: args.email, role: args.role, token: invite.token }); return { ok: true }; } });
