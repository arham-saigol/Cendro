import { describe, expect, test } from "vitest";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  scrollActivePillIntoView,
  syncToggleScrollState,
  useTaskRailAutoScroll,
  type TaskRailScrollOptions,
} from "./task-rail-scroll";

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
  el.scrollLeft = 0;
  el.scrollWidth = 500;
  el.clientWidth = 300;

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
  el.setAttribute = (name: string, value: string) => {
    attributes.set(name, value);
  };
  el.getAttribute = (name: string) => {
    return attributes.get(name) ?? null;
  };
  el.removeAttribute = (name: string) => {
    attributes.delete(name);
  };
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
  el.querySelector = (selector: string) => {
    if (selector === '[data-active="true"]') {
      return el.dataset.hasActiveChild ? {
        getBoundingClientRect: () => ({
          left: 400 - el.scrollLeft,
          right: 480 - el.scrollLeft,
        }),
      } : null;
    }
    return null;
  };
  el.getBoundingClientRect = () => ({ left: 100, right: 300 });

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

(globalThis as any).document = mockDoc;
(globalThis as any).window = globalThis;

describe("task-rail-scroll pure helpers", () => {
  test("syncToggleScrollState sets data-scroll-start and data-scroll-end accurately", () => {
    const node = createMockElement("div");
    node.scrollWidth = 500;
    node.clientWidth = 300;
    node.scrollLeft = 0;

    syncToggleScrollState(node);
    expect(node.dataset.scrollStart).toBe("false");
    expect(node.dataset.scrollEnd).toBe("true");

    node.scrollLeft = 50;
    syncToggleScrollState(node);
    expect(node.dataset.scrollStart).toBe("true");
    expect(node.dataset.scrollEnd).toBe("true");

    node.scrollLeft = 200; // maxScroll = 500 - 300 = 200
    syncToggleScrollState(node);
    expect(node.dataset.scrollStart).toBe("true");
    expect(node.dataset.scrollEnd).toBe("false");
  });

  test("scrollActivePillIntoView adjusts scrollLeft when active pill is outside viewport", () => {
    let activePillRect = { left: 400, right: 480 };
    const railRect = { left: 100, right: 300 };

    const pill = {
      getBoundingClientRect: () => activePillRect,
    } as unknown as HTMLElement;

    const rail = {
      scrollLeft: 0,
      getBoundingClientRect: () => railRect,
      querySelector: (selector: string) => (selector === '[data-active="true"]' ? pill : null),
    } as unknown as HTMLElement;

    // Pill is beyond the right edge (right: 480 > railBox.right: 300)
    // Diff is 480 - 300 = 180
    scrollActivePillIntoView(rail);
    expect(rail.scrollLeft).toBe(180);

    // Pill is beyond the left edge (left: 50 < railBox.left: 100)
    activePillRect = { left: 50, right: 130 };
    scrollActivePillIntoView(rail);
    // rail.scrollLeft was 180, decreases by (100 - 50 = 50) => 130
    expect(rail.scrollLeft).toBe(130);
  });
});

describe("useTaskRailAutoScroll hook", () => {
  test("re-triggers scroll and sync state on company switch with same role and option count", async () => {
    const observedElements: any[] = [];
    let disconnectedCount = 0;

    class MockResizeObserver {
      callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe(node: any) {
        observedElements.push(node);
      }
      disconnect() {
        disconnectedCount++;
      }
    }
    (globalThis as any).ResizeObserver = MockResizeObserver;

    const railElement = createMockElement("div");
    railElement.scrollWidth = 600;
    railElement.clientWidth = 200;
    railElement.scrollLeft = 0;
    railElement.dataset.hasActiveChild = "true";

    let setPropsFn: (props: Partial<TaskRailScrollOptions>) => void;

    function TestHost() {
      const [options, setOptions] = useState<TaskRailScrollOptions>({
        railRef: { current: railElement },
        activeCompanyId: "company-alpha",
        canUseAllTasks: true,
        effectiveTaskView: "all",
        activeView: "all",
        ownFilterCount: 3,
      });

      setPropsFn = (patch) => setOptions((prev) => ({ ...prev, ...patch }));

      useTaskRailAutoScroll(options);
      return null;
    }

    const container = createMockElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(TestHost));
    });

    // Initial mount: rail is observed and scroll state is synced
    expect(observedElements).toHaveLength(1);
    expect(railElement.scrollLeft).toBe(180);
    expect(railElement.dataset.scrollStart).toBe("true");

    // Reset scroll position to test re-trigger
    railElement.scrollLeft = 0;
    railElement.dataset.scrollStart = "false";
    const initialObservedCount = observedElements.length;

    // Switch company to "company-beta" with SAME role (canUseAllTasks: true),
    // SAME option count (ownFilterCount: 3), and SAME activeView ("all")
    await act(async () => {
      setPropsFn({ activeCompanyId: "company-beta" });
    });

    // Both the ResizeObserver effect and the state effect retrigger because activeCompanyId changed
    expect(observedElements.length).toBeGreaterThan(initialObservedCount);
    expect(railElement.scrollLeft).toBe(180);
    expect(railElement.dataset.scrollStart).toBe("true");

    // Reset scroll position again to test effectiveTaskView switch
    railElement.scrollLeft = 0;
    railElement.dataset.scrollStart = "false";
    const afterCompanyObservedCount = observedElements.length;

    // Switch effectiveTaskView from "all" to "my" with same company, role, count, and activeView
    await act(async () => {
      setPropsFn({ effectiveTaskView: "my" });
    });

    expect(observedElements.length).toBeGreaterThan(afterCompanyObservedCount);
    expect(railElement.scrollLeft).toBe(180);
    expect(railElement.dataset.scrollStart).toBe("true");

    await act(async () => {
      root.unmount();
    });

    expect(disconnectedCount).toBeGreaterThan(0);
  });
});
