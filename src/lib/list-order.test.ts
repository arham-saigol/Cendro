import { expect, test } from "vitest";
import { insertListItem } from "./list-drag";
import { mergeFilteredListOrder, restoreListCustomOrder, sameListOrder } from "./list-order";

const rows = [{ _id: "A" }, { _id: "B" }, { _id: "C" }, { _id: "D" }];

test("restores saved rows in order, ignores absent IDs, and appends the rest in default order", () => {
  const customOrder = ["C", "missing", "A", "A"];
  const restored = restoreListCustomOrder(rows, customOrder, rows);
  expect(restored.map((row) => row._id)).toEqual(["C", "A", "B", "D"]);
  expect(customOrder).toEqual(["C", "missing", "A", "A"]);
  expect(restoreListCustomOrder(rows, null, rows).map((row) => row._id)).toEqual(["A", "B", "C", "D"]);
});

test("appends newly created rows after the saved order using the supplied default order", () => {
  const defaultOrder = [{ _id: "D" }, { _id: "C" }, { _id: "B" }, { _id: "A" }];
  expect(restoreListCustomOrder(rows, ["A", "B"], defaultOrder).map((row) => row._id)).toEqual(["A", "B", "D", "C"]);
});

test("a filtered move keeps hidden rows in their saved slots", () => {
  const baseline = ["A", "H", "B", "C"];
  const visible = ["A", "B", "C"];
  const moved = insertListItem(visible, "C", { anchorId: "A", edge: "before" });
  expect(moved).toEqual(["C", "A", "B"]);
  expect(mergeFilteredListOrder(baseline, visible, moved)).toEqual(["C", "H", "A", "B"]);
});

test("a move that starts from field sorting still merges into the saved order", () => {
  const baseline = ["A", "H", "B", "C"];
  const fieldSorted = ["B", "C", "A"];
  const moved = insertListItem(fieldSorted, "C", { anchorId: "B", edge: "before" });
  expect(moved).toEqual(["C", "B", "A"]);
  expect(mergeFilteredListOrder(baseline, fieldSorted, moved)).toEqual(["C", "H", "B", "A"]);
});

test("detects unchanged order vectors", () => {
  expect(sameListOrder(["A", "B"], ["A", "B"])).toBe(true);
  expect(sameListOrder(["A", "B"], ["B", "A"])).toBe(false);
  expect(sameListOrder(["A"], ["A", "B"])).toBe(false);
});
