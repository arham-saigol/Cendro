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
  expect(transportDiagnostic()!.events.at(-1)?.kind).toBe("close");
});
