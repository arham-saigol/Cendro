import { afterEach, expect, test, vi } from "vitest";

const authState = vi.hoisted(() => ({ sessionId: "test-session" as string | null }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => authState }));
import { POST } from "./route";

const snapshot = {
  event: "stall", episode: "a7727582-453d-4a16-8751-6f8e9624e589", build: "local",
  status: "loading", stage: "convex-auth", elapsedSeconds: 20,
  webSocketConnected: false, everConnected: false, connectionRetries: 0,
  online: true, autoRetries: 0, confirmation: "pending", token: null, profile: null,
};
function request(body: object) {
  return new Request("https://cendro.app/api/auth-diagnostics", {
    method: "POST", headers: { origin: "https://cendro.app", "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
afterEach(() => { authState.sessionId = "test-session"; vi.restoreAllMocks(); });

test("accepts only a redacted, authenticated same-origin diagnostic", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect((await POST(request({ ...snapshot, jwt: "secret" }))).status).toBe(400);
  expect(warn).not.toHaveBeenCalled();
  authState.sessionId = null;
  expect((await POST(request(snapshot))).status).toBe(401);
  authState.sessionId = "test-session";
  expect((await POST(new Request("https://cendro.app/api/auth-diagnostics", { method: "POST", headers: { origin: "https://other.example", "content-type": "application/json" }, body: JSON.stringify(snapshot) }))).status).toBe(403);
  expect((await POST(request(snapshot))).status).toBe(204);
  expect(warn.mock.calls[0][1]).toEqual(snapshot);
  // Duplicate delivery is idempotent and does not consume another log slot.
  expect((await POST(request(snapshot))).status).toBe(204);
  expect(warn).toHaveBeenCalledTimes(1);
  expect((await POST(request({ ...snapshot, autoRetries: 1, stage: "data" }))).status).toBe(204);
  expect(warn.mock.calls[1][1]).toMatchObject({ autoRetries: 1, stage: "data" });
});

test("ingestion bounds diagnostics per signed-in session", async () => {
  authState.sessionId = "rate-test-session";
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (let i = 0; i < 6; i++) {
    expect((await POST(request({ ...snapshot, episode: `a772758${i}-453d-4a16-8751-6f8e9624e589` }))).status).toBe(204);
  }
  expect((await POST(request({ ...snapshot, episode: "a7727586-453d-4a16-8751-6f8e9624e589" }))).status).toBe(429);
  expect(warn).toHaveBeenCalledTimes(6);
});

test("dedupe cache eviction does not reset active session quotas", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (let session = 0; session < 170; session++) {
    authState.sessionId = `quota-session-${session}`;
    for (let attempt = 0; attempt < 6; attempt++) {
      const episode = `a7727582-453d-4a16-8751-${String(session * 6 + attempt).padStart(12, "0")}`;
      expect((await POST(request({ ...snapshot, episode }))).status).toBe(204);
    }
  }
  authState.sessionId = "quota-session-0";
  expect((await POST(request({ ...snapshot, episode: "a7727582-453d-4a16-8751-999999999999" }))).status).toBe(429);
});

test("rejects a streaming body that exceeds the byte limit without a Content-Length", async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(4096))); controller.close(); } });
  const req = new Request("https://cendro.app/api/auth-diagnostics", {
    method: "POST", headers: { origin: "https://cendro.app", "content-type": "application/json" }, body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  expect((await POST(req)).status).toBe(413);
});
