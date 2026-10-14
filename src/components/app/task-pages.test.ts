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
  taskIds: ["A", "B", "C"],
  taskStates: {} as Record<string, { status: string; rawStatus: string }>,
  dueDates: {} as Record<string, number>,
  serverTime: null as number | null,
  clockFails: false,
  clockWait: null as Promise<void> | null,
  otherAssigneeIds: [] as string[],
  pausedIds: [] as string[],
  lifecycleAllowed: true,
  capabilities: [] as string[],
  ignorePausedQuery: false,
  lifecycleWrites: [] as { taskIds: string[]; paused: boolean }[],
  railRows: new Map<string, () => void>(),
  selectMy: null as null | (() => void),
  selectAll: null as null | (() => void),
  selects: new Map<string, () => void>(),
  checkboxes: new Map<string, { checked: boolean; onCheckedChange: (value: boolean) => void; onSelect?: (event: { preventDefault: () => void }) => void }>(),
  filterPaused: null as null | ((value: boolean) => void),
  drop: null as null | ((id: string, insertion: ListInsertion) => void),
  selectCustom: null as null | (() => void),
  writes: [] as { args: { orderedIds: string[]; expectedRevision: number }; resolve: (value: { orderedIds: string[]; revision: number }) => void }[],
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./company-context", () => ({ useCompany: () => ({
  activeCompanyId: "company", active: { membership: { _id: "member" }, capabilities: state.capabilities },
}) }));
vi.mock("convex/react", () => {
  const getServerTime = async () => {
    if (state.clockFails) throw new Error("Clock unavailable");
    const serverTime = state.serverTime ?? Date.now();
    if (state.clockWait) await state.clockWait;
    return serverTime;
  };
  return {
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
      state.selects.clear();
      state.checkboxes.clear();
      return { status: "Exhausted", loadMore: vi.fn(), results:
        [...(state.pending ? ["pending:new"] : []), ...state.taskIds]
          .filter((_id) => state.ignorePausedQuery || state.pausedIds.includes(_id) === Boolean(args.paused))
          .map((_id) => ({
            _id, reference: _id, title: _id, recurrence: _id === "B" ? "weekly" : "daily", priority: "low", createdAt: 1,
            dueDate: state.dueDates[_id],
            pausedAt: state.pausedIds.includes(_id) ? 1 : undefined,
            canPause: state.lifecycleAllowed, canResume: state.lifecycleAllowed,
            assigneeMembershipIds: [state.otherAssigneeIds.includes(_id) ? "other" : "member"], assignees: [], state: state.taskStates[_id] ?? { status: "Due" },
          })),
      };
    },
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
      if (getFunctionName(ref) === "tasks:getServerTime") return getServerTime;
      const mutate = ["tasks:saveCustomView", "tasks:saveListOrder"].includes(getFunctionName(ref))
        ? (args: typeof state.writes[number]["args"]) => new Promise<{ orderedIds: string[]; revision: number }>((resolve) => state.writes.push({ args, resolve }))
        : getFunctionName(ref) === "tasks:setJdPausedBulk"
          ? async (args: { taskIds: string[]; paused: boolean }) => { state.lifecycleWrites.push(args); }
          : vi.fn();
      return Object.assign(mutate, { withOptimisticUpdate: () => mutate });
    },
  };
});
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
        if (label.includes("All Tasks")) state.selectAll = button.props.onClick ?? null;
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
    CheckboxItem: ({ children, ...props }: { checked: boolean; onCheckedChange: (value: boolean) => void; onSelect?: (event: { preventDefault: () => void }) => void; children: ReactNode }) => {
      const label = findLabel(children);
      if (label) state.checkboxes.set(label, props);
      if (label === "Inactive tasks") state.filterPaused = props.onCheckedChange;
      return children;
    },
  };
});

let container: ReturnType<typeof createMockElement>;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  state.view = { orderedIds: ["A", "B", "C"], revision: 0 };
  state.pending = false;
  state.taskIds = ["A", "B", "C"];
  state.taskStates = {};
  state.dueDates = {};
  state.serverTime = null;
  state.clockFails = false;
  state.clockWait = null;
  state.otherAssigneeIds = [];
  state.pausedIds = [];
  state.lifecycleAllowed = true;
  state.capabilities = [];
  state.ignorePausedQuery = false;
  state.lifecycleWrites = [];
  state.filterPaused = null;
  state.selects.clear();
  state.checkboxes.clear();
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

