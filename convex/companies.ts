import { query } from "./_generated/server";
import { currentUser, memberFullName, membershipCapabilities } from "./permissions";

async function companyAccessRows(ctx: Parameters<typeof currentUser>[0], activeOnly: boolean) {
  const { user } = await currentUser(ctx);
  const memberships = await ctx.db.query("companyMemberships").withIndex("by_user", (q) => q.eq("userId", user._id)).take(100);
  if (memberships.length === 100) console.warn("companyAccessRows reached the 100 membership limit; company list may be truncated.");
  const rows = await Promise.all(
    memberships
      .filter((membership) => !activeOnly || membership.active)
      .map(async (membership) => {
        const [company, caps] = await Promise.all([
          ctx.db.get(membership.companyId),
          membership.active ? membershipCapabilities(ctx, membership) : new Set<string>(),
        ]);
        if (!company || company.deletedAt) return null;
        return {
          company: { _id: company._id, name: company.name, timeZone: company.timeZone },
          membership: { _id: membership._id, role: membership.role, active: membership.active, firstName: membership.firstName, secondName: membership.secondName },
          displayName: memberFullName(membership, user),
          capabilities: Array.from(caps),
        };
      }),
  );
  return rows.filter((row) => row !== null);
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
  handler: async (ctx) => await companyAccessRows(ctx, true),
});
