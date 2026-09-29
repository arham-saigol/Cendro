import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useShellStall } from "./shell-stall";
import { createMockElement } from "./test-dom";
import { ConvexClerkAuthProvider } from "./convex-clerk-auth";
import { recordTransportEvent } from "@/lib/convex-transport-diagnostics";

const clerkState = vi.hoisted(() => ({ signedIn: true, sessionId: "session-a", orgId: null as string | null, token: null as string | null, calls: [] as unknown[] }));
const syncState = vi.hoisted(() => ({ calls: 0, failUntil: 0, missingEmail: false }));
vi.mock("./pwa-agent", () => ({ PwaAgent: () => null }));
vi.mock("@clerk/nextjs", () => {
  const getToken = async (options: unknown) => {
    clerkState.calls.push(options);
    return clerkState.token;
  };
  return { useAuth: () => ({ isLoaded: true, isSignedIn: clerkState.signedIn, sessionId: clerkState.sessionId, orgId: clerkState.orgId, orgRole: null, sessionClaims: null, getToken }) };
});
vi.mock("convex/react", async () => {
  const React = await import("react");
  const AuthContext = React.createContext({ isLoading: true, isAuthenticated: false });
  function ConvexProviderWithAuth({ useAuth, children }: { useAuth: () => { isAuthenticated: boolean; fetchAccessToken: (options: { forceRefreshToken: boolean }) => Promise<string | null> }; children: React.ReactNode }) {
    const auth = useAuth();
    const [state, setState] = React.useState({ isLoading: true, isAuthenticated: false });
    React.useEffect(() => {
      if (!auth.isAuthenticated) {
        setState({ isLoading: false, isAuthenticated: false });
        return;
      }
      let current = true;
      setState({ isLoading: true, isAuthenticated: false });
      void auth.fetchAccessToken({ forceRefreshToken: false }).then((token) => {
        if (current) setState({ isLoading: false, isAuthenticated: !!token });
      });
      return () => { current = false; };
    }, [auth]);
    return React.createElement(AuthContext.Provider, { value: state }, children);
  }
  const sync = async () => {
    syncState.calls++;
    if (syncState.missingEmail) {
      const { ConvexError } = await import("convex/values");
      throw new ConvexError("Authenticated email is required.");
    }
    if (syncState.calls <= syncState.failUntil) throw new Error("temporary failure");
  };
  return {
    ConvexReactClient: class {}, ConvexProviderWithAuth,
    useConvexAuth: () => React.useContext(AuthContext), useMutation: () => sync,
  };
});
import {
  SHELL_AUTO_RETRY_MS,
  SHELL_STALL_WARN_MS,
  readShellRetries,
  type ShellConnection,
} from "@/lib/shell-access";

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const disconnected: ShellConnection = { isWebSocketConnected: false, hasEverConnected: false, connectionRetries: 0 };

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

  test("pre-reload transport survives failed delivery and is included in recovery", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
    try {
      recordTransportEvent({ kind: "close", socket: 1, code: 1006, clean: false });
      await render();
      await advance(SHELL_AUTO_RETRY_MS);
      const saved = JSON.parse(sessionStorage.getItem("cendro.bootTransport")!);
      expect(saved.transport.events).toContainEqual(expect.objectContaining({ kind: "close", code: 1006 }));
      await remount();
      expect(result!.diagnostic?.previousTransport).toEqual(saved);
      await advance(5_000);
      status = "ready";
      await render();
      const recovery = fetchSpy.mock.calls.map(([, options]) => JSON.parse(options?.body as string)).find((body) => body.event === "recovered");
      expect(recovery.previousTransport).toEqual(saved);
      expect(readShellRetries(sessionStorage)).toBe(0);
      expect(sessionStorage.getItem("cendro.bootTransport")).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("untrusted saved transport cannot leak arbitrary fields into a copied diagnostic", async () => {
    await render();
    sessionStorage.setItem("cendro.bootTransport", JSON.stringify({ episode: result!.diagnostic!.episode, token: "secret-jwt" }));
    await advance(1_000);
    expect(result!.diagnostic?.previousTransport).toBeNull();
    expect(JSON.stringify(result!.diagnostic)).not.toContain("secret-jwt");
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

test("mocked adapter policy retries terminal failure and invalidates on session switch", async () => {
  vi.useFakeTimers();
  clerkState.signedIn = true;
  clerkState.sessionId = "session-a";
  clerkState.token = null;
  clerkState.calls = [];
  const root = createRoot(createMockElement());
  try {
    await act(async () => {
      root.render(React.createElement(ConvexClerkAuthProvider, { client: {} as any }));
    });
    expect(clerkState.calls).toEqual([{ template: "convex", skipCache: false }]);

    // No page reload or new Clerk event: the terminal Convex auth failure must
    // schedule a new handshake so this tab recovers when the service returns.
    clerkState.token = "valid-token";
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(clerkState.calls).toHaveLength(2);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(clerkState.calls).toHaveLength(2); // No needless resets after success.

    clerkState.sessionId = "session-b";
    await act(async () => {
      root.render(React.createElement(ConvexClerkAuthProvider, { client: {} as any }));
    });
    expect(clerkState.calls).toHaveLength(3); // Same signed-in boolean, different principal.
  } finally {
    await act(async () => { root.unmount(); });
    vi.useRealTimers();
  }
});

test("mocked adapter policy resets backoff after recovery", async () => {
  vi.useFakeTimers();
  clerkState.signedIn = true;
  clerkState.sessionId = "same-session";
  clerkState.orgId = null;
  clerkState.token = null;
  clerkState.calls = [];
  const root = createRoot(createMockElement());
  try {
    await act(async () => {
      root.render(React.createElement(ConvexClerkAuthProvider, { client: {} as any }));
    });
    await act(async () => { vi.advanceTimersByTime(5_000); });
    clerkState.token = "valid-token";
    await act(async () => { vi.advanceTimersByTime(10_000); });

    // An org change reauthenticates with the same session, and this separate
    // failure must use the initial delay, not the earlier episode's backoff.
    clerkState.token = null;
    clerkState.orgId = "org-2";
    await act(async () => {
      root.render(React.createElement(ConvexClerkAuthProvider, { client: {} as any }));
    });
    const callsBeforeRetry = clerkState.calls.length;
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(clerkState.calls).toHaveLength(callsBeforeRetry + 1);
  } finally {
    await act(async () => { root.unmount(); });
    clerkState.orgId = null;
    vi.useRealTimers();
  }
});

test("mocked adapter policy resets backoff on session change", async () => {
  vi.useFakeTimers();
  clerkState.signedIn = true;
  clerkState.sessionId = "unavailable-session";
  clerkState.token = null;
  clerkState.calls = [];
  const root = createRoot(createMockElement());
  try {
    await act(async () => {
      root.render(React.createElement(ConvexClerkAuthProvider, { client: {} as any }));
    });
    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000]) {
      await act(async () => { vi.advanceTimersByTime(delay); });
    }
    clerkState.sessionId = "new-session";
    await act(async () => {
      root.render(React.createElement(ConvexClerkAuthProvider, { client: {} as any }));
    });
    const callsAfterSwitch = clerkState.calls.length;
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(clerkState.calls).toHaveLength(callsAfterSwitch + 1);
  } finally {
    await act(async () => { root.unmount(); });
    vi.useRealTimers();
  }
});

test("profile sync does not retry a missing-email claim until the session changes", async () => {
  vi.useFakeTimers();
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud");
  const { ConvexClientProvider } = await import("./providers");
  clerkState.signedIn = true;
  clerkState.sessionId = "without-email";
  clerkState.token = "valid-token";
  syncState.calls = 0;
  syncState.missingEmail = true;
  const root = createRoot(createMockElement());
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await act(async () => { root.render(React.createElement(ConvexClientProvider, null)); });
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(syncState.calls).toBe(1);
    clerkState.sessionId = "another-session";
    await act(async () => { root.render(React.createElement(ConvexClientProvider, null)); });
    expect(syncState.calls).toBe(2);
  } finally {
    await act(async () => { root.unmount(); });
    error.mockRestore();
    syncState.missingEmail = false;
    vi.unstubAllEnvs();
    vi.useRealTimers();
  }
});

test("profile sync eventually succeeds after more than four transient failures without reloading", async () => {
  vi.useFakeTimers();
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud");
  const { ConvexClientProvider } = await import("./providers");
  clerkState.signedIn = true;
  clerkState.token = "valid-token";
  syncState.calls = 0;
  syncState.failUntil = 4;
  syncState.missingEmail = false;
  const root = createRoot(createMockElement());
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await act(async () => { root.render(React.createElement(ConvexClientProvider, null)); });
    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      await act(async () => { vi.advanceTimersByTime(delay); });
    }
    expect(syncState.calls).toBe(5);
  } finally {
    await act(async () => { root.unmount(); });
    warn.mockRestore();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  }
});
