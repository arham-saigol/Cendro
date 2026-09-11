import { expect, test } from "vitest";
import {
  ListPreferenceController,
  type ListPreference,
  type ListPreferenceControllerOptions,
  type ListSortLike,
} from "./list-preference-controller";
import type { SopListSort } from "./sop-list-sort";
import type { TaskListSort } from "./task-list-sort";

const taskMessages: ListPreferenceControllerOptions = {
  conflict: "Task order changed in another session. Please repeat the move.",
  saveFailed: "Could not save task order.",
};
const sopMessages: ListPreferenceControllerOptions = {
  conflict: "SOP order changed in another session. Please repeat the move.",
  saveFailed: "Could not save the SOP order.",
};

type Recorded<TSort extends ListSortLike> = {
  sort: TSort;
  orderedIds?: string[];
  expectedRevision: number;
  resolve: (value: ListPreference<TSort>) => void;
  reject: (error: Error) => void;
};

function harness<TSort extends ListSortLike>(messages: ListPreferenceControllerOptions, initial: ListPreference<TSort>) {
  const writes: Recorded<TSort>[] = [];
  const controller = new ListPreferenceController<TSort>((command) => new Promise((resolve, reject) => {
    writes.push({ ...command, resolve, reject });
  }), messages);
  controller.receive(initial);
  return { controller, writes };
}

const taskInitial: ListPreference<TaskListSort> = {
  sort: { mode: "custom" }, customOrder: ["A", "B", "C"], revision: 1, orderFormat: "vector",
};
const sopInitial: ListPreference<SopListSort> = {
  sort: { mode: "custom" }, customOrder: ["A", "B", "C"], revision: 1, orderFormat: "vector",
};

test("coalesces rapid moves while showing the latest order immediately", async () => {
  const { controller, writes } = harness(taskMessages, taskInitial);
  controller.saveOrder(["C", "A", "B"]);
  controller.saveOrder(["B", "C", "A"]);
  controller.saveOrder(["B", "A", "C"]);
  expect(controller.getSnapshot().preference?.customOrder).toEqual(["B", "A", "C"]);
  expect(writes).toHaveLength(1);
  const acknowledged = { ...taskInitial, customOrder: ["C", "A", "B"], revision: 2 };
  const dragVersion = controller.getSnapshot().dragVersion;
  controller.receive(acknowledged);
  expect(controller.getSnapshot().dragVersion).toBe(dragVersion);
  writes[0].resolve(acknowledged);
  await Promise.resolve();
  expect(writes[1]).toMatchObject({ orderedIds: ["B", "A", "C"], expectedRevision: 2 });
  writes[1].resolve({ ...taskInitial, customOrder: ["B", "A", "C"], revision: 3 });
  await Promise.resolve();
  expect(controller.getSnapshot()).toMatchObject({ pending: false, preference: { customOrder: ["B", "A", "C"], revision: 3 } });
});

test("external updates and failures discard dependent moves instead of restoring an old snapshot", async () => {
  const { controller, writes } = harness(taskMessages, taskInitial);
  controller.saveOrder(["C", "A", "B"]);
  controller.saveOrder(["B", "C", "A"]);
  controller.receive({ ...taskInitial, customOrder: ["A", "C", "B"], revision: 2 });
  writes[0].reject(new Error("stale"));
  await Promise.resolve();
  expect(writes).toHaveLength(1);
  expect(controller.getSnapshot()).toMatchObject({ pending: false, preference: { customOrder: ["A", "C", "B"] } });
  expect(controller.getSnapshot().error).toContain("another session");
});

test("a completion from an unmounted scope cannot change its replacement", async () => {
  const { controller, writes } = harness(taskMessages, taskInitial);
  controller.saveOrder(["C", "A", "B"]);
  controller.cancel();
  const replacement = harness(taskMessages, taskInitial).controller;
  writes[0].resolve({ ...taskInitial, customOrder: ["C", "A", "B"], revision: 2 });
  await Promise.resolve();
  expect(replacement.getSnapshot().preference).toEqual(taskInitial);
});

test("a legacy null order does not acknowledge a vector order save", () => {
  const { controller } = harness(taskMessages, taskInitial);
  controller.saveOrder([]);
  controller.receive({ sort: { mode: "custom" }, customOrder: null, revision: 2 });
  expect(controller.getSnapshot().error).toContain("another session");
  expect(controller.getSnapshot().pending).toBe(false);
});

test("blocks further sorting while a sort save is pending and ignores moves until it settles", async () => {
  const { controller, writes } = harness(taskMessages, taskInitial);
  controller.saveSort({ mode: "field", field: "title", direction: "asc" });
  expect(controller.getSnapshot().sorting).toBe(true);
  controller.saveSort({ mode: "field", field: "code", direction: "asc" });
  controller.saveOrder(["B", "A", "C"]);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ sort: { mode: "field", field: "title", direction: "asc" } });
  writes[0].resolve({ ...taskInitial, sort: { mode: "field", field: "title", direction: "asc" }, revision: 2 });
  await Promise.resolve();
  expect(writes).toHaveLength(1);
  expect(controller.getSnapshot()).toMatchObject({ pending: false, sorting: false });
});

test("reports SOP-specific conflict and failure messages", async () => {
  const { controller, writes } = harness(sopMessages, sopInitial);
  controller.saveSort({ mode: "field", field: "assignedTo", direction: "asc" });
  expect(writes[0]).toMatchObject({ sort: { mode: "field", field: "assignedTo", direction: "asc" } });
  writes[0].resolve({ ...sopInitial, sort: { mode: "field", field: "assignedTo", direction: "asc" }, revision: 2 });
  await Promise.resolve();
  expect(controller.getSnapshot()).toMatchObject({
    pending: false,
    preference: { sort: { mode: "field", field: "assignedTo", direction: "asc" }, revision: 2 },
  });

  controller.saveOrder(["B", "A", "C"]);
  controller.receive({ ...sopInitial, customOrder: ["A", "B", "C"], revision: 3 });
  expect(controller.getSnapshot().error).toBe(sopMessages.conflict);

  const failing = new ListPreferenceController<SopListSort>(async () => { throw "boom"; }, sopMessages);
  failing.receive(sopInitial);
  failing.saveOrder(["C", "B", "A"]);
  await Promise.resolve();
  await Promise.resolve();
  expect(failing.getSnapshot()).toMatchObject({ error: sopMessages.saveFailed, pending: false });
});

test("adopts a subscription that already confirmed a lost acknowledgement", async () => {
  const { controller, writes } = harness(taskMessages, taskInitial);
  controller.saveOrder(["C", "A", "B"]);
  const confirmed = { ...taskInitial, customOrder: ["C", "A", "B"], revision: 2 };
  controller.receive(confirmed);
  writes[0].reject(new Error("network"));
  await Promise.resolve();
  expect(controller.getSnapshot()).toMatchObject({ pending: false, error: null, preference: { customOrder: ["C", "A", "B"], revision: 2 } });
});
