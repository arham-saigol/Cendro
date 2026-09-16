/**
 * Preview cache for detail drawers. List rows seed the record they already
 * have, so opening a detail can paint synchronously while the authoritative
 * query resolves. Previews are never trusted over the server result — readers
 * must drop them once the query answers (including on access loss).
 */

const LIMIT = 300;
const previews = new Map<string, { value: unknown; at: number }>();

function key(scope: string, id: string) {
  return `${scope}:${id}`;
}

export function seedDetailPreview(scope: string, id: string | null | undefined, value: unknown) {
  if (!id || value == null) return;
  previews.delete(key(scope, id)); // reinsert to refresh LRU order
  previews.set(key(scope, id), { value, at: Date.now() });
  if (previews.size > LIMIT) {
    const oldest = previews.keys().next().value;
    if (oldest !== undefined) previews.delete(oldest);
  }
}

export function getDetailPreview<T>(scope: string, id: string | null | undefined): T | undefined {
  if (!id) return undefined;
  return previews.get(key(scope, id))?.value as T | undefined;
}

export function dropDetailPreview(scope: string, id: string | null | undefined) {
  if (id) previews.delete(key(scope, id));
}
