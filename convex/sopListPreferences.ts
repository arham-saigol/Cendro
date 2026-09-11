import { v } from "convex/values";

export const sopListSortDirectionValidator = v.union(v.literal("asc"), v.literal("desc"));

export const sopListSortFieldValidator = v.union(
  v.literal("code"),
  v.literal("title"),
  v.literal("assignedTo"),
  v.literal("createdAt"),
  v.literal("updatedAt"),
);

export const sopListSortValidator = v.union(
  v.object({ mode: v.literal("default") }),
  v.object({ mode: v.literal("custom") }),
  v.object({
    mode: v.literal("field"),
    field: sopListSortFieldValidator,
    direction: sopListSortDirectionValidator,
  }),
);

export const sopListPreferenceValidator = v.object({
  companyId: v.id("companies"),
  membershipId: v.id("companyMemberships"),
  sort: sopListSortValidator,
  customOrder: v.optional(v.array(v.id("sops"))),
  revision: v.number(),
  updatedAt: v.number(),
});

export const sopListPreferenceResultValidator = v.object({
  sort: sopListSortValidator,
  customOrder: v.union(v.array(v.id("sops")), v.null()),
  revision: v.number(),
  updatedAt: v.union(v.number(), v.null()),
});
