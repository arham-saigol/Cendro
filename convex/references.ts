import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export type ReferenceKind = "jd" | "one_time" | "sop";

const prefixes: Record<ReferenceKind, string> = {
  jd: "JD",
  one_time: "TSK",
  sop: "SOP",
};

const padLengths: Record<ReferenceKind, number> = {
  jd: 3,
  one_time: 3,
  sop: 3,
};

/** Allocates a company-scoped, human-readable reference inside the caller's transaction. */
export async function nextReference(ctx: MutationCtx, companyId: Id<"companies">, kind: ReferenceKind) {
  const counter = await ctx.db
    .query("referenceCounters")
    .withIndex("by_companyId_and_kind", (q) => q.eq("companyId", companyId).eq("kind", kind))
    .unique();
  const number = (counter?.lastNumber ?? 0) + 1;

  if (counter) await ctx.db.patch(counter._id, { lastNumber: number });
  else await ctx.db.insert("referenceCounters", { companyId, kind, lastNumber: number });

  return `${prefixes[kind]}-${String(number).padStart(padLengths[kind], "0")}`;
}
