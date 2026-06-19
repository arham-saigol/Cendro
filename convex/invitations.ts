import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { currentUser } from "./permissions";

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
    const { user } = await currentUser(ctx);
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
    await ctx.db.patch(invitation._id, { status: "accepted" });
    await ctx.db.insert("auditEvents", { companyId: invitation.companyId, actorUserId: user._id, action: "invitation.accept", targetType: "membership", targetId: membershipId, metadata: { role: invitation.role }, createdAt: now });
    return { companyId: invitation.companyId };
  },
});
