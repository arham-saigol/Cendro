import type { OptimisticLocalStore } from "convex/browser";

/**
 * Drop ids from every loaded page of a paginated list query so rows disappear
 * immediately; the mutation still reconciles authoritatively on the server.
 */
export function removeFromListPages(localStore: OptimisticLocalStore, queryFn: any, ids: Set<string>) {
  for (const entry of localStore.getAllQueries(queryFn)) {
    const value = entry.value as { page?: { _id: string }[] } | undefined;
    if (!value?.page) continue;
    const page = value.page.filter((row) => !ids.has(row._id));
    if (page.length !== value.page.length) localStore.setQuery(queryFn, entry.args, { ...value, page });
  }
}

/**
 * Prepend a synthetic row to the first page of each loaded paginated list, so a
 * create shows a pending row immediately. The optimistic patch reverts when the
 * real row arrives via the subscription.
 */
export function prependToListFirstPage(localStore: OptimisticLocalStore, queryFn: any, row: any) {
  for (const entry of localStore.getAllQueries(queryFn)) {
    const value = entry.value as { page?: { _id: string }[] } | undefined;
    if (!value?.page) continue;
    const cursor = (entry.args as { paginationOpts?: { cursor?: string | null } } | undefined)?.paginationOpts?.cursor ?? null;
    if (cursor !== null) continue;
    localStore.setQuery(queryFn, entry.args, { ...value, page: [row, ...value.page] });
  }
}

/** Apply `update` to a row inside every loaded page of a paginated list query. */
export function updateInListPages(localStore: OptimisticLocalStore, queryFn: any, id: string, update: (row: any) => any) {
  for (const entry of localStore.getAllQueries(queryFn)) {
    const value = entry.value as { page?: { _id: string }[] } | undefined;
    if (!value?.page) continue;
    const index = value.page.findIndex((row) => row._id === id);
    if (index < 0) continue;
    const page = value.page.slice();
    page[index] = update(page[index]);
    localStore.setQuery(queryFn, entry.args, { ...value, page });
  }
}

/** Apply `update` to `value.task` inside loaded detail queries shaped like `{ task }`. */
export function updateInDetailQueries(localStore: OptimisticLocalStore, queryFn: any, id: string, update: (task: any) => any) {
  for (const entry of localStore.getAllQueries(queryFn)) {
    const value = entry.value as { task?: { _id: string } } | undefined;
    if (value?.task?._id !== id) continue;
    localStore.setQuery(queryFn, entry.args, { ...value, task: update(value.task) });
  }
}
