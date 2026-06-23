import { mutation, query } from "./_generated/server";
import type { UserIdentity } from "convex/server";
import { ConvexError, v } from "convex/values";
import { currentUser } from "./permissions";
import { normalizeEmail } from "./validation";

function cleanNamePart(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nameFields(firstName: string, secondName: string) {
  const cleanSecondName = secondName.trim();
  return cleanSecondName ? { firstName, secondName: cleanSecondName } : { firstName };
}

function namesFromIdentity(identity: UserIdentity, email: string) {
  return nameFields(cleanNamePart(identity.givenName) || cleanNamePart(identity.name) || email, cleanNamePart(identity.familyName));
}

function namesForExistingUser(existing: { firstName?: unknown; secondName?: unknown }, identity: UserIdentity, email: string) {
  const names = namesFromIdentity(identity, email);
  const firstName = typeof existing.firstName === "string" ? cleanNamePart(existing.firstName) || email : names.firstName;
  const secondName = typeof existing.secondName === "string" ? cleanNamePart(existing.secondName) : names.secondName ?? "";
  return nameFields(firstName, secondName);
}

export const syncCurrentUser = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const email = identity.email ? normalizeEmail(identity.email) : null;
    if (!email) throw new ConvexError("Authenticated email is required.");
    const imageUrl = identity.pictureUrl;
    const now = Date.now();
    const existing = await ctx.db.query("appUsers").withIndex("by_subject", (q) => q.eq("clerkSubject", identity.tokenIdentifier)).unique();
    if (existing) {
      const names = namesForExistingUser(existing, identity, email);
      await ctx.db.replace(existing._id, { clerkSubject: existing.clerkSubject, email, ...names, imageUrl, createdAt: existing.createdAt, updatedAt: now });
      return existing._id;
    }
    const names = namesFromIdentity(identity, email);
    return await ctx.db.insert("appUsers", { clerkSubject: identity.tokenIdentifier, email, ...names, imageUrl, createdAt: now, updatedAt: now });
  },
});

export const updateCurrentName = mutation({
  args: { firstName: v.string(), secondName: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { user } = await currentUser(ctx);
    const firstName = args.firstName.trim();
    const secondName = args.secondName?.trim() ?? "";
    if (!firstName) throw new ConvexError("First name is required.");
    await ctx.db.replace(user._id, { clerkSubject: user.clerkSubject, email: user.email, ...nameFields(firstName, secondName), imageUrl: user.imageUrl, createdAt: user.createdAt, updatedAt: Date.now() });
    return user._id;
  },
});

export const me = query({ args: {}, handler: async (ctx) => { try { return (await currentUser(ctx)).user; } catch { return null; } } });
