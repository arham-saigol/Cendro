import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { capabilities, defaultRoleCapabilities, type Capability } from "../src/lib/permissions";
import { normalizeEmail } from "./validation";

type Ctx = MutationCtx | QueryCtx;

export function isPlatformAdminEmail(email?: string | null) {
  const configured = process.env.PLATFORM_ADMIN_EMAIL?.toLowerCase();
  return Boolean(configured && email?.toLowerCase() === configured);
}

export async function currentUser(ctx: Ctx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Please sign in.");
  const user = await ctx.db.query("appUsers").withIndex("by_subject", (q) => q.eq("clerkSubject", identity.tokenIdentifier)).unique();
  if (!user) throw new ConvexError("Your profile is still syncing. Refresh in a moment.");
  return { identity, user };
}

export async function currentOrCreateUser(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Please sign in.");
  const email = identity.email ? normalizeEmail(identity.email) : null;
  if (!email) throw new ConvexError("Authenticated email is required.");
  const name = identity.name;
  const imageUrl = identity.pictureUrl;
  const now = Date.now();
  const existing = await ctx.db.query("appUsers").withIndex("by_subject", (q) => q.eq("clerkSubject", identity.tokenIdentifier)).unique();
  if (existing) {
    await ctx.db.patch(existing._id, { email, name, imageUrl, updatedAt: now });
    return { identity, user: { ...existing, email, name, imageUrl, updatedAt: now } };
  }
  const userId = await ctx.db.insert("appUsers", { clerkSubject: identity.tokenIdentifier, email, name, imageUrl, createdAt: now, updatedAt: now });
  const user = await ctx.db.get(userId);
  if (!user) throw new ConvexError("Could not create your profile.");
  return { identity, user };
}

export async function requireMembership(ctx: Ctx, companyId: Id<"companies">) {
  const { user } = await currentUser(ctx);
  const company = await ctx.db.get(companyId);
  if (!company || company.deletedAt) throw new ConvexError("Company not found.");
  const membership = await ctx.db.query("companyMemberships").withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", user._id)).unique();
  if (!membership || !membership.active) throw new ConvexError("You do not have access to this company.");
  return { user, membership, company };
}

export async function membershipCapabilities(ctx: Ctx, m: Doc<"companyMemberships">) {
  const allowed = new Set<Capability>(defaultRoleCapabilities[m.role]);
  const overrides = await ctx.db.query("permissionOverrides").withIndex("by_membership", (q) => q.eq("membershipId", m._id)).take(500);
  for (const o of overrides) {
    if (!capabilities.includes(o.capability as Capability)) continue;
    o.effect === "allow" ? allowed.add(o.capability as Capability) : allowed.delete(o.capability as Capability);
  }
  return allowed;
}

export async function requireCapability(ctx: Ctx, companyId: Id<"companies">, capability: Capability) {
  const auth = await requireMembership(ctx, companyId);
  const caps = await membershipCapabilities(ctx, auth.membership);
  if (!caps.has(capability)) throw new ConvexError("You do not have access to do that.");
  return { ...auth, capabilities: caps };
}

async function addActiveMembership(ctx: Ctx, ids: Set<Id<"companyMemberships">>, companyId: Id<"companies">, id: Id<"companyMemberships">) {
  const candidate = await ctx.db.get(id);
  if (candidate?.companyId === companyId && candidate.active) ids.add(id);
}

