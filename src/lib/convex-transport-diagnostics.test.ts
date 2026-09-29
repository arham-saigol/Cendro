import { afterEach, expect, test, vi } from "vitest";

// Native events, not browser automation. The SDK's own handlers must keep working.
class Socket extends EventTarget {
  sent: unknown[] = [];
  closed: unknown[][] = [];
  close(code?: number, reason?: string) { this.closed.push([code, reason]); }
  send(data: unknown) { this.sent.push(data); }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function harness() {
  vi.resetModules();
  const diagnostics = await import("./convex-transport-diagnostics");
  const ObservedSocket = diagnostics.diagnosticWebSocket(Socket as unknown as typeof WebSocket);
  return { ...diagnostics, socket: new ObservedSocket("wss://happy-otter-123.convex.cloud/api/1.41.0/sync?secret=never-store") };
}

test("records auth rejection and native lifecycle without retaining secrets or changing messages", async () => {
  vi.useFakeTimers();
  const { socket, transportDiagnostic, transportDiagnosticSchema } = await harness();
  const listener = vi.fn();
  socket.addEventListener("message", listener);
  await vi.advanceTimersByTimeAsync(397);
  socket.dispatchEvent(new Event("open"));
  const tokenFrame = JSON.stringify({ type: "Authenticate", tokenType: "User", baseVersion: 4, value: "secret-jwt" });
  socket.send(tokenFrame);
  const rejection = JSON.stringify({ baseVersion: 4, type: "AuthError", error: "secret-email@example.com secret-jwt", authUpdateAttempted: true });
  socket.dispatchEvent(Object.assign(new Event("message"), { data: rejection }));
  socket.dispatchEvent(Object.assign(new Event("close"), { code: 1008, wasClean: true, reason: "secret-close-reason" }));
  const result = transportDiagnostic()!;
  expect(result).toMatchObject({ attempts: 1, opens: 1, messages: 1, authSends: 1, authErrors: 1 });
  expect(result.events).toContainEqual({ atMs: 397, kind: "authenticate", socket: 1, version: 4 });
  expect(result.events).toContainEqual({ atMs: 397, kind: "auth-error", socket: 1, version: 4, authUpdateAttempted: true });
  expect(result.events).toContainEqual({ atMs: 397, kind: "close", socket: 1, code: 1008, clean: true });
  expect(transportDiagnosticSchema.safeParse(result).success).toBe(true);
  expect(JSON.stringify(result)).not.toContain("secret");
  expect((socket as unknown as Socket).sent).toEqual([tokenFrame]);
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ data: rejection }));
});

test("observation preserves native constructor and send failures without exposing error contents", async () => {
  vi.resetModules();
  const { diagnosticWebSocket, transportDiagnostic } = await import("./convex-transport-diagnostics");
  const failure = new Error("secret-network-error");
  class ThrowingConstructor extends Socket {
    constructor() { super(); throw failure; }
  }
  const FailingSocket = diagnosticWebSocket(ThrowingConstructor as unknown as typeof WebSocket);
  expect(() => new FailingSocket("wss://happy-otter-123.convex.cloud/api/1.41.0/sync")).toThrow(failure);
  expect(transportDiagnostic()!.events.at(-1)?.kind).toBe("constructor-error");
  class ThrowingSend extends Socket {
    override send() { throw failure; }
  }
  const FailingSend = diagnosticWebSocket(ThrowingSend as unknown as typeof WebSocket);
  const socket = new FailingSend("wss://happy-otter-123.convex.cloud/api/1.41.0/sync");
  expect(() => socket.send("secret-token")).toThrow(failure);
  expect(transportDiagnostic()!.events.at(-1)?.kind).toBe("send-error");
  expect(JSON.stringify(transportDiagnostic())).not.toContain("secret");
});

test("bounded history distinguishes enforced CSP from generic failures and client closes", async () => {
  vi.useFakeTimers();
  const document = new EventTarget();
  vi.stubGlobal("document", document);
  const { socket, transportDiagnostic, TRANSPORT_EVENT_LIMIT } = await harness();
  const violation = (disposition: string, host: string) => Object.assign(new Event("securitypolicyviolation"), {
    disposition, effectiveDirective: "connect-src", blockedURI: `wss://${host}/secret-path`,
  });
  document.dispatchEvent(violation("report", "happy-otter-123.convex.cloud"));
  document.dispatchEvent(violation("enforce", "unrelated.example.com"));
  expect(transportDiagnostic()!.events.some((event) => event.kind === "csp-blocked")).toBe(false);
  document.dispatchEvent(violation("enforce", "happy-otter-123.convex.cloud"));
  expect(transportDiagnostic()!.events.at(-1)?.kind).toBe("csp-blocked");
  socket.close(1000, "secret-reason");
  expect(transportDiagnostic()!.events.at(-1)?.kind).toBe("client-close");
  expect((socket as unknown as Socket).closed).toEqual([[1000, "secret-reason"]]);
  for (let i = 0; i < 50; i++) socket.dispatchEvent(new Event("error"));
  expect(transportDiagnostic()!.events).toHaveLength(TRANSPORT_EVENT_LIMIT);
  socket.dispatchEvent(Object.assign(new Event("close"), { code: 1006, wasClean: false }));
  document.dispatchEvent(violation("enforce", "happy-otter-123.convex.cloud"));
  expect(transportDiagnostic()!.events.at(-1)?.kind).toBe("close"); // Already observed before close.
});

