import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireMembership } from "./permissions";
import { nonEmpty } from "./validation";

export const getOrCreateSession = mutation({
  args: { companyId: v.id("companies"), sessionId: v.optional(v.id("aiChatSessions")) },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    if (args.sessionId) {
      const existing = await ctx.db.get(args.sessionId);
      if (existing && existing.companyId === args.companyId && existing.membershipId === membership._id) return existing._id;
    }
    const now = Date.now();
    return await ctx.db.insert("aiChatSessions", { companyId: args.companyId, membershipId: membership._id, createdAt: now, updatedAt: now });
  },
});

export const listMessages = query({
  args: { companyId: v.id("companies"), sessionId: v.id("aiChatSessions") },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.companyId !== args.companyId || session.membershipId !== membership._id) throw new ConvexError("Chat session not found.");
    return await ctx.db.query("aiChatMessages").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).take(100);
  },
});

export const appendMessage = mutation({
  args: { companyId: v.id("companies"), sessionId: v.id("aiChatSessions"), role: v.union(v.literal("user"), v.literal("assistant"), v.literal("tool")), content: v.string(), clientMessageId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.companyId !== args.companyId || session.membershipId !== membership._id) throw new ConvexError("Chat session not found.");
    const content = nonEmpty(args.content, "Message");
    const now = Date.now();
    const id = await ctx.db.insert("aiChatMessages", { sessionId: args.sessionId, role: args.role, content, clientMessageId: args.clientMessageId, createdAt: now });
    await ctx.db.patch(args.sessionId, { title: session.title ?? content.slice(0, 80), updatedAt: now });
    return id;
  },
});
