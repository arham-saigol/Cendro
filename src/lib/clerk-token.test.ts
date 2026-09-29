import { afterEach, describe, expect, test, vi } from "vitest";
import { CLERK_GET_TOKEN_TIMEOUT_MS, boundGetToken } from "./clerk-token";
import { clearBootEpisode, tokenOutcome } from "./auth-diagnostics";
import { recordTransportEvent, transportDiagnostic } from "./convex-transport-diagnostics";

describe("boundGetToken", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    clearBootEpisode();
  });

  test("returns the token when getToken resolves in time", async () => {
    const bounded = boundGetToken(async () => "token-123", 50);
    await expect(bounded({ template: "convex" })).resolves.toBe("token-123");
  });

  test("returns null when getToken resolves null, without warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bounded = boundGetToken(async () => null, 50);
    await expect(bounded({ template: "convex" })).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  test("returns null instead of hanging when getToken never settles", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bounded = boundGetToken(() => new Promise(() => {}), CLERK_GET_TOKEN_TIMEOUT_MS);
    const pending = bounded({ template: "convex" });
    await vi.advanceTimersByTimeAsync(CLERK_GET_TOKEN_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  test("redacts rejected or synchronously thrown token failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = "secret-claim@example.com";
    const bounded = boundGetToken(() => { throw { message: secret, code: secret, status: 429, requestId: "req_123", token: secret }; }, 50);
    await expect(bounded({ skipCache: true })).resolves.toBeNull();
    expect(tokenOutcome()).toMatchObject({ result: "rejected", refresh: true, status: 429, requestId: "req_123" });
    expect(JSON.stringify(tokenOutcome())).not.toContain(secret);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    await expect(boundGetToken(() => Promise.reject(null), 50)({})).resolves.toBeNull();
    expect(tokenOutcome()?.result).toBe("rejected");
  });

  test("a new session and a completed boot cannot inherit the previous transport trace", async () => {
    await boundGetToken(async () => "old-token", 50, "session-a")({});
    recordTransportEvent({ kind: "auth-error", socket: 1 });
    await boundGetToken(async () => "new-token", 50, "session-b")({});
    expect(transportDiagnostic()!.events.map((event) => event.kind)).toEqual(["token-start", "token-obtained"]);
    clearBootEpisode();
    expect(transportDiagnostic()).toBeNull();
  });

  test("a late result from a replaced token request cannot describe the current session", async () => {
    let finishOld!: (token: string) => void;
    const old = boundGetToken(() => new Promise<string>((resolve) => { finishOld = resolve; }), 1000, "session-a")({});
    expect(tokenOutcome("session-b")).toBeNull();
    await expect(boundGetToken(async () => null, 1000, "session-b")({})).resolves.toBeNull();
    finishOld("old-session-token");
    await expect(old).resolves.toBe("old-session-token"); // SDK still guards obsolete auth configs.
    expect(tokenOutcome("session-b")?.result).toBe("empty");
    expect(tokenOutcome("session-a")).toBeNull();
  });
});
