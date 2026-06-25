import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { currentOrCreateUser } from "./permissions";
import { capabilities, type Capability } from "../src/lib/permissions";

export const preview = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const invitation = await ctx.db.query("invitations").withIndex("by_token", (q) => q.eq("token", args.token)).unique();
    if (!invitation || invitation.status !== "pending" || invitation.expiresAt < Date.now()) return null;
    const company = await ctx.db.get(invitation.companyId);
    if (!company || company.deletedAt) return null;
    return { role: invitation.role, companyName: company.name };
  },
});

export const accept = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const { user } = await currentOrCreateUser(ctx);
    const invitation = await ctx.db.query("invitations").withIndex("by_token", (q) => q.eq("token", args.token)).unique();
    if (!invitation || invitation.status !== "pending") throw new ConvexError("Invitation not found.");
    if (invitation.expiresAt < Date.now()) throw new ConvexError("This invitation has expired.");
    if (invitation.email.toLowerCase() !== user.email.toLowerCase()) throw new ConvexError("This invitation was sent to a different email address.");
    const company = await ctx.db.get(invitation.companyId);
    if (!company || company.deletedAt) throw new ConvexError("Company not found.");
    const now = Date.now();
    const existing = await ctx.db.query("companyMemberships").withIndex("by_company_user", (q) => q.eq("companyId", invitation.companyId).eq("userId", user._id)).unique();
    const membershipId = existing
      ? existing._id
      : await ctx.db.insert("companyMemberships", { companyId: invitation.companyId, userId: user._id, role: invitation.role, active: true, createdAt: now, updatedAt: now });
    if (existing) await ctx.db.patch(existing._id, { role: invitation.role, active: true, updatedAt: now });

    const branchIds = invitation.branchIds ?? [];
    const departmentIds = invitation.departmentIds ?? [];
    const managedBranchIds = invitation.managedBranchIds ?? [];
    const managedDepartmentIds = invitation.managedDepartmentIds ?? [];
    const managedUserMembershipIds = invitation.managedUserMembershipIds ?? [];
    for (const branchId of [...branchIds, ...managedBranchIds]) { const branch = await ctx.db.get(branchId); if (!branch || branch.companyId !== invitation.companyId) throw new ConvexError("Invitation contains an invalid branch."); }
    for (const departmentId of [...departmentIds, ...managedDepartmentIds]) { const department = await ctx.db.get(departmentId); if (!department || department.companyId !== invitation.companyId) throw new ConvexError("Invitation contains an invalid department."); }
    for (const userMembershipId of managedUserMembershipIds) { const scopedMembership = await ctx.db.get(userMembershipId); if (!scopedMembership || scopedMembership.companyId !== invitation.companyId || !scopedMembership.active) throw new ConvexError("Invitation contains an invalid managed user."); }

    for (const row of await ctx.db.query("userBranchAssignments").withIndex("by_membership", (q) => q.eq("membershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
    for (const row of await ctx.db.query("userDepartmentAssignments").withIndex("by_membership", (q) => q.eq("membershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
    for (const branchId of branchIds) await ctx.db.insert("userBranchAssignments", { companyId: invitation.companyId, membershipId, branchId });
    for (const departmentId of departmentIds) await ctx.db.insert("userDepartmentAssignments", { companyId: invitation.companyId, membershipId, departmentId });

    for (const row of await ctx.db.query("managerBranchScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
    for (const row of await ctx.db.query("managerDepartmentScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
    for (const row of await ctx.db.query("managerUserScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
    for (const branchId of managedBranchIds) await ctx.db.insert("managerBranchScopes", { companyId: invitation.companyId, managerMembershipId: membershipId, branchId, updatedAt: now });
    for (const departmentId of managedDepartmentIds) await ctx.db.insert("managerDepartmentScopes", { companyId: invitation.companyId, managerMembershipId: membershipId, departmentId, updatedAt: now });
    for (const userMembershipId of managedUserMembershipIds) if (userMembershipId !== membershipId) await ctx.db.insert("managerUserScopes", { companyId: invitation.companyId, managerMembershipId: membershipId, userMembershipId, updatedAt: now });

    for (const row of await ctx.db.query("permissionOverrides").withIndex("by_membership", (q) => q.eq("membershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
    for (const override of invitation.permissionOverrides ?? []) {
      if (!capabilities.includes(override.capability as Capability)) continue;
      await ctx.db.insert("permissionOverrides", { companyId: invitation.companyId, membershipId, capability: override.capability, effect: override.effect, updatedAt: now });
    }

    await ctx.db.patch(invitation._id, { status: "accepted" });
    await ctx.db.insert("auditEvents", { companyId: invitation.companyId, actorUserId: user._id, action: "invitation.accept", targetType: "membership", targetId: membershipId, metadata: { role: invitation.role }, createdAt: now });
    return { companyId: invitation.companyId };
  },
});

export const markSent = internalMutation({
  args: { invitationId: v.id("invitations") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.invitationId, { sentAt: Date.now() });
  },
});