function oneTimeStatuses() {
  state.taskIds = ["A", "B", "C", "D"];
  state.taskStates = {
    A: { status: "Pending", rawStatus: "due" },
    B: { status: "In Progress", rawStatus: "in_progress" },
    C: { status: "Completed", rawStatus: "completed" },
    D: { status: "Overdue", rawStatus: "overdue" },
  };
}

async function checkFilter(label: string, checked: boolean) {
  const option = state.checkboxes.get(label);
  expect(option).toBeDefined();
  await act(async () => option!.onCheckedChange(checked));
}

test("One-Time All and My default to non-overdue statuses and support independent status selections", async () => {
  oneTimeStatuses();
  state.taskIds.push("E");
  state.taskStates.E = { status: "Overdue", rawStatus: "overdue" };
  state.otherAssigneeIds = ["E"];
  state.capabilities = ["tasks:one_time:view:any"];
  await mount("one", false);
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
  expect(["Pending", "In progress", "Completed"].map((label) => state.checkboxes.get(label)?.checked)).toEqual([true, true, true]);
  expect(state.checkboxes.get("Overdue")?.checked).toBe(false);
  expect(state.checkboxes.get("All statuses")?.checked).toBe(false);
  await act(async () => state.selectMy!());
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);

  const preventDefault = vi.fn();
  state.checkboxes.get("Overdue")!.onSelect!({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce(); // Multi-select does not dismiss the menu.
  await checkFilter("Overdue", true);
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C", "D"]);
  await checkFilter("Pending", false);
  expect([...state.railRows.keys()]).toEqual(["B", "C", "D"]);
  await act(async () => state.selectAll!());
  expect([...state.railRows.keys()]).toEqual(["B", "C", "D", "E"]);
  await checkFilter("All statuses", true);
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C", "D", "E"]);
  await checkFilter("All statuses", false);
  expect([...state.railRows.keys()]).toEqual([]);
  await clickButton("Clear filters");
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C", "D", "E"]);
});

test("One-Time Custom has only an overdue toggle, independent of All/My filters, and preserves hidden order on drag", async () => {
  oneTimeStatuses();
  state.view = { orderedIds: ["A", "D", "B", "C"], revision: 0 };
  await mount("one", false);
  await checkFilter("Completed", false);
  await act(async () => state.selectCustom!());
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
  expect([...state.checkboxes.keys()]).toEqual(["Show overdue tasks"]);
  expect(state.selects.size).toBe(0);
  expect(state.checkboxes.get("Show overdue tasks")?.checked).toBe(false);
  await act(async () => state.drop!("B", { anchorId: "A", edge: "before" }));
  expect(state.writes[0].args).toMatchObject({ orderedIds: ["B", "D", "A", "C"], expectedRevision: 0 });
  await act(async () => state.writes[0].resolve({ orderedIds: ["B", "D", "A", "C"], revision: 1 }));
  await checkFilter("Show overdue tasks", true);
  expect([...state.railRows.keys()]).toEqual(["B", "D", "A", "C"]);
  await checkFilter("Show overdue tasks", false);
  expect([...state.railRows.keys()]).toEqual(["B", "A", "C"]);
  await act(async () => state.selectAll!());
  expect([...state.railRows.keys()]).toEqual(["A", "B"]);
});

test("Custom explains an overdue-only empty view and offers to reveal the tasks", async () => {
  state.taskStates = Object.fromEntries(["A", "B", "C"].map((id) => [id, { status: "Overdue", rawStatus: "overdue" }]));
  await mount("one");
  expect([...state.railRows.keys()]).toEqual([]);
  expect(button("Show overdue tasks")).toBeDefined();
  await clickButton("Show overdue tasks");
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
});

test("the default overdue filter does not turn a genuinely empty list into a no-matches state", async () => {
  state.taskIds = [];
  await mount("one", false);
  expect(descendants(container).some((node) => node.nodeValue === "No tasks yet" || node.textContent === "No tasks yet")).toBe(true);
  expect(button("Clear filters")).toBeUndefined();
});

test("an empty inactive JD view keeps its filter and offers to return to active tasks", async () => {
  await mount("jd", false);
  await checkFilter("Inactive tasks", true);
  expect([...state.railRows.keys()]).toEqual([]);
  expect(descendants(container).some((node) => node.textContent === "No matching tasks")).toBe(true);
  await clickButton("Clear filters");
  expect(new Set(state.railRows.keys())).toEqual(new Set(["A", "B", "C"]));
});

test("explicit One-Time status filters remain clearable even when the query is empty", async () => {
  state.taskIds = [];
  await mount("one", false);
  await checkFilter("Completed", false);
  expect(button("Clear filters")).toBeDefined();
});

test.each([false, true])("One-Time tasks become overdue without a subscription update (Custom: %s)", async (custom) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  state.taskStates = {
    A: { status: "Pending", rawStatus: "due" },
    B: { status: "In Progress", rawStatus: "in_progress" },
    C: { status: "Completed", rawStatus: "completed" },
  };
  state.dueDates = { A: Date.now() + 1000, B: Date.now() + 2000, C: Date.now() - 1000 };
  state.capabilities = ["tasks:one_time:view:any"];
  await mount("one", custom);
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
  expect([...state.railRows.keys()]).toEqual(["B", "C"]);
  if (!custom) await act(async () => state.selectMy!());
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect([...state.railRows.keys()]).toEqual(["C"]);
  await checkFilter(custom ? "Show overdue tasks" : "Overdue", true);
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
});

