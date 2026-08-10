import { query } from "./_generated/server";
import { currentUser, membershipCapabilities } from "./permissions";

async function companyAccessRows(ctx: Parameters<typeof currentUser>[0], activeOnly: boolean) {
  const { user } = await currentUser(ctx);
  const memberships = await ctx.db.query("companyMemberships").withIndex("by_user", (q) => q.eq("userId", user._id)).take(100);
  if (memberships.length === 100) console.warn("companyAccessRows reached the 100 membership limit; company list may be truncated.");
  const rows = [];
  for (const membership of memberships) {
    if (activeOnly && !membership.active) continue;
    const company = await ctx.db.get(membership.companyId);
    if (company && !company.deletedAt) {
      const caps = membership.active ? await membershipCapabilities(ctx, membership) : new Set();
      rows.push({
        company: { _id: company._id, name: company.name, timeZone: company.timeZone },
        membership: { _id: membership._id, role: membership.role, active: membership.active },
        capabilities: Array.from(caps),
      });
    }
  }
  return rows;
}

async function accessibleCompanies(ctx: Parameters<typeof currentUser>[0]) {
  return await companyAccessRows(ctx, true);
}

export const accessStatus = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { status: "signedOut" as const };

    const user = await ctx.db.query("appUsers").withIndex("by_subject", (q) => q.eq("clerkSubject", identity.tokenIdentifier)).unique();
    if (!user) return { status: "profileMissing" as const, email: identity.email ?? null };

    const companies = await companyAccessRows(ctx, false);
    if (companies.length === 0) return { status: "noCompanies" as const, email: user.email };

    return { status: "ready" as const, email: user.email, companies };
  },
});

export const accessible = query({
  args: {},
  handler: accessibleCompanies,
});
