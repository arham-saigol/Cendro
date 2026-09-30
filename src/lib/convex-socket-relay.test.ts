// @vitest-environment node
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import { experimental_upgradeWebSocket } from "@vercel/functions";
import { afterEach, expect, test, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { relayConvexSocket } from "./convex-socket-relay";

const servers: Server[] = [];
const sockets = new Set<WebSocket>();
const track = (socket: WebSocket) => { sockets.add(socket); return socket; };
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  return `ws://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.restoreAllMocks();
});

test("real sockets preserve queued auth, text/binary frames and close codes in both directions", async () => {
  const origin = "https://www.cendro.app";
  const upstreamServer = createServer();
  const upstreamWs = new WebSocketServer({ noServer: true });
  let release!: () => void;
  upstreamServer.on("upgrade", (req, socket, head) => {
    expect(req.headers.origin).toBe(origin);
    release = () => upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", track(ws)));
  });
  const upstreamUrl = await listen(upstreamServer);
  const relayServer = createServer();
  // Supply only Vercel's request context; exercise its installed upgrade API
  // and real sockets, rather than mocking the framework's WebSocket adapter.
  const requestContext = new AsyncLocalStorage<{ upgradeWebSocket: () => {
    req: Parameters<WebSocketServer["handleUpgrade"]>[0];
    socket: Parameters<WebSocketServer["handleUpgrade"]>[1];
    head: Buffer;
  } }>();
  const contextSymbol = Symbol.for("@vercel/request-context");
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const previous = globals[contextSymbol];
  globals[contextSymbol] = { get: () => requestContext.getStore() };
  let complete!: Promise<Response>;
  relayServer.on("upgrade", (req, socket, head) => {
    requestContext.run({ upgradeWebSocket: () => ({ req, socket, head }) }, () => {
      complete = experimental_upgradeWebSocket((ws) => relayConvexSocket(track(ws), upstreamUrl, origin));
    });
  });
  const relayUrl = await listen(relayServer);
  const browser = track(new WebSocket(relayUrl));
  await once(browser, "open");
  // Send protocol frames while the upstream's HTTP upgrade is still pending.
  const auth = JSON.stringify({ type: "Authenticate", value: "test-jwt" });
  browser.send(auth);
  const buffer = Buffer.from([0, 1, 255]);
  browser.send(buffer);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const connected = once(upstreamWs, "connection");
  release();
  const [backend] = await connected as [WebSocket];
  const messages: Array<[string, boolean]> = [];
  backend.on("message", (data, binary) => messages.push([data.toString("hex"), binary]));
  await vi.waitFor(() => expect(messages).toEqual([[Buffer.from(auth).toString("hex"), false], [buffer.toString("hex"), true]]));
  const response = once(browser, "message");
  backend.send("server-confirmation");
  const [data, binary] = await response;
  expect(data.toString()).toBe("server-confirmation");
  expect(binary).toBe(false);
  const closing = once(browser, "close");
  backend.close(1012);
  expect((await closing)[0]).toBe(1012);
  try { expect((await complete).status).toBe(204); }
  finally { globals[contextSymbol] = previous; }
});

test("a disconnected browser releases a pending upstream connection", async () => {
  const upstreamServer = createServer();
  let upstreamClosed!: Promise<unknown>;
  upstreamServer.on("upgrade", (_req, socket) => {
    upstreamClosed = once(socket, "end").then(() => socket.destroy());
    socket.resume();
  });
  const upstream = await listen(upstreamServer);
  const server = createServer();
  const gateway = new WebSocketServer({ server });
  let complete!: Promise<void>;
  gateway.on("connection", (socket) => { complete = relayConvexSocket(track(socket), upstream, "https://www.cendro.app"); });
  const browser = track(new WebSocket(await listen(server)));
  await once(browser, "open");
  await vi.waitFor(() => expect(upstreamClosed).toBeDefined());
  browser.close();
  await complete;
  await upstreamClosed;
});

test("an upstream rejected upgrade closes the relay and logs status without response secrets", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const upstream = await listen(createServer((_req, res) => { res.writeHead(403); res.end("secret-response-body"); }));
  const server = createServer();
  const gateway = new WebSocketServer({ server });
  let complete!: Promise<void>;
  gateway.on("connection", (socket) => { complete = relayConvexSocket(track(socket), upstream, "https://www.cendro.app"); });
  const browser = track(new WebSocket(await listen(server)));
  const closing = once(browser, "close");
  await once(browser, "open");
  expect((await closing)[0]).toBe(1011);
  await complete;
  expect(warn).toHaveBeenCalledWith("[cendro] convex relay upgrade failed", { status: 403 });
  expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
});
