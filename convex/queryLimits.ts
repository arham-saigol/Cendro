export const DEFAULT_QUERY_LIMIT = 500;

/**
 * Streams a bounded scan until `target` accepted rows collect or `budget`
 * docs are read, reporting whether the range was exhausted.
 *
 * This is the scan-until-filled primitive for in-function searches. A
 * function may call `.paginate()` only once — a second page throws "ran
 * multiple paginated queries" on a real deployment (convex-test does not
 * enforce the rule) — so loops over pages crash in production. Async
 * iteration uses the query stream instead: it reads lazily, stops the moment
 * the target fills, and never consumes the paginate budget.
 */
export async function scanUntil<T>(
  docs: AsyncIterable<T>,
  budget: number,
  target: number,
  keep: (doc: T) => Promise<boolean>,
): Promise<{ kept: T[]; exhausted: boolean }> {
  const kept: T[] = [];
  let scanned = 0;
  for await (const doc of docs) {
    if (kept.length >= target || scanned >= budget) return { kept, exhausted: false };
    scanned += 1;
    if (await keep(doc)) kept.push(doc);
  }
  return { kept, exhausted: true };
}

/**
 * Reads one extra row so callers can distinguish a complete bounded result
 * from a partial one. The returned rows always stay within the requested
 * application limit.
 */
export async function takeWithOverflow<T>(
  take: (limit: number) => Promise<T[]>,
  limit = DEFAULT_QUERY_LIMIT,
) {
  const rows = await take(limit + 1);
  return {
    rows: rows.slice(0, limit),
    isTruncated: rows.length > limit,
  };
}