test("an active socket keeps counters and endpoint consistent across boot and session trace resets", async () => {
  const { socket, transportDiagnostic } = await harness();
  const { clearBootEpisode, beginTokenAttempt } = await import("./auth-diagnostics");
  socket.dispatchEvent(new Event("open"));
  clearBootEpisode();
  socket.dispatchEvent(Object.assign(new Event("message"), { data: "{}" }));
  expect(transportDiagnostic()).toMatchObject({
    endpoint: "happy-otter-123.convex.cloud", sdk: "1.41.0", attempts: 0, opens: 0, messages: 1,
    events: [{ kind: "first-message", socket: 1, atMs: expect.any(Number) }],
  });
  beginTokenAttempt("session-a");
  beginTokenAttempt("session-b");
  socket.send(JSON.stringify({ type: "Authenticate", tokenType: "User", baseVersion: 2, value: "secret-jwt" }));
  socket.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ type: "AuthError", baseVersion: 2, authUpdateAttempted: true }) }));
  expect(transportDiagnostic()).toMatchObject({
    endpoint: "happy-otter-123.convex.cloud", sdk: "1.41.0", attempts: 0, messages: 1, authSends: 1, authErrors: 1,
  });
  expect(transportDiagnostic()!.events.map((event) => event.kind)).toEqual(["authenticate", "auth-error"]);
  expect(JSON.stringify(transportDiagnostic())).not.toContain("secret");
});

test("a reused socket does not attribute a previous session's auth error to the next session", async () => {
  const { socket, transportDiagnostic } = await harness();
  const { beginTokenAttempt, clearBootEpisode } = await import("./auth-diagnostics");
  const authenticate = (version: number) => socket.send(JSON.stringify({
    type: "Authenticate", tokenType: "User", baseVersion: version, value: "secret-jwt",
  }));
  const reject = (version: number) => socket.dispatchEvent(Object.assign(new Event("message"), {
    data: JSON.stringify({ type: "AuthError", baseVersion: version, authUpdateAttempted: true }),
  }));
  beginTokenAttempt("session-a");
  authenticate(4);
  clearBootEpisode(); // Successful boot clears evidence, not the identity comparison key.
  beginTokenAttempt("session-b");
  reject(4); // Response to the old session, after the diagnostic reset.
  expect(transportDiagnostic()!.authErrors).toBe(0);
  authenticate(5);
  authenticate(6);
  reject(4);
  reject(5); // Earlier current-session attempt is still observable after version 6 is sent.
  reject(6);
  expect(transportDiagnostic()!.authErrors).toBe(2);
  expect(transportDiagnostic()!.events.filter((event) => event.kind === "auth-error")).toEqual([
    { kind: "auth-error", socket: 1, version: 5, authUpdateAttempted: true, atMs: expect.any(Number) },
    { kind: "auth-error", socket: 1, version: 6, authUpdateAttempted: true, atMs: expect.any(Number) },
  ]);
  beginTokenAttempt("session-c");
  authenticate(6); // A reused identity version cannot prove which session produced a late response.
  reject(6);
  expect(transportDiagnostic()!.authErrors).toBe(0);
  expect(JSON.stringify(transportDiagnostic())).not.toContain("secret");
});

test("overlapping reconnects record one endpoint-level CSP violation without guessing its socket", async () => {
  vi.useFakeTimers();
  const document = new EventTarget();
  vi.stubGlobal("document", document);
  vi.resetModules();
  const { diagnosticWebSocket, transportDiagnostic } = await import("./convex-transport-diagnostics");
  const ObservedSocket = diagnosticWebSocket(Socket as unknown as typeof WebSocket);
  const endpoint = "wss://happy-otter-123.convex.cloud/api/1.41.0/sync";
  const first = new ObservedSocket(endpoint);
  first.dispatchEvent(Object.assign(new Event("close"), { code: 1006, wasClean: false }));
  new ObservedSocket(endpoint);
  document.dispatchEvent(Object.assign(new Event("securitypolicyviolation"), {
    disposition: "enforce", effectiveDirective: "connect-src", blockedURI: endpoint,
  }));
  expect(transportDiagnostic()!.events.filter((event) => event.kind === "csp-blocked")).toEqual([
    { kind: "csp-blocked", atMs: expect.any(Number) },
  ]);
});

test("a CSP violation delivered after a failed socket closes is captured, then observation expires", async () => {
  vi.useFakeTimers();
  const document = new EventTarget();
  vi.stubGlobal("document", document);
  const { socket, transportDiagnostic } = await harness();
  const violation = () => Object.assign(new Event("securitypolicyviolation"), {
    disposition: "enforce", effectiveDirective: "connect-src",
    blockedURI: "wss://happy-otter-123.convex.cloud/api/1.41.0/sync",
  });
  socket.dispatchEvent(Object.assign(new Event("close"), { code: 1006, wasClean: false }));
  document.dispatchEvent(violation());
  expect(transportDiagnostic()!.events.at(-1)?.kind).toBe("csp-blocked");
  const events = transportDiagnostic()!.events.length;
  document.dispatchEvent(violation());
  expect(transportDiagnostic()!.events).toHaveLength(events);

  const { socket: another } = await harness();
  another.dispatchEvent(Object.assign(new Event("close"), { code: 1006, wasClean: false }));
  await vi.advanceTimersByTimeAsync(5_000);
  const expiredEvents = transportDiagnostic()!.events.length;
  document.dispatchEvent(violation());
  expect(transportDiagnostic()!.events).toHaveLength(expiredEvents);
});
