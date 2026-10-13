import { recordTransportEvent } from "./convex-transport-diagnostics";

/** Change only the socket's route. Convex retains its client, auth state,
 * subscriptions, mutation IDs and reconnect backoff across failed upgrades. */
export function recoveringWebSocket(Base: typeof WebSocket, appOrigin: string): typeof WebSocket {
  let preferred: "direct" | "relay" = "direct";
  let deployment: string | null = null;
  const remember = () => {
    try {
      sessionStorage.setItem(`cendro.socketRoute:${deployment}`, JSON.stringify({ route: preferred, at: Date.now() }));
    } catch { /* Route recovery still works with blocked storage. */ }
  };
  return class extends Base {
    private clientClosed = false;

    constructor(url: string | URL, protocols?: string | string[]) {
      const target = new URL(url);
      const version = target.pathname.match(/^\/api\/(\d+\.\d+\.\d+)\/sync$/)?.[1];
      if (version && deployment !== target.host) {
        deployment = target.host;
        preferred = "direct";
        try {
          const saved = JSON.parse(sessionStorage.getItem(`cendro.socketRoute:${deployment}`) ?? "null");
          const age = Date.now() - saved?.at;
          if ((saved?.route === "direct" || saved?.route === "relay") && age >= 0 && age < 30 * 60_000) preferred = saved.route;
        } catch { /* Invalid or unavailable storage cannot block startup. */ }
      }
      const route = version ? preferred : "direct";
      const relay = new URL(`/api/convex-relay/${version}`, appOrigin);
      relay.protocol = relay.protocol === "https:" ? "wss:" : "ws:";
      super(route === "relay" ? relay.href : url, protocols);
      if (!version) return;
      if (route === "relay") recordTransportEvent({ kind: "relay-attempt" });
      let opened = false;
      let received = false;
      let healthyRecorded = false;
      const healthy = () => {
        if (healthyRecorded) return;
        healthyRecorded = true;
        preferred = route;
        remember();
      };
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
        // The other path gets the next SDK attempt immediately. A page reload
        // must not reset startup to repeated attempts on the failed path.
        preferred = route === "direct" ? "relay" : "direct";
        remember();
      });
    }

    override close(code?: number, reason?: string) {
      this.clientClosed = true;
      super.close(code, reason);
    }
  };
}
