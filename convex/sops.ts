import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireCapability, requireMembership, visibleSop } from "./permissions";
import { nonEmpty } from "./validation";

async function assertTargets(ctx: any, companyId: Id<"companies">, args: { branchIds: Id<"branches">[]; departmentIds: Id<"departments">[]; userMembershipIds: Id<"companyMemberships">[] }) {
  for (const branchId of args.branchIds) { const branch = await ctx.db.get(branchId); if (!branch || branch.companyId !== companyId) throw new ConvexError("Branch not found."); }
  for (const departmentId of args.departmentIds) { const department = await ctx.db.get(departmentId); if (!department || department.companyId !== companyId) throw new ConvexError("Department not found."); }
  for (const membershipId of args.userMembershipIds) { const membership = await ctx.db.get(membershipId); if (!membership || membership.companyId !== companyId) throw new ConvexError("User not found."); }
}
function manageCapability(scopeType: "company" | "branch" | "department" | "user") { return scopeType === "company" ? "sops:manage:company" : scopeType === "branch" ? "sops:manage:branch" : scopeType === "department" ? "sops:manage:department" : "sops:manage:user"; }
async function deleteEmbeddings(ctx: any, sopId: Id<"sops">) { for (const row of await ctx.db.query("sopEmbeddings").withIndex("by_sop", (q: any) => q.eq("sopId", sopId)).take(100)) await ctx.db.delete(row._id); }
async function deleteScopeRows(ctx: any, sopId: Id<"sops">) {
  for (const row of await ctx.db.query("sopBranchScopes").withIndex("by_sop", (q: any) => q.eq("sopId", sopId)).take(500)) await ctx.db.delete(row._id);
  for (const row of await ctx.db.query("sopDepartmentScopes").withIndex("by_sop", (q: any) => q.eq("sopId", sopId)).take(500)) await ctx.db.delete(row._id);
  for (const row of await ctx.db.query("sopUserScopes").withIndex("by_sop", (q: any) => q.eq("sopId", sopId)).take(500)) await ctx.db.delete(row._id);
}
async function insertScopeRows(ctx: any, companyId: Id<"companies">, sopId: Id<"sops">, args: { branchIds: Id<"branches">[]; departmentIds: Id<"departments">[]; userMembershipIds: Id<"companyMemberships">[] }) {
  for (const branchId of args.branchIds) await ctx.db.insert("sopBranchScopes", { companyId, sopId, branchId });
  for (const departmentId of args.departmentIds) await ctx.db.insert("sopDepartmentScopes", { companyId, sopId, departmentId });
  for (const userMembershipId of args.userMembershipIds) await ctx.db.insert("sopUserScopes", { companyId, sopId, userMembershipId });
}
async function withScopes(ctx: any, sop: Doc<"sops">) {
  const branchIds = (await ctx.db.query("sopBranchScopes").withIndex("by_sop", (q: any) => q.eq("sopId", sop._id)).take(500)).map((row: any) => row.branchId);
  const departmentIds = (await ctx.db.query("sopDepartmentScopes").withIndex("by_sop", (q: any) => q.eq("sopId", sop._id)).take(500)).map((row: any) => row.departmentId);
  const userMembershipIds = (await ctx.db.query("sopUserScopes").withIndex("by_sop", (q: any) => q.eq("sopId", sop._id)).take(500)).map((row: any) => row.userMembershipId);
  return { ...sop, branchIds, departmentIds, userMembershipIds };
}

export const list = query({
  args: { companyId: v.id("companies"), search: v.optional(v.string()), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    // Visibility/search filtering happens after database pagination, so pages may contain fewer items than requested; continuation tokens still advance correctly.
    const page = await ctx.db.query("sops").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").paginate(args.paginationOpts);
    const out = [];
    const search = args.search?.trim().toLowerCase();
    for (const sop of page.page) {
      if (await visibleSop(ctx, args.companyId, membership, sop)) {
        if (!search || sop.title.toLowerCase().includes(search) || sop.content.toLowerCase().includes(search)) out.push(await withScopes(ctx, sop));
      }
    }
    return { ...page, page: out };
  },
});

export const get = query({ args: { companyId: v.id("companies"), sopId: v.id("sops") }, handler: async (ctx, args) => { const { membership } = await requireMembership(ctx, args.companyId); const sop = await ctx.db.get(args.sopId); if (!sop || sop.companyId !== args.companyId || !(await visibleSop(ctx, args.companyId, membership, sop))) throw new ConvexError("SOP not found."); return await withScopes(ctx, sop); } });

export const create = mutation({
  args: { companyId: v.id("companies"), title: v.string(), content: v.string(), scopeType: v.union(v.literal("company"), v.literal("branch"), v.literal("department"), v.literal("user")), branchIds: v.array(v.id("branches")), departmentIds: v.array(v.id("departments")), userMembershipIds: v.array(v.id("companyMemberships")) },
  handler: async (ctx, args) => {
    const { membership } = await requireCapability(ctx, args.companyId, "sops:create");
    await requireCapability(ctx, args.companyId, manageCapability(args.scopeType));
    const title = nonEmpty(args.title, "Title");
    const content = nonEmpty(args.content, "SOP body");
    await assertTargets(ctx, args.companyId, args);
    const now = Date.now();
    const id = await ctx.db.insert("sops", { companyId: args.companyId, title, content, scopeType: args.scopeType, creatorMembershipId: membership._id, updatedByMembershipId: membership._id, createdAt: now, updatedAt: now });
    await insertScopeRows(ctx, args.companyId, id, args);
    await ctx.scheduler.runAfter(0, internal.sops.indexSop, { companyId: args.companyId, sopId: id });
    return id;
  },
});

export const update = mutation({ args: { companyId: v.id("companies"), sopId: v.id("sops"), title: v.string(), content: v.string() }, handler: async (ctx, args) => { const { membership } = await requireMembership(ctx, args.companyId); const sop = await ctx.db.get(args.sopId); if (!sop || sop.companyId !== args.companyId || !(await visibleSop(ctx, args.companyId, membership, sop))) throw new ConvexError("SOP not found."); await requireCapability(ctx, args.companyId, manageCapability(sop.scopeType)); await ctx.db.patch(args.sopId, { title: nonEmpty(args.title, "Title"), content: nonEmpty(args.content, "SOP body"), updatedByMembershipId: membership._id, updatedAt: Date.now() }); await ctx.scheduler.runAfter(0, internal.sops.indexSop, { companyId: args.companyId, sopId: args.sopId }); } });
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
