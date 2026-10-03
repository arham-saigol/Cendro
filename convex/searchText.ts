import { normalizePaletteQuery, PALETTE_MIN_QUERY_LENGTH } from "../src/lib/palette-search";

/**
 * Normalizes reference codes (and queries against them) for forgiving search:
 * lowercase, strip separators, and collapse leading zeros inside digit runs, so
 * "jd-5", "JD 005", and "jd005" all match the stored reference "JD-005".
 */
export function referenceSearchKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .replace(/\d+/g, (run) => String(parseInt(run, 10)));
}

/**
 * Resolves a typed code to the reference spelling stored on rows ("PREFIX-NNN"
 * with 3-digit padding) so a lookup can hit the reference index even when the
 * row sits beyond the palette's bounded scan. Returns null when the query does
 * not parse as a code (letters + digits).
 */
export function referenceCodeCandidate(value: string) {
  const match = /^([a-z]+)[^a-z0-9]*0*(\d+)$/.exec(value.trim().toLowerCase());
  if (!match) return null;
  return `${match[1].toUpperCase()}-${match[2].padStart(3, "0")}`;
}

export const PALETTE_RESULT_LIMIT = 8;
export const PALETTE_CANDIDATE_LIMIT = 128;

/** Choose one indexed read path. A code lookup never scans title matches. */
export function paletteSearchInput(value: string) {
  const needle = normalizePaletteQuery(value);
  if (needle.length < PALETTE_MIN_QUERY_LENGTH) return null;
  const code = /^(jd|tsk|sop)[\s-]*(\d*)$/.exec(needle);
  if (code) {
    return {
      kind: "reference" as const,
      prefix: `${code[1].toUpperCase()}-${code[2]}`,
      exact: referenceCodeCandidate(needle),
    };
  }
  // Convex search accepts at most 16 tokens. Punctuation-only input needs no read.
  const terms = needle.match(/[\p{L}\p{N}]+/gu)?.slice(0, 16);
  return terms?.length ? { kind: "title" as const, query: terms.join(" ") } : null;
}
