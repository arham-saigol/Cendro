import { afterEach, describe, expect, test, vi } from "vitest";
import { CLERK_GET_TOKEN_TIMEOUT_MS, boundGetToken } from "./clerk-token";

describe("boundGetToken", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  test("returns null when getToken rejects, matching the uncaught wrapper behavior", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bounded = boundGetToken(() => Promise.reject(new Error("fetch failed")), 50);
    await expect(bounded({})).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
