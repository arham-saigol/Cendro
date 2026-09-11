export const sopListOrderLimit = 2_000;
// SOP IDs are ASCII, so the serialized JSON string length matches the payload's bytes.
export const sopListOrderMaxSerializedBytes = 128 * 1024;

export type SopListSortDirection = "asc" | "desc";
export type SopListSortField = "code" | "title" | "assignedTo" | "createdAt" | "updatedAt";

export type SopListSort =
  | { mode: "default" }
  | { mode: "custom" }
  | { mode: "field"; field: SopListSortField; direction: SopListSortDirection };

export function defaultSopListSort(): SopListSort {
  return { mode: "default" };
}

export function defaultSopListSortField(): SopListSortField {
  return "createdAt";
}

export function defaultSopListSortDirection(): SopListSortDirection {
  return "desc";
}

export function initialSopListSortDirection(field: SopListSortField): SopListSortDirection {
  return field === "createdAt" || field === "updatedAt" ? "desc" : "asc";
}
