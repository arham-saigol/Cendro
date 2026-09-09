export const DEFAULT_QUERY_LIMIT = 500;

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
