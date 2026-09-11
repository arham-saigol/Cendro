export type ListOrderRow = { _id: string };

export function sameListOrder(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function mergeFilteredListOrder(
  fullOrder: readonly string[],
  filteredIds: readonly string[],
  nextFilteredIds: readonly string[],
) {
  const filtered = new Set(filteredIds);
  const next = [...nextFilteredIds];
  let nextIndex = 0;
  return fullOrder.map((id) => (filtered.has(id) ? next[nextIndex++] ?? id : id));
}

/** Saved IDs that are present keep their saved order; every other row follows the supplied default order. */
export function restoreListCustomOrder<TRow extends ListOrderRow>(
  rows: readonly TRow[],
  customOrder: readonly string[] | null | undefined,
  defaultOrderedRows: readonly TRow[],
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

  return [...restored, ...defaultOrderedRows.filter((row) => !included.has(row._id))];
}
