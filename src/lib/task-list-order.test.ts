import { describe, expect, test } from "vitest";
import {
  mergeFilteredTaskListOrder,
  moveTaskListId,
  restoreTaskListCustomOrder,
  sameTaskListOrder,
  sortTaskListRows,
  taskListOrderKeyMaxLength,
  taskListOrderPositionForMove,
  type TaskListOrderingRow,
} from "./task-list-order";

function row(id: string, values: Partial<TaskListOrderingRow> = {}): TaskListOrderingRow {
  return {
    _id: id,
    reference: `JD-${id}`,
    title: id,
    createdAt: 1,
    ...values,
  };
}

describe("task list ordering", () => {
  test("uses the requested default JD frequency and one-time priority sequences", () => {
    const jdRows = [
      row("yearly", { recurrence: "annually", createdAt: 1 }),
      row("daily", { recurrence: "daily", createdAt: 2 }),
      row("weekly", { recurrence: "weekly", createdAt: 3 }),
      row("alternate", { recurrence: "every_other_day", createdAt: 4 }),
    ];
    expect(sortTaskListRows(jdRows, "jd", { mode: "default" }).map((task) => task._id)).toEqual([
      "daily",
      "alternate",
      "weekly",
      "yearly",
    ]);

    const oneTimeRows = [
      row("medium", { priority: "medium", createdAt: 4 }),
      row("high-old", { priority: "high", createdAt: 1 }),
      row("low", { priority: "low", createdAt: 5 }),
      row("high-new", { priority: "high", createdAt: 9 }),
    ];
    expect(sortTaskListRows(oneTimeRows, "one_time", { mode: "default" }).map((task) => task._id)).toEqual([
      "high-new",
      "high-old",
      "medium",
      "low",
    ]);
  });

  test("sorts numeric task codes across padding boundaries and leaves invalid codes last", () => {
    const rows = [
      row("invalid", { reference: "unexpected" }),
      row("999", { reference: "JD-999" }),
      row("10", { reference: "JD-010" }),
      row("1000", { reference: "JD-1000" }),
      row("9", { reference: "JD-009" }),
    ];

    expect(sortTaskListRows(rows, "jd", { mode: "field", field: "code", direction: "asc" }).map((task) => task._id)).toEqual([
      "9",
      "10",
      "999",
      "1000",
      "invalid",
    ]);
    expect(sortTaskListRows(rows, "jd", { mode: "field", field: "code", direction: "desc" }).map((task) => task._id)).toEqual([
      "1000",
      "999",
      "10",
      "9",
      "invalid",
    ]);
  });

  test("compares visible assignees independently of their source order and keeps empty values last", () => {
    const rows = [
      row("unassigned", { assignees: [] }),
      row("zeta", { assignees: [{ user: { name: "Zeta" } }] }),
      row("alpha-beta", { assignees: [{ user: { name: "Beta" } }, { user: { name: "alpha" } }] }),
      row("alpha", { assignees: [{ user: { name: "alpha" } }] }),
    ];

    expect(sortTaskListRows(rows, "jd", { mode: "field", field: "user", direction: "asc" }).map((task) => task._id)).toEqual([
      "alpha",
      "alpha-beta",
      "zeta",
      "unassigned",
    ]);
    expect(sortTaskListRows(rows, "jd", { mode: "field", field: "user", direction: "desc" }).map((task) => task._id)).toEqual([
      "zeta",
      "alpha-beta",
      "alpha",
      "unassigned",
    ]);
  });

  test("keeps missing numeric values last in both directions", () => {
    const rows = [
      row("missing", { dueDate: null, quantity: null }),
      row("late", { dueDate: 30, quantity: 3 }),
      row("early", { dueDate: 10, quantity: 1 }),
    ];

    expect(sortTaskListRows(rows, "one_time", { mode: "field", field: "dueDate", direction: "asc" }).map((task) => task._id)).toEqual(["early", "late", "missing"]);
    expect(sortTaskListRows(rows, "one_time", { mode: "field", field: "dueDate", direction: "desc" }).map((task) => task._id)).toEqual(["late", "early", "missing"]);
    expect(sortTaskListRows(rows, "jd", { mode: "field", field: "quantity", direction: "desc" }).map((task) => task._id)).toEqual(["late", "early", "missing"]);
  });

  test("restores surviving custom IDs, retains later pages, and replaces only filtered slots on reorder", () => {
    const rows = Array.from({ length: 201 }, (_, index) => row(String(index + 1), { recurrence: "daily", createdAt: index }));
    const customOrder = ["201", "2", "missing", "1"];
    const restored = restoreTaskListCustomOrder(rows, "jd", customOrder);
    expect(restored.slice(0, 3).map((task) => task._id)).toEqual(["201", "2", "1"]);
    expect(restored).toHaveLength(201);
    expect(customOrder).toEqual(["201", "2", "missing", "1"]);

    const full = ["A", "X", "B", "Y", "C"];
    const visible = ["A", "B", "C"];
    const moved = moveTaskListId(visible, "C", "A");
    expect(moved).toEqual(["C", "A", "B"]);
    expect(mergeFilteredTaskListOrder(full, visible, moved)).toEqual(["C", "X", "A", "Y", "B"]);
    expect(sameTaskListOrder(visible, moveTaskListId(visible, "A", "A"))).toBe(true);
  });

  test("rebalances repeated inserts into the same interval before producing an invalid position", () => {
    const rows = [row("start"), row("end")];
    const orderedIds = ["start", "end"];
    let orderKeys = new Map([
      ["start", "0/1"],
      ["end", "1/1"],
    ]);
    let rebalanceCount = 0;

    for (let index = 0; index < 1_800; index += 1) {
      const taskId = `insert-${index}`;
      rows.splice(1, 0, row(taskId));
      orderedIds.splice(1, 0, taskId);
      const position = taskListOrderPositionForMove(orderedIds, taskId, orderKeys);
      if (position.rebalancedOrderKeys) {
        rebalanceCount += 1;
        orderKeys = new Map(position.rebalancedOrderKeys.map(({ taskId, orderKey }) => [taskId, orderKey]));
      } else {
        orderKeys.set(taskId, position.orderKey);
      }
      expect(position.orderKey).toMatch(/^(?:0|-[1-9]\d*|[1-9]\d*)\/[1-9]\d*$/);
      expect(position.orderKey.length).toBeLessThanOrEqual(taskListOrderKeyMaxLength);
    }

    expect(rebalanceCount).toBeGreaterThan(0);
    for (const orderKey of orderKeys.values()) {
      expect(orderKey).toMatch(/^(?:0|-[1-9]\d*|[1-9]\d*)\/[1-9]\d*$/);
      expect(orderKey.length).toBeLessThanOrEqual(taskListOrderKeyMaxLength);
    }
    expect(restoreTaskListCustomOrder(rows, "jd", orderedIds, orderKeys).map((task) => task._id)).toEqual(orderedIds);
  });
});
