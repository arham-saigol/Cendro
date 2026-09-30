import { recordTransportEvent } from "./convex-transport-diagnostics";

/** Change only the socket's route. Convex retains its client, auth state,
 * subscriptions, mutation IDs and reconnect backoff across failed upgrades. */
export function recoveringWebSocket(Base: typeof WebSocket, appOrigin: string): typeof WebSocket {
  let preferred: "direct" | "relay" = "direct";
  let failures = 0;
  return class extends Base {
    private clientClosed = false;

    constructor(url: string | URL, protocols?: string | string[]) {
      const target = new URL(url);
      const version = target.pathname.match(/^\/api\/(\d+\.\d+\.\d+)\/sync$/)?.[1];
      const route = version ? preferred : "direct";
      const relay = new URL(`/api/convex-relay/${version}`, appOrigin);
      relay.protocol = relay.protocol === "https:" ? "wss:" : "ws:";
      super(route === "relay" ? relay.href : url, protocols);
      if (route === "relay") recordTransportEvent({ kind: "relay-attempt" });
      let opened = false;
      let received = false;
      const healthy = () => { preferred = route; failures = 0; };
      this.addEventListener("open", () => {
        opened = true;
        if (route === "direct") healthy();
      });
      this.addEventListener("message", () => {
        received = true;
        healthy();
      });
      this.addEventListener("close", () => {
        if (this.clientClosed || (opened && (route === "direct" || received))) return;
        // A relay upgrade alone isn't proof that its upstream opened. If it
        // closes before any Convex frame, keep the direct route available.
        failures++;
        if (route === "relay" || failures >= 3) {
          preferred = route === "direct" ? "relay" : "direct";
          failures = 0;
        }
      });
    }

    override close(code?: number, reason?: string) {
      this.clientClosed = true;
      super.close(code, reason);
    }
  };
}
