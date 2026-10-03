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
