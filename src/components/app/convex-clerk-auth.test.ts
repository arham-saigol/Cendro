import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexReactClient, useConvexAuth } from "convex/react";
import { version as convexVersion } from "convex";
import { ConvexClerkAuthProvider } from "./convex-clerk-auth";
import { createMockElement } from "./test-dom";
import { diagnosticWebSocket, transportDiagnostic } from "@/lib/convex-transport-diagnostics";

const clerk = vi.hoisted(() => ({ token: vi.fn<() => Promise<string | null>>(), sessionId: "session-1" }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({
  isLoaded: true, isSignedIn: true, sessionId: clerk.sessionId,
  orgId: null, orgRole: null, sessionClaims: { aud: "convex" }, getToken: clerk.token,
}) }));

// Controlled transport with the installed Convex auth state machine, not a
// token-truthiness replacement for ConvexProviderWithAuth.
class ControlledSocket extends EventTarget {
  static sockets: ControlledSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: Array<{ type: string; baseVersion?: number }> = [];
  readyState = 0;
  constructor() { super(); ControlledSocket.sockets.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.finishClose(1000); }
  failUpgrade() { this.dispatchEvent(new Event("error")); this.finishClose(1006); }
  private finishClose(code: number) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "", wasClean: code === 1000 }));
    this.onclose?.({ code, reason: "" });
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); this.onopen?.(); }
  message(data: object) {
    const event = { data: JSON.stringify(data) };
    this.dispatchEvent(Object.assign(new Event("message"), event));
    this.onmessage?.(event);
  }
}

