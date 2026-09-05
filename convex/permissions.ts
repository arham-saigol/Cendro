import type { UserIdentity } from "convex/server";
import { ConvexError } from "convex/values";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  resolveEffectiveCapabilities,
  type Capability,
  type Role,
} from "../src/lib/permissions";
import { isPlatformAdmin } from "../src/lib/platform-admin";
import { normalizeEmail } from "./validation";

type Ctx = MutationCtx | QueryCtx;

export type CompanyAuthContext = {
  identity: UserIdentity;
  user: Doc<"appUsers">;
  company: Doc<"companies">;
  membership: Doc<"companyMemberships">;
  capabilities: Set<Capability>;
};

export function isPlatformAdminSubject(subject?: string | null) {
  return isPlatformAdmin(subject);
}

export function assertPlatformAdmin(identity: UserIdentity | null | undefined) {
  if (!identity || !isPlatformAdminSubject(identity.subject)) {
    throw new ConvexError("You do not have access to this.");
  }
}

// Deprecated email check - preserved only for safe closed fallback
export function isPlatformAdminEmail() {
  return false;
}
export function assertPlatformAdminEmail() {
  throw new ConvexError("You do not have access to this.");
}

export async function currentUser(ctx: Ctx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Please sign in.");
  const user = await ctx.db
    .query("appUsers")
    .withIndex("by_subject", (q) => q.eq("clerkSubject", identity.tokenIdentifier))
    .unique();
  if (!user) throw new ConvexError("Your profile is still syncing. Refresh in a moment.");
  return { identity, user };
}

export type { Role };
export type OverrideChange = {
  membershipId: Id<"companyMemberships">;
  capability: Capability;
  effect: "allow" | "deny" | "inherit";
};

