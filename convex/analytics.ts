import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { membershipCapabilities, requireMembership, scopedMembershipIds, visibleSop } from "./permissions";
import type { Doc, Id } from "./_generated/dataModel";

async function allActiveMembershipIds(ctx: QueryCtx, companyId: Id<"companies">) {
  const rows: Doc<"companyMemberships">[] = await ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(500);
  return new Set(rows.filter((m) => m.active).map((m) => m._id));
}

async function analyticsSummary(ctx: QueryCtx, args: { companyId: Id<"companies"> }) {
    const { membership } = await requireMembership(ctx, args.companyId);
    const caps = await membershipCapabilities(ctx, membership);
    if (!caps.has("analytics:view:company") && !caps.has("analytics:view:managed_scope") && !caps.has("analytics:view:self")) throw new ConvexError("You do not have access to analytics.");
    const scoped = caps.has("analytics:view:company") ? await allActiveMembershipIds(ctx, args.companyId) : caps.has("analytics:view:managed_scope") ? await scopedMembershipIds(ctx, args.companyId, membership) : new Set([membership._id]);
    const jd = await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500);
    const one = await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500);
    const visibleJd = jd.filter((t) => scoped.has(t.createdByMembershipId) || t.assigneeMembershipIds.some((id) => scoped.has(id)));
    const visibleOne = one.filter((t) => scoped.has(t.createdByMembershipId) || t.assigneeMembershipIds.some((id) => scoped.has(id)));
    const overdueOne = visibleOne.filter((t) => t.status !== "completed" && (t.overdueAt || (t.dueDate && t.dueDate < Date.now()))).length;
    const completedOne = visibleOne.filter((t) => t.status === "completed").length;
    const sops = await ctx.db.query("sops").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500);
    let sopCount = 0;
    for (const sop of sops) if (await visibleSop(ctx, args.companyId, membership, sop)) sopCount++;
    const recent = membership.role === "Admin"
      ? (await ctx.db.query("auditEvents").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").take(8)).map((event) => ({ _id: event._id, action: event.action, targetType: event.targetType, createdAt: event.createdAt }))
      : [];
    return { role: membership.role, scopeSize: scoped.size, jdTaskCount: visibleJd.length, oneTimeTaskCount: visibleOne.length, overdueTasks: overdueOne, completionRate: visibleOne.length ? Math.round(completedOne / visibleOne.length * 100) : 100, sopCount, recent };
}

export const summary = query({
  args: { companyId: v.id("companies") },
  handler: analyticsSummary,
});

export const aiSummary = query({
  args: { companyId: v.id("companies") },
  handler: analyticsSummary,
});
