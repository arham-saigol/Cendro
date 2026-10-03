import { ConvexError } from "convex/values";
import { normalizePaletteQuery, paletteQueryError, PALETTE_MIN_QUERY_LENGTH } from "../src/lib/palette-search";
import { scanUntil } from "./queryLimits";
import type { QueryCtx } from "./_generated/server";

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
const PALETTE_READ_BYTES = 2 * 1024 * 1024;

/** Validate input without silently discarding search terms. */
export function paletteSearchInput(value: string) {
  const needle = normalizePaletteQuery(value);
  if (needle.length < PALETTE_MIN_QUERY_LENGTH) return null;
  const error = paletteQueryError(needle);
  if (error) throw new ConvexError(error);
  const terms = needle.match(/[\p{L}\p{N}]+/gu);
  return terms?.length ? { needle, title: terms.join(" ") } : null;
}

/** Cover stored codes, numeric prefixes, and the import boundary's 3–15 digit padding. */
function referencePrefixes(needle: string, supportedPrefixes: string[]) {
  const code = /^(?:(jd|tsk|ot|sop)[\s-]*)?(\d*)$/.exec(needle);
  if (!code) return [];
  const prefix = code[1]?.toUpperCase();
  const digits = code[2];
  const prefixes = prefix ? supportedPrefixes.filter((value) => value === prefix) : supportedPrefixes;
  if (digits.length > 15) return [];
  const spellings = new Set<string>();
  // A fully entered spelling wins over a different zero-padded record.
  if (digits.length >= 3) spellings.add(digits);
  if (/[1-9]/.test(digits)) {
    const number = digits.replace(/^0+/, "");
    for (let width = Math.max(3, number.length); width <= 15; width++) {
      spellings.add(number.padStart(width, "0"));
    }
    spellings.add(number);
  } else {
    // Preserve a padded partial code such as JD-00 without overlapping ranges.
    spellings.add(digits);
  }
  return prefixes.flatMap((value) => Array.from(spellings, (spelling) => `${value}-${spelling}`));
}

/** Merge indexed code and title candidates under one read/result budget. */
export async function searchPaletteRows<T extends { _id: string }>(ctx: QueryCtx, { input, prefixes, byReference, byTitle, isVisible }: {
  input: NonNullable<ReturnType<typeof paletteSearchInput>>;
  prefixes: string[];
  byReference: (prefix: string) => AsyncIterable<T>;
  byTitle: (title: string) => AsyncIterable<T>;
  isVisible: (row: T) => Promise<boolean>;
}) {
  let byteLimitReached = false;
  async function* candidates() {
    const sources = referencePrefixes(input.needle, prefixes).map((prefix) => () => byReference(prefix));
    sources.push(() => byTitle(input.title));
    for (const source of sources) {
      for await (const row of source()) {
        yield row;
        // SOP documents include their content. Stop early when matches are large.
        if ((await ctx.meta.getTransactionMetrics()).bytesRead.used >= PALETTE_READ_BYTES) {
          byteLimitReached = true;
          return;
        }
      }
    }
  }
  const seen = new Set<string>();
  const { kept, exhausted } = await scanUntil(candidates(), PALETTE_CANDIDATE_LIMIT, PALETTE_RESULT_LIMIT, async (row) => {
    if (seen.has(row._id)) return false;
    seen.add(row._id);
    return await isVisible(row);
  });
  return { rows: kept, truncated: !exhausted || byteLimitReached };
}
