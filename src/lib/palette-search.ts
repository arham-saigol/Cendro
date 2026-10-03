export const PALETTE_MIN_QUERY_LENGTH = 2;
export const PALETTE_MAX_QUERY_LENGTH = 200;
export const PALETTE_SEARCH_DELAY_MS = 300;

export function normalizePaletteQuery(query: string) {
  return query.trim().toLowerCase().slice(0, PALETTE_MAX_QUERY_LENGTH);
}
