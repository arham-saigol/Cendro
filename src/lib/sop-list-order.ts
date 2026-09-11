import { restoreListCustomOrder } from "./list-order";
import {
  defaultSopListSortDirection,
  defaultSopListSortField,
  type SopListSort,
  type SopListSortDirection,
} from "./sop-list-sort";
import { sopTargetName, type SopTargetNameRow } from "./sop-target-name";

export type SopListOrderingRow = SopTargetNameRow & {
  _id: string;
  reference?: string | null;
  title?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
};

export type SopListOrderingOptions = {
  companyName?: string;
};

export type SopListFilterRow = SopListOrderingRow & {
  content?: string | null;
  filterBranchIds?: readonly string[] | null;
  userMembershipIds?: readonly string[] | null;
  matchesMyView?: boolean;
};

export type SopListFilters = {
  search?: string;
  view?: "all" | "my";
  scope?: "all" | "company" | "branch" | "department" | "user";
  branchId?: string | null;
  userMembershipId?: string | null;
};

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const codePattern = /^SOP-(\d+)$/i;

function normalizedText(value: string | null | undefined) {
  const text = value?.trim();
  return text || null;
}

function numberValue(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function comparePresent<T>(
  a: T | null,
  b: T | null,
  direction: SopListSortDirection,
  compare: (left: T, right: T) => number,
) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const result = compare(a, b);
  return direction === "asc" ? result : -result;
}

function parseCode(reference: string | null | undefined) {
  const match = codePattern.exec(reference?.trim() ?? "");
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function tieBreak(a: SopListOrderingRow, b: SopListOrderingRow) {
  const byCreatedAt = comparePresent(numberValue(a.createdAt), numberValue(b.createdAt), "desc", (left, right) => left - right);
  return byCreatedAt || a._id.localeCompare(b._id);
}

function effectiveSort(sort: SopListSort) {
  if (sort.mode === "field") return sort;
  return {
    mode: "field" as const,
    field: defaultSopListSortField(),
    direction: defaultSopListSortDirection(),
  };
}

export function compareSopListRows(
  sort: SopListSort,
  a: SopListOrderingRow,
  b: SopListOrderingRow,
  options: SopListOrderingOptions = {},
) {
  const active = effectiveSort(sort);
  const direction = active.direction;
  let primary = 0;

  switch (active.field) {
    case "code":
      primary = comparePresent(parseCode(a.reference), parseCode(b.reference), direction, (left, right) => left - right);
      break;
    case "title":
      primary = comparePresent(normalizedText(a.title), normalizedText(b.title), direction, (left, right) => collator.compare(left, right));
      break;
    case "assignedTo":
      primary = comparePresent(
        normalizedText(sopTargetName(a, options.companyName)),
        normalizedText(sopTargetName(b, options.companyName)),
        direction,
        (left, right) => collator.compare(left, right),
      );
      break;
    case "createdAt":
      primary = comparePresent(numberValue(a.createdAt), numberValue(b.createdAt), direction, (left, right) => left - right);
      break;
    case "updatedAt":
      primary = comparePresent(numberValue(a.updatedAt), numberValue(b.updatedAt), direction, (left, right) => left - right);
      break;
  }

  return primary || tieBreak(a, b);
}

export function sortSopListRows<TRow extends SopListOrderingRow>(
  rows: readonly TRow[],
  sort: SopListSort,
  options: SopListOrderingOptions = {},
) {
  return [...rows].sort((a, b) => compareSopListRows(sort, a, b, options));
}

export function restoreSopListCustomOrder<TRow extends SopListOrderingRow>(
  rows: readonly TRow[],
  customOrder: readonly string[] | null | undefined,
  options: SopListOrderingOptions = {},
) {
  return restoreListCustomOrder(rows, customOrder, sortSopListRows(rows, { mode: "default" }, options));
}

/** The list filters authorized rows locally, so search, view, and scope stay consistent across pages. */
export function filterSopListRows<TRow extends SopListFilterRow>(
  rows: readonly TRow[],
  filters: SopListFilters = {},
) {
  const needle = filters.search?.trim().toLowerCase();
  return rows.filter((row) => {
    if (
      needle &&
      !row.reference?.toLowerCase().includes(needle) &&
      !row.title?.toLowerCase().includes(needle) &&
      !row.content?.toLowerCase().includes(needle)
    ) return false;
    if (filters.view === "my" && !row.matchesMyView) return false;
    if (filters.scope && filters.scope !== "all" && row.scopeType !== filters.scope) return false;
    if (filters.branchId && !(row.filterBranchIds ?? []).includes(filters.branchId)) return false;
    if (filters.view !== "my" && filters.userMembershipId && !(row.userMembershipIds ?? []).includes(filters.userMembershipId)) return false;
    return true;
  });
}
