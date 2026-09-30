import WebSocket, { type RawData } from "ws";

// Convex frames can contain large query results/import arguments. Vercel's
// 256 KiB default is too small. Bound both frame size and queued output.
export const RELAY_BUFFER_LIMIT = 16 * 1024 * 1024;

/** Transparent per-connection forwarding. Never interpret or log JWTs or data.
 * Convex remains the authority for authentication and all workspace operations. */
export function relayConvexSocket(client: WebSocket, url: string, origin: string): Promise<void> {
  return new Promise((resolve) => {
    const upstream = new WebSocket(url, {
      headers: { Origin: origin }, handshakeTimeout: 60_000, maxPayload: RELAY_BUFFER_LIMIT,
    });
    let finished = false;
    let queuedBytes = 0;
    const pending: Array<{ data: RawData; binary: boolean }> = [];
    // Close gracefully before the Hobby/Fluid 300-second invocation deadline.
    // The existing Convex SDK reconnects and restores protocol state.
    const lifetime = setTimeout(() => finish(1012), 285_000);
    lifetime.unref();
    function finish(code: number) {
      if (finished) return;
      finished = true;
      clearTimeout(lifetime);
      pending.length = 0;
      const wireCode = code === 1005 ? 1000 : code === 1006 ? 1011 : code;
      upstream.terminate();
      if (client.readyState === WebSocket.CLOSED) { resolve(); return; }
      // Keep the invocation alive until its close frame is flushed. Bound a
      // stalled close handshake so it finishes before the platform deadline.
      const closing = setTimeout(() => { client.terminate(); resolve(); }, 5_000);
      closing.unref();
      client.once("close", () => { clearTimeout(closing); resolve(); });
      if (client.readyState === WebSocket.OPEN) client.close(wireCode);
    }
    const size = (data: RawData) => Array.isArray(data)
      ? data.reduce((total, chunk) => total + chunk.byteLength, 0) : data.byteLength;
    function forward(socket: WebSocket, data: RawData, binary: boolean) {
      if (finished) return;
      if (socket.readyState !== WebSocket.OPEN) { finish(1011); return; }
      if (socket.bufferedAmount + size(data) > RELAY_BUFFER_LIMIT) { finish(1009); return; }
      socket.send(data, { binary }, (error) => { if (error) finish(1011); });
    }
    client.on("message", (data, binary) => {
      if (finished) return;
      if (upstream.readyState === WebSocket.CONNECTING) {
        if (pending.length >= 256 || queuedBytes + size(data) > RELAY_BUFFER_LIMIT) { finish(1009); return; }
        queuedBytes += size(data);
        pending.push({ data, binary });
      } else forward(upstream, data, binary);
    });
    upstream.once("open", () => {
      for (const message of pending) forward(upstream, message.data, message.binary);
      pending.length = 0;
      queuedBytes = 0;
    });
    upstream.on("message", (data, binary) => forward(client, data, binary));
    upstream.once("unexpected-response", (_request, response) => {
      if (!finished) console.warn("[cendro] convex relay upgrade failed", { status: response.statusCode });
      response.resume();
      finish(1011);
    });
    upstream.on("error", () => {
      if (!finished) console.warn("[cendro] convex relay transport failed");
      finish(1011);
    });
    upstream.once("close", (code) => finish(code));
    client.once("close", (code) => finish(code));
    client.on("error", () => finish(1011));
  });
}
