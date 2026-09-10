"use client";

import {
  DragOverlay,
  type BeforeDragStartEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragDropManager,
} from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import type { DropAnimationFunction } from "@dnd-kit/dom";
import { SortableKeyboardPlugin } from "@dnd-kit/dom/sortable";
import { getWindow, parseTranslate, prefersReducedMotion } from "@dnd-kit/dom/utilities";
import { Grip } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import {
  insertTask, resolveTaskInsertion, taskMovePoint, taskPreviewOffsets, taskReleasePoint,
  type Point, type TaskInsertion, type TaskRowBounds,
} from "@/lib/task-list-drag";
import { sameTaskListOrder } from "@/lib/task-list-order";

type Refs = { handleRef: (node: Element | null) => void; targetRef: (node: Element | null) => void };
type Binding = { handle?: Element | null; target?: Element | null; refs?: Refs };
type Layout = { rows: TaskRowBounds[]; headerHeight: number; tableLeft: number; tableWidth: number };
type Session = {
  sourceId: string;
  key: string;
  keyboard: boolean;
  layout: Layout;
  pointer: Point;
  insertion: TaskInsertion | null;
  overlay: HTMLTableElement;
};
type Options = {
  ids: string[];
  sessionKey: string;
  disabled: boolean;
  wrapperRef: RefObject<HTMLDivElement | null>;
  bodyRef: RefObject<HTMLTableSectionElement | null>;
  onDrop: (sourceId: string, insertion: TaskInsertion) => void;
};

// Only the keyboard sorting plugin is needed; React owns both the table and rail.
const plugins = [SortableKeyboardPlugin];

// Rows carry a preview transform while dragging, and getBoundingClientRect() reports that transformed
// box — including for the frames where the transform is being animated away. The rail places each row
// control with `top`, so measure the layout box instead: offsetTop/offsetHeight are defined on the
// layout box and ignore transforms, transitions, and scrolling. The walk stops at the wrapper, which is
// both the rail's containing block and the coordinate space the pointer insertion math already uses.
function layoutOffsetTop(element: HTMLElement, boundary: HTMLElement) {
  let top = 0;
  for (let node: HTMLElement | null = element; node && node !== boundary; node = node.offsetParent as HTMLElement | null) {
    top += node.offsetTop;
  }
  return top;
}

function measureTaskLayout(wrapper: HTMLDivElement | null, body: HTMLTableSectionElement | null): Layout | null {
  if (!wrapper || !body) return null;
  const origin = wrapper.getBoundingClientRect();
  const table = body.closest("table")!;
  const tableRect = table.getBoundingClientRect();
  return {
    rows: [...body.querySelectorAll<HTMLTableRowElement>("tr[data-task-id]")].map((row) => ({
      id: row.dataset.taskId!,
      top: layoutOffsetTop(row, wrapper),
      height: row.offsetHeight,
    })),
    headerHeight: table.tHead?.getBoundingClientRect().height ?? 36,
    tableLeft: tableRect.left - origin.left,
    tableWidth: tableRect.width,
  };
}

// The source keeps its layout slot while its overlay follows the pointer, so its own shift is
// never applied. Storing it would translate the real source row by the whole move distance in
// any commit that lands after the session ends but before the offsets are cleared — the same
// commit that already shows the reordered list.
function previewRowOffsets(current: Session, nextIds: readonly string[]) {
  const offsets = taskPreviewOffsets(current.layout.rows, nextIds);
  offsets.delete(current.sourceId);
  return offsets;
}

function projectTaskDrag(current: Session, wrapper: HTMLDivElement, point: Point) {
  current.pointer = point;
  const rect = wrapper.getBoundingClientRect();
  const pointer = { x: point.x - rect.left, y: point.y - rect.top };
  current.insertion = resolveTaskInsertion(
    current.layout.rows, current.sourceId, pointer, { left: 0, right: rect.width },
  );
  const ids = current.layout.rows.map((row) => row.id);
  const next = current.insertion ? insertTask(ids, current.sourceId, current.insertion) : ids;
  return previewRowOffsets(current, next);
}

