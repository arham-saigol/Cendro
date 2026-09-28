import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexReactClient, useConvexAuth } from "convex/react";
import { ConvexClerkAuthProvider } from "./convex-clerk-auth";
import { createMockElement } from "./test-dom";

const clerk = vi.hoisted(() => ({ token: vi.fn<() => Promise<string | null>>(), sessionId: "session-1" }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({
  isLoaded: true, isSignedIn: true, sessionId: clerk.sessionId,
  orgId: null, orgRole: null, sessionClaims: { aud: "convex" }, getToken: clerk.token,
}) }));

// Controlled transport with the installed Convex auth state machine, not a
// token-truthiness replacement for ConvexProviderWithAuth.
class ControlledSocket {
  static sockets: ControlledSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: Array<{ type: string; baseVersion?: number }> = [];
  readyState = 0;
  constructor() { ControlledSocket.sockets.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: "" }); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data: object) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

describe("real Convex auth boundary", () => {
  let root: Root;
  let client: ConvexReactClient;
  let state: ReturnType<typeof useConvexAuth>;
  function Probe() { state = useConvexAuth(); return null; }
  async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

  beforeEach(async () => {
    ControlledSocket.sockets = [];
    clerk.sessionId = "session-1";
    clerk.token.mockReset().mockResolvedValue("test-token");
    client = new ConvexReactClient("https://happy-otter-123.convex.cloud", {
      webSocketConstructor: ControlledSocket as unknown as typeof WebSocket, logger: false,
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

  test("terminal token failure retries; recovery still requires server confirmation", async () => {
    vi.useFakeTimers();
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
