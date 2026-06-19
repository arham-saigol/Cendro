import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireMembership, scopedMembershipIds, visibleSop } from "./permissions";

export const summary = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const scoped = await scopedMembershipIds(ctx, args.companyId, membership);
    const jd = await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).collect();
    const one = await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).collect();
    const visibleJd = jd.filter((t) => t.assigneeMembershipIds.some((id) => scoped.has(id)));
    const visibleOne = one.filter((t) => t.assigneeMembershipIds.some((id) => scoped.has(id)));
    const overdueOne = visibleOne.filter((t) => !t.completedAt && t.dueDate < Date.now()).length;
    const completedOne = visibleOne.filter((t) => t.completedAt).length;
    const sops = await ctx.db.query("sops").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).collect();
    let sopCount = 0;
    for (const sop of sops) if (await visibleSop(ctx, args.companyId, membership, sop)) sopCount++;
    const recent = membership.role === "Admin"
      ? (await ctx.db.query("auditEvents").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").take(8)).map((event) => ({ action: event.action, targetType: event.targetType, createdAt: event.createdAt }))
      : [];
    return { role: membership.role, scopeSize: scoped.size, jdTaskCount: visibleJd.length, oneTimeTaskCount: visibleOne.length, overdueTasks: overdueOne, completionRate: visibleOne.length ? Math.round(completedOne / visibleOne.length * 100) : 100, sopCount, recent };
  },
});
