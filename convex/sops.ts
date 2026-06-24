import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { Capability } from "../src/lib/permissions";
import { membershipCapabilities, requireCapability, requireMembership, scopedMembershipIds, visibleSop, visibleSopForSelf } from "./permissions";
import { nonEmpty } from "./validation";

function firstName(user: Doc<"appUsers">) { return user.firstName.trim() || user.email; }
function fullName(user: Doc<"appUsers">) { return [firstName(user), user.secondName?.trim()].filter(Boolean).join(" ") || user.email; }

async function assertTargets(ctx: any, companyId: Id<"companies">, args: { branchIds: Id<"branches">[]; departmentIds: Id<"departments">[]; userMembershipIds: Id<"companyMemberships">[] }) {
  for (const branchId of args.branchIds) { const branch = await ctx.db.get(branchId); if (!branch || branch.companyId !== companyId) throw new ConvexError("Branch not found."); }
  for (const departmentId of args.departmentIds) { const department = await ctx.db.get(departmentId); if (!department || department.companyId !== companyId) throw new ConvexError("Department not found."); }
  for (const membershipId of args.userMembershipIds) { const membership = await ctx.db.get(membershipId); if (!membership || membership.companyId !== companyId || !membership.active) throw new ConvexError("User not found."); }
}
function assertScopeSelection(args: { scopeType: "company" | "branch" | "department" | "user"; branchIds: Id<"branches">[]; departmentIds: Id<"departments">[]; userMembershipIds: Id<"companyMemberships">[] }) {
  if (args.scopeType === "company" && (args.branchIds.length || args.departmentIds.length || args.userMembershipIds.length)) throw new ConvexError("Company-wide SOPs cannot target a branch or user.");
  if (args.scopeType === "branch" && (args.branchIds.length !== 1 || args.departmentIds.length || args.userMembershipIds.length)) throw new ConvexError("Select one branch for branch scope.");
  if (args.scopeType === "department" && (args.departmentIds.length !== 1 || args.branchIds.length || args.userMembershipIds.length)) throw new ConvexError("Select one department for department scope.");
  if (args.scopeType === "user" && (args.userMembershipIds.length !== 1 || args.branchIds.length || args.departmentIds.length)) throw new ConvexError("Select one user for user scope.");
}
function manageCapability(scopeType: "company" | "branch" | "department" | "user"): Capability { return scopeType === "company" ? "sops:manage:company" : scopeType === "branch" ? "sops:manage:branch" : scopeType === "department" ? "sops:manage:department" : "sops:manage:user"; }
const sopViewValidator = v.union(v.literal("all"), v.literal("my"));
const sopScopeFilterValidator = v.union(v.literal("all"), v.literal("company"), v.literal("branch"), v.literal("department"), v.literal("user"));
async function deleteEmbeddings(ctx: any, sopId: Id<"sops">) { for (const row of await ctx.db.query("sopEmbeddings").withIndex("by_sop", (q: any) => q.eq("sopId", sopId)).take(100)) await ctx.db.delete(row._id); }
async function deleteScopeRows(ctx: any, sopId: Id<"sops">) {
  for (const row of await ctx.db.query("sopBranchScopes").withIndex("by_sop", (q: any) => q.eq("sopId", sopId)).take(500)) await ctx.db.delete(row._id);
  for (const row of await ctx.db.query("sopDepartmentScopes").withIndex("by_sop", (q: any) => q.eq("sopId", sopId)).take(500)) await ctx.db.delete(row._id);
  for (const row of await ctx.db.query("sopUserScopes").withIndex("by_sop", (q: any) => q.eq("sopId", sopId)).take(500)) await ctx.db.delete(row._id);
}
async function insertScopeRows(ctx: MutationCtx, companyId: Id<"companies">, sopId: Id<"sops">, args: { branchIds: Id<"branches">[]; departmentIds: Id<"departments">[]; userMembershipIds: Id<"companyMemberships">[] }) {
  for (const branchId of args.branchIds) await ctx.db.insert("sopBranchScopes", { companyId, sopId, branchId });
  for (const departmentId of args.departmentIds) await ctx.db.insert("sopDepartmentScopes", { companyId, sopId, departmentId });
  for (const userMembershipId of args.userMembershipIds) await ctx.db.insert("sopUserScopes", { companyId, sopId, userMembershipId });
}
async function withScopes(ctx: QueryCtx, sop: Doc<"sops">, companyName?: string) {
  const branchIds = (await ctx.db.query("sopBranchScopes").withIndex("by_sop", (q) => q.eq("sopId", sop._id)).take(500)).map((row) => row.branchId);
  const departmentIds = (await ctx.db.query("sopDepartmentScopes").withIndex("by_sop", (q) => q.eq("sopId", sop._id)).take(500)).map((row) => row.departmentId);
  const userMembershipIds = (await ctx.db.query("sopUserScopes").withIndex("by_sop", (q) => q.eq("sopId", sop._id)).take(500)).map((row) => row.userMembershipId);
  let scopeTargetName = companyName ?? "Company";
  let scopeTargetUser: { firstName: string; name: string; imageUrl: string | null } | null = null;
  if (sop.scopeType === "branch") {
    const branch = branchIds[0] ? await ctx.db.get(branchIds[0]) : null;
    scopeTargetName = branch?.companyId === sop.companyId ? branch.name : "Unknown branch";
  } else if (sop.scopeType === "department") {
    const department = departmentIds[0] ? await ctx.db.get(departmentIds[0]) : null;
    scopeTargetName = department?.companyId === sop.companyId ? department.name : "Unknown department";
  } else if (sop.scopeType === "user") {
    const membership = userMembershipIds[0] ? await ctx.db.get(userMembershipIds[0]) : null;
    const user = membership?.companyId === sop.companyId ? await ctx.db.get(membership.userId) : null;
    if (user) {
      scopeTargetName = fullName(user);
      scopeTargetUser = { firstName: firstName(user), name: scopeTargetName, imageUrl: user.imageUrl ?? null };
    } else {
      scopeTargetName = "Unknown user";
    }
  }
  return { ...sop, branchIds, departmentIds, userMembershipIds, scopeTargetName, scopeTargetUser };
}