test.each([-600_000, 600_000])("deadline updates ignore device clock skew (%s ms)", async (skew) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  state.serverTime = Date.parse("2026-10-14T12:00:00Z");
  vi.setSystemTime(state.serverTime + skew);
  state.dueDates = { A: state.serverTime + 1000, B: state.serverTime + 2000 };
  await mount("one", false);
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
  expect([...state.railRows.keys()]).toEqual(["B", "C"]);
  vi.setSystemTime(Date.now() + 3_600_000); // Changing the wall clock must not advance server time.
  await act(async () => root!.render(React.createElement(TaskList, { kind: "one" })));
  expect([...state.railRows.keys()]).toEqual(["B", "C"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect([...state.railRows.keys()]).toEqual(["C"]);
});

test("failed server clock synchronization preserves server state and reports the failure", async () => {
  state.clockFails = true;
  state.dueDates = { A: Date.now() - 1000 };
  await mount("one", false);
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
  expect(descendants(container).some((node) => node.textContent === "Could not refresh task deadlines. Retrying automatically.")).toBe(true);
});

test("an initially unavailable clock recovers automatically while the page remains visible", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  const start = Date.parse("2026-10-14T12:00:00Z");
  vi.setSystemTime(start);
  state.clockFails = true;
  state.dueDates = { A: start + 500, B: start + 4000 };
  await mount("one", false);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // A second failed attempt.
  state.clockFails = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect([...state.railRows.keys()]).toEqual(["B", "C"]);
  expect(descendants(container).some((node) => node.getAttribute?.("role") === "alert")).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
  expect([...state.railRows.keys()]).toEqual(["C"]);
});

