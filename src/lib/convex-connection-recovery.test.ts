import { afterEach, expect, test, vi } from "vitest";
import { recoveringWebSocket } from "./convex-connection-recovery";

class Socket extends EventTarget {
  constructor(public readonly url: string) { super(); }
  close() { this.dispatchEvent(new Event("close")); }
}
const direct = "wss://happy-otter-123.convex.cloud/api/1.46.0/sync";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test("a broken relay doesn't prevent direct recovery, and intentional closes don't trigger failover", () => {
  const Recovering = recoveringWebSocket(Socket as unknown as typeof WebSocket, "https://www.cendro.app");
  for (let i = 0; i < 4; i++) { const socket = new Recovering(direct); socket.close(); expect(socket.url).toBe(direct); }
  new Recovering(direct).dispatchEvent(new Event("close"));
  const relay = new Recovering(direct);
  expect(relay.url).toBe("wss://www.cendro.app/api/convex-relay/1.46.0");
  relay.dispatchEvent(new Event("open"));
  // A platform upgrade followed by an upstream failure is not a healthy route.
  relay.dispatchEvent(new Event("close"));
  const recovered = new Recovering(direct);
  expect(recovered.url).toBe(direct);
  recovered.dispatchEvent(new Event("open"));
  recovered.dispatchEvent(new Event("close"));
  expect(new Recovering(direct).url).toBe(direct);
});

test("startup alternates failed routes across reloads and scopes saved choices to the deployment", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const origin = "https://www.cendro.app";
  const First = recoveringWebSocket(Socket as unknown as typeof WebSocket, origin);
  const failed = new First(direct);
  expect(failed.url).toBe(direct);
  failed.dispatchEvent(new Event("close"));
  // A new constructor factory models reloading the module/client.
  const Reloaded = recoveringWebSocket(Socket as unknown as typeof WebSocket, origin);
  const relay = new Reloaded(direct);
  expect(relay.url).toBe(`${origin.replace("https:", "wss:")}/api/convex-relay/1.46.0`);
  relay.dispatchEvent(new Event("close"));
  expect(new Reloaded(direct).url).toBe(direct);
  const Other = recoveringWebSocket(Socket as unknown as typeof WebSocket, origin);
  const otherUrl = "wss://other-otter-123.convex.cloud/api/1.46.0/sync";
  expect(new Other(otherUrl).url).toBe(otherUrl);
});

test("expired route preferences do not force a new visit onto the relay", () => {
  vi.useFakeTimers();
  vi.stubGlobal("sessionStorage", { getItem: () => JSON.stringify({ route: "relay", at: Date.now() - 31 * 60_000 }) });
  const Recovering = recoveringWebSocket(Socket as unknown as typeof WebSocket, "https://www.cendro.app");
  expect(new Recovering(direct).url).toBe(direct);
});
