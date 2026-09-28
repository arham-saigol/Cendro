import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

// This endpoint is independent of Convex transport. Strict parsing prevents
// accidental collection of credentials, identities, arbitrary errors or URLs.
const diagnostic = z.strictObject({
  event: z.enum(["stall", "retry", "recovered"]),
  episode: z.uuid(),
  build: z.string().max(64).regex(/^[a-zA-Z0-9._-]+$/),
  status: z.enum(["loading", "convexUnauthenticated", "profileMissing", "ready", "noCompanies", "signedOut"]),
  stage: z.enum(["session", "convex-auth", "data"]).nullable(),
  elapsedSeconds: z.number().int().min(0).max(86400),
  webSocketConnected: z.boolean(), everConnected: z.boolean(),
  connectionRetries: z.number().int().min(0).max(100000), online: z.boolean(),
  autoRetries: z.number().int().min(0).max(100000),
  confirmation: z.enum(["confirmed", "pending", "terminal", "not-applicable"]),
  token: z.strictObject({
    result: z.enum(["obtained", "empty", "timeout", "rejected"]),
    durationMs: z.number().int().min(0).max(86400000),
    refresh: z.boolean(), attempt: z.number().int().min(1).max(100000),
    code: z.enum(["network_error", "session_expired", "session_invalid", "token_expired", "too_many_requests", "rate_limit_exceeded", "resource_forbidden", "invalid_session", "unexpected_error"]).optional(),
    status: z.number().int().min(400).max(599).optional(),
    requestId: z.string().max(64).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  }).nullable(),
});

// Best-effort per-instance cap; platform log retention/rate limits remain an
// operations concern, not a guarantee provided by this endpoint.
const seen = new Set<string>();
const quotas = new Map<string, { start: number; count: number }>();

export async function POST(req: Request) {
  const { sessionId } = await auth();
  if (!sessionId) return new Response(null, { status: 401 });
  if (req.headers.get("origin") !== new URL(req.url).origin || !req.headers.get("content-type")?.startsWith("application/json")) return new Response(null, { status: 403 });
  if (Number(req.headers.get("content-length") ?? 0) > 2048) return new Response(null, { status: 413 });
  const text = await req.text();
  if (text.length > 2048) return new Response(null, { status: 413 });
  let value: unknown;
  try { value = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
  const parsed = diagnostic.safeParse(value);
  if (!parsed.success) return new Response(null, { status: 400 });
  const key = `${sessionId}:${parsed.data.episode}:${parsed.data.event}`;
  if (seen.has(key)) return new Response(null, { status: 204 });
  const now = Date.now();
  const current = quotas.get(sessionId);
  const quota = current && now - current.start < 60_000 ? current : { start: now, count: 0 };
  if (quota.count >= 6) return new Response(null, { status: 429 });
  if (seen.size > 1000) { seen.clear(); quotas.clear(); }
  quotas.set(sessionId, { ...quota, count: quota.count + 1 });
  seen.add(key);
  console.warn("[cendro] auth diagnostic", parsed.data);
  return new Response(null, { status: 204 });
}