async function sopMatchesFilters(ctx: QueryCtx, sop: Doc<"sops">, args: { scope?: "all" | Doc<"sops">["scopeType"]; branchId?: Id<"branches">; userMembershipId?: Id<"companyMemberships"> }) {
  if (args.scope && args.scope !== "all" && sop.scopeType !== args.scope) return false;
  if (args.branchId) {
    const rows = await ctx.db.query("sopBranchScopes").withIndex("by_sop", (q) => q.eq("sopId", sop._id)).take(500);
    if (!rows.some((row) => row.branchId === args.branchId)) return false;
  }
  if (args.userMembershipId) {
    const rows = await ctx.db.query("sopUserScopes").withIndex("by_sop", (q) => q.eq("sopId", sop._id)).take(500);
    if (!rows.some((row) => row.userMembershipId === args.userMembershipId)) return false;
  }
  return true;
}

async function sopVisibleForView(ctx: QueryCtx, companyId: Id<"companies">, membership: Doc<"companyMemberships">, sop: Doc<"sops">, view?: "all" | "my") {
  if (view === "all" && (membership.role === "Admin" || membership.role === "Manager")) return await visibleSop(ctx, companyId, membership, sop);
  return await visibleSopForSelf(ctx, companyId, membership, sop);
}

async function filteredSopRows(ctx: QueryCtx, args: { companyId: Id<"companies">; search?: string; view?: "all" | "my"; scope?: "all" | Doc<"sops">["scopeType"]; branchId?: Id<"branches">; userMembershipId?: Id<"companyMemberships">; limit: number }) {
  const { membership } = await requireMembership(ctx, args.companyId);
  const company = await ctx.db.get(args.companyId);
  const out = [];
  const search = args.search?.trim().toLowerCase();
  for await (const sop of ctx.db.query("sops").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc")) {
    if (out.length >= args.limit) break;
    if (!(await sopVisibleForView(ctx, args.companyId, membership, sop, args.view))) continue;
    if (!(await sopMatchesFilters(ctx, sop, args))) continue;
    if (search && !sop.title.toLowerCase().includes(search) && !sop.content.toLowerCase().includes(search)) continue;
    out.push(await withScopes(ctx, sop, company?.name));
  }
  return out;
}

