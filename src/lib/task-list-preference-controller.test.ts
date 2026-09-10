import { expect, test } from "vitest";
import { TaskListPreferenceController, type TaskListPreference } from "./task-list-preference-controller";

const initial: TaskListPreference = { sort: { mode: "custom" }, customOrder: ["A", "B", "C"], revision: 1, orderFormat: "vector" };
function harness() {
  const writes: { orderedIds?: string[]; expectedRevision: number; resolve: (value: TaskListPreference) => void; reject: (error: Error) => void }[] = [];
  const controller = new TaskListPreferenceController((command) => new Promise((resolve, reject) => {
    writes.push({ ...command, resolve, reject });
  }));
  controller.receive(initial);
  return { controller, writes };
}

test("coalesces rapid moves while showing the latest order immediately", async () => {
  const { controller, writes } = harness();
  controller.saveOrder(["C", "A", "B"]);
  controller.saveOrder(["B", "C", "A"]);
  controller.saveOrder(["B", "A", "C"]);
  expect(controller.getSnapshot().preference?.customOrder).toEqual(["B", "A", "C"]);
  expect(writes).toHaveLength(1);
  const acknowledged = { ...initial, customOrder: ["C", "A", "B"], revision: 2 };
  const dragVersion = controller.getSnapshot().dragVersion;
  controller.receive(acknowledged);
  expect(controller.getSnapshot().dragVersion).toBe(dragVersion);
  writes[0].resolve(acknowledged);
  await Promise.resolve();
  expect(writes[1]).toMatchObject({ orderedIds: ["B", "A", "C"], expectedRevision: 2 });
  writes[1].resolve({ ...initial, customOrder: ["B", "A", "C"], revision: 3 });
  await Promise.resolve();
  expect(controller.getSnapshot()).toMatchObject({ pending: false, preference: { customOrder: ["B", "A", "C"], revision: 3 } });
});

test("external updates and failures discard dependent moves instead of restoring an old snapshot", async () => {
  const { controller, writes } = harness();
  controller.saveOrder(["C", "A", "B"]);
  controller.saveOrder(["B", "C", "A"]);
  controller.receive({ ...initial, customOrder: ["A", "C", "B"], revision: 2 });
  writes[0].reject(new Error("stale"));
  await Promise.resolve();
  expect(writes).toHaveLength(1);
  expect(controller.getSnapshot()).toMatchObject({ pending: false, preference: { customOrder: ["A", "C", "B"] } });
  expect(controller.getSnapshot().error).toContain("another session");
});

test("a completion from an unmounted scope cannot change its replacement", async () => {
  const { controller, writes } = harness();
  controller.saveOrder(["C", "A", "B"]);
  controller.cancel();
  const replacement = harness().controller;
  writes[0].resolve({ ...initial, customOrder: ["C", "A", "B"], revision: 2 });
  await Promise.resolve();
  expect(replacement.getSnapshot().preference).toEqual(initial);
});
