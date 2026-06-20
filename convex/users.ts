import { mutation, query } from "./_generated/server";
import { ConvexError } from "convex/values";
import { currentUser } from "./permissions";
import { normalizeEmail } from "./validation";

export const syncCurrentUser = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const email = identity.email ? normalizeEmail(identity.email) : null;
    if (!email) throw new ConvexError("Authenticated email is required.");
    const name = identity.name;
    const imageUrl = identity.pictureUrl;
    const now = Date.now();
    const existing = await ctx.db.query("appUsers").withIndex("by_subject", (q) => q.eq("clerkSubject", identity.tokenIdentifier)).unique();
    if (existing) {
      await ctx.db.patch(existing._id, { email, name, imageUrl, updatedAt: now });
      return existing._id;
    }
    return await ctx.db.insert("appUsers", { clerkSubject: identity.tokenIdentifier, email, name, imageUrl, createdAt: now, updatedAt: now });
  },
});

export const me = query({ args: {}, handler: async (ctx) => { try { return (await currentUser(ctx)).user; } catch { return null; } } });