export const list = query({
  args: { companyId: v.id("companies"), search: v.optional(v.string()), view: v.optional(sopViewValidator), scope: v.optional(sopScopeFilterValidator), branchId: v.optional(v.id("branches")), userMembershipId: v.optional(v.id("companyMemberships")), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const company = await ctx.db.get(args.companyId);
    // Visibility/search filtering happens after database pagination, so pages may contain fewer items than requested; continuation tokens still advance correctly.
    const page = await ctx.db.query("sops").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").paginate(args.paginationOpts);
    const out = [];
    const search = args.search?.trim().toLowerCase();
    for (const sop of page.page) {
      if (!(await sopVisibleForView(ctx, args.companyId, membership, sop, args.view))) continue;
      if (!(await sopMatchesFilters(ctx, sop, args))) continue;
      if (search && !sop.title.toLowerCase().includes(search) && !sop.content.toLowerCase().includes(search)) continue;
      out.push(await withScopes(ctx, sop, company?.name));
    }
    return { ...page, page: out };
  },
});

export const listRows = query({
  args: { companyId: v.id("companies"), search: v.optional(v.string()), view: v.optional(sopViewValidator), scope: v.optional(sopScopeFilterValidator), branchId: v.optional(v.id("branches")), userMembershipId: v.optional(v.id("companyMemberships")) },
  handler: async (ctx, args) => await filteredSopRows(ctx, { ...args, limit: 200 }),
});

export const get = query({ args: { companyId: v.id("companies"), sopId: v.id("sops") }, handler: async (ctx, args) => { const { membership } = await requireMembership(ctx, args.companyId); const sop = await ctx.db.get(args.sopId); if (!sop || sop.companyId !== args.companyId || !(await visibleSop(ctx, args.companyId, membership, sop))) throw new ConvexError("SOP not found."); const company = await ctx.db.get(args.companyId); return await withScopes(ctx, sop, company?.name); } });

const scopeOptionCapabilities: Capability[] = ["sops:create", "sops:manage:company", "sops:manage:branch", "sops:manage:user"];

export const scopeOptions = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const capabilities = await membershipCapabilities(ctx, membership);
    if (!scopeOptionCapabilities.some((capability) => capabilities.has(capability))) throw new ConvexError("You do not have access to do that.");
    const canUseBranch = capabilities.has("sops:manage:branch");
    const canUseUser = capabilities.has("sops:manage:user");
    const [branches, memberships] = await Promise.all([
      canUseBranch ? ctx.db.query("branches").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500) : Promise.resolve([]),
      canUseUser ? ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500) : Promise.resolve([]),
    ]);
    const users = [];
    for (const membership of memberships.filter((m) => m.active)) {
      const user = await ctx.db.get(membership.userId);
      if (user) users.push({ membership: { _id: membership._id, role: membership.role }, user: { name: fullName(user), firstName: firstName(user), imageUrl: user.imageUrl ?? null } });
    }
    return { branches: branches.map((branch) => ({ _id: branch._id, name: branch.name })), users };
  },
});

