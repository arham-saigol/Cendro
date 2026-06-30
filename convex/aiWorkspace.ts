import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { analyticsScopedMembershipIds, membershipCapabilities, requireMembership, scopedMembershipIds, taskHasVisibleAssignee } from "./permissions";

function firstName(user: Doc<"appUsers">) { return user.firstName.trim() || user.email; }
function fullName(user: Doc<"appUsers">) { return [firstName(user), user.secondName?.trim()].filter(Boolean).join(" ") || user.email; }

async function peopleRows(ctx: QueryCtx, companyId: Id<"companies">, ids: Set<Id<"companyMemberships">>, limit: number) {
  const out = [];
  for (const membershipId of Array.from(ids).slice(0, limit)) {
    const membership = await ctx.db.get(membershipId);
    if (!membership || membership.companyId !== companyId || !membership.active) continue;
    const user = await ctx.db.get(membership.userId);
    if (!user) continue;
    out.push({ membershipId: membership._id, name: fullName(user), email: user.email, role: membership.role });
  }
  return out;
}

export const context = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership, company } = await requireMembership(ctx, args.companyId);
    const capabilities = await membershipCapabilities(ctx, membership);
    const scoped = await scopedMembershipIds(ctx, args.companyId, membership);
    return {
      companyName: company.name,
      role: membership.role,
      capabilities: Array.from(capabilities),
      scope: membership.role === "Admin" ? "company" : membership.role === "Manager" ? "managed" : "self",
      visiblePeopleLimit: scoped.size,
      unsupportedActions: ["delete", "remove", "role-change", "permission-change", "bulk-update"],
    };
  },
});

export const peopleInScope = query({
  args: { companyId: v.id("companies"), limit: v.number() },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const limit = Math.min(Math.max(Math.floor(args.limit), 1), 50);
    const ids = await scopedMembershipIds(ctx, args.companyId, membership);
    return await peopleRows(ctx, args.companyId, ids, limit);
  },
});

export const performanceSummary = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const scoped = await analyticsScopedMembershipIds(ctx, args.companyId, membership);
    const oneTime = await ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500);
    const visibleOneTime = oneTime.filter((task) => taskHasVisibleAssignee(task, scoped));
    const completed = visibleOneTime.filter((task) => task.status === "completed").length;
    const overdue = visibleOneTime.filter((task) => task.status !== "completed" && (task.overdueAt || (task.dueDate && task.dueDate < Date.now()))).length;
    const people = await peopleRows(ctx, args.companyId, scoped, 50);
    const byPerson = people.map((person) => {
      const assigned = visibleOneTime.filter((task) => task.assigneeMembershipIds.includes(person.membershipId));
      const personCompleted = assigned.filter((task) => task.status === "completed").length;
      const personOverdue = assigned.filter((task) => task.status !== "completed" && (task.overdueAt || (task.dueDate && task.dueDate < Date.now()))).length;
      return { name: person.name, role: person.role, assignedOneTimeTasks: assigned.length, completedOneTimeTasks: personCompleted, overdueOneTimeTasks: personOverdue };
    });
    return {
      role: membership.role,
      scopeSize: scoped.size,
      oneTimeTaskCount: visibleOneTime.length,
      completedOneTimeTasks: completed,
      overdueOneTimeTasks: overdue,
      completionRate: visibleOneTime.length ? Math.round((completed / visibleOneTime.length) * 100) : 100,
      byPerson: byPerson.slice(0, 20),
    };
  },
});
