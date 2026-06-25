import type { UserIdentity } from "convex/server";
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

export async function currentOrCreateUser(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Please sign in.");
  const email = identity.email ? normalizeEmail(identity.email) : null;
  if (!email) throw new ConvexError("Authenticated email is required.");
  const imageUrl = identity.pictureUrl;
  const now = Date.now();
  const existing = await ctx.db.query("appUsers").withIndex("by_subject", (q) => q.eq("clerkSubject", identity.tokenIdentifier)).unique();
  if (existing) {
    const names = namesForExistingUser(existing, identity, email);
    await ctx.db.replace(existing._id, { clerkSubject: existing.clerkSubject, email, ...names, imageUrl, createdAt: existing.createdAt, updatedAt: now });
    const user = await ctx.db.get(existing._id);
    if (!user) throw new ConvexError("Could not update your profile.");
    return { identity, user };
  }
  const names = namesFromIdentity(identity, email);
  const userId = await ctx.db.insert("appUsers", { clerkSubject: identity.tokenIdentifier, email, ...names, imageUrl, createdAt: now, updatedAt: now });
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
  if (caps.has(`${prefix}:assign:self` as Capability) && assignees.length > 0 && assignees.every((id) => id === m._id)) return;
  throw new ConvexError("You can only assign tasks inside your allowed scope.");
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

async function membershipBranchIds(ctx: Ctx, membershipIds: Set<Id<"companyMemberships">>) {
  const branchIds = new Set<Id<"branches">>();
  for (const membershipId of membershipIds) {
    const rows = await ctx.db.query("userBranchAssignments").withIndex("by_membership", (q) => q.eq("membershipId", membershipId)).take(500);
    for (const row of rows) branchIds.add(row.branchId);
  }
  return branchIds;
}

async function membershipDepartmentIds(ctx: Ctx, membershipIds: Set<Id<"companyMemberships">>) {
  const departmentIds = new Set<Id<"departments">>();
  for (const membershipId of membershipIds) {
    const rows = await ctx.db.query("userDepartmentAssignments").withIndex("by_membership", (q) => q.eq("membershipId", membershipId)).take(500);
    for (const row of rows) departmentIds.add(row.departmentId);
  }
  return departmentIds;
}

export async function visibleSopForSelf(ctx: Ctx, companyId: Id<"companies">, m: Doc<"companyMemberships">, sop: Doc<"sops">) {
  if (sop.companyId !== companyId) return false;
  if (sop.scopeType === "company") return true;
  if (sop.scopeType === "user") {
    const rows = await ctx.db.query("sopUserScopes").withIndex("by_sop", (q) => q.eq("sopId", sop._id)).take(500);
    return rows.some((row) => row.userMembershipId === m._id);
  }
  if (sop.scopeType === "branch") {
    const branchIds = await membershipBranchIds(ctx, new Set([m._id]));
    const sopBranches = await ctx.db.query("sopBranchScopes").withIndex("by_sop", (q) => q.eq("sopId", sop._id)).take(500);
    return sopBranches.some((row) => branchIds.has(row.branchId));
  }
  const departmentIds = await membershipDepartmentIds(ctx, new Set([m._id]));
  const sopDepartments = await ctx.db.query("sopDepartmentScopes").withIndex("by_sop", (q) => q.eq("sopId", sop._id)).take(500);
  return sopDepartments.some((row) => departmentIds.has(row.departmentId));
}

export type SopVisibilityContext = {
  scopedMembershipIds: Set<Id<"companyMemberships">>;
  membershipBranchIds: Set<Id<"branches">>;
  membershipDepartmentIds: Set<Id<"departments">>;
  managerBranchScopes: Set<Id<"branches">>;
  managerDepartmentScopes: Set<Id<"departments">>;
};

export async function buildSopVisibilityContext(ctx: Ctx, companyId: Id<"companies">, m: Doc<"companyMemberships">): Promise<SopVisibilityContext | null> {
  const caps = await membershipCapabilities(ctx, m);
  if (!caps.has("sops:manage:branch") && !caps.has("sops:manage:department") && !caps.has("sops:manage:user")) return null;
  const scoped = await scopedMembershipIds(ctx, companyId, m);
  const membershipBranchSet = await membershipBranchIds(ctx, scoped);
  const membershipDepartmentSet = await membershipDepartmentIds(ctx, scoped);
  const managedBranches = await ctx.db.query("managerBranchScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", m._id)).take(500);
  const managedDepartments = await ctx.db.query("managerDepartmentScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", m._id)).take(500);
  return {
    scopedMembershipIds: scoped,
    membershipBranchIds: membershipBranchSet,
    membershipDepartmentIds: membershipDepartmentSet,
    managerBranchScopes: new Set(managedBranches.map((row) => row.branchId)),
    managerDepartmentScopes: new Set(managedDepartments.map((row) => row.departmentId)),
  };
}

export async function visibleSop(ctx: Ctx, companyId: Id<"companies">, m: Doc<"companyMemberships">, sop: Doc<"sops">, visibility?: SopVisibilityContext | null) {
  if (sop.companyId !== companyId) return false;
  if (m.role === "Admin") return true;
  const caps = await membershipCapabilities(ctx, m);
  if (!caps.has("sops:manage:branch") && !caps.has("sops:manage:department") && !caps.has("sops:manage:user")) return await visibleSopForSelf(ctx, companyId, m, sop);
  if (sop.scopeType === "company") return true;
  const v = visibility ?? await buildSopVisibilityContext(ctx, companyId, m);
  if (!v) return false;
  if (sop.scopeType === "user") {
    const rows = await ctx.db.query("sopUserScopes").withIndex("by_sop", (q) => q.eq("sopId", sop._id)).take(500);
    return rows.some((row) => v.scopedMembershipIds.has(row.userMembershipId));
  }
  if (sop.scopeType === "branch") {
    const sopBranches = await ctx.db.query("sopBranchScopes").withIndex("by_sop", (q) => q.eq("sopId", sop._id)).take(500);
    return sopBranches.some((row) => v.membershipBranchIds.has(row.branchId) || v.managerBranchScopes.has(row.branchId));
  }
  const sopDepartments = await ctx.db.query("sopDepartmentScopes").withIndex("by_sop", (q) => q.eq("sopId", sop._id)).take(500);
  return sopDepartments.some((row) => v.membershipDepartmentIds.has(row.departmentId) || v.managerDepartmentScopes.has(row.departmentId));
}

export function assertPlatformAdminEmail(email?: string | null) {
  if (!isPlatformAdminEmail(email)) throw new ConvexError("You do not have access to this.");
}