export const filterOptions = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    if (membership.role !== "Admin" && membership.role !== "Manager") return { branches: [], users: [] };

    const branchIds = new Set<Id<"branches">>();
    let userIds: Set<Id<"companyMemberships">>;
    if (membership.role === "Admin") {
      const [branches, memberships] = await Promise.all([
        ctx.db.query("branches").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500),
        ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500),
      ]);
      for (const branch of branches) branchIds.add(branch._id);
      userIds = new Set(memberships.filter((m) => m.active).map((m) => m._id));
    } else {
      userIds = await scopedMembershipIds(ctx, args.companyId, membership);
      const managedBranches = await ctx.db.query("managerBranchScopes").withIndex("by_manager", (q) => q.eq("managerMembershipId", membership._id)).take(500);
      for (const row of managedBranches) branchIds.add(row.branchId);
      for (const userId of userIds) {
        const assignments = await ctx.db.query("userBranchAssignments").withIndex("by_membership", (q) => q.eq("membershipId", userId)).take(500);
        for (const assignment of assignments) branchIds.add(assignment.branchId);
      }
    }

    const branches = [];
    for (const branchId of branchIds) {
      const branch = await ctx.db.get(branchId);
      if (branch?.companyId === args.companyId) branches.push({ _id: branch._id, name: branch.name });
    }
    const users = [];
    for (const membershipId of userIds) {
      const userMembership = await ctx.db.get(membershipId);
      if (!userMembership || userMembership.companyId !== args.companyId || !userMembership.active) continue;
      const user = await ctx.db.get(userMembership.userId);
      if (user) users.push({ membership: { _id: userMembership._id, role: userMembership.role }, user: { name: fullName(user), firstName: firstName(user), imageUrl: user.imageUrl ?? null } });
    }
    branches.sort((a, b) => a.name.localeCompare(b.name));
    users.sort((a, b) => a.user.name.localeCompare(b.user.name));
    return { branches, users };
  },
});

export const create = mutation({
  args: { companyId: v.id("companies"), title: v.string(), content: v.string(), scopeType: v.union(v.literal("company"), v.literal("branch"), v.literal("department"), v.literal("user")), branchIds: v.array(v.id("branches")), departmentIds: v.array(v.id("departments")), userMembershipIds: v.array(v.id("companyMemberships")) },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "sops:create");
    await requireCapability(ctx, args.companyId, manageCapability(args.scopeType));
    const title = nonEmpty(args.title, "Title");
    const content = nonEmpty(args.content, "SOP body");
    assertScopeSelection(args);
    await assertTargets(ctx, args.companyId, args);
    const now = Date.now();
    const id = await ctx.db.insert("sops", { companyId: args.companyId, title, content, scopeType: args.scopeType, creatorMembershipId: membership._id, updatedByMembershipId: membership._id, createdAt: now, updatedAt: now });
    await insertScopeRows(ctx, args.companyId, id, args);
    await ctx.scheduler.runAfter(0, internal.sops.indexSop, { companyId: args.companyId, sopId: id });
    return id;
  },
});

export const update = mutation({ args: { companyId: v.id("companies"), sopId: v.id("sops"), title: v.string(), content: v.string() }, handler: async (ctx, args) => { const { membership } = await requireMembership(ctx, args.companyId); const sop = await ctx.db.get(args.sopId); if (!sop || sop.companyId !== args.companyId || !(await visibleSop(ctx, args.companyId, membership, sop))) throw new ConvexError("SOP not found."); await requireCapability(ctx, args.companyId, manageCapability(sop.scopeType)); await ctx.db.patch(args.sopId, { title: nonEmpty(args.title, "Title"), content: nonEmpty(args.content, "SOP body"), updatedByMembershipId: membership._id, updatedAt: Date.now() }); await ctx.scheduler.runAfter(0, internal.sops.indexSop, { companyId: args.companyId, sopId: args.sopId }); } });

export const updateScope = mutation({
  args: { companyId: v.id("companies"), sopId: v.id("sops"), scopeType: v.union(v.literal("company"), v.literal("branch"), v.literal("user")), branchIds: v.array(v.id("branches")), userMembershipIds: v.array(v.id("companyMemberships")) },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const sop = await ctx.db.get(args.sopId);
    if (!sop || sop.companyId !== args.companyId || !(await visibleSop(ctx, args.companyId, membership, sop))) throw new ConvexError("SOP not found.");
    await requireCapability(ctx, args.companyId, manageCapability(sop.scopeType));
    await requireCapability(ctx, args.companyId, manageCapability(args.scopeType));
    const scopeArgs = { scopeType: args.scopeType, branchIds: args.branchIds, departmentIds: [], userMembershipIds: args.userMembershipIds };
    assertScopeSelection(scopeArgs);
    await assertTargets(ctx, args.companyId, scopeArgs);
    await deleteScopeRows(ctx, args.sopId);
    await ctx.db.patch(args.sopId, { scopeType: args.scopeType, updatedByMembershipId: membership._id, updatedAt: Date.now() });
    await insertScopeRows(ctx, args.companyId, args.sopId, scopeArgs);
    await ctx.scheduler.runAfter(0, internal.sops.indexSop, { companyId: args.companyId, sopId: args.sopId });
  },
});