test("clock retries pause while hidden, resume on visibility, and are removed on unmount", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  state.clockFails = true;
  state.dueDates = { A: Date.now() + 500 };
  let visibility = "visible";
  let onVisible: (() => void) | undefined;
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener) => {
    if (type === "visibilitychange") onVisible = listener as () => void;
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  try {
    await mount("one", false);
    expect(vi.getTimerCount()).toBe(1);
    visibility = "hidden";
    await act(async () => onVisible!());
    expect(vi.getTimerCount()).toBe(0);
    state.clockFails = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
    visibility = "visible";
    await act(async () => onVisible!());
    expect([...state.railRows.keys()]).toEqual(["B", "C"]);
    let reject!: (error: Error) => void;
    state.clockWait = new Promise<void>((_resolve, rejectRequest) => { reject = rejectRequest; });
    await act(async () => onVisible!());
    visibility = "hidden";
    await act(async () => onVisible!());
    await act(async () => reject(new Error("Clock unavailable")));
    expect(vi.getTimerCount()).toBe(0); // A request that fails after hiding must not restart retries.
    state.clockWait = null;
    state.clockFails = true;
    visibility = "visible";
    await act(async () => onVisible!());
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => root!.unmount());
    root = undefined;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

test("a failed clock refresh retains overdue status and keeps future deadline timers running", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  state.serverTime = Date.parse("2026-10-14T12:00:00Z");
  state.dueDates = { A: state.serverTime + 1000, B: state.serverTime + 2000 };
  let onVisible: (() => void) | undefined;
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener) => {
    if (type === "visibilitychange") onVisible = listener as () => void;
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  try {
    await mount("one", false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
    expect([...state.railRows.keys()]).toEqual(["B", "C"]);
    state.clockFails = true;
    await act(async () => onVisible!());
    expect([...state.railRows.keys()]).toEqual(["B", "C"]);
    expect(descendants(container).some((node) => node.textContent === "Could not refresh task deadlines. Retrying automatically.")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect([...state.railRows.keys()]).toEqual(["C"]);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

test("a delayed successful clock refresh cannot rewind an already observed deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  const start = Date.parse("2026-10-14T12:00:00Z");
  state.serverTime = start;
  state.dueDates = { A: start + 1000 };
  let onVisible: (() => void) | undefined;
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener) => {
    if (type === "visibilitychange") onVisible = listener as () => void;
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  try {
    await mount("one", false);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    state.serverTime = start + 200;
    let release!: () => void;
    state.clockWait = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => onVisible!());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect([...state.railRows.keys()]).toEqual(["B", "C"]);
    await act(async () => release()); // The timestamp was captured before A's deadline.
    expect([...state.railRows.keys()]).toEqual(["B", "C"]);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

test("overdue-only All and My views explain the default filter and reuse Clear filters", async () => {
  state.taskStates = Object.fromEntries(["A", "B", "C"].map((id) => [id, { status: "Overdue", rawStatus: "overdue" }]));
  state.capabilities = ["tasks:one_time:view:any"];
  await mount("one", false);
  const explanation = "Overdue tasks are hidden by default. Select Overdue in the status filter or clear filters to show them.";
  expect(descendants(container).some((node) => node.textContent === explanation)).toBe(true);
  await act(async () => state.selectMy!());
  expect(descendants(container).some((node) => node.textContent === explanation)).toBe(true);
  expect(button("Show overdue tasks")).toBeUndefined();
  await clickButton("Clear filters");
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
});

test("returning to a suspended tab immediately re-evaluates deadlines", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  let onVisible: (() => void) | undefined;
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener) => {
    if (type === "visibilitychange") onVisible = listener as () => void;
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  try {
    state.dueDates = { A: Date.now() + 1000 };
    await mount("one", false);
    vi.setSystemTime(Date.now() + 5000); // The browser has not delivered its timer yet.
    await act(async () => onVisible!());
    expect([...state.railRows.keys()]).toEqual(["B", "C"]);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

test("deadline updates cancel the old timer and handle deadlines beyond the browser timer limit", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  const start = Date.now();
  const month = 30 * 24 * 60 * 60 * 1000;
  state.dueDates = { A: start + 1000 };
  await mount("one", false);
  state.dueDates.A = start + month;
  await act(async () => root!.render(React.createElement(TaskList, { kind: "one" })));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(2_147_483_647 - 2000); });
  expect([...state.railRows.keys()]).toEqual(["A", "B", "C"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(month - 2_147_483_647 + 1); });
  expect([...state.railRows.keys()]).toEqual(["B", "C"]);
});

test("Job Description retains its all-status default and single-select status filter", async () => {
  oneTimeStatuses();
  await mount("jd", false);
  expect(new Set(state.railRows.keys())).toEqual(new Set(["A", "B", "C", "D"]));
  await act(async () => state.selects.get("Completed")!());
  expect([...state.railRows.keys()]).toEqual(["C"]);
  await act(async () => state.selects.get("All statuses")!());
  expect(new Set(state.railRows.keys())).toEqual(new Set(["A", "B", "C", "D"]));
});
