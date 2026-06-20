import { query } from "./_generated/server";
import { currentUser, membershipCapabilities } from "./permissions";

async function accessibleCompanies(ctx: Parameters<typeof currentUser>[0]) {
  const { user } = await currentUser(ctx);
  const memberships = await ctx.db.query("companyMemberships").withIndex("by_user", (q) => q.eq("userId", user._id)).take(100);
  const rows = [];
  for (const membership of memberships.filter((m) => m.active)) {
    const company = await ctx.db.get(membership.companyId);
    if (company && !company.deletedAt) {
      const caps = await membershipCapabilities(ctx, membership);
      rows.push({ company, membership, capabilities: Array.from(caps) });
    }
  }
  return rows;
}

export const accessStatus = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { status: "signedOut" as const };

    const user = await ctx.db.query("appUsers").withIndex("by_subject", (q) => q.eq("clerkSubject", identity.tokenIdentifier)).unique();
    if (!user) return { status: "profileMissing" as const, email: identity.email ?? null };

    const companies = await accessibleCompanies(ctx);
    if (companies.length === 0) return { status: "noCompanies" as const, email: user.email };

    return { status: "ready" as const, email: user.email, companies };
  },
});

export const accessible = query({
  args: {},
  handler: accessibleCompanies,
});