export const remove = mutation({ args: { companyId: v.id("companies"), sopId: v.id("sops") }, handler: async (ctx, args) => { const { membership } = await requireMembership(ctx, args.companyId); const sop = await ctx.db.get(args.sopId); if (!sop || sop.companyId !== args.companyId || !(await visibleSop(ctx, args.companyId, membership, sop))) throw new ConvexError("SOP not found."); await requireCapability(ctx, args.companyId, manageCapability(sop.scopeType)); await deleteEmbeddings(ctx, args.sopId); await deleteScopeRows(ctx, args.sopId); await ctx.db.delete(args.sopId); } });

async function textSearch(ctx: any, args: { companyId: Id<"companies">; query: string }) {
  const { membership } = await requireMembership(ctx, args.companyId);
  const rows = await ctx.db.query("sops").withIndex("by_company", (q: any) => q.eq("companyId", args.companyId)).take(100);
  const needle = args.query.trim().toLowerCase();
  if (!needle) return [];
  const out = [];
  for (const sop of rows) {
    if (await visibleSop(ctx, args.companyId, membership, sop) && (sop.title.toLowerCase().includes(needle) || sop.content.toLowerCase().includes(needle))) out.push({ id: sop._id, title: sop.title, excerpt: sop.content.slice(0, 500), scopeType: sop.scopeType });
  }
  return out.slice(0, 8);
}

export const searchAccessible = query({ args: { companyId: v.id("companies"), query: v.string() }, handler: textSearch });

export const visibleSearchRows = internalQuery({ args: { companyId: v.id("companies"), embeddingIds: v.array(v.id("sopEmbeddings")) }, handler: async (ctx, args) => { const { membership } = await requireMembership(ctx, args.companyId); const out = []; for (const embeddingId of args.embeddingIds) { const embedding = await ctx.db.get(embeddingId); if (!embedding || embedding.companyId !== args.companyId) continue; const sop = await ctx.db.get(embedding.sopId); if (!sop || !(await visibleSop(ctx, args.companyId, membership, sop))) continue; out.push({ id: sop._id, title: sop.title, excerpt: embedding.chunk.slice(0, 500), scopeType: sop.scopeType }); } return out; } });

export const authorizeSearch = internalQuery({ args: { companyId: v.id("companies") }, handler: async (ctx, args) => { await requireMembership(ctx, args.companyId); return null; } });

export const semanticSearchAccessible = action({
  args: { companyId: v.id("companies"), query: v.string() },
  handler: async (ctx, args): Promise<{ id: Id<"sops">; title: string; excerpt: string; scopeType: Doc<"sops">["scopeType"] }[]> => {
    const query = args.query.trim();
    if (!query) return [];
    await ctx.runQuery(internal.sops.authorizeSearch, { companyId: args.companyId });
    const apiKey = process.env.VOYAGE_API_KEY;
    if (!apiKey) return await ctx.runQuery(internal.sops.searchFallback, args);
    const vector = await embed(apiKey, query);
    if (!vector) return await ctx.runQuery(internal.sops.searchFallback, args);
    const results = await ctx.vectorSearch("sopEmbeddings", "by_embedding", { vector, limit: 16, filter: (q) => q.eq("companyId", args.companyId) });
    if (!results.length) return await ctx.runQuery(internal.sops.searchFallback, args);
    const rows = await ctx.runQuery(internal.sops.visibleSearchRows, { companyId: args.companyId, embeddingIds: results.map((r) => r._id) });
    return rows.slice(0, 8);
  },
});

