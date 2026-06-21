type RateLimitBucket = { count: number; resetAt: number };

declare global {
  var __cendroAiRateLimits: Map<string, RateLimitBucket> | undefined;
}

const buckets = globalThis.__cendroAiRateLimits ?? new Map<string, RateLimitBucket>();
globalThis.__cendroAiRateLimits = buckets;

export function consumeAiRateLimit(key: string, options: { limit: number; windowMs: number }) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return { ok: true as const };
  }
  if (bucket.count >= options.limit) return { ok: false as const, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  bucket.count += 1;
  return { ok: true as const };
}
