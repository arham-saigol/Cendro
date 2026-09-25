import { describe, expect, test } from "vitest";
import {
  SHELL_AUTO_RETRY_MS,
  SHELL_MAX_AUTO_RETRIES,
  SHELL_STALL_WARN_MS,
  bumpShellRetries,
  clearShellRetries,
  isShellWaiting,
  loadingStage,
  readShellRetries,
  shellStallSummary,
  shouldAutoRetry,
} from "./shell-access";

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("loadingStage", () => {
  const base = { clerkLoaded: true, clerkSignedIn: true, convexAuthLoading: false, convexAuthenticated: true, accessPending: false };

  test("is 'session' while Clerk has not finished loading", () => {
    expect(loadingStage({ ...base, clerkLoaded: false })).toBe("session");
  });

  test("is 'convex-auth' while the token handshake is pending", () => {
    expect(loadingStage({ ...base, convexAuthenticated: false, convexAuthLoading: true })).toBe("convex-auth");
  });

  test("is 'data' while the access query has no result yet", () => {
    expect(loadingStage({ ...base, accessPending: true })).toBe("data");
  });

  test("is null once everything resolved", () => {
    expect(loadingStage(base)).toBeNull();
  });

  test("is null when the token fetch definitively failed (convexUnauthenticated)", () => {
    // convexAuthLoading false + convexAuthenticated false is a terminal failure,
    // not a pending stage — the shell shows its own status, not a stage label.
    expect(loadingStage({ ...base, convexAuthenticated: false, convexAuthLoading: false })).toBeNull();
  });

  test("is null for signed-out users regardless of pending state", () => {
    expect(loadingStage({ ...base, clerkSignedIn: false, accessPending: true })).toBeNull();
  });
});

describe("isShellWaiting", () => {
  test("covers every status that can hold the user on a blocking card", () => {
    expect(isShellWaiting("loading")).toBe(true);
    expect(isShellWaiting("convexUnauthenticated")).toBe(true);
    expect(isShellWaiting("profileMissing")).toBe(true);
  });

  test("excludes resolved states", () => {
    expect(isShellWaiting("ready")).toBe(false);
    expect(isShellWaiting("signedOut")).toBe(false);
    expect(isShellWaiting("noCompanies")).toBe(false);
  });
});

describe("auto-retry budget", () => {
  test("auto-retries only after the stall threshold and below the cap", () => {
    expect(shouldAutoRetry(SHELL_AUTO_RETRY_MS - 1, 0)).toBe(false);
    expect(shouldAutoRetry(SHELL_AUTO_RETRY_MS, 0)).toBe(true);
    expect(shouldAutoRetry(SHELL_AUTO_RETRY_MS, SHELL_MAX_AUTO_RETRIES - 1)).toBe(true);
    expect(shouldAutoRetry(SHELL_AUTO_RETRY_MS, SHELL_MAX_AUTO_RETRIES)).toBe(false);
  });

  test("retry counter survives reloads via storage and clears on success", () => {
    const storage = fakeStorage();
    expect(readShellRetries(storage)).toBe(0);
    expect(bumpShellRetries(storage)).toBe(1);
    expect(bumpShellRetries(storage)).toBe(2);
    // Cap reached: no more auto-retries even though still stalled.
    expect(shouldAutoRetry(SHELL_AUTO_RETRY_MS * 4, readShellRetries(storage))).toBe(false);
    clearShellRetries(storage);
    expect(readShellRetries(storage)).toBe(0);
  });

  test("storage failures degrade to zero retries without throwing", () => {
    const broken = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    };
    expect(readShellRetries(broken)).toBe(0);
    expect(bumpShellRetries(broken)).toBe(1);
    clearShellRetries(broken);
  });
});

describe("shellStallSummary", () => {
  test("reports the failing stage with non-sensitive connection diagnostics", () => {
    const summary = shellStallSummary({
      status: "loading",
      stage: "convex-auth",
      elapsedMs: SHELL_STALL_WARN_MS + 5000,
      connection: { isWebSocketConnected: false, hasEverConnected: true, connectionRetries: 3 },
      autoRetries: 1,
      online: false,
    });
    expect(summary).toEqual({
      status: "loading",
      stage: "convex-auth",
      elapsedSeconds: 25,
      webSocketConnected: false,
      everConnected: true,
      connectionRetries: 3,
      online: false,
      autoRetries: 1,
    });
  });

  test("tolerates a missing connection state", () => {
    const summary = shellStallSummary({ status: "profileMissing", stage: null, elapsedMs: 0, connection: null, autoRetries: 0, online: true });
    expect(summary.webSocketConnected).toBe(false);
    expect(summary.everConnected).toBe(false);
  });
});
