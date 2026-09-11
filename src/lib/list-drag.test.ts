import { expect, test } from "vitest";
import { insertListItem, listMovePoint, listPreviewOffsets, listReleasePoint, resolveListInsertion } from "./list-drag";

const rows = [
  { id: "A", top: 100, height: 40 },
  { id: "B", top: 140, height: 70 },
  { id: "C", top: 210, height: 40 },
];
const envelope = { left: 50, right: 600 };
const ids = rows.map((row) => row.id);

test("resolves the rail, edges and gaps immediately using actual row heights", () => {
  for (const y of [80, 99, 100, 119]) {
    expect(insertListItem(ids, "C", resolveListInsertion(rows, "C", { x: 45, y }, envelope)!)).toEqual(["C", "A", "B"]);
  }
  expect(insertListItem(ids, "C", resolveListInsertion(rows, "C", { x: 50, y: 140 }, envelope)!)).toEqual(["A", "C", "B"]);
  expect(insertListItem(ids, "A", resolveListInsertion(rows, "A", { x: 50, y: 270 }, envelope)!)).toEqual(["B", "C", "A"]);
  expect(insertListItem(ids, "B", resolveListInsertion(rows, "B", { x: 50, y: 175 }, envelope)!)).toEqual(ids);
  expect(resolveListInsertion(rows, "C", { x: 10, y: 140 }, envelope)).toBeNull();
  expect(resolveListInsertion(rows, "C", { x: 50, y: 0 }, envelope)).toBeNull();
  expect(resolveListInsertion(rows, "missing", { x: 50, y: 140 }, envelope)).toBeNull();
});

test("preview preserves each row's height and uses the same offsets for the rail", () => {
  expect([...listPreviewOffsets(rows, ["C", "A", "B"])]).toEqual([["C", -110], ["A", 40], ["B", 40]]);
});

test("uses incoming movement and native release rather than stale operation coordinates", () => {
  const operation = { position: { current: { x: 50, y: 230 } } };
  expect(listMovePoint({ operation, to: { x: 50, y: 80 } })).toEqual({ x: 50, y: 80 });
  expect(listMovePoint({ operation, by: { y: -150 } })).toEqual({ x: 50, y: 80 });
  const nativeEvent = Object.assign(new Event("pointerup"), { clientX: 50, clientY: 80 });
  const point = listReleasePoint({ operation, nativeEvent });
  expect(insertListItem(ids, "C", resolveListInsertion(rows, "C", point, envelope)!)).toEqual(["C", "A", "B"]);
});
