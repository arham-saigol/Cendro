import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useShellStall } from "./shell-stall";
import {
  SHELL_AUTO_RETRY_MS,
  SHELL_STALL_WARN_MS,
  readShellRetries,
  type ShellConnection,
} from "@/lib/shell-access";

class MockNode {}
class MockElement extends MockNode {}
class MockHTMLElement extends MockElement {}
class MockHTMLIFrameElement extends MockHTMLElement {}
class MockHTMLInputElement extends MockHTMLElement {}

(globalThis as any).Node = MockNode;
(globalThis as any).Element = MockElement;
(globalThis as any).HTMLElement = MockHTMLElement;
(globalThis as any).HTMLIFrameElement = MockHTMLIFrameElement;
(globalThis as any).HTMLInputElement = MockHTMLInputElement;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createMockElement(tag = "div"): any {
  const el = new MockHTMLElement() as any;
  const children: any[] = [];
  const attributes = new Map<string, string>();
  const listeners = new Map<string, ((...args: any[]) => void)[]>();

  el.nodeType = 1;
  el.tagName = tag.toUpperCase();
  el.nodeName = tag.toUpperCase();
  el.children = children;
  el.childNodes = children;
  el.style = {};
  el.dataset = {};
  el.ownerDocument = globalThis.document;
  el.appendChild = (child: any) => {
    child.parentNode = el;
    children.push(child);
    return child;
  };
  el.insertBefore = (child: any, before: any) => {
    child.parentNode = el;
    const index = children.indexOf(before);
    if (index !== -1) children.splice(index, 0, child);
    else children.push(child);
    return child;
  };
  el.removeChild = (child: any) => {
    const index = children.indexOf(child);
    if (index !== -1) children.splice(index, 1);
    child.parentNode = null;
    return child;
  };
  el.setAttribute = (name: string, value: string) => attributes.set(name, value);
  el.getAttribute = (name: string) => attributes.get(name) ?? null;
  el.removeAttribute = (name: string) => attributes.delete(name);
  el.addEventListener = (event: string, fn: (...args: any[]) => void) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event)!.push(fn);
  };
  el.removeEventListener = (event: string, fn: (...args: any[]) => void) => {
    const arr = listeners.get(event);
    if (arr) {
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    }
  };
  el.querySelector = () => null;
  el.getBoundingClientRect = () => ({ left: 0, right: 0 });
  return el;
}

const mockDoc: any = new MockNode();
mockDoc.nodeType = 9;
mockDoc.createElement = createMockElement;
mockDoc.createTextNode = (text: string) => {
  const node: any = new MockNode();
  node.nodeType = 3;
  node.nodeValue = text;
  node.parentNode = null;
  return node;
};
mockDoc.createComment = () => {
  const node: any = new MockNode();
  node.nodeType = 8;
  node.parentNode = null;
  return node;
};
mockDoc.documentElement = createMockElement("html");
mockDoc.head = createMockElement("head");
mockDoc.body = createMockElement("body");
mockDoc.activeElement = null;
mockDoc.addEventListener = () => {};
mockDoc.removeEventListener = () => {};

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const disconnected: ShellConnection = { isWebSocketConnected: false, hasEverConnected: false, connectionRetries: 0 };

(globalThis as any).document = mockDoc;
(globalThis as any).window = globalThis;

