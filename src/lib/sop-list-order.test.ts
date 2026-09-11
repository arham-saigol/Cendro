import { describe, expect, test } from "vitest";
import { filterSopListRows, restoreSopListCustomOrder, sortSopListRows, type SopListFilterRow } from "./sop-list-order";

function row(id: string, values: Partial<SopListFilterRow> = {}): SopListFilterRow {
  return { _id: id, reference: `SOP-${id}`, title: id, createdAt: 1, ...values };
}

describe("sop list ordering", () => {
  test("sorts numeric SOP codes and leaves malformed codes last in both directions", () => {
    const rows = [
      row("invalid", { reference: "unexpected" }),
      row("1000", { reference: "SOP-1000" }),
      row("10", { reference: "SOP-010" }),
      row("9", { reference: "SOP-009" }),
      row("2", { reference: "sop-2" }),
    ];

    expect(sortSopListRows(rows, { mode: "field", field: "code", direction: "asc" }).map((sop) => sop._id)).toEqual([
      "2", "9", "10", "1000", "invalid",
    ]);
    expect(sortSopListRows(rows, { mode: "field", field: "code", direction: "desc" }).map((sop) => sop._id)).toEqual([
      "1000", "10", "9", "2", "invalid",
    ]);
  });

  test("sorts titles case-insensitively with trimmed text and keeps missing titles last", () => {
    const rows = [
      row("missing", { title: "   " }),
      row("beta", { title: " beta " }),
      row("Alpha", { title: "alpha" }),
      row("gamma", { title: "Gamma" }),
    ];

    expect(sortSopListRows(rows, { mode: "field", field: "title", direction: "asc" }).map((sop) => sop._id)).toEqual([
      "Alpha", "beta", "gamma", "missing",
    ]);
    expect(sortSopListRows(rows, { mode: "field", field: "title", direction: "desc" }).map((sop) => sop._id)).toEqual([
      "gamma", "beta", "Alpha", "missing",
    ]);
  });

  test("sorts Assigned To by the full rendered target name across scope types", () => {
    const rows = [
      row("branch", { scopeType: "branch", scopeTargetName: "Zed Branch" }),
      row("company", { scopeType: "company", scopeTargetName: "Acme Inc" }),
      row("user", { scopeType: "user", scopeTargetName: "Bea Ramirez" }),
      row("department", { scopeType: "department", scopeTargetName: "Alpha Dept" }),
    ];

    expect(sortSopListRows(rows, { mode: "field", field: "assignedTo", direction: "asc" }).map((sop) => sop._id)).toEqual([
      "company", "department", "user", "branch",
    ]);
    expect(sortSopListRows(rows, { mode: "field", field: "assignedTo", direction: "desc" }).map((sop) => sop._id)).toEqual([
      "branch", "user", "department", "company",
    ]);
  });

  test("uses the shared fallbacks when a target name is missing", () => {
    const rows = [
      row("branch", { scopeType: "branch" }),
      row("company", { scopeType: "company" }),
      row("department", { scopeType: "department" }),
      row("user", { scopeType: "user" }),
    ];

    expect(sortSopListRows(rows, { mode: "field", field: "assignedTo", direction: "asc" }, { companyName: "Zenith Co" }).map((sop) => sop._id)).toEqual([
      "branch", "department", "user", "company",
    ]);
  });

  test("sorts raw timestamps in both directions and defaults to newest first", () => {
    const rows = [
      row("middle", { createdAt: 20, updatedAt: 200 }),
      row("invalid", { createdAt: Number.NaN, updatedAt: Number.NaN }),
      row("newest", { createdAt: 30, updatedAt: 100 }),
      row("oldest", { createdAt: 10, updatedAt: 300 }),
    ];

    expect(sortSopListRows(rows, { mode: "default" }).map((sop) => sop._id)).toEqual([
      "newest", "middle", "oldest", "invalid",
    ]);
    expect(sortSopListRows(rows, { mode: "field", field: "createdAt", direction: "asc" }).map((sop) => sop._id)).toEqual([
      "oldest", "middle", "newest", "invalid",
    ]);
    expect(sortSopListRows(rows, { mode: "field", field: "updatedAt", direction: "desc" }).map((sop) => sop._id)).toEqual([
      "oldest", "middle", "newest", "invalid",
    ]);
  });

  test("breaks equal values by creation time descending and then by ID", () => {
    const rows = [
      row("b", { title: "Same", createdAt: 5 }),
      row("a", { title: "Same", createdAt: 5 }),
      row("newer", { title: "Same", createdAt: 9 }),
    ];

    expect(sortSopListRows(rows, { mode: "field", field: "title", direction: "asc" }).map((sop) => sop._id)).toEqual([
      "newer", "a", "b",
    ]);
  });

  test("restores saved SOPs, drops deleted ones, and appends new SOPs in default order", () => {
    const rows = [
      row("kept-old", { createdAt: 1 }),
      row("kept-new", { createdAt: 4 }),
      row("added", { createdAt: 3 }),
    ];
    const customOrder = ["kept-new", "deleted", "kept-old"];

    expect(restoreSopListCustomOrder(rows, customOrder).map((sop) => sop._id)).toEqual([
      "kept-new", "kept-old", "added",
    ]);
    expect(customOrder).toEqual(["kept-new", "deleted", "kept-old"]);
    expect(restoreSopListCustomOrder(rows, []).map((sop) => sop._id)).toEqual([
      "kept-new", "added", "kept-old",
    ]);
  });

  test("filters on body text, type, branch, person, and My view", () => {
    const rows = [
      row("company", { scopeType: "company", content: "Count the drawer", matchesMyView: true, filterBranchIds: [], userMembershipIds: [] }),
      row("branch", { scopeType: "branch", content: "Lock the door", matchesMyView: false, filterBranchIds: ["branch-1"], userMembershipIds: [] }),
      row("person", { scopeType: "user", content: "Special duties", matchesMyView: false, filterBranchIds: [], userMembershipIds: ["employee-2"] }),
    ];

    expect(filterSopListRows(rows, { search: "  DRAWER " }).map((sop) => sop._id)).toEqual(["company"]);
    expect(filterSopListRows(rows, { search: "sop-branch" }).map((sop) => sop._id)).toEqual(["branch"]);
    expect(filterSopListRows(rows, { search: "nothing here" })).toEqual([]);
    expect(filterSopListRows(rows, { scope: "user" }).map((sop) => sop._id)).toEqual(["person"]);
    expect(filterSopListRows(rows, { branchId: "branch-1" }).map((sop) => sop._id)).toEqual(["branch"]);
    expect(filterSopListRows(rows, { userMembershipId: "employee-2" }).map((sop) => sop._id)).toEqual(["person"]);
    expect(filterSopListRows(rows, { view: "my" }).map((sop) => sop._id)).toEqual(["company"]);
    // The Person filter only applies to the All view.
    expect(filterSopListRows(rows, { view: "my", userMembershipId: "employee-2" }).map((sop) => sop._id)).toEqual(["company"]);
    expect(filterSopListRows(rows, {}).map((sop) => sop._id)).toEqual(["company", "branch", "person"]);
  });
});