function cloneFeedback(row: HTMLTableRowElement) {
  const table = document.createElement("table");
  table.className = "task-table task-drag-overlay-table";
  table.style.width = `${row.getBoundingClientRect().width}px`;
  const body = table.createTBody();
  const clone = row.cloneNode(true) as HTMLTableRowElement;
  for (const node of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
    for (const attribute of [...node.attributes]) {
      if (attribute.name === "id" || attribute.name.startsWith("data-") || attribute.name.startsWith("aria-")) {
        node.removeAttribute(attribute.name);
      }
    }
    node.removeAttribute("tabindex");
    node.removeAttribute("contenteditable");
  }
  clone.style.transform = "";
  for (const [index, cell] of [...clone.cells].entries()) {
    const width = row.cells[index].getBoundingClientRect().width;
    cell.style.width = `${width}px`;
    cell.style.minWidth = `${width}px`;
    cell.style.maxWidth = `${width}px`;
  }
  body.appendChild(clone);
  table.setAttribute("inert", "");
  table.setAttribute("aria-hidden", "true");
  return table;
}

export function useTaskListDrag(options: Options) {
  const { wrapperRef, bodyRef } = options;
  const bindings = useRef(new Map<string, Binding>());
  const manager = useRef<DragDropManager | null>(null);
  const session = useRef<Session | null>(null);
  const latest = useRef(options);
  const [layout, setLayout] = useState<Layout>({ rows: [], headerHeight: 36, tableLeft: 56, tableWidth: 0 });
  const [active, setActive] = useState(false);
  const [offsets, setOffsets] = useState(new Map<string, number>());
  const [overlay, setOverlay] = useState<HTMLTableElement | null>(null);
  const idsKey = JSON.stringify(options.ids);

  const measure = useCallback((): Layout | null => {
    return measureTaskLayout(wrapperRef.current, bodyRef.current);
  }, [bodyRef, wrapperRef]);

  const clear = useCallback(() => {
    const current = session.current;
    if (current && !current.keyboard) {
      const handle = bindings.current.get(current.sourceId)?.handle;
      if (handle instanceof HTMLElement && document.activeElement === handle) handle.blur();
    }
    session.current = null;
    setActive(false);
    setOffsets(new Map());
    // Keep the feedback content until dnd-kit finishes its drop animation.
  }, []);

  const cancel = useCallback(() => {
    if (session.current) manager.current?.actions.stop({ canceled: true });
    clear();
  }, [clear]);

  useLayoutEffect(() => {
    latest.current = options;
    if (session.current && (session.current.key !== options.sessionKey || options.disabled)) cancel();
  });

  useLayoutEffect(() => {
    if (active) return;
    const update = () => {
      const next = measure();
      if (next) setLayout((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    };
    update();
    const observer = new ResizeObserver(() => {
      if (session.current) return;
      update();
    });
    if (bodyRef.current) observer.observe(bodyRef.current);
    for (const row of bodyRef.current?.rows ?? []) observer.observe(row);
    const table = bodyRef.current?.closest("table");
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, [active, bodyRef, idsKey, measure]);

  const project = useCallback((point: Point) => {
    const current = session.current;
    const wrapper = wrapperRef.current;
    if (!current || !wrapper) return;
    setOffsets(projectTaskDrag(current, wrapper, point));
  }, [wrapperRef]);

  useLayoutEffect(() => {
    if (!active) return;
    const onScroll = () => {
      if (session.current && !session.current.keyboard) project(session.current.pointer);
    };
    const resize = () => cancel();
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", resize);
    const observer = new ResizeObserver((entries) => {
      const current = session.current;
      if (!current) return;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.taskId;
        const original = current.layout.rows.find((row) => row.id === id);
        if (original && Math.abs(entry.target.getBoundingClientRect().height - original.height) > 0.5) {
          cancel();
          return;
        }
      }
    });
    for (const row of bodyRef.current?.rows ?? []) observer.observe(row);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", resize);
      observer.disconnect();
    };
  }, [active, bodyRef, cancel, project]);

  useLayoutEffect(() => () => {
    session.current = null;
    manager.current?.actions.stop({ canceled: true });
  }, []);

  const register = useCallback((id: string, refs: Refs | null) => {
    const binding = bindings.current.get(id) ?? {};
    if (!refs) {
      binding.refs?.handleRef(null);
      binding.refs?.targetRef(null);
      bindings.current.delete(id);
      return;
    }
    binding.refs = refs;
    bindings.current.set(id, binding);
    refs.handleRef(binding.handle ?? null);
    refs.targetRef(binding.target ?? null);
  }, []);

  const attach = useCallback((id: string, kind: "handle" | "target", node: Element | null) => {
    const binding = bindings.current.get(id) ?? {};
    binding[kind] = node;
    bindings.current.set(id, binding);
    if (kind === "handle") binding.refs?.handleRef(node);
    else binding.refs?.targetRef(node);
  }, []);

  const onBeforeDragStart = useCallback((event: BeforeDragStartEvent, instance: DragDropManager) => {
    const source = event.operation.source;
    const sourceId = String(source?.id);
    const measured = measureTaskLayout(wrapperRef.current, bodyRef.current);
    const row = [...(bodyRef.current?.rows ?? [])].find((row) => row.dataset.taskId === sourceId);
    if (latest.current.disabled || !source || !row || !measured || !latest.current.ids.includes(sourceId)) {
      event.preventDefault();
      return;
    }
    manager.current = instance;
    const feedback = cloneFeedback(row);
    session.current = {
      sourceId, key: latest.current.sessionKey, keyboard: event.operation.activatorEvent?.type === "keydown",
      layout: measured, insertion: null, pointer: event.operation.position.current, overlay: feedback,
    };
    setLayout(measured);
    setOverlay(feedback);
    setActive(true);
  }, [bodyRef, wrapperRef]);

  const onDragMove = useCallback((event: DragMoveEvent) => {
    const current = session.current;
    const wrapper = wrapperRef.current;
    if (!current || current.keyboard || !wrapper) return;
    setOffsets(projectTaskDrag(current, wrapper, taskMovePoint(event)));
  }, [wrapperRef]);

  const onDragOver = useCallback((event: DragOverEvent) => {
    const current = session.current;
    const target = event.operation.target;
    if (!current?.keyboard || !target) return;
    const ids = current.layout.rows.map((row) => row.id);
    const targetId = String(target.id);
    const from = ids.indexOf(current.sourceId);
    const to = ids.indexOf(targetId);
    if (to < 0) return;
    current.insertion = targetId === current.sourceId ? null : { anchorId: targetId, edge: to < from ? "before" : "after" };
    const next = current.insertion ? insertTask(ids, current.sourceId, current.insertion) : ids;
    setOffsets(previewRowOffsets(current, next));
  }, []);

  const onDragEnd = useCallback((event: DragEndEvent) => {
    const current = session.current;
    if (!current) return;
    const valid = !event.canceled && current.key === latest.current.sessionKey && !latest.current.disabled;
    const wrapper = wrapperRef.current;
    if (valid && !current.keyboard && wrapper) projectTaskDrag(current, wrapper, taskReleasePoint(event));
    const insertion = current.insertion;
    const ids = current.layout.rows.map((row) => row.id);
    if (!current.keyboard) {
      const handle = bindings.current.get(current.sourceId)?.handle;
      if (handle instanceof HTMLElement && document.activeElement === handle) handle.blur();
    }
    session.current = null;
    setActive(false);
    setOffsets(new Map());
    if (valid && insertion && !sameTaskListOrder(ids, insertTask(ids, current.sourceId, insertion))) {
      latest.current.onDrop(current.sourceId, insertion);
    }
  }, [wrapperRef]);

  const rowStyle = useCallback((id: string): CSSProperties | undefined => {
    const shift = offsets.get(id);
    return shift ? { transform: `translateY(${shift}px)` } : undefined;
  }, [offsets]);

  return {
    active, layout, overlay, register, attach, rowStyle,
    onBeforeDragStart, onDragMove, onDragOver, onDragEnd,
  };
}

export type TaskListDrag = ReturnType<typeof useTaskListDrag>;

export function TaskSortableRow({
  id, index, scope, disabled, drag, children, ...props
}: {
  id: string; index: number; scope: string; disabled: boolean; drag: TaskListDrag;
} & React.ComponentProps<"tr">) {
  const { ref, handleRef, targetRef, isDragSource } = useSortable({
    id, index, group: scope, type: "task", accept: "task", disabled,
    plugins, transition: { duration: 0 },
  });
  const register = drag.register;
  useLayoutEffect(() => {
    register(id, { handleRef, targetRef });
    return () => register(id, null);
  }, [id, register, handleRef, targetRef]);
  return <tr {...props} ref={ref} data-task-id={id} data-dragging={isDragSource ? "true" : undefined} style={drag.rowStyle(id)}>{children}</tr>;
}

export function TaskDragRailRow({
  id, label, disabled, disabledReason, checked, drag, children,
}: {
  id: string; label: string; disabled: boolean; disabledReason?: string; checked: boolean;
  drag: TaskListDrag; children: ReactNode;
}) {
  const attach = drag.attach;
  const handleRef = useCallback((node: HTMLButtonElement | null) => attach(id, "handle", node), [attach, id]);
  const targetRef = useCallback((node: HTMLDivElement | null) => attach(id, "target", node), [attach, id]);
  const row = drag.layout.rows.find((row) => row.id === id);
  return (
    <>
      <div ref={targetRef} aria-hidden="true" className="pointer-events-none absolute" style={{
        top: row?.top ?? 0, height: row?.height ?? 0, left: drag.layout.tableLeft, width: drag.layout.tableWidth,
      }} />
      <div className="task-list-rail-row pointer-events-auto absolute left-0 flex w-14 items-center justify-end gap-1 pr-2"
        data-active={checked ? "true" : undefined}
        style={{ top: row?.top ?? 0, height: row?.height ?? 0, visibility: row ? undefined : "hidden", ...drag.rowStyle(id) }}>
        <button type="button" ref={handleRef} className="task-list-rail-control task-list-drag-handle"
          disabled={disabled} aria-label={label} title={disabledReason ?? label}>
          <Grip className="h-4 w-4" />
        </button>
        {children}
      </div>
    </>
  );
}

const DROP_ANIMATION_DURATION = 150;
const DROP_ANIMATION_EASING = "ease";
// While dragging, dnd-kit pins the overlay's translate through an `!important` CSS variable;
// the dropping attribute releases that rule so the animation below owns the property.
const DROPPING_ATTRIBUTE = "data-dnd-dropping";

// This list keeps no dnd-kit placeholder, so the default animation falls back to the source row as
// its target. Settle the clone on that row's committed position explicitly instead, measured after
// React has reordered the list, and release the !important translate rule the overlay is pinned by.
const animateOverlayToSource: DropAnimationFunction = ({ source, feedbackElement, translate }) => {
  const row = document.querySelector<HTMLTableRowElement>(`tr[data-task-id="${CSS.escape(String(source.id))}"]`);
  if (!row) return;
  const from = feedbackElement.getBoundingClientRect();
  const to = row.getBoundingClientRect();
  const current = parseTranslate(getComputedStyle(feedbackElement).translate) ?? translate;
  feedbackElement.setAttribute(DROPPING_ATTRIBUTE, "");
  return feedbackElement.animate(
    {
      translate: [
        `${current.x}px ${current.y}px`,
        `${current.x + to.left - from.left}px ${current.y + to.top - from.top}px`,
      ],
    },
    {
      duration: prefersReducedMotion(getWindow(feedbackElement)) ? 0 : DROP_ANIMATION_DURATION,
      easing: DROP_ANIMATION_EASING,
    },
  ).finished.then(() => {
    feedbackElement.removeAttribute(DROPPING_ATTRIBUTE);
  });
};

export function TaskListDragOverlay({ table }: { table: HTMLTableElement | null }) {
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (node && table) node.replaceChildren(table);
  }, [table]);
  return <DragOverlay className="task-drag-overlay" dropAnimation={animateOverlayToSource}>
    <div ref={ref} aria-hidden="true" />
  </DragOverlay>;
}
