import { readFileSync } from "node:fs";
import postcss, { type AtRule, type Declaration, type Rule } from "postcss";
import { describe, expect, test } from "vitest";

const stylesheet = postcss.parse(readFileSync(new URL("./globals.css", import.meta.url), "utf8"));

describe("task list table overflow", () => {
  test("keeps columns reachable when the list pane is constrained", () => {
    const pane = stylesheet.nodes.find((node): node is Rule => node.type === "rule" && node.selector === ".task-list-pane");
    expect(pane?.nodes?.find((node): node is Declaration => node.type === "decl" && node.prop === "container-type")?.value).toBe("inline-size");

    const wideTableWrap = stylesheet.nodes.find((node): node is Rule => node.type === "rule" && node.selector === ".task-list-table-wrap");
    expect(wideTableWrap?.nodes?.find((node): node is Declaration => node.type === "decl" && node.prop === "overflow-x")?.value).toBe("clip");

    const constrainedPane = stylesheet.nodes.find((node): node is AtRule => node.type === "atrule" && node.name === "container");
    const tableWrap = constrainedPane?.nodes?.find((node): node is Rule => node.type === "rule" && node.selector === ".task-list-table-wrap");
    expect(tableWrap?.nodes?.find((node): node is Declaration => node.type === "decl" && node.prop === "overflow-x")?.value).toBe("auto");
    expect(tableWrap?.nodes?.find((node): node is Declaration => node.type === "decl" && node.prop === "scrollbar-width")?.value).toBe("none");
  });
});