describe("real Convex auth boundary", () => {
  let root: Root;
  let client: ConvexReactClient;
  let state: ReturnType<typeof useConvexAuth>;
  let initialAttempts: number;
  let initialOpens: number;
  function Probe() { state = useConvexAuth(); return null; }
  async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

  beforeEach(async () => {
    vi.useFakeTimers();
    ControlledSocket.sockets = [];
    initialAttempts = transportDiagnostic()?.attempts ?? 0;
    initialOpens = transportDiagnostic()?.opens ?? 0;
    clerk.sessionId = "session-1";
    clerk.token.mockReset().mockResolvedValue("test-token");
    client = new ConvexReactClient("https://happy-otter-123.convex.cloud", {
      webSocketConstructor: diagnosticWebSocket(ControlledSocket as unknown as typeof WebSocket), logger: false,
    });
    root = createRoot(createMockElement());
    await act(async () => { root.render(React.createElement(ConvexClerkAuthProvider, { client }, React.createElement(Probe))); });
    await flush();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => { root.unmount(); });
    const closing = client.close();
    // An opening socket closes only after its open event.
    for (const socket of ControlledSocket.sockets) if (socket.readyState === 0) socket.open();
    await closing;
    clerk.token.mockReset();
    vi.restoreAllMocks();
  });

  test("obtained token remains pending until server confirms after transport opens", async () => {
    expect(clerk.token).toHaveBeenCalled();
    expect(state.isLoading).toBe(true);
    expect(state.isAuthenticated).toBe(false);
    const socket = ControlledSocket.sockets[0];
    await act(async () => { socket.open(); });
    const authMessage = socket.sent.find((message) => message.type === "Authenticate" && message.baseVersion !== undefined);
    expect(authMessage).toBeDefined();
    expect(state.isAuthenticated).toBe(false);
    await act(async () => {
      socket.message({ type: "Transition", startVersion: { querySet: 0, ts: "AAAAAAAAAAA=", identity: authMessage!.baseVersion },
        endVersion: { querySet: 0, ts: "AAAAAAAAAAA=", identity: authMessage!.baseVersion! + 1 }, modifications: [] });
    });
    expect(state.isAuthenticated).toBe(true);
  });

  test("failed upgrades reproduce the employee's pending auth and recover through SDK reconnect", async () => {
    // The SDK's capped backoff is 16s at this jitter value. No token outage,
    // auth rejection, or application retry is needed to reproduce the report.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    for (let attempt = 0; attempt < 44; attempt++) {
      await act(async () => {
        ControlledSocket.sockets.at(-1)!.failUpgrade();
        await vi.advanceTimersByTimeAsync(16_000);
      });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(client.connectionState()).toMatchObject({
      isWebSocketConnected: false, hasEverConnected: false, connectionRetries: 44,
    });
    expect(clerk.token).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({ isLoading: true, isAuthenticated: false });
    expect(ControlledSocket.sockets.every((socket) => socket.sent.length === 0)).toBe(true);
    const trace = transportDiagnostic()!;
    expect(trace.attempts - initialAttempts).toBe(45);
    expect(trace.opens - initialOpens).toBe(0);
    expect(trace.events).toContainEqual(expect.objectContaining({ kind: "close", code: 1006, clean: false }));
    expect(trace.endpoint).toBe("happy-otter-123.convex.cloud");
    expect(trace.sdk).toBe(convexVersion);

    // Restore only the transport, not Clerk or the provider. The pending token
    // is sent on reconnect; auth still requires the server's acknowledgement.
    const socket = ControlledSocket.sockets.at(-1)!;
    await act(async () => { socket.open(); });
    expect(state.isAuthenticated).toBe(false);
    const authMessage = socket.sent.find((message) => message.type === "Authenticate" && message.baseVersion !== undefined);
    expect(authMessage).toBeDefined();
    await act(async () => { socket.message({
      type: "Transition", startVersion: { querySet: 0, ts: "AAAAAAAAAAA=", identity: authMessage!.baseVersion },
      endVersion: { querySet: 0, ts: "AAAAAAAAAAA=", identity: authMessage!.baseVersion! + 1 }, modifications: [],
    }); });
    expect(state).toMatchObject({ isLoading: false, isAuthenticated: true });
  });

  test("a slow socket handshake remains pending and authenticates when the server responds", async () => {
    clerk.token.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve("test-token"), 410)));
    clerk.sessionId = "delayed-handshake-session";
    await act(async () => { root.render(React.createElement(ConvexClerkAuthProvider, { client }, React.createElement(Probe))); });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(ControlledSocket.sockets).toHaveLength(1);
    expect(ControlledSocket.sockets[0].readyState).toBe(0);
    expect(transportDiagnostic()!.events.some((event) => event.kind === "client-close")).toBe(false);
    expect(state).toMatchObject({ isLoading: true, isAuthenticated: false });
    const socket = ControlledSocket.sockets[0];
    await act(async () => { socket.open(); });
    const authMessage = socket.sent.find((message) => message.type === "Authenticate" && message.baseVersion !== undefined);
    expect(authMessage).toBeDefined();
    await act(async () => { socket.message({
      type: "Transition", startVersion: { querySet: 0, ts: "AAAAAAAAAAA=", identity: authMessage!.baseVersion },
      endVersion: { querySet: 0, ts: "AAAAAAAAAAA=", identity: authMessage!.baseVersion! + 1 }, modifications: [],
    }); });
    expect(state).toMatchObject({ isLoading: false, isAuthenticated: true });
  });

  test("a late token from a replaced Clerk session cannot overwrite the new handshake", async () => {
    let resolveOld!: (token: string) => void;
    clerk.token.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    clerk.sessionId = "old-pending-session";
    await act(async () => { root.render(React.createElement(ConvexClerkAuthProvider, { client }, React.createElement(Probe))); });
    await flush();

    clerk.token.mockResolvedValue("new-session-token");
    clerk.sessionId = "new-session";
    await act(async () => { root.render(React.createElement(ConvexClerkAuthProvider, { client }, React.createElement(Probe))); });
    await flush();
    await act(async () => { resolveOld("obsolete-token"); });

    const socket = ControlledSocket.sockets.at(-1)!;
    await act(async () => { socket.open(); });
    const authMessage = socket.sent.find((message) => message.type === "Authenticate" && message.baseVersion !== undefined);
    expect(authMessage).toMatchObject({ value: "new-session-token" });
    expect(JSON.stringify(socket.sent)).not.toContain("obsolete-token");
    expect(state.isAuthenticated).toBe(false);
    await act(async () => { socket.message({
      type: "Transition", startVersion: { querySet: 0, ts: "AAAAAAAAAAA=", identity: authMessage!.baseVersion },
      endVersion: { querySet: 0, ts: "AAAAAAAAAAA=", identity: authMessage!.baseVersion! + 1 }, modifications: [],
    }); });
    expect(state.isAuthenticated).toBe(true);
  });

  test("terminal token failure retries; recovery still requires server confirmation", async () => {
    clerk.token.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue("recovered-token");
    clerk.sessionId = "session-2";
    await act(async () => { root.render(React.createElement(ConvexClerkAuthProvider, { client }, React.createElement(Probe))); });
    await flush();
    expect(state.isAuthenticated).toBe(false);
    expect(state.isLoading).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await flush();
    expect(clerk.token).toHaveBeenCalledTimes(3);
    expect(state.isAuthenticated).toBe(false);
    expect(state.isLoading).toBe(true);
    const socket = ControlledSocket.sockets.at(-1)!;
    await act(async () => { socket.open(); });
    const authMessage = socket.sent.find((message) => message.type === "Authenticate" && message.baseVersion !== undefined);
    expect(authMessage).toBeDefined();
    await act(async () => { socket.message({
      type: "Transition", startVersion: { querySet: 0, ts: "AAAAAAAAAAA=", identity: authMessage!.baseVersion },
      endVersion: { querySet: 0, ts: "AAAAAAAAAAA=", identity: authMessage!.baseVersion! + 1 }, modifications: [],
    }); });
    expect(state.isAuthenticated).toBe(true);
  });
});
