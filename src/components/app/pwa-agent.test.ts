import { describe, expect, test, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { isMobileUserAgent, PwaAgent } from "./pwa-agent";

// Minimal DOM scaffold so react-dom can mount PwaAgent in edge-runtime —
// same approach as task-rail-scroll.test.ts.
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
  el.ownerDocument = (globalThis as any).document;

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
  el.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0 });
  return el;
}

const mockDoc: any = new MockNode();
mockDoc.nodeType = 9;
mockDoc.createElement = createMockElement;
mockDoc.createElementNS = (_ns: string, tag: string) => createMockElement(tag);
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

// Own window event registry so tests can fire browser events deterministically.
const windowListeners = new Map<string, ((event: any) => void)[]>();
(globalThis as any).addEventListener = (type: string, fn: (event: any) => void) => {
  if (!windowListeners.has(type)) windowListeners.set(type, []);
  windowListeners.get(type)!.push(fn);
};
(globalThis as any).removeEventListener = (type: string, fn: (event: any) => void) => {
  const arr = windowListeners.get(type);
  if (arr) {
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  }
};

function fireBeforeInstallPrompt() {
  const event = {
    type: "beforeinstallprompt",
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    prompt: async () => {},
  };
  for (const fn of windowListeners.get("beforeinstallprompt") ?? []) fn(event);
  return event;
}

const storage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
};

(globalThis as any).matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });

const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";

function stubNavigator(overrides: Record<string, unknown>) {
  vi.stubGlobal("navigator", {
    userAgent: DESKTOP_UA,
    platform: "Win32",
    maxTouchPoints: 0,
    onLine: true,
    ...overrides,
  });
}

function stubStandalone(standalone: boolean) {
  vi.stubGlobal("matchMedia", () => ({ matches: standalone, addEventListener: () => {}, removeEventListener: () => {} }));
}

const MOBILE_NAV = { userAgent: ANDROID_UA, platform: "Linux armv8l", maxTouchPoints: 5, userAgentData: { mobile: true } };

async function renderAgent() {
  const container = createMockElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(PwaAgent));
  });
  return { container, root };
}

// React sets el.textContent for text-only elements instead of appending text
// nodes, so read both the node's own textContent and its text-node children.
function pageText(node: any): string {
  const own = typeof node.textContent === "string" ? node.textContent : node.nodeType === 3 ? (node.nodeValue ?? "") : "";
  const kids = (node.childNodes ?? []).map((child: any) => pageText(child)).join(" ");
  return `${own} ${kids}`;
}

afterEach(() => {
  storage.clear();
  windowListeners.clear();
  vi.unstubAllGlobals();
});

describe("isMobileUserAgent", () => {
  test("rejects desktop browsers even though they fire beforeinstallprompt", () => {
    expect(isMobileUserAgent(DESKTOP_UA, false)).toBe(false);
    expect(isMobileUserAgent(DESKTOP_UA)).toBe(false);
  });

  test("accepts Android phones and tablets", () => {
    expect(isMobileUserAgent(ANDROID_UA, true)).toBe(true);
    // Android tablets omit the "Mobile" token; userAgentData still flags them.
    expect(isMobileUserAgent(ANDROID_UA.replace(" Mobile", ""), true)).toBe(true);
    expect(isMobileUserAgent(ANDROID_UA.replace(" Mobile", ""))).toBe(true);
  });

  test("falls back to the UA string when userAgentData is absent", () => {
    expect(isMobileUserAgent(IPHONE_UA)).toBe(true);
    expect(isMobileUserAgent(DESKTOP_UA)).toBe(false);
  });
});

describe("PwaAgent install prompt", () => {
  test("never shows the install card on desktop", async () => {
    stubNavigator({ userAgentData: { mobile: false } });
    const { container, root } = await renderAgent();

    fireBeforeInstallPrompt();
    await act(async () => {});

    expect(pageText(container)).not.toContain("Install Cendro");
    await act(async () => root.unmount());
  });

  test("shows the install card on mobile when the browser offers one", async () => {
    stubNavigator(MOBILE_NAV);
    const { container, root } = await renderAgent();

    fireBeforeInstallPrompt();
    await act(async () => {});

    expect(pageText(container)).toContain("Install Cendro");
    await act(async () => root.unmount());
  });

  test("stays hidden when running as an installed standalone PWA", async () => {
    stubStandalone(true);
    stubNavigator(MOBILE_NAV);
    const { container, root } = await renderAgent();

    fireBeforeInstallPrompt();
    await act(async () => {});

    expect(pageText(container)).not.toContain("Install Cendro");
    await act(async () => root.unmount());
  });

  test("ignores the event when display-mode flips to standalone after mount", async () => {
    let standalone = false;
    vi.stubGlobal("matchMedia", () => ({ matches: standalone, addEventListener: () => {}, removeEventListener: () => {} }));
    stubNavigator(MOBILE_NAV);
    const { container, root } = await renderAgent();

    standalone = true;
    fireBeforeInstallPrompt();
    await act(async () => {});

    expect(pageText(container)).not.toContain("Install Cendro");
    await act(async () => root.unmount());
  });

  test("stays hidden after the user dismissed it", async () => {
    storage.set("cendro.install-dismissed", "1");
    stubNavigator(MOBILE_NAV);
    const { container, root } = await renderAgent();

    fireBeforeInstallPrompt();
    await act(async () => {});

    expect(pageText(container)).not.toContain("Install Cendro");
    await act(async () => root.unmount());
  });

  test("offers the share-menu hint on iOS Safari", async () => {
    stubNavigator({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 });
    const { container, root } = await renderAgent();

    expect(pageText(container)).toContain("Add to Home Screen");
    await act(async () => root.unmount());
  });
});
