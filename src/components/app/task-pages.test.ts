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
  pausedIds: [] as string[],
  lifecycleAllowed: true,
  capabilities: [] as string[],
  ignorePausedQuery: false,
  lifecycleWrites: [] as { taskIds: string[]; paused: boolean }[],
  railRows: new Map<string, () => void>(),
  selectMy: null as null | (() => void),
  selects: new Map<string, () => void>(),
  filterPaused: null as null | ((value: boolean) => void),
  drop: null as null | ((id: string, insertion: ListInsertion) => void),
  selectCustom: null as null | (() => void),
  writes: [] as { args: { orderedIds: string[]; expectedRevision: number }; resolve: (value: { orderedIds: string[]; revision: number }) => void }[],
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./company-context", () => ({ useCompany: () => ({
  activeCompanyId: "company", active: { membership: { _id: "member" }, capabilities: state.capabilities },
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
  usePaginatedQuery: (_ref: unknown, args: { paused?: boolean }) => {
    state.railRows.clear();
    return { status: "Exhausted", loadMore: vi.fn(), results:
      [...(state.pending ? ["pending:new"] : []), "A", "B", "C"]
        .filter((_id) => state.ignorePausedQuery || state.pausedIds.includes(_id) === Boolean(args.paused))
        .map((_id) => ({
          _id, reference: _id, title: _id, recurrence: _id === "B" ? "weekly" : "daily", priority: "low", createdAt: 1,
          pausedAt: state.pausedIds.includes(_id) ? 1 : undefined,
          canPause: state.lifecycleAllowed, canResume: state.lifecycleAllowed,
          assigneeMembershipIds: ["member"], assignees: [], state: { status: "Due" },
        })),
    };
  },
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
    const mutate = ["tasks:saveCustomView", "tasks:saveListOrder"].includes(getFunctionName(ref))
      ? (args: typeof state.writes[number]["args"]) => new Promise<{ orderedIds: string[]; revision: number }>((resolve) => state.writes.push({ args, resolve }))
      : getFunctionName(ref) === "tasks:setJdPausedBulk"
        ? async (args: { taskIds: string[]; paused: boolean }) => { state.lifecycleWrites.push(args); }
        : vi.fn();
    return Object.assign(mutate, { withOptimisticUpdate: () => mutate });
  },
}));
// Drive the list's drag/drop seam without depending on pointer geometry or animation.
vi.mock("./list-dnd", () => ({
  useListDrag: (options: { onDrop: typeof state.drop }) => { state.drop = options.onDrop; return { active: false }; },
  ListDragOverlay: () => null,
  ListDragRailRow: ({ id, children }: { id: string; children: React.ReactElement<{ onCheckedChange: () => void }> }) => {
    state.railRows.set(id, children.props.onCheckedChange);
    return null;
  },
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
        const label = React.Children.toArray(button.props.children);
        if (label.includes("Custom")) state.selectCustom = button.props.onClick ?? null;
        if (label.includes("My Tasks")) state.selectMy = button.props.onClick ?? null;
      });
    });
    return null;
  },
}));
vi.mock("@/lib/use-is-coarse-pointer", () => ({ useIsCoarsePointer: () => false }));

vi.mock("@radix-ui/react-dropdown-menu", () => {
  const pass = ({ children }: { children: ReactNode }) => children;
  const findLabel = (node: ReactNode): string | null => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) {
      for (const child of node) {
        const label = findLabel(child);
        if (label) return label;
      }
      return null;
    }
    if (React.isValidElement<{ children?: ReactNode }>(node)) return findLabel(node.props.children);
    return null;
  };
  return { Root: pass, Trigger: pass, Portal: pass, Content: pass, Sub: pass, SubTrigger: pass, SubContent: pass,
    Item: ({ onSelect, children }: { onSelect?: () => void; children?: ReactNode }) => {
      const label = findLabel(children);
      if (label && onSelect) state.selects.set(label, onSelect);
      return children;
    },
    CheckboxItem: ({ onCheckedChange, children }: { onCheckedChange: (value: boolean) => void; children: ReactNode }) => {
      state.filterPaused = onCheckedChange;
      return children;
    },
  };
});