export const searchFallback = internalQuery({ args: { companyId: v.id("companies"), query: v.string() }, handler: textSearch });

export const getForIndexing = internalQuery({ args: { companyId: v.id("companies"), sopId: v.id("sops") }, handler: async (ctx, args): Promise<Doc<"sops"> | null> => { const sop = await ctx.db.get(args.sopId); return sop && sop.companyId === args.companyId ? sop : null; } });
export const storeEmbedding = internalMutation({ args: { companyId: v.id("companies"), sopId: v.id("sops"), chunk: v.string(), embedding: v.array(v.number()) }, handler: async (ctx, args) => { const sop = await ctx.db.get(args.sopId); if (!sop || sop.companyId !== args.companyId) throw new ConvexError("SOP not found."); if (args.embedding.length !== 1024) throw new ConvexError("SOP embedding dimensions did not match voyage-4."); await deleteEmbeddings(ctx, args.sopId); return await ctx.db.insert("sopEmbeddings", { companyId: args.companyId, sopId: args.sopId, chunk: args.chunk, embedding: args.embedding, metadata: { title: sop.title, scopeType: sop.scopeType }, updatedAt: Date.now() }); } });

async function embed(apiKey: string, input: string) {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: process.env.VOYAGE_EMBEDDING_MODEL || "voyage-4", input: [input], output_dimension: 1024 }) });
  if (!res.ok) return null;
  const json = await res.json() as { data?: { embedding: number[] }[] };
  const embedding = json.data?.[0]?.embedding;
  return embedding?.length === 1024 ? embedding : null;
}

export const aiSearch = query({
  args: { companyId: v.id("companies"), query: v.string() },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const needle = args.query.trim().toLowerCase();
    if (!needle) return [];
    const rows = await ctx.db.query("sops").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").take(100);
    const out = [];
    for (const sop of rows) {
      if (!(await visibleSop(ctx, args.companyId, membership, sop))) continue;
      if (sop.title.toLowerCase().includes(needle) || sop.content.toLowerCase().includes(needle)) out.push({ id: sop._id, title: sop.title, excerpt: sop.content.slice(0, 700), scopeType: sop.scopeType });
      if (out.length >= 8) break;
    }
    return out;
  },
});

export const aiGet = query({
  args: { companyId: v.id("companies"), sopId: v.id("sops") },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const sop = await ctx.db.get(args.sopId);
    if (!sop || sop.companyId !== args.companyId || !(await visibleSop(ctx, args.companyId, membership, sop))) throw new ConvexError("SOP not found.");
    return { id: sop._id, title: sop.title, content: sop.content.slice(0, 8000), scopeType: sop.scopeType };
  },
});

export const aiCreate = mutation({
  args: { companyId: v.id("companies"), title: v.string(), content: v.string() },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "sops:create");
    await requireCapability(ctx, args.companyId, "sops:manage:company");
    const title = nonEmpty(args.title, "Title");
    const content = nonEmpty(args.content, "SOP body");
    const now = Date.now();
    const id = await ctx.db.insert("sops", { companyId: args.companyId, title, content, scopeType: "company", creatorMembershipId: membership._id, updatedByMembershipId: membership._id, createdAt: now, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.sops.indexSop, { companyId: args.companyId, sopId: id });
    return { id, title, content: content.slice(0, 8000), scopeType: "company" as const };
  },
});

export const indexSop = internalAction({ args: { companyId: v.id("companies"), sopId: v.id("sops") }, handler: async (ctx, args) => { const sop: Doc<"sops"> | null = await ctx.runQuery(internal.sops.getForIndexing, args); if (!sop) return { skipped: true }; const apiKey = process.env.VOYAGE_API_KEY; if (!apiKey) return { skipped: true }; const input = sop.title + "\n\n" + sop.content; const embedding = await embed(apiKey, input); if (embedding) await ctx.runMutation(internal.sops.storeEmbedding, { companyId: args.companyId, sopId: args.sopId, chunk: input, embedding }); return { skipped: !embedding }; } });
