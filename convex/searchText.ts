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