let container: ReturnType<typeof createMockElement>;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  state.view = { orderedIds: ["A", "B", "C"], revision: 0 };
  state.pending = false;
  state.pausedIds = [];
  state.lifecycleAllowed = true;
  state.capabilities = [];
  state.ignorePausedQuery = false;
  state.lifecycleWrites = [];
  state.filterPaused = null;
  state.selects.clear();
  state.writes = [];
});

async function mount(kind: "jd" | "one", custom = true) {
  container = createMockElement();
  root = createRoot(container);
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

function descendants(node: any): any[] {
  return [node, ...(node.children ?? []).flatMap(descendants)];
}
function button(label: string) {
  return descendants(container).find((node) => node.tagName === "BUTTON" && (node.getAttribute?.("aria-label") === label || descendants(node).some((child) => child.nodeValue === label || child.textContent === label)));
}
async function clickButton(label: string) {
  const node = button(label);
  expect(node).toBeDefined();
  const props = node[Object.keys(node).find((key) => key.startsWith("__reactProps$"))!];
  await act(async () => props.onClick());
}

test("bulk lifecycle actions follow selection state and permissions, and submit the selected IDs", async () => {
  await mount("jd", false);
  await act(async () => state.railRows.get("A")!());
  await act(async () => state.railRows.get("B")!());
  expect(button("Make inactive")).toBeDefined();
  // Icon-only button: the label lives on the tooltip, not as button text.
  expect(button("Make inactive")?.getAttribute("data-tooltip")).toBe("Make inactive");
  expect(button("Make active")).toBeUndefined();
  await clickButton("Make inactive");
  expect(state.lifecycleWrites).toEqual([{ companyId: "company", taskIds: ["A", "B"], paused: true }]);
  state.pausedIds = ["A", "B", "C"];
  await act(async () => state.filterPaused!(true));
  await act(async () => state.railRows.get("A")!());
  expect(button("Make active")).toBeDefined();
  await clickButton("Make active");
  expect(state.lifecycleWrites[1]).toMatchObject({ taskIds: ["A"], paused: false });
  state.lifecycleAllowed = false;
  await act(async () => root!.render(React.createElement(TaskList, { kind: "jd" })));
  await act(async () => state.railRows.get("A")!());
  expect(button("Make active")).toBeUndefined();
});

test("a live selection that becomes mixed offers neither pause nor resume", async () => {
  await mount("jd", false);
  await act(async () => state.railRows.get("A")!());
  await act(async () => state.railRows.get("B")!());
  state.ignorePausedQuery = true;
  state.pausedIds = ["B"];
  await act(async () => root!.render(React.createElement(TaskList, { kind: "jd" })));
  expect(button("Make inactive")).toBeUndefined();
  expect(button("Make active")).toBeUndefined();
});

test("paused filtering works in All and My views and with a frequency filter, while Custom never includes paused rows", async () => {
  state.pausedIds = ["B"];
  state.capabilities = ["tasks:jd:view:any"];
  await mount("jd", false);
  expect([...state.railRows.keys()]).toEqual(["A", "C"]);
  await act(async () => state.filterPaused!(true));
  expect([...state.railRows.keys()]).toEqual(["B"]);
  await act(async () => state.selectMy!());
  expect([...state.railRows.keys()]).toEqual(["B"]);
  await act(async () => state.selects.get("Daily")!());
  expect([...state.railRows.keys()]).toEqual([]);
  await act(async () => state.selects.get("Weekly")!());
  expect([...state.railRows.keys()]).toEqual(["B"]);
  state.filterPaused = null;
  await act(async () => state.selectCustom!());
  expect(state.filterPaused).toBeNull();
  expect([...state.railRows.keys()]).toEqual(["A", "C"]);
});
