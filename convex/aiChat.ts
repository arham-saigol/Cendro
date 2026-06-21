import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { membershipCapabilities, requireMembership } from "./permissions";
import { nonEmpty } from "./validation";

function safeTitle(value: string) {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

const aiRateLimitConfigs = {
  "ai-chat": { limit: 20, windowMs: 60_000 },
  "ai-title": { limit: 10, windowMs: 60_000 },
} as const;

async function assertSession(ctx: any, companyId: any, sessionId: any) {
  const { membership, user } = await requireMembership(ctx, companyId);
  const session = await ctx.db.get(sessionId);
  if (!session || session.companyId !== companyId || session.membershipId !== membership._id) throw new ConvexError("Chat session not found.");
  return { session, membership, user };
}

export const consumeRateLimit = mutation({
  args: { kind: v.union(v.literal("ai-chat"), v.literal("ai-title")) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Authentication required.");

    const now = Date.now();
    const expired = await ctx.db.query("aiRateLimits").withIndex("by_resetAt", (q) => q.lt("resetAt", now)).take(20);
    for (const bucket of expired) await ctx.db.delete(bucket._id);

    const config = aiRateLimitConfigs[args.kind];
    const key = `${args.kind}:${identity.tokenIdentifier}`;
    const bucket = await ctx.db.query("aiRateLimits").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (!bucket) {
      await ctx.db.insert("aiRateLimits", { key, count: 1, resetAt: now + config.windowMs, updatedAt: now });
      return { ok: true as const };
    }
    if (bucket.resetAt <= now) {
      await ctx.db.patch(bucket._id, { count: 1, resetAt: now + config.windowMs, updatedAt: now });
      return { ok: true as const };
    }
    if (bucket.count >= config.limit) return { ok: false as const, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
    await ctx.db.patch(bucket._id, { count: bucket.count + 1, updatedAt: now });
    return { ok: true as const };
  },
});

export const listSessions = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const rows = await ctx.db.query("aiChatSessions").withIndex("by_membership", (q) => q.eq("membershipId", membership._id)).take(50);
    return rows
      .filter((row) => row.companyId === args.companyId && row.hasMessages)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((row) => ({ _id: row._id, title: row.title, createdAt: row.createdAt, updatedAt: row.updatedAt }));
  },
});

export const createSession = mutation({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const now = Date.now();
    return await ctx.db.insert("aiChatSessions", { companyId: args.companyId, membershipId: membership._id, hasMessages: false, createdAt: now, updatedAt: now });
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
    return await ctx.db.insert("aiChatSessions", { companyId: args.companyId, membershipId: membership._id, hasMessages: false, createdAt: now, updatedAt: now });
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
      const existing = await ctx.db.query("aiChatMessages").withIndex("by_session_and_clientMessageId", (q) => q.eq("sessionId", args.sessionId).eq("clientMessageId", args.clientMessageId)).unique();
      if (existing) return existing._id;
    }
    const now = Date.now();
    const id = await ctx.db.insert("aiChatMessages", { sessionId: args.sessionId, role: args.role, content, clientMessageId: args.clientMessageId, createdAt: now });
    await ctx.db.patch(session._id, { hasMessages: true, updatedAt: now });
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

export const deleteSession = mutation({
  args: { companyId: v.id("companies"), sessionId: v.id("aiChatSessions") },
  handler: async (ctx, args) => {
    await assertSession(ctx, args.companyId, args.sessionId);
    const messages = await ctx.db.query("aiChatMessages").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).take(100);
    for (const message of messages) await ctx.db.delete(message._id);
    await ctx.db.delete(args.sessionId);
    return null;
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
