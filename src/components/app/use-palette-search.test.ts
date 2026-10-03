import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { Id } from "../../../convex/_generated/dataModel";
import { usePaletteSearch } from "./use-palette-search";
import { createMockElement } from "./test-dom";

type Modification = { type: "Add" | "Remove"; udfPath?: string; args?: { query: string }[] };
class SearchSocket extends EventTarget {
  static sockets: SearchSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 0;
  sent: { type: string; modifications?: Modification[] }[] = [];
  constructor(_url: string) { super(); SearchSocket.sockets.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); this.onopen?.(); }
  close() {
    this.readyState = 3;
    const event = { code: 1000, reason: "" };
    this.dispatchEvent(Object.assign(new Event("close"), event));
    this.onclose?.(event);
  }
}

describe("palette search requests through the installed Convex client", () => {
  let root: Root;
  let client: ConvexReactClient;
  let props: Parameters<typeof usePaletteSearch>[0];
  function Probe() { usePaletteSearch(props); return null; }
  async function render(patch: Partial<typeof props> = {}) {
    props = { ...props, ...patch };
    await act(async () => root.render(React.createElement(ConvexProvider, { client }, React.createElement(Probe))));
  }
  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    await act(async () => { for (const socket of SearchSocket.sockets) if (socket.readyState === 0) socket.open(); });
  }
  function modifications(type: Modification["type"]) {
    return SearchSocket.sockets.flatMap((socket) => socket.sent.flatMap((message) => message.modifications ?? [])).filter((mod) => mod.type === type);
  }
  beforeEach(async () => {
    vi.useFakeTimers();
    SearchSocket.sockets = [];
    client = new ConvexReactClient("https://palette-test.convex.cloud", { webSocketConstructor: SearchSocket as unknown as typeof WebSocket, logger: false });
    root = createRoot(createMockElement());
    props = { open: false, query: "", companyId: "company-a" as Id<"companies">, canSearch: true };
    await render();
    await act(async () => { for (const socket of SearchSocket.sockets) socket.open(); });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    const closing = client.close();
    for (const socket of SearchSocket.sockets) if (socket.readyState === 0) socket.open();
    await closing;
    vi.useRealTimers();
  });

  test("rapid typing sends one batch after settling; closing immediately unsubscribes", async () => {
    await render({ open: true, query: "fr" });
    await advance(150);
    await render({ query: "free" });
    await advance(150);
    await render({ query: "freezer" });
    await advance(299);
    expect(modifications("Add")).toHaveLength(0);
    await advance(1);
    expect(modifications("Add").map((mod) => mod.udfPath).sort()).toEqual(["sops:search", "tasks:searchJd", "tasks:searchOneTime"]);
    expect(modifications("Add").every((mod) => mod.args?.[0]?.query === "freezer")).toBe(true);
    await render({ query: " FREEZER " });
    await advance(5_000);
    expect(modifications("Add")).toHaveLength(3);
    await render({ open: false });
    expect(modifications("Remove")).toHaveLength(3);
    await advance(5_000);
    expect(modifications("Add")).toHaveLength(3);
  });

  test("restoring a term, switching company, and regaining permission each wait before subscribing", async () => {
    await render({ open: true, query: "freezer" });
    await advance(300);
    expect(modifications("Add")).toHaveLength(3);
    await render({ query: "freezers" });
    await advance(50);
    await render({ query: "freezer" });
    await advance(299);
    expect(modifications("Add")).toHaveLength(3);
    await advance(1);
    expect(modifications("Add")).toHaveLength(6);
    await render({ companyId: "company-b" as Id<"companies"> });
    await advance(299);
    expect(modifications("Add")).toHaveLength(6);
    await advance(1);
    expect(modifications("Add")).toHaveLength(9);
    await render({ canSearch: false });
    expect(modifications("Remove")).toHaveLength(9);
    await render({ canSearch: true });
    await advance(299);
    expect(modifications("Add")).toHaveLength(9);
    await advance(1);
    expect(modifications("Add")).toHaveLength(12);
  });

  test("overlong searches send no requests", async () => {
    await render({ open: true, query: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen" });
    await advance(1_000);
    expect(modifications("Add")).toHaveLength(0);
  });

  test("closed, empty, short, and unauthorized searches send no requests", async () => {
    await render({ query: "freezer" });
    await advance(1_000);
    await render({ open: true, query: "f" });
    await advance(1_000);
    await render({ query: "" });
    await advance(1_000);
    await render({ query: "freezer", canSearch: false });
    await advance(1_000);
    expect(modifications("Add")).toHaveLength(0);
  });
});
