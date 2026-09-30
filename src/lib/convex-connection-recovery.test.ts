import { expect, test } from "vitest";
import { recoveringWebSocket } from "./convex-connection-recovery";

class Socket extends EventTarget {
  constructor(public readonly url: string) { super(); }
  close() { this.dispatchEvent(new Event("close")); }
}
const direct = "wss://happy-otter-123.convex.cloud/api/1.46.0/sync";

test("a broken relay doesn't prevent direct recovery, and intentional closes don't trigger failover", () => {
  const Recovering = recoveringWebSocket(Socket as unknown as typeof WebSocket, "https://www.cendro.app");
  for (let i = 0; i < 4; i++) { const socket = new Recovering(direct); socket.close(); expect(socket.url).toBe(direct); }
  for (let i = 0; i < 3; i++) new Recovering(direct).dispatchEvent(new Event("close"));
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
