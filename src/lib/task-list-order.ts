import {
  defaultTaskListSortDirection,
  defaultTaskListSortField,
  type TaskListSort,
  type TaskListSortDirection,
  type TaskListTaskType,
} from "./task-list-sort";

export type TaskListAssignee = {
  user?: {
    name?: string | null;
    email?: string | null;
  } | null;
};

export type TaskListOrderingRow = {
  _id: string;
  reference?: string | null;
  title?: string | null;
  assignees?: readonly TaskListAssignee[] | null;
  recurrence?: string | null;
  priority?: string | null;
  dueDate?: number | null;
  createdAt?: number | null;
  quantity?: number | null;
};

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const jdReferencePattern = /^JD-(\d+)$/i;
const oneTimeReferencePattern = /^TSK-(\d+)$/i;

const frequencyRanks = new Map<string, number>([
  ["daily", 0],
  ["every_other_day", 1],
  ["weekly", 2],
  ["semimonthly", 3],
  ["monthly", 4],
  ["quarterly", 5],
  ["semiannually", 6],
  ["annually", 7],
]);

const priorityRanks = new Map<string, number>([
  ["low", 0],
  ["medium", 1],
  ["high", 2],
]);

function normalizedText(value: string | null | undefined) {
  const text = value?.trim();
  return text || null;
}

function comparePresent<T>(
  a: T | null,
  b: T | null,
  direction: TaskListSortDirection,
  compare: (left: T, right: T) => number,
) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const result = compare(a, b);
  return direction === "asc" ? result : -result;
}

function parseReference(taskType: TaskListTaskType, reference: string | null | undefined) {
  const match = (taskType === "jd" ? jdReferencePattern : oneTimeReferencePattern).exec(reference?.trim() ?? "");
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function assigneeNames(row: TaskListOrderingRow) {
  return (row.assignees ?? [])
    .map((assignee) => normalizedText(assignee.user?.name) ?? normalizedText(assignee.user?.email) ?? "Unknown user")
    .sort((left, right) => collator.compare(left, right));
}

function compareAssigneeNames(
  a: readonly string[],
  b: readonly string[],
  direction: TaskListSortDirection,
) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const commonLength = Math.min(a.length, b.length);
  for (let index = 0; index < commonLength; index += 1) {
    const compared = collator.compare(a[index], b[index]);
    if (compared !== 0) return direction === "asc" ? compared : -compared;
  }
  const lengthDifference = a.length - b.length;
  return direction === "asc" ? lengthDifference : -lengthDifference;
}

function tieBreak(a: TaskListOrderingRow, b: TaskListOrderingRow) {
  const createdA = Number.isFinite(a.createdAt) ? (a.createdAt as number) : null;
  const createdB = Number.isFinite(b.createdAt) ? (b.createdAt as number) : null;
  const byCreatedAt = comparePresent(createdA, createdB, "desc", (left, right) => left - right);
  return byCreatedAt || a._id.localeCompare(b._id);
}

function effectiveSort(taskType: TaskListTaskType, sort: TaskListSort) {
  if (sort.mode === "field") return sort;
  return {
    mode: "field" as const,
    field: defaultTaskListSortField(taskType),
    direction: defaultTaskListSortDirection(taskType),
  };
}

function rank(value: string | null | undefined, ranks: ReadonlyMap<string, number>) {
  const normalized = normalizedText(value)?.toLowerCase();
  return normalized === undefined || normalized === null ? null : ranks.get(normalized) ?? null;
}

function numberValue(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function compareTaskListRows(
  taskType: TaskListTaskType,
  sort: TaskListSort,
  a: TaskListOrderingRow,
  b: TaskListOrderingRow,
) {
  const activeSort = effectiveSort(taskType, sort);
  const direction = activeSort.direction;
  let primary = 0;

  switch (activeSort.field) {
    case "code":
      primary = comparePresent(
        parseReference(taskType, a.reference),
        parseReference(taskType, b.reference),
        direction,
        (left, right) => left - right,
      );
      break;
    case "user":
      primary = compareAssigneeNames(assigneeNames(a), assigneeNames(b), direction);
      break;
    case "frequency":
      primary = comparePresent(
        rank(a.recurrence, frequencyRanks),
        rank(b.recurrence, frequencyRanks),
        direction,
        (left, right) => left - right,
      );
      break;
    case "priority":
      primary = comparePresent(
        rank(a.priority, priorityRanks),
        rank(b.priority, priorityRanks),
        direction,
        (left, right) => left - right,
      );
      break;
    case "dueDate":
      primary = comparePresent(numberValue(a.dueDate), numberValue(b.dueDate), direction, (left, right) => left - right);
      break;
    case "title":
      primary = comparePresent(normalizedText(a.title), normalizedText(b.title), direction, (left, right) => collator.compare(left, right));
      break;
    case "dateAssigned":
      primary = comparePresent(numberValue(a.createdAt), numberValue(b.createdAt), direction, (left, right) => left - right);
      break;
    case "quantity":
      primary = comparePresent(numberValue(a.quantity), numberValue(b.quantity), direction, (left, right) => left - right);
      break;
  }

  return primary || tieBreak(a, b);
}

export function sortTaskListRows<TRow extends TaskListOrderingRow>(
  rows: readonly TRow[],
  taskType: TaskListTaskType,
  sort: TaskListSort,
) {
  return [...rows].sort((a, b) => compareTaskListRows(taskType, sort, a, b));
}

export function restoreTaskListCustomOrder<TRow extends TaskListOrderingRow>(
  rows: readonly TRow[],
  taskType: TaskListTaskType,
  customOrder: readonly string[] | null | undefined,
) {
  const rowById = new Map(rows.map((row) => [row._id, row]));
  const restored: TRow[] = [];
  const included = new Set<string>();

  for (const id of customOrder ?? []) {
    const row = rowById.get(id);
    if (row && !included.has(id)) {
      restored.push(row);
      included.add(id);
    }
  }

  const missing = rows.filter((row) => !included.has(row._id));
  return [...restored, ...sortTaskListRows(missing, taskType, { mode: "default" })];
}

export function moveTaskListId(
  ids: readonly string[],
  sourceId: string,
  targetId: string,
) {
  const sourceIndex = ids.indexOf(sourceId);
  const targetIndex = ids.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return [...ids];
  const next = [...ids];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

export function mergeFilteredTaskListOrder(
  fullOrder: readonly string[],
  filteredIds: readonly string[],
  nextFilteredIds: readonly string[],
) {
  const filtered = new Set(filteredIds);
  const next = [...nextFilteredIds];
  let nextIndex = 0;
  return fullOrder.map((id) => (filtered.has(id) ? next[nextIndex++] ?? id : id));
}

export function sameTaskListOrder(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
