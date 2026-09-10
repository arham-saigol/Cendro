export type TaskRowBounds = { id: string; top: number; height: number };
export type TaskInsertion = { anchorId: string; edge: "before" | "after" };
export type Point = { x: number; y: number };

export function resolveTaskInsertion(
  rows: readonly TaskRowBounds[],
  sourceId: string,
  pointer: Point,
  envelope: { left: number; right: number },
): TaskInsertion | null {
  const first = rows[0];
  const last = rows.at(-1);
  if (!first || !last || !rows.some((row) => row.id === sourceId)) return null;
  if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return null;
  if (
    pointer.x < envelope.left - 12 || pointer.x > envelope.right + 12 ||
    pointer.y < first.top - first.height ||
    pointer.y > last.top + last.height * 2
  ) return null;
  const candidates = rows.filter((row) => row.id !== sourceId);
  const following = candidates.find((row) => pointer.y < row.top + row.height / 2);
  if (following) return { anchorId: following.id, edge: "before" };
  const preceding = candidates.at(-1);
  return preceding ? { anchorId: preceding.id, edge: "after" } : null;
}

export function insertTask(
  ids: readonly string[],
  sourceId: string,
  insertion: TaskInsertion,
): string[] {
  if (!ids.includes(sourceId) || sourceId === insertion.anchorId || !ids.includes(insertion.anchorId)) return [...ids];
  const next = ids.filter((id) => id !== sourceId);
  next.splice(next.indexOf(insertion.anchorId) + (insertion.edge === "after" ? 1 : 0), 0, sourceId);
  return next;
}

export function taskPreviewOffsets(rows: readonly TaskRowBounds[], nextIds: readonly string[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const offsets = new Map<string, number>();
  let top = rows[0]?.top ?? 0;
  for (const [index, id] of nextIds.entries()) {
    const row = byId.get(id);
    if (!row) continue;
    offsets.set(id, top - row.top);
    const gap = index + 1 < rows.length
      ? Math.max(0, rows[index + 1].top - rows[index].top - rows[index].height)
      : 0;
    top += row.height + gap;
  }
  return offsets;
}

// dragmove is dispatched before operation.position is updated by dnd-kit.
export function taskMovePoint(event: { to?: Point; by?: Partial<Point>; operation: { position: { current: Point } } }): Point {
  return event.to ?? {
    x: event.operation.position.current.x + (event.by?.x ?? 0),
    y: event.operation.position.current.y + (event.by?.y ?? 0),
  };
}

export function taskReleasePoint(event: { nativeEvent?: Event; operation: { position: { current: Point } } }): Point {
  const native = event.nativeEvent;
  if (native && "clientX" in native && "clientY" in native &&
      typeof native.clientX === "number" && typeof native.clientY === "number") {
    return { x: native.clientX, y: native.clientY };
  }
  return event.operation.position.current;
}
