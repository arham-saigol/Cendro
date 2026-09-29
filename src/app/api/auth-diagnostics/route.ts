import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { savedTransportSchema, transportDiagnosticSchema } from "@/lib/convex-transport-diagnostics";

// This endpoint is independent of Convex transport. Strict parsing prevents
// accidental collection of credentials, identities, arbitrary errors or URLs.
const diagnostic = z.strictObject({
  event: z.enum(["stall", "retry", "recovered"]),
  episode: z.uuid(),
  build: z.string().max(64).regex(/^[a-zA-Z0-9._-]+$/),
  // Optional while already-open tabs on the previous build still report.
  capturedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  transport: transportDiagnosticSchema.nullable().optional(),
  previousTransport: savedTransportSchema.nullable().optional(),
  status: z.enum(["loading", "convexUnauthenticated", "profileMissing", "ready", "noCompanies", "signedOut"]),
  stage: z.enum(["session", "convex-auth", "data"]).nullable(),
  elapsedSeconds: z.number().int().min(0).max(86400),
  webSocketConnected: z.boolean(), everConnected: z.boolean(),
  connectionRetries: z.number().int().min(0).max(100000), online: z.boolean(),
  autoRetries: z.number().int().min(0).max(100000),
  confirmation: z.enum(["confirmed", "pending", "terminal", "not-applicable"]),
  profile: z.enum(["synced", "missing-email", "convex-error", "other-failure"]).nullable(),
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
  if (Number(req.headers.get("content-length") ?? 0) > 8192) return new Response(null, { status: 413 });
  if (!req.body) return new Response(null, { status: 400 });
  const reader = req.body.getReader();
  const bytes = new Uint8Array(8192);
  let length = 0;
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    if (length + chunk.byteLength > bytes.length) {
      void reader.cancel().catch(() => {});
      return new Response(null, { status: 413 });
    }
    bytes.set(chunk, length);
    length += chunk.byteLength;
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length))); } catch { return new Response(null, { status: 400 }); }
  const parsed = diagnostic.safeParse(value);
  if (!parsed.success) return new Response(null, { status: 400 });
  // The episode spans automatic reloads; each bounded reload has its own
  // status and retry count, while duplicate delivery of that event is ignored.
  const key = `${sessionId}:${parsed.data.episode}:${parsed.data.event}:${parsed.data.autoRetries}`;
  if (seen.has(key)) return new Response(null, { status: 204 });
  const now = Date.now();
  const current = quotas.get(sessionId);
  const quota = current && now - current.start < 60_000 ? current : { start: now, count: 0 };
  if (quota.count >= 6) return new Response(null, { status: 429 });
  if (seen.size > 1000) seen.clear();
  if (!current && quotas.size >= 1000) {
    for (const [id, entry] of quotas) if (now - entry.start >= 60_000) quotas.delete(id);
    if (quotas.size >= 1000) return new Response(null, { status: 429 });
  }
  quotas.set(sessionId, { ...quota, count: quota.count + 1 });
  seen.add(key);
  console.warn("[cendro] auth diagnostic", parsed.data);
  return new Response(null, { status: 204 });
}
