export const PALETTE_MIN_QUERY_LENGTH = 2;
export const PALETTE_MAX_QUERY_LENGTH = 200;
export const PALETTE_SEARCH_DELAY_MS = 300;

export function paletteQueryError(query: string) {
  return (query.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) > 16
    ? "Use 16 words or fewer to search tasks and SOPs."
    : null;
}

export function normalizePaletteQuery(query: string) {
  return query.trim().toLowerCase().slice(0, PALETTE_MAX_QUERY_LENGTH);
}