describe("useShellStall", () => {
  let sessionStorage: ReturnType<typeof fakeStorage>;
  let reloadSpy: ReturnType<typeof vi.fn>;
  let warnSpy: MockInstance;
  let errorSpy: MockInstance;
  let result: ReturnType<typeof useShellStall> | null;
  let container: any;
  let root: Root;
  let status: string;

  function Host() {
    result = useShellStall(status, "data", disconnected);
    return null;
  }

  async function render() {
    await act(async () => {
      root.render(React.createElement(Host));
    });
  }

  async function advance(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  }

  async function remount() {
    await act(async () => {
      root.unmount();
    });
    container = createMockElement("div");
    root = createRoot(container);
    await render();
  }

  beforeEach(() => {
    sessionStorage = fakeStorage();
    reloadSpy = vi.fn();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    Object.defineProperty(globalThis, "sessionStorage", { value: sessionStorage, configurable: true });
    Object.defineProperty(globalThis, "location", { value: { reload: reloadSpy }, configurable: true });
    vi.useFakeTimers();
    result = null;
    status = "loading";
    container = createMockElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.useRealTimers();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("stays quiet under the warn threshold, escalates past it with one console.warn", async () => {
    await render();
    expect(result!.stalled).toBe(false);

    await advance(SHELL_STALL_WARN_MS - 2_000);
    expect(result!.stalled).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();

    await advance(2_000);
    expect(result!.stalled).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("[cendro] app shell still waiting");
    expect(warnSpy.mock.calls[0][1]).toMatchObject({ status: "loading", stage: "data", webSocketConnected: false });

    await advance(5_000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  test("auto-retries once per stall episode and stops after the session cap", async () => {
    await render();
    await advance(SHELL_AUTO_RETRY_MS);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(readShellRetries(sessionStorage)).toBe(1);

    // Same episode: no further automatic reloads even after more waiting.
    await advance(SHELL_AUTO_RETRY_MS * 2);
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    // Simulates the page after reload #1: storage survives, timer restarts,
    // and the card shows the persisted retry count.
    await remount();
    expect(result!.reloads).toBe(1);
    await advance(SHELL_AUTO_RETRY_MS);
    expect(reloadSpy).toHaveBeenCalledTimes(2);
    expect(readShellRetries(sessionStorage)).toBe(2);

    // Simulates the page after reload #2: cap reached, card stays — no spin.
    await remount();
    expect(result!.reloads).toBe(2);
    await advance(SHELL_AUTO_RETRY_MS * 3);
    expect(reloadSpy).toHaveBeenCalledTimes(2);
    expect(readShellRetries(sessionStorage)).toBe(2);
    expect(result!.stalled).toBe(true);
  });

  test("disabled storage stops automatic reloads but keeps manual retry", async () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      value: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
        removeItem: () => {
          throw new Error("denied");
        },
      },
      configurable: true,
    });
    await render();

    // Storage can't persist the counter, so auto-retry would loop forever — it stays off.
    await advance(SHELL_AUTO_RETRY_MS * 3);
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(result!.stalled).toBe(true);

    // The manual escape hatch still works.
    act(() => {
      result!.retry();
    });
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  test("manual retry reloads immediately and counts toward the cap", async () => {
    await render();
    await advance(3_000);

    act(() => {
      result!.retry();
    });
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(readShellRetries(sessionStorage)).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("[cendro] app shell retry requested");
  });

  test("a waiting-status transition keeps the stall clock running", async () => {
    await render();
    await advance(SHELL_STALL_WARN_MS);
    expect(result!.stalled).toBe(true);

    // loading -> convexUnauthenticated: still waiting, so the elapsed time
    // carries over and the error card shows immediately instead of after
    // another full warn threshold.
    status = "convexUnauthenticated";
    await render();
    expect(result!.stalled).toBe(true);
    expect(result!.elapsedMs).toBeGreaterThanOrEqual(SHELL_STALL_WARN_MS);

    // Auto-retry still measures from the original start of the wait.
    await advance(SHELL_AUTO_RETRY_MS - SHELL_STALL_WARN_MS);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  test("recovering resets the timer and clears the retry counter", async () => {
    await render();
    await advance(SHELL_AUTO_RETRY_MS);
    expect(readShellRetries(sessionStorage)).toBe(1);

    // Status leaves the waiting set: counter clears and elapsed resets.
    status = "ready";
    await render();
    expect(result!.stalled).toBe(false);
    expect(result!.elapsedMs).toBe(0);
    expect(readShellRetries(sessionStorage)).toBe(0);

    // A later, separate stall starts a fresh episode.
    status = "convexUnauthenticated";
    await render();
    await advance(SHELL_STALL_WARN_MS + 1_000);
    expect(result!.stalled).toBe(true);
    expect(result!.elapsedMs).toBeLessThanOrEqual(SHELL_STALL_WARN_MS + 2_000);
  });
});
