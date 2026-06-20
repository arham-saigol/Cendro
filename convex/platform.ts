import { ConvexError, v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { assertPlatformAdminEmail, isPlatformAdminEmail } from "./permissions";

async function platformEmail(ctx: { auth: { getUserIdentity: () => Promise<{ email?: string | null } | null> } }) {
  const identity = await ctx.auth.getUserIdentity();
  assertPlatformAdminEmail(identity?.email);
  return identity?.email || "";
}

export const access = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    return { isAdmin: isPlatformAdminEmail(identity?.email), email: identity?.email ?? null };
  },
});

export const listCompanies = query({
  args: {},
  handler: async (ctx) => {
    await platformEmail(ctx);
    const companies = await ctx.db.query("companies").collect();
    const rows = [];
    for (const company of companies) {
      const memberCount = (await ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", company._id)).collect()).length;
      rows.push({ company, memberCount });
    }
    return rows;
  },
});

export const createCompanyRecord = mutation({
  args: { name: v.string(), adminEmail: v.string() },
  handler: async (ctx, args) => {
    const actorEmail = await platformEmail(ctx);
    const now = Date.now();
    const name = args.name.trim();
    const adminEmail = args.adminEmail.toLowerCase();
    const pendingInvitations = await ctx.db.query("invitations").withIndex("by_email", (q) => q.eq("email", adminEmail)).collect();
    for (const invitation of pendingInvitations) {
      if (invitation.role !== "Admin" || invitation.status !== "pending" || invitation.expiresAt <= now) continue;
      const company = await ctx.db.get(invitation.companyId);
      if (company && !company.deletedAt && company.name === name) return { companyId: company._id, token: invitation.token };
    }
    const companyId = await ctx.db.insert("companies", { name, createdAt: now });
    const token = crypto.randomUUID();
    await ctx.db.insert("invitations", { companyId, email: adminEmail, role: "Admin", token, status: "pending", createdAt: now, expiresAt: now + 1_209_600_000 });
    await ctx.db.insert("auditEvents", { companyId, actorEmail, action: "platform.company_create", targetType: "company", targetId: companyId, createdAt: now });
    return { companyId, token };
  },
});

export const createCompany = action({
  args: { name: v.string(), adminEmail: v.string() },
  handler: async (ctx, args): Promise<{ companyId: string }> => {
    await platformEmail(ctx);
    const created = await ctx.runMutation(api.platform.createCompanyRecord, args);
    await ctx.runAction(internal.email.sendInvitation, { companyId: created.companyId, email: args.adminEmail, role: "Admin", token: created.token });
    return { companyId: created.companyId };
  },
});

export const deleteCompany = mutation({
  args: { companyId: v.id("companies"), confirmation: v.string() },
  handler: async (ctx, args) => {
    const actorEmail = await platformEmail(ctx);
    const company = await ctx.db.get(args.companyId);
    if (!company) throw new ConvexError("Company not found.");
    if (args.confirmation !== company.name) throw new ConvexError("Type the company name to confirm deletion.");
    await ctx.db.patch(args.companyId, { deletedAt: Date.now() });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorEmail, action: "platform.company_delete", targetType: "company", targetId: args.companyId, metadata: { behavior: "Soft delete: child records are retained for audit and the company becomes inaccessible." }, createdAt: Date.now() });
  },
});
