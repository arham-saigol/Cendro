import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { membershipCapabilities, requireMembership, scopedMembershipIds, visibleSop } from "./permissions";
import type { Id } from "./_generated/dataModel";

async function allActiveMembershipIds(ctx: any, companyId: Id<"companies">) {
  const rows = await ctx.db.query("companyMemberships").withIndex("by_company", (q: any) => q.eq("companyId", companyId)).take(500);
  return new Set(rows.filter((m: any) => m.active).map((m: any) => m._id));
}

export const summary = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const caps = await membershipCapabilities(ctx, membership);
    if (!caps.has("analytics:view:company") && !caps.has("analytics:view:managed_scope") && !caps.has("analytics:view:self")) throw new ConvexError("You do not have access to analytics.");
    const scoped = caps.has("analytics:view:company") ? await allActiveMembershipIds(ctx, args.companyId) : caps.has("analytics:view:managed_scope") ? await scopedMembershipIds(ctx, args.companyId, membership) : new Set([membership._id]);
    const jd = await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500);
    const one = await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500);
    const visibleJd = jd.filter((t) => t.assigneeMembershipIds.some((id) => scoped.has(id)));
    const visibleOne = one.filter((t) => t.assigneeMembershipIds.some((id) => scoped.has(id)));
    const overdueOne = visibleOne.filter((t) => !t.completedAt && t.dueDate < Date.now()).length;
    const completedOne = visibleOne.filter((t) => t.completedAt).length;
    const sops = await ctx.db.query("sops").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500);
    let sopCount = 0;
    for (const sop of sops) if (await visibleSop(ctx, args.companyId, membership, sop)) sopCount++;
    const recent = membership.role === "Admin"
      ? (await ctx.db.query("auditEvents").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").take(8)).map((event) => ({ _id: event._id, action: event.action, targetType: event.targetType, createdAt: event.createdAt }))
      : [];
    return { role: membership.role, scopeSize: scoped.size, jdTaskCount: visibleJd.length, oneTimeTaskCount: visibleOne.length, overdueTasks: overdueOne, completionRate: visibleOne.length ? Math.round(completedOne / visibleOne.length * 100) : 100, sopCount, recent };
  },
});
