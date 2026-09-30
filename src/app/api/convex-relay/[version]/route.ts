import { auth } from "@clerk/nextjs/server";
import { experimental_upgradeWebSocket } from "@vercel/functions";
import { relayConvexSocket, RELAY_BUFFER_LIMIT } from "@/lib/convex-socket-relay";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request, context: { params: Promise<{ version: string }> }) {
  const origin = new URL(req.url).origin;
  if (req.headers.get("origin") !== origin) return new Response(null, { status: 403 });
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
  const { sessionId } = await auth();
  if (!sessionId) return new Response(null, { status: 401 });
  const { version } = await context.params;
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version)) return new Response(null, { status: 400 });
  // A fixed deployment from trusted configuration, never a client-supplied
  // destination, authorization header, cookie or admin/deployment credential.
  const deployment = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!deployment || !/^https:\/\/[a-z0-9-]+\.convex\.cloud\/?$/.test(deployment)) return new Response(null, { status: 503 });
  const upstream = new URL(`/api/${version}/sync`, deployment);
  upstream.protocol = "wss:";
  return experimental_upgradeWebSocket((socket) => relayConvexSocket(socket, upstream.href, origin), {
    maxPayload: RELAY_BUFFER_LIMIT,
  });
}
