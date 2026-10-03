import { describe, expect, test, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { isMobileUserAgent, PwaAgent } from "./pwa-agent";
import { createMockElement } from "./test-dom";

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
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("isMobileUserAgent", () => {
  test("rejects desktop browsers even though they fire beforeinstallprompt", () => {
    expect(isMobileUserAgent(DESKTOP_UA, false)).toBe(false);
    expect(isMobileUserAgent(DESKTOP_UA)).toBe(false);
  });

  test("accepts Android phones and tablets", () => {
    expect(isMobileUserAgent(ANDROID_UA, true)).toBe(true);
    // Android tablets omit the "Mobile" token and can legitimately report
    // mobile:false — the Android UA still marks them as mobile.
    const tabletUa = ANDROID_UA.replace(" Mobile", "");
    expect(isMobileUserAgent(tabletUa, false)).toBe(true);
    expect(isMobileUserAgent(tabletUa)).toBe(true);
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

describe("PwaAgent service worker", () => {
  test("registers the worker and keeps checking for updates without a prompt", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.useFakeTimers();
    const update = vi.fn();
    const register = vi.fn().mockResolvedValue({ update });
    stubNavigator({ serviceWorker: { register, addEventListener: () => {}, removeEventListener: () => {} } });
    const { container, root } = await renderAgent();
    await act(async () => {}); // let register() resolve so the interval is armed

    expect(register).toHaveBeenCalledWith("/sw.js");
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(update).toHaveBeenCalledTimes(1);

    // The update path never renders a card.
    expect(pageText(container)).not.toContain("Update available");
    expect(pageText(container)).not.toContain("Reload");
    await act(async () => root.unmount());
  });
});
