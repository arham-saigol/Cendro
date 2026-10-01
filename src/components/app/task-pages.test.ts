import { afterEach, expect, test, vi } from "vitest";
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getFunctionName } from "convex/server";
import type { ListInsertion } from "@/lib/list-drag";
import { createMockElement } from "./test-dom";
import { TaskList } from "./task-pages";

Object.assign(document, { createElementNS: (_namespace: string, tag: string) => createMockElement(tag) });

const state = vi.hoisted(() => ({
  view: { orderedIds: ["A", "B", "C"], revision: 0 },
  pending: false,
  drop: null as null | ((id: string, insertion: ListInsertion) => void),
  selectCustom: null as null | (() => void),
  writes: [] as { args: { orderedIds: string[]; expectedRevision: number }; resolve: (value: { orderedIds: string[]; revision: number }) => void }[],
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./company-context", () => ({ useCompany: () => ({
  activeCompanyId: "company", active: { membership: { _id: "member" }, capabilities: [] },
}) }));
vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0]) => {
    switch (getFunctionName(ref)) {
      case "tasks:getCustomView": return state.view;
      case "tasks:getListPreference": return { sort: { mode: "default" }, customOrder: null, revision: 0 };
      case "tasks:assignableUsers": return { users: [], isTruncated: false };
      default: return [];
    }
  },
  usePaginatedQuery: () => ({ status: "Exhausted", loadMore: vi.fn(), results:
    [...(state.pending ? ["pending:new"] : []), "A", "B", "C"].map((_id) => ({
      _id, reference: _id, title: _id, recurrence: "daily", priority: "low", createdAt: 1,
      assigneeMembershipIds: ["member"], assignees: [], state: { status: "Due" },
    })),
  }),
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
    const mutate = ["tasks:saveCustomView", "tasks:saveListOrder"].includes(getFunctionName(ref))
      ? (args: typeof state.writes[number]["args"]) => new Promise<{ orderedIds: string[]; revision: number }>((resolve) => state.writes.push({ args, resolve }))
      : vi.fn();
    return Object.assign(mutate, { withOptimisticUpdate: () => mutate });
  },
}));
// Drive the list's drag/drop seam without depending on pointer geometry or animation.
vi.mock("./list-dnd", () => ({
  useListDrag: (options: { onDrop: typeof state.drop }) => { state.drop = options.onDrop; return { active: false }; },
  ListDragOverlay: () => null,
  ListDragRailRow: () => null,
  ListSortableRow: () => null,
}));
vi.mock("@dnd-kit/react", () => ({ DragDropProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("./task-rail-scroll", () => ({
  useTaskRailAutoScroll: () => ({ syncToggleScrollState: vi.fn() }),
  TaskRail: ({ children }: { children: ReactNode }) => {
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
      React.Children.forEach(child.props.children, (button) => {
        if (!React.isValidElement<{ children?: ReactNode; onClick?: () => void }>(button)) return;
        if (React.Children.toArray(button.props.children).includes("Custom")) state.selectCustom = button.props.onClick ?? null;
      });
    });
    return null;
  },
}));
vi.mock("@/lib/use-is-coarse-pointer", () => ({ useIsCoarsePointer: () => false }));

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  state.view = { orderedIds: ["A", "B", "C"], revision: 0 };
  state.pending = false;
  state.writes = [];
});

async function mount(kind: "jd" | "one", custom = true) {
  root = createRoot(createMockElement());
  await act(async () => root!.render(React.createElement(TaskList, { kind })));
  if (custom) await act(async () => state.selectCustom!());
}

test("Custom keeps queued moves when its subscription arrives before the save acknowledgement", async () => {
  await mount("jd");
  await act(async () => state.drop!("B", { anchorId: "A", edge: "before" }));
  await act(async () => state.drop!("C", { anchorId: "B", edge: "before" }));
  expect(state.writes).toHaveLength(1);
  state.view = { orderedIds: ["B", "A", "C"], revision: 1 };
  await act(async () => root!.render(React.createElement(TaskList, { kind: "jd" })));
  await act(async () => state.writes[0].resolve(state.view));
  expect(state.writes[1].args).toMatchObject({ orderedIds: ["C", "B", "A"], expectedRevision: 1 });
  // Returning to the in-flight order must coalesce, not produce a redundant save.
  await act(async () => state.drop!("C", { anchorId: "B", edge: "after" }));
  await act(async () => state.drop!("C", { anchorId: "B", edge: "before" }));
  await act(async () => state.writes[1].resolve({ orderedIds: ["C", "B", "A"], revision: 2 }));
  expect(state.writes).toHaveLength(2);
});

test.each([true, false])("reordering excludes optimistic creation rows (Custom: %s)", async (custom) => {
  state.pending = true;
  await mount("one", custom);
  await act(async () => state.drop!("B", { anchorId: "A", edge: "before" }));
  expect(state.writes[0].args).toMatchObject({ orderedIds: ["B", "A", "C"], expectedRevision: 0 });
});