export function cleanNamePart(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function nameFields(firstName: string, secondName: string) {
  const cleanSecondName = secondName.trim();
  return cleanSecondName ? { firstName, secondName: cleanSecondName } : { firstName };
}

export function namesFromIdentity(identity: UserIdentity, email: string) {
  return nameFields(
    cleanNamePart(identity.givenName) || cleanNamePart(identity.name) || email,
    cleanNamePart(identity.familyName)
  );
}

export function namesForExistingUser(
  existing: { firstName?: unknown; secondName?: unknown },
  identity: UserIdentity,
  email: string
) {
  const names = namesFromIdentity(identity, email);
  const firstName =
    typeof existing.firstName === "string" ? cleanNamePart(existing.firstName) || email : names.firstName;
  const secondName =
    typeof existing.secondName === "string" ? cleanNamePart(existing.secondName) : names.secondName ?? "";
  return nameFields(firstName, secondName);
}

export function memberFirstName(
  membership: { firstName?: string } | null | undefined,
  user: { firstName: string; email: string }
) {
  return membership?.firstName?.trim() || user.firstName.trim() || user.email;
}

export function memberFullName(
  membership: { firstName?: string; secondName?: string } | null | undefined,
  user: { firstName: string; secondName?: string; email: string }
) {
  const first = memberFirstName(membership, user);
  const second =
    membership?.secondName !== undefined ? membership.secondName.trim() : user.secondName?.trim() ?? "";
  return [first, second].filter(Boolean).join(" ") || user.email;
}

export async function membershipCapabilities(ctx: Ctx, m: Doc<"companyMemberships">) {
  const overrides = await ctx.db
    .query("permissionOverrides")
    .withIndex("by_membership", (q) => q.eq("membershipId", m._id))
    .take(500);
  return resolveEffectiveCapabilities(
    m.role,
    overrides.map((o) => ({ capability: o.capability, effect: o.effect }))
  );
}

export async function effectiveCapsAfter(
  ctx: Ctx,
  membership: Doc<"companyMemberships">,
  nextRole?: Role,
  overrides: OverrideChange[] = []
) {
  const rows = await ctx.db
    .query("permissionOverrides")
    .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
    .take(500);
  const changes = overrides.filter((override) => override.membershipId === membership._id);
  const combinedOverrides: Array<{ capability: string; effect: "allow" | "deny" | "inherit" }> = [];

  for (const row of rows) {
    if (!changes.some((c) => c.capability === row.capability)) {
      combinedOverrides.push({ capability: row.capability, effect: row.effect });
    }
  }
  for (const change of changes) {
    combinedOverrides.push(change);
  }

  return resolveEffectiveCapabilities(nextRole ?? membership.role, combinedOverrides);
}

export async function assertPermissionManagerRemains(
  ctx: Ctx,
  companyId: Id<"companies">,
  changedMembershipId: Id<"companyMemberships">,
  nextRole?: Role,
  override?: OverrideChange | OverrideChange[],
  nextActive?: boolean
) {
  const overrides = override ? (Array.isArray(override) ? override : [override]) : [];
  const memberships = await ctx.db
    .query("companyMemberships")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .take(500);
  for (const membership of memberships) {
    const isActive = membership._id === changedMembershipId ? (nextActive ?? true) : membership.active;
    if (!isActive) continue;
    const caps = await effectiveCapsAfter(
      ctx,
      membership,
      membership._id === changedMembershipId ? nextRole : undefined,
      overrides
    );
    if (caps.has("company:manage_permissions")) return;
  }
  throw new ConvexError("At least one active member must be able to manage permissions.");
}

export async function assertPermissionManagerRemainsAfterActiveChanges(
  ctx: Ctx,
  companyId: Id<"companies">,
  activeChanges: Map<Id<"companyMemberships">, boolean>
) {
  const memberships = await ctx.db
    .query("companyMemberships")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .take(500);
  for (const membership of memberships) {
    const active = activeChanges.get(membership._id) ?? membership.active;
    if (!active) continue;
    const caps = await membershipCapabilities(ctx, membership);
    if (caps.has("company:manage_permissions")) return;
  }
  throw new ConvexError("At least one active member must be able to manage permissions.");
}

export async function currentOrCreateUser(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Please sign in.");
  const email = identity.email ? normalizeEmail(identity.email) : null;
  if (!email) throw new ConvexError("Authenticated email is required.");
  const imageUrl = identity.pictureUrl;
  const now = Date.now();
  const existing = await ctx.db
    .query("appUsers")
    .withIndex("by_subject", (q) => q.eq("clerkSubject", identity.tokenIdentifier))
    .unique();
  if (existing) {
    const names = namesForExistingUser(existing, identity, email);
    await ctx.db.replace(existing._id, {
      clerkSubject: existing.clerkSubject,
      email,
      ...names,
      imageUrl,
      createdAt: existing.createdAt,
      updatedAt: now,
    });
    const user = await ctx.db.get(existing._id);
    if (!user) throw new ConvexError("Could not update your profile.");
    return { identity, user };
  }
  const names = namesFromIdentity(identity, email);
  const userId = await ctx.db.insert("appUsers", {
    clerkSubject: identity.tokenIdentifier,
    email,
    ...names,
    imageUrl,
    createdAt: now,
    updatedAt: now,
  });
  const user = await ctx.db.get(userId);
  if (!user) throw new ConvexError("Could not create your profile.");
  return { identity, user };
}

export async function requireCompanyAccess(
  ctx: Ctx,
  companyId: Id<"companies">
): Promise<CompanyAuthContext> {
  const { identity, user } = await currentUser(ctx);
  const company = await ctx.db.get(companyId);
  if (!company || company.deletedAt) throw new ConvexError("Company not found.");
  const membership = await ctx.db
    .query("companyMemberships")
    .withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", user._id))
    .unique();
  if (!membership || !membership.active) throw new ConvexError("You do not have access to this company.");
  const caps = await membershipCapabilities(ctx, membership);
  return { identity, user, company, membership, capabilities: caps };
}

export async function requireMembership(ctx: Ctx, companyId: Id<"companies">) {
  const auth = await requireCompanyAccess(ctx, companyId);
  return {
    user: auth.user,
    membership: auth.membership,
    company: auth.company,
    capabilities: auth.capabilities,
    identity: auth.identity,
  };
}

export async function requireCapability(ctx: Ctx, companyId: Id<"companies">, capability: Capability) {
  const auth = await requireCompanyAccess(ctx, companyId);
  if (!auth.capabilities.has(capability)) throw new ConvexError("You do not have access to do that.");
  return auth;
}

export async function assertCompanyDocument<Table extends TableNames>(
  ctx: Ctx,
  companyId: Id<"companies">,
  table: Table,
  id: Id<Table>,
  notFoundMessage = "Resource not found."
): Promise<Doc<Table>> {
  const doc = await ctx.db.get(id);
  if (!doc || (doc as any).companyId !== companyId) {
    throw new ConvexError(notFoundMessage);
  }
  return doc;
}

async function addActiveMembership(
  ctx: Ctx,
  ids: Set<Id<"companyMemberships">>,
  companyId: Id<"companies">,
  id: Id<"companyMemberships">
) {
  const candidate = await ctx.db.get(id);
  if (candidate?.companyId === companyId && candidate.active) ids.add(id);
}

export async function activeCompanyMembershipIds(ctx: Ctx, companyId: Id<"companies">) {
  const all = await ctx.db
    .query("companyMemberships")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .take(500);
  return new Set(all.filter((x) => x.active).map((x) => x._id));
}

export async function getManagedMembershipIds(
  ctx: Ctx,
  companyId: Id<"companies">,
  managerMembershipId: Id<"companyMemberships">
): Promise<Set<Id<"companyMemberships">>> {
  const ids = new Set<Id<"companyMemberships">>([managerMembershipId]);
  const userScopes = await ctx.db
    .query("managerUserScopes")
    .withIndex("by_manager", (q) => q.eq("managerMembershipId", managerMembershipId))
    .take(500);
  for (const row of userScopes) await addActiveMembership(ctx, ids, companyId, row.userMembershipId);

  const branchScopes = await ctx.db
    .query("managerBranchScopes")
    .withIndex("by_manager", (q) => q.eq("managerMembershipId", managerMembershipId))
    .take(500);
  for (const row of branchScopes) {
    const assignments = await ctx.db
      .query("userBranchAssignments")
      .withIndex("by_branch", (q) => q.eq("branchId", row.branchId))
      .take(500);
    for (const assignment of assignments) await addActiveMembership(ctx, ids, companyId, assignment.membershipId);
  }

  const departmentScopes = await ctx.db
    .query("managerDepartmentScopes")
    .withIndex("by_manager", (q) => q.eq("managerMembershipId", managerMembershipId))
    .take(500);
  for (const row of departmentScopes) {
    const assignments = await ctx.db
      .query("userDepartmentAssignments")
      .withIndex("by_department", (q) => q.eq("departmentId", row.departmentId))
      .take(500);
    for (const assignment of assignments) await addActiveMembership(ctx, ids, companyId, assignment.membershipId);
  }
  return ids;
}

export async function scopedMembershipIds(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  precomputedCaps?: Set<Capability>,
  targetCapability?: Capability
): Promise<Set<Id<"companyMemberships">>> {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  if (targetCapability) {
    if (caps.has(targetCapability)) {
      return await activeCompanyMembershipIds(ctx, companyId);
    }
  } else if (
    caps.has("analytics:view:company") ||
    caps.has("tasks:jd:view:any") ||
    caps.has("tasks:one_time:view:any") ||
    caps.has("sops:view:company")
  ) {
    return await activeCompanyMembershipIds(ctx, companyId);
  }
  return await getManagedMembershipIds(ctx, companyId, m._id);
}

export function hasAnalyticsViewAccess(caps: Set<Capability>) {
  return (
    caps.has("analytics:view:company") ||
    caps.has("analytics:view:managed_scope") ||
    caps.has("analytics:view:self")
  );
}

export function assertAnalyticsViewAccess(caps: Set<Capability>) {
  if (!hasAnalyticsViewAccess(caps)) throw new ConvexError("You do not have access to analytics.");
}

export async function analyticsScopedMembershipIds(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  precomputedCaps?: Set<Capability>
) {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  assertAnalyticsViewAccess(caps);
  if (caps.has("analytics:view:company")) return await activeCompanyMembershipIds(ctx, companyId);
  if (caps.has("analytics:view:managed_scope")) {
    const scoped = await getManagedMembershipIds(ctx, companyId, m._id);
    if (!caps.has("analytics:view:self")) scoped.delete(m._id);
    return scoped;
  }
  return new Set<Id<"companyMemberships">>([m._id]);
}

export function visibleAssigneeMembershipIds(
  assigneeMembershipIds: readonly Id<"companyMemberships">[],
  scopedIds: Set<Id<"companyMemberships">>
) {
  return assigneeMembershipIds.filter((id) => scopedIds.has(id));
}

export function taskHasVisibleAssignee(
  task: { assigneeMembershipIds: readonly Id<"companyMemberships">[] },
  scopedIds: Set<Id<"companyMemberships">>
) {
  return task.assigneeMembershipIds.some((id) => scopedIds.has(id));
}

export async function canViewTask(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  task: {
    companyId: Id<"companies">;
    assigneeMembershipIds: readonly Id<"companyMemberships">[];
    createdByMembershipId: Id<"companyMemberships">;
  },
  kind: "jd" | "one_time",
  precomputedCaps?: Set<Capability>,
  cachedManagedIds?: Set<Id<"companyMemberships">>
): Promise<boolean> {
  if (task.companyId !== companyId) return false;
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (caps.has(`${prefix}:view:any` as Capability)) return true;
  const targets =
    task.assigneeMembershipIds.length > 0 ? task.assigneeMembershipIds : [task.createdByMembershipId];
  if (caps.has(`${prefix}:view:managed` as Capability)) {
    const managed = cachedManagedIds ?? (await getManagedMembershipIds(ctx, companyId, m._id));
    if (targets.some((id) => managed.has(id))) return true;
  }
  if (caps.has(`${prefix}:view:self` as Capability)) {
    if (targets.includes(m._id) || task.createdByMembershipId === m._id) return true;
  }
  return false;
}

export async function assertCanAssign(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  assignees: Id<"companyMemberships">[],
  kind: "jd" | "one_time",
  precomputedCaps?: Set<Capability>
) {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (caps.has(`${prefix}:assign:any` as Capability)) return;
  if (caps.has(`${prefix}:assign:managed` as Capability)) {
    const scoped = await getManagedMembershipIds(ctx, companyId, m._id);
    if (assignees.every((id) => scoped.has(id))) return;
  }
  if (caps.has(`${prefix}:assign:self` as Capability) && assignees.length > 0 && assignees.every((id) => id === m._id))
    return;
  throw new ConvexError("You can only assign tasks inside your allowed scope.");
}

export async function assertCanUpdateTask(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  targets: Id<"companyMemberships">[],
  kind: "jd" | "one_time",
  precomputedCaps?: Set<Capability>
) {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (caps.has(`${prefix}:update:any` as Capability)) return;
  if (caps.has(`${prefix}:update:managed` as Capability)) {
    const scoped = await getManagedMembershipIds(ctx, companyId, m._id);
    if (targets.every((id) => scoped.has(id))) return;
  }
  if (caps.has(`${prefix}:update:self` as Capability) && targets.includes(m._id)) return;
  throw new ConvexError("You cannot update this task.");
}

export async function assertCanDeleteTask(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  targets: Id<"companyMemberships">[],
  kind: "jd" | "one_time",
  precomputedCaps?: Set<Capability>
) {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (caps.has(`${prefix}:delete:any` as Capability)) return;
  if (caps.has(`${prefix}:delete:managed` as Capability)) {
    const scoped = await getManagedMembershipIds(ctx, companyId, m._id);
    if (targets.every((id) => scoped.has(id))) return;
  }
  if (caps.has(`${prefix}:delete:self` as Capability) && targets.includes(m._id)) return;
  throw new ConvexError("You do not have access to delete this task.");
}

async function membershipBranchIds(ctx: Ctx, membershipIds: Set<Id<"companyMemberships">>) {
  const branchIds = new Set<Id<"branches">>();
  for (const membershipId of membershipIds) {
    const rows = await ctx.db
      .query("userBranchAssignments")
      .withIndex("by_membership", (q) => q.eq("membershipId", membershipId))
      .take(500);
    for (const row of rows) branchIds.add(row.branchId);
  }
  return branchIds;
}

async function membershipDepartmentIds(ctx: Ctx, membershipIds: Set<Id<"companyMemberships">>) {
  const departmentIds = new Set<Id<"departments">>();
  for (const membershipId of membershipIds) {
    const rows = await ctx.db
      .query("userDepartmentAssignments")
      .withIndex("by_membership", (q) => q.eq("membershipId", membershipId))
      .take(500);
    for (const row of rows) departmentIds.add(row.departmentId);
  }
  return departmentIds;
}

export async function visibleSopForSelf(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  sop: Doc<"sops">
) {
  if (sop.companyId !== companyId) return false;
  if (sop.scopeType === "company") return true;
  if (sop.scopeType === "user") {
    const rows = await ctx.db
      .query("sopUserScopes")
      .withIndex("by_sop", (q) => q.eq("sopId", sop._id))
      .take(500);
    return rows.some((row) => row.userMembershipId === m._id);
  }
  if (sop.scopeType === "branch") {
    const branchIds = await membershipBranchIds(ctx, new Set([m._id]));
    const sopBranches = await ctx.db
      .query("sopBranchScopes")
      .withIndex("by_sop", (q) => q.eq("sopId", sop._id))
      .take(500);
    return sopBranches.some((row) => branchIds.has(row.branchId));
  }
  const departmentIds = await membershipDepartmentIds(ctx, new Set([m._id]));
  const sopDepartments = await ctx.db
    .query("sopDepartmentScopes")
    .withIndex("by_sop", (q) => q.eq("sopId", sop._id))
    .take(500);
  return sopDepartments.some((row) => departmentIds.has(row.departmentId));
}

export type SopVisibilityContext = {
  scopedMembershipIds: Set<Id<"companyMemberships">>;
  membershipBranchIds: Set<Id<"branches">>;
  membershipDepartmentIds: Set<Id<"departments">>;
  managerBranchScopes: Set<Id<"branches">>;
  managerDepartmentScopes: Set<Id<"departments">>;
};

export async function buildSopVisibilityContext(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  precomputedCaps?: Set<Capability>
): Promise<SopVisibilityContext | null> {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  const canSeeManaged =
    caps.has("sops:view:managed") ||
    caps.has("sops:manage:branch") ||
    caps.has("sops:manage:department") ||
    caps.has("sops:manage:user") ||
    caps.has("sops:delete:branch") ||
    caps.has("sops:delete:department") ||
    caps.has("sops:delete:user");
  if (!canSeeManaged) return null;
  const scoped = await getManagedMembershipIds(ctx, companyId, m._id);
  const membershipBranchSet = await membershipBranchIds(ctx, scoped);
  const membershipDepartmentSet = await membershipDepartmentIds(ctx, scoped);
  const managedBranches = await ctx.db
    .query("managerBranchScopes")
    .withIndex("by_manager", (q) => q.eq("managerMembershipId", m._id))
    .take(500);
  const managedDepartments = await ctx.db
    .query("managerDepartmentScopes")
    .withIndex("by_manager", (q) => q.eq("managerMembershipId", m._id))
    .take(500);
  return {
    scopedMembershipIds: scoped,
    membershipBranchIds: membershipBranchSet,
    membershipDepartmentIds: membershipDepartmentSet,
    managerBranchScopes: new Set(managedBranches.map((row) => row.branchId)),
    managerDepartmentScopes: new Set(managedDepartments.map((row) => row.departmentId)),
  };
}

export async function visibleSop(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  sop: Doc<"sops">,
  visibility?: SopVisibilityContext | null,
  precomputedCaps?: Set<Capability>
) {
  if (sop.companyId !== companyId) return false;
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  if (caps.has("sops:view:company")) return true;
  if (caps.has("sops:view:managed")) {
    if (sop.scopeType === "company") return true;
    const v = visibility ?? (await buildSopVisibilityContext(ctx, companyId, m, caps));
    if (v) {
      if (sop.scopeType === "user") {
        const rows = await ctx.db
          .query("sopUserScopes")
          .withIndex("by_sop", (q) => q.eq("sopId", sop._id))
          .take(500);
        if (rows.some((row) => v.scopedMembershipIds.has(row.userMembershipId))) return true;
      } else if (sop.scopeType === "branch") {
        const sopBranches = await ctx.db
          .query("sopBranchScopes")
          .withIndex("by_sop", (q) => q.eq("sopId", sop._id))
          .take(500);
        if (sopBranches.some((row) => v.membershipBranchIds.has(row.branchId) || v.managerBranchScopes.has(row.branchId)))
          return true;
      } else if (sop.scopeType === "department") {
        const sopDepartments = await ctx.db
          .query("sopDepartmentScopes")
          .withIndex("by_sop", (q) => q.eq("sopId", sop._id))
          .take(500);
        for (const row of sopDepartments) {
          if (v.membershipDepartmentIds.has(row.departmentId) || v.managerDepartmentScopes.has(row.departmentId))
            return true;
          const department = await ctx.db.get(row.departmentId);
          if (department?.companyId === companyId && v.managerBranchScopes.has(department.branchId)) return true;
        }
      }
    }
  }
  if (caps.has("sops:view:self")) {
    return await visibleSopForSelf(ctx, companyId, m, sop);
  }
  return false;
}

export function sopDeleteCapability(scopeType: Doc<"sops">["scopeType"]): Capability {
  return scopeType === "company"
    ? "sops:delete:company"
    : scopeType === "branch"
    ? "sops:delete:branch"
    : scopeType === "department"
    ? "sops:delete:department"
    : "sops:delete:user";
}

export function sopManageCapability(scopeType: Doc<"sops">["scopeType"]): Capability {
  return scopeType === "company"
    ? "sops:manage:company"
    : scopeType === "branch"
    ? "sops:manage:branch"
    : scopeType === "department"
    ? "sops:manage:department"
    : "sops:manage:user";
}