export async function scopedMembershipIds(ctx: Ctx, companyId: Id<"companies">, m: Doc<"companyMemberships">) {
  if (m.role === "Admin") {
    const all = await ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(500);
    return new Set(all.filter((x) => x.active).map((x) => x._id));
  }
  if (m.role === "Employee") return new Set<Id<"companyMemberships">>([m._id]);
  const ids = new Set<Id<"companyMemberships">>([m._id]);
  const userScopes = await ctx.db.query("managerUserScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", m._id)).take(500);
  for (const row of userScopes) await addActiveMembership(ctx, ids, companyId, row.userMembershipId);
  const branchScopes = await ctx.db.query("managerBranchScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", m._id)).take(500);
  for (const row of branchScopes) {
    const assignments = await ctx.db.query("userBranchAssignments").withIndex("by_branch", (q) => q.eq("branchId", row.branchId)).take(500);
    for (const assignment of assignments) await addActiveMembership(ctx, ids, companyId, assignment.membershipId);
  }
  const departmentScopes = await ctx.db.query("managerDepartmentScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", m._id)).take(500);
  for (const row of departmentScopes) {
    const assignments = await ctx.db.query("userDepartmentAssignments").withIndex("by_department", (q) => q.eq("departmentId", row.departmentId)).take(500);
    for (const assignment of assignments) await addActiveMembership(ctx, ids, companyId, assignment.membershipId);
  }
  return ids;
}

export async function assertCanAssign(ctx: Ctx, companyId: Id<"companies">, m: Doc<"companyMemberships">, assignees: Id<"companyMemberships">[], kind: "jd" | "one_time") {
  const caps = await membershipCapabilities(ctx, m);
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (caps.has(`${prefix}:assign:any` as Capability)) return;
  if (caps.has(`${prefix}:assign:managed` as Capability)) {
    const scoped = await scopedMembershipIds(ctx, companyId, m);
    if (assignees.every((id) => scoped.has(id))) return;
  }
  if (assignees.length > 0 && assignees.every((id) => id === m._id)) return;
  throw new ConvexError("You can only assign tasks inside your scope.");
}

export async function assertCanUpdateTask(ctx: Ctx, companyId: Id<"companies">, m: Doc<"companyMemberships">, assignees: Id<"companyMemberships">[], kind: "jd" | "one_time") {
  const caps = await membershipCapabilities(ctx, m);
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (caps.has(`${prefix}:update:any` as Capability)) return;
  if (caps.has(`${prefix}:update:managed` as Capability)) {
    const scoped = await scopedMembershipIds(ctx, companyId, m);
    if (assignees.every((id) => scoped.has(id))) return;
  }
  if (caps.has(`${prefix}:update:self` as Capability) && assignees.includes(m._id)) return;
  throw new ConvexError("You cannot update this task.");
}

export async function visibleSop(ctx: Ctx, companyId: Id<"companies">, m: Doc<"companyMemberships">, sop: Doc<"sops">) {
  if (sop.companyId !== companyId) return false;
  if (sop.scopeType === "company" || m.role === "Admin") return true;
  if (sop.scopeType === "user") {
    const rows = await ctx.db.query("sopUserScopes").withIndex("by_sop", (q) => q.eq("sopId", sop._id)).take(500);
    return rows.some((row) => row.userMembershipId === m._id);
  }
  if (sop.scopeType === "branch") {
    const userBranches = await ctx.db.query("userBranchAssignments").withIndex("by_membership", (q) => q.eq("membershipId", m._id)).take(500);
    const sopBranches = await ctx.db.query("sopBranchScopes").withIndex("by_sop", (q) => q.eq("sopId", sop._id)).take(500);
    const branchIds = new Set(userBranches.map((row) => row.branchId));
    return sopBranches.some((row) => branchIds.has(row.branchId));
  }
  const userDepartments = await ctx.db.query("userDepartmentAssignments").withIndex("by_membership", (q) => q.eq("membershipId", m._id)).take(500);
  const sopDepartments = await ctx.db.query("sopDepartmentScopes").withIndex("by_sop", (q) => q.eq("sopId", sop._id)).take(500);
  const departmentIds = new Set(userDepartments.map((row) => row.departmentId));
  return sopDepartments.some((row) => departmentIds.has(row.departmentId));
}

export function assertPlatformAdminEmail(email?: string | null) {
  if (!isPlatformAdminEmail(email)) throw new ConvexError("You do not have access to this.");
}
