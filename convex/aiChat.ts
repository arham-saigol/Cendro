import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { membershipCapabilities, requireMembership } from "./permissions";
import { nonEmpty } from "./validation";

function safeTitle(value: string) {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

async function assertSession(ctx: any, companyId: any, sessionId: any) {
  const { membership, user } = await requireMembership(ctx, companyId);
  const session = await ctx.db.get(sessionId);
  if (!session || session.companyId !== companyId || session.membershipId !== membership._id) throw new ConvexError("Chat session not found.");
  return { session, membership, user };
}

export const listSessions = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const rows = await ctx.db.query("aiChatSessions").withIndex("by_membership", (q) => q.eq("membershipId", membership._id)).take(50);
    return rows
      .filter((row) => row.companyId === args.companyId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((row) => ({ _id: row._id, title: row.title, createdAt: row.createdAt, updatedAt: row.updatedAt }));
  },
});

export const createSession = mutation({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const now = Date.now();
    return await ctx.db.insert("aiChatSessions", { companyId: args.companyId, membershipId: membership._id, createdAt: now, updatedAt: now });
  },
});

export const getSession = query({
  args: { companyId: v.id("companies"), sessionId: v.id("aiChatSessions") },
  handler: async (ctx, args) => {
    const { session } = await assertSession(ctx, args.companyId, args.sessionId);
    return { _id: session._id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt };
  },
});

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

export const authorizeSessionForAgent = query({
  args: { companyId: v.id("companies"), sessionId: v.id("aiChatSessions") },
  handler: async (ctx, args) => {
    const { membership } = await assertSession(ctx, args.companyId, args.sessionId);
    const capabilities = await membershipCapabilities(ctx, membership);
    return { membershipId: membership._id, role: membership.role, capabilities: Array.from(capabilities) };
  },
});

export const listMessages = query({
  args: { companyId: v.id("companies"), sessionId: v.id("aiChatSessions") },
  handler: async (ctx, args) => {
    await assertSession(ctx, args.companyId, args.sessionId);
    return (await ctx.db.query("aiChatMessages").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).take(100)).sort((a, b) => a.createdAt - b.createdAt);
  },
});

export const appendMessage = mutation({
  args: { companyId: v.id("companies"), sessionId: v.id("aiChatSessions"), role: v.union(v.literal("user"), v.literal("assistant"), v.literal("tool")), content: v.string(), clientMessageId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { session } = await assertSession(ctx, args.companyId, args.sessionId);
    const content = nonEmpty(args.content, "Message");
    if (args.clientMessageId) {
      const existing = await ctx.db.query("aiChatMessages").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).take(100);
      if (existing.some((message) => message.clientMessageId === args.clientMessageId)) return existing.find((message) => message.clientMessageId === args.clientMessageId)!._id;
    }
    const now = Date.now();
    const id = await ctx.db.insert("aiChatMessages", { sessionId: args.sessionId, role: args.role, content, clientMessageId: args.clientMessageId, createdAt: now });
    await ctx.db.patch(session._id, { updatedAt: now });
    return id;
  },
});

export const setSessionTitle = mutation({
  args: { companyId: v.id("companies"), sessionId: v.id("aiChatSessions"), title: v.string() },
  handler: async (ctx, args) => {
    await assertSession(ctx, args.companyId, args.sessionId);
    const title = safeTitle(args.title);
    if (!title) throw new ConvexError("Title is required.");
    await ctx.db.patch(args.sessionId, { title, updatedAt: Date.now() });
    return title;
  },
});

export const recordToolAudit = mutation({
  args: { companyId: v.id("companies"), sessionId: v.id("aiChatSessions"), toolName: v.string(), ok: v.boolean(), risk: v.union(v.literal("read"), v.literal("write"), v.literal("external")) },
  handler: async (ctx, args) => {
    const { user } = await assertSession(ctx, args.companyId, args.sessionId);
    if (args.risk !== "write") return null;
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "ai.tool", targetType: "aiChatSession", targetId: args.sessionId, metadata: { toolName: args.toolName, ok: args.ok, risk: args.risk }, createdAt: Date.now() });
    return null;
  },
});
