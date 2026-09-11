import { restoreListCustomOrder } from "./list-order";
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

const customOrderKeyPattern = /^(?:0|-[1-9]\d*|[1-9]\d*)\/[1-9]\d*$/;
const customOrderKeyGap = 1_024n;
export const taskListOrderKeyMaxLength = 512;

type ParsedCustomOrderKey = {
  numerator: bigint;
  denominator: bigint;
};

export type TaskListOrderKeyUpdate = {
  taskId: string;
  orderKey: string;
};

class TaskListOrderRebalanceRequired extends Error {}

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

function greatestCommonDivisor(left: bigint, right: bigint) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function formatCustomOrderKey(numerator: bigint, denominator: bigint) {
  if (denominator <= 0n) throw new Error("A custom task order key needs a positive denominator.");
  const divisor = greatestCommonDivisor(numerator, denominator);
  const key = `${numerator / divisor}/${denominator / divisor}`;
  if (key.length > taskListOrderKeyMaxLength) throw new TaskListOrderRebalanceRequired();
  return key;
}

function parseCustomOrderKey(value: string): ParsedCustomOrderKey | null {
  if (!customOrderKeyPattern.test(value)) return null;
  const [numerator, denominator] = value.split("/");
  try {
    return { numerator: BigInt(numerator), denominator: BigInt(denominator) };
  } catch {
    return null;
  }
}

function compareCustomOrderKeys(left: ParsedCustomOrderKey, right: ParsedCustomOrderKey) {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function customOrderKeyAt(position: number) {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new Error("A custom task order position must be a non-negative safe integer.");
  }
  return formatCustomOrderKey(BigInt(position) * customOrderKeyGap, 1n);
}

function restoreTaskListCustomOrderBase<TRow extends TaskListOrderingRow>(
  rows: readonly TRow[],
  taskType: TaskListTaskType,
  customOrder: readonly string[] | null | undefined,
) {
  return restoreListCustomOrder(rows, customOrder, sortTaskListRows(rows, taskType, { mode: "default" }));
}

export function taskListCustomOrderKeys<TRow extends TaskListOrderingRow>(
  rows: readonly TRow[],
  taskType: TaskListTaskType,
  customOrder: readonly string[] | null | undefined,
  persistedKeys?: ReadonlyMap<string, string>,
) {
  const keys = new Map<string, string>();
  for (const [index, row] of restoreTaskListCustomOrderBase(rows, taskType, customOrder).entries()) {
    const persistedKey = persistedKeys?.get(row._id);
    keys.set(row._id, persistedKey && parseCustomOrderKey(persistedKey) ? persistedKey : customOrderKeyAt(index));
  }
  return keys;
}

export function taskListOrderKeyBetween(
  before: string | null | undefined,
  after: string | null | undefined,
) {
  const previous = before ? parseCustomOrderKey(before) : null;
  const next = after ? parseCustomOrderKey(after) : null;
  if (before && !previous) throw new Error("The preceding custom task order key is invalid.");
  if (after && !next) throw new Error("The following custom task order key is invalid.");
  if (previous && next && compareCustomOrderKeys(previous, next) >= 0) {
    throw new Error("The custom task order keys are not ordered.");
  }
  if (!previous && !next) return formatCustomOrderKey(0n, 1n);
  if (!previous && next) {
    return formatCustomOrderKey(next.numerator - customOrderKeyGap * next.denominator, next.denominator);
  }
  if (previous && !next) {
    return formatCustomOrderKey(previous.numerator + customOrderKeyGap * previous.denominator, previous.denominator);
  }
  return formatCustomOrderKey(
    previous!.numerator * next!.denominator + next!.numerator * previous!.denominator,
    2n * previous!.denominator * next!.denominator,
  );
}

export function taskListOrderPositionForMove(
  orderedIds: readonly string[],
  sourceId: string,
  orderKeys: ReadonlyMap<string, string>,
) {
  const sourceIndex = orderedIds.indexOf(sourceId);
  if (sourceIndex < 0) throw new Error("The task is not in the custom task order.");
  if (new Set(orderedIds).size !== orderedIds.length) throw new Error("The custom task order contains duplicate tasks.");

  const beforeId = orderedIds[sourceIndex - 1];
  const afterId = orderedIds[sourceIndex + 1];
  const beforeKey = beforeId ? orderKeys.get(beforeId) : null;
  const afterKey = afterId ? orderKeys.get(afterId) : null;
  if ((beforeId && !beforeKey) || (afterId && !afterKey)) {
    throw new Error("Could not calculate a position for this task. Refresh and try again.");
  }

  try {
    return {
      orderKey: taskListOrderKeyBetween(beforeKey, afterKey),
      rebalancedOrderKeys: null,
    };
  } catch (error) {
    if (!(error instanceof TaskListOrderRebalanceRequired)) throw error;
    const rebalancedOrderKeys = orderedIds.map((taskId, index) => ({
      taskId,
      orderKey: customOrderKeyAt(index),
    }));
    return {
      orderKey: rebalancedOrderKeys[sourceIndex].orderKey,
      rebalancedOrderKeys,
    };
  }
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
  persistedKeys?: ReadonlyMap<string, string>,
) {
  const baseOrder = restoreTaskListCustomOrderBase(rows, taskType, customOrder);
  if (!persistedKeys?.size) return baseOrder;

  const baseIndexById = new Map(baseOrder.map((row, index) => [row._id, index]));
  const keys = taskListCustomOrderKeys(rows, taskType, customOrder, persistedKeys);
  const parsedKeys = new Map(
    Array.from(keys, ([id, key]) => [id, parseCustomOrderKey(key)]),
  );

  return [...baseOrder].sort((left, right) => {
    const leftKey = parsedKeys.get(left._id);
    const rightKey = parsedKeys.get(right._id);
    if (leftKey && rightKey) {
      const compared = compareCustomOrderKeys(leftKey, rightKey);
      if (compared !== 0) return compared;
    }
    return (baseIndexById.get(left._id) ?? 0) - (baseIndexById.get(right._id) ?? 0);
  });
}
