# Task list alignment, sorting, and manual order

Status: implementation plan only. No application changes are included.

## 1. Outcome and decisions

Implement the changes in the shared JD/one-time task list, preserving selection, inline editing, side-peek navigation, filters, permissions, and reactive updates.

- Put selection and drag controls in the actual table row. Their center must follow the row's real height, with no separately calculated vertical offsets.
- Reuse the existing `@dnd-kit/react` dependency and Lucide `GripVertical` six-dot icon.
- Add single-column ascending/descending sorting, plus explicit Default and Custom modes.
- A completed drag that changes position selects Custom and saves the resulting order. Starting, canceling, or dropping a task back in place does not change mode or persist anything.
- Preserve the requested defaults: JD frequency from Daily to Yearly; one-time priority from High to Low; newest-created first for ties.

**Important discrepancy:** one-time priority sorting is not currently implemented. `listOneTimeRows` returns creation-descending database pages and the frontend comparator returns zero for all one-time rows. Delivering the user's stated default therefore corrects this behavior; it does not preserve the current newest-first bug. JD frequency sorting exists but only over already-loaded rows.

**Product assumption:** sort mode and Custom order are personal, scoped by `(companyId, membershipId, taskType)`, and restored across reloads/devices. All/My, search, assignee, status, frequency, and priority filters are projections of that one order, not separate saved orders. This lets employees organize their own work without altering another person's workspace. A shared company order would require a different permission and concurrency contract; do not silently implement it with task-level `order` fields.

**Scale decision to review:** the proposed simple implementation supports complete client-side sorting and an atomic saved ID vector, with a validated maximum of 2,000 IDs per personal order. This comfortably covers the reported 100–200 rows, but is an explicit new Custom-order capacity, not an existing product limit. Before implementation ships, verify the expected company task volumes and the bounded transaction measurements in section 9. If larger Custom lists are required, replace the vector design before release; do not truncate orders or present a partial list as globally sorted. Field sorting itself must not silently stop at this limit.

## 2. What exists today

| Location | Finding and consequence |
| --- | --- |
| `src/components/app/task-pages.tsx`, `TaskListPage` around 1170–1860 | Shared implementation for both task types. `kind` is `jd` or `one`; backend task types are `jd` or `one_time`. Reuse `taskTypeFor` at the boundary. |
| Same file, around 1204–1270 | `usePaginatedQuery` loads 200 scanned records initially. Search and frequency/priority enter query arguments; My/status/assignee also filter locally. JD then sorts the loaded subset. |
| Same file, around 1321 | IntersectionObserver loads additional pages near the list bottom. Loading more can insert JD tasks above existing rows because sorting occurs after paging. |
| Same file, around 1650–1677 | An absolute sibling checkbox rail has a 36px header and a separate 41px flex item per task. It is not table layout. `group-hover/row` cannot match the separate sibling table row. |
| `src/app/globals.css`, around 265–305 and 517 | Table cells have nominal 41px height, borders, and content-driven minimum heights. Rail items have an additional transparent-border rule. Independently laid-out boxes can diverge through content, zoom, or rounding. |
| `convex/tasks.ts`, `listJdRows` and `listOneTimeRows` | Both paginate `by_company` descending before filtering and visibility checks, then enrich each result. Empty result pages can still have a continuation cursor. Neither query implements priority order. |
| `convex/tasks.ts`, `visible`, `taskVisibilityAuth`, `enrichedJd`, `enrichedOneTime` | Existing authorization and scoped assignee projection must be preserved. Sort User using only returned assignees, never hidden users' names. |
| `convex/schema.ts` | Task documents have `reference`, recurrence/priority, timestamps, assignee IDs; no task-list preference or Custom-order storage. |
| `convex/references.ts` | Codes are `JD-001`/`TSK-001`, with padding of at least three digits. String ordering fails at `999`/`1000`; parse the numeric suffix. |
| `src/components/app/company-pages.tsx`, sortable structure rows | Already uses `DragDropProvider`, `useSortable`, `isSortable`, `handleRef`, and `GripVertical`; handles cancellation and persists on drop. Follow this API family. |
| `package.json` / `package-lock.json` | React 19, Next 16, Convex 1.41; dnd-kit React resolves to 0.5.0 and declares React 18/19 peer compatibility. No new runtime drag library is needed. |
| `convex/productionFixes.test.ts`, `tasksHardening.test.ts`, `authz.fixture.ts` | Existing pagination/search and scoped-visibility regression seams and `convex-test` fixtures. |
| `vitest.config.*`, `task-rail-scroll.test.ts` | Vitest uses edge-runtime. The rail test is for horizontal filter pills, not selection geometry. Its mocked DOM cannot prove real table alignment. |

The separate rail is the structural explanation supported by inspection. Exact pixel drift has not been reproduced in a browser during planning; measure it before the fix rather than asserting a particular fractional error per row.

Similar rails remain in company users and SOPs. Do not broaden this task to those screens or delete their shared CSS. Scope new styles to the task-list table. Dashboard/company tables also use `.task-table`.

## 3. Sorting contract

Use a discriminated sort state:

- `{ mode: "default" }`
- `{ mode: "field", field, direction: "asc" | "desc" }`
- `{ mode: "custom" }`

Allow only fields appropriate to the task type. Keep rank/comparator/merge helpers in `src/lib/task-list-order.ts` with narrow typed row inputs, and share the persisted sort validator/type through a small module usable by Convex and React. Do not make the existing large component or new endpoints depend on additional `any` casts.

| Header | Ascending | Descending | Initial click |
| --- | --- | --- | --- |
| Code | Numeric suffix small to large | Large to small | Ascending |
| Assigned to (User) | Display names A–Z | Z–A | Ascending |
| Frequency, JD | daily, every_other_day, weekly, semimonthly, monthly, quarterly, semiannually, annually | Reverse rank | Ascending |
| Priority, one-time | low, medium, high | high, medium, low | Descending |
| Due date, one-time | Earlier actual timestamp first | Later timestamp first | Ascending |
| Title, both | A–Z | Z–A | Ascending |
| Date assigned, one-time | Older `createdAt` first | Newer first | Descending |
| Quantity, JD | Numeric small to large | Large to small | Ascending |

Leave Status unsortable because workflow order is not specified, and Time unsortable because it is optional free-form text rather than a normalized duration. Do not add sorting to action/selection columns. Date assigned means the timestamp the current UI displays; do not invent reassignment-history semantics.

Comparator details:

1. Parse the expected code prefix and a safe integer suffix, consistent with the reference allocator. Invalid/missing values go last in both directions. Include `JD-009`, `JD-010`, `JD-999`, and `JD-1000` in tests.
2. Use one `Intl.Collator("en", { sensitivity: "base", numeric: true })` for displayed text; trim it first. Explicit locale prevents different devices choosing different locale defaults in this English interface.
3. For User, reuse the current `assigneeDisplayName` rule (`user.name`, then email). For multiple returned assignees, sort their display-name keys alphabetically, then compare the lists lexicographically, with shorter equal-prefix lists first. This is independent of assignment insertion order. Never mutate the displayed assignee array. An empty visible-assignee list goes last both ways.
4. Missing dates, quantities, and invalid ranks go last both ways. Reverse only the comparison of present primary values; do not reverse null placement or tie-breakers.
5. For equal primary values, use `createdAt` descending, then task ID ascending for a deterministic total order. Default JD uses the existing recurrence rank; Default one-time uses high/medium/low explicitly, not the UI `priorities` array's low-first order.
6. No multi-column sort UI. Clicking a different header chooses its initial direction; clicking the active header toggles direction indefinitely. Default is selected explicitly from the mode control.
7. Selecting a field or Default retains the saved Custom order. Selecting Custom restores it; if none exists, show the default sequence without writing, and establish a snapshot only on a real drag.
8. Keep a sort active even if its header becomes hidden by a filter/My view; the toolbar continues to identify it and permits switching to Default. No hidden automatic mode resets.

## 4. Loading and global correctness

Sorting only the first 200 records is not correct. A task on page two can belong at the very top in Code, User, Priority, or Custom order.

For the reported list sizes, reuse the existing authorized paginated row queries and exhaust their pages before allowing a manual reorder or presenting a finished sorted list. Avoid a new denormalized index per field and per viewer, particularly because visible assignee names differ by viewer.

Implementation steps:

1. Query the company/task-type dataset without the UI search or frequency/priority predicates for this screen. Keep those optional endpoint arguments for existing callers/tests. Apply all task-list filters to the complete authorized result set locally. A company/type cache then survives changes between All/My and other filters.
2. Retain bounded Convex pages, and automatically request the next page whenever status becomes `CanLoadMore`, sequentially, until `Exhausted`. Continue through empty authorized pages. Stop on unmount/company/type changes and surface errors with retry. Do not replace pagination with `.collect()`.
3. Initially show a loading state with task controls disabled until the full dataset and preference are available. Do not advertise a complete global order while more pages are pending. Loading failure must not fall through to an empty-list or successful-order state.
4. Sort the complete result, then filter it, then render an initial 200 rows. Repurpose the existing observer/Load more button to reveal another 200 already-sorted rows. Keep separate names for query completion and rendered-row count; do not let display pagination masquerade as database completion.
5. Build ID/rank maps once per result/preference change. Do not use `indexOf` for every comparator call. Preserve selection by ID across sorts. Select all retains the current rendered-row semantics, with an accessible label that makes this clear.
6. For the first drag from a field/default order, snapshot the full filtered sequence, including rows not rendered yet, and move the dragged ID relative to its drop target. Only mounted rows are drop targets. Users can reveal further rows before starting a drag; do not remount/reveal rows during the drag.
7. On realtime membership/task changes, recompute the settled list. During an active drag, freeze its ID sequence and defer display reordering. Cancel if the source/target disappears or scope changes; do not apply stale indexes to new data. After settlement reconcile with the latest query, not a copied old task array.

Tradeoff: every visited company/type still requires O(N) fetched authorized rows, O(N) retained client data, and O(N log N) local sorting. Existing enriched rows include description/notes and per-task lookups, so this is not suitable for tens of thousands of tasks. Measure 200, 1,000, and 2,000 records, including payload-heavy tasks and sparse authorization. If unacceptable, the prerequisite is a lightweight paginated sorting projection plus bounded row hydration, or server-ordered pagination with maintained keys; do not work around it with an arbitrary first-page sort. Do not introduce virtualization or that larger data model without this evidence.

Backend page options should be clamped to the screen's 200-item batch size and bounded read options supported by the installed Convex version. Account for assignee enrichment and JD cycle reads in measurements, not just the initial index scan.

## 5. Persistence and filtered reordering

### Storage

Add `taskListPreferences` in `convex/schema.ts`:

- `companyId: Id<"companies">`
- `membershipId: Id<"companyMemberships">`
- `taskType: "jd" | "one_time"`
- `sort`: validated discriminated state from section 3
- `customOrder`: optional array of task IDs, validated by task type
- `revision`: integer starting at 1
- `updatedAt`: mutation timestamp
- index `by_company_membership_type` on the three scope fields

Prefer a discriminated document validator so JD preferences cannot contain one-time IDs. If the public API accepts string IDs to match current task APIs, normalize each ID against the selected table before use.

An ID vector is intentional: a drag from Code descending must preserve the sequence the user actually saw, including all unaffected rows. A single rank patch against the old frequency order would not do that. At hundreds of tasks an atomic vector is simpler than fractional ranks, repeated rank rebalancing, or generation-based snapshot publication.

Use an application limit of 2,000 IDs and a conservative serialized-size check below the Convex document limit; reject oversize input with a clear error. Never silently truncate. This is a reviewable capacity choice, with the release gate described above, not permission to silently disable requested functionality for an existing larger customer.

### Restore and merge rules

Let `A` be the current complete authorized task set, `C` the saved vector, and `V` the IDs matching the active filters.

- Restored Custom = surviving IDs from `C` in saved order, followed by IDs in `A` absent from `C`, in Default order.
- Deletion or access loss removes a row from display immediately; a stale stored ID grants no visibility. New/imported/newly-visible tasks appear at the end. Task edits and JD cycle changes do not move saved IDs in Custom mode.
- During the next successful reorder, prune no-longer-authorized/deleted IDs and include currently known new IDs. Do not write preferences just because a query or render ran.
- For a drag in a filtered view, start with restored full Custom (or Default if no Custom snapshot exists), identify the slots occupied by `V`, and refill exactly those slots with the newly ordered full filtered sequence. Nonmatching tasks retain their slots and relative order.
- Example: full Custom `[A, X, B, Y, C]`, filter shows `[A, B, C]`; dragging C before A produces `[C, X, A, Y, B]` globally and `[C, A, B]` under the filter.
- When the filtered view was field-sorted, use that field-sorted sequence as the replacement sequence before applying the move. When unfiltered, the whole saved sequence becomes the displayed field/default sequence plus the move. This prevents switching to Custom from undoing the other visible rows' ordering.
- Switching to another field and then back to Custom restores the prior vector exactly for surviving IDs. Switching to Default changes only `sort`.

### Endpoints and authorization

Keep the new public endpoints in `convex/tasks.ts` so they can reuse the private task-visibility helpers without a broad authorization refactor:

- `getListPreference({ companyId, taskType })`: derives the active membership from auth, uses the compound index, returns the caller's validated preference or a default with revision 0. No writes on read.
- `setListSort({ companyId, taskType, sort, expectedRevision })`: validates allowed fields for the task type, derives membership, retains Custom IDs, updates revision atomically, returns the saved revision/state.
- `saveListOrder({ companyId, taskType, orderedIds, expectedRevision })`: validates size/uniqueness/ID type, verifies each submitted task belongs to the company and is visible using precomputed auth/scopes, then atomically saves the vector AND `sort: custom` and increments revision.

Use object-form function definitions with explicit args/return validators. Follow `convex/_generated/ai/guidelines.md` and read the Convex expert skill before future implementation edits.

No caller-supplied membership identity. Active membership and task visibility are sufficient because this changes only the caller's preference, not task content. Do not reuse update-task permissions to prevent a read-only task viewer from organizing their own list. Reuse the existing generic not-found/access failure style. Reject duplicates, foreign-company tasks, inaccessible tasks, and wrong-type IDs. Do not trust the client to prove visibility.

The saved sequence is a preference, never an authorization source. It may omit new tasks; restore appends them. Returning previously known stale IDs only to the same authenticated owner is acceptable, but never return hidden task documents or enrich them from these IDs. Company soft deletion and membership deactivation already block access; retain preference records with existing retained child data. No global fanout cleanup on task deletion.

### Concurrent saves and errors

Compare `expectedRevision` in the transaction. A mismatch returns a stable conflict error; do not overwrite newer state. Convex transaction retries alone do not prevent an old browser snapshot overwriting a newer preference.

Optimistically show Custom immediately on a successful local drop, then persist. Serialize preference writes per mounted scope; disable further drags/mode changes while a write is pending. On failure discard the optimistic overlay, use the latest subscribed preference, and show a retryable error. Do not roll back to stale task contents. On conflicts ask the user to repeat the move against the refreshed order rather than replaying stale indexes.

Store pending scope/revision with the operation. A late result after company/type switch must not alter the new screen. Network retry of an already committed request can encounter a revision conflict; reconcile by comparing the subscribed saved state to the requested state, treating an identical persisted result as success rather than applying the move twice.

## 6. Row layout and accessible sorting controls

Replace the task list's absolute checkbox rail with one leading controls `<th>`/`<td>` in every real row. Put a flex container inside the cell, with the drag button first and Checkbox second. Use normal table `vertical-align: middle`; the inner container needs no independent row height.

- Allocate a compact fixed control-column width (approximately 64px; verify existing spacing and touch targets). Keep the code/title baseline visually consistent by adjusting only the task list's gutter/wrapper.
- Remove task-list-only `-ml-11`, width calculation, and `pl-11` as required by the integrated column. Use a task-list-specific wrapper class for horizontal overflow; inspect the existing `.task-table-wrap { overflow: hidden }` cascade.
- Increment `jdColumns`/`oneColumns`, including loading and empty-state colspans, and account for conditional metadata columns.
- Put select-all in the control header aligned with row checkboxes, with an empty handle-width spacer. Show on actual header hover/focus and while anything is selected.
- Row controls show on row hover/focus-within; selected checkboxes stay visible. Show handles/checkboxes on coarse pointers where hover does not exist. Keep keyboard focus indicators visible.
- Preserve selected/checked backgrounds and move the side-peek selected indicator to the intended code boundary if adding the control cell changes `td:first-child` behavior. Scope overrides so other tables remain unchanged.
- Mark the control cell/buttons interactive and stop propagation as appropriate. Fix the row key handler to ignore interactive descendants; its current Enter/Space path can open details when a nested keyboard control is used.

Create a small `TaskSortHeader` that renders a semantic `<th scope="col" aria-sort=...>` containing a full-width `<button>`. Show inactive sort arrows on hover/focus, and active direction continuously. Reserve icon space to avoid column-width jumps. Header buttons work with click, Enter, and Space; labels announce field/current order/next action. In Default mode expose the effective Frequency ascending or Priority descending on its header; Custom has no active column sort.

Add a toolbar sort menu beside existing filters: Default, Custom, and the supported fields/directions. This keeps Default/Custom and hidden-column sorts reachable on all views. Keep saved Custom available while field-sorting; label the current mode. No new table framework is necessary for one controlled sort descriptor.

## 7. dnd-kit integration

Extract only the row rendering needed for a hook-owning `SortableTaskRow`; avoid refactoring unrelated dialogs/detail forms. Use `useSortable` with task ID, current rendered index, and a group scoped to company/type/membership. Attach `ref` to `<tr>` and `handleRef` only to the leading button. Use `DragDropProvider` around the table, not DOM wrappers inside `<tbody>`.

Follow the existing company structure implementation and 0.5.0 types: `isSortable(source)`, `initialIndex`, `index`, and `event.canceled`. Do not mix in legacy `@dnd-kit/core`/`@dnd-kit/sortable` APIs. The package's release tarball types were checked during planning because this checkout has no `node_modules`; `handleRef` and row refs accept `Element`, so a native table row is supported at the type boundary.

- Handle-only activation; selecting text, editing cells, toggling status/checkboxes, opening popovers, or opening details must not initiate dragging.
- Reuse built-in pointer/keyboard sensors, collision handling, scrolling, and drag feedback. Verify activation thresholds and touch behavior against the installed version. Restrict movement to the vertical axis using the library's supported modifier if needed; do not write pointer collision or autoscroll engines.
- Use `GripVertical` with a label such as “Reorder JD-012: Task title”. Restore focus to that task's handle after the move.
- Check default library keyboard announcements; add meaningful pickup, destination, completion, and cancellation labels only where its supported accessibility configuration needs them.
- On drag end validate source/target/group and compare the resulting ID order, not merely a mutable numeric index. Make one persistence call only for a real move.
- Reorder one task at a time, even if multiple tasks are checked. Selection remains unchanged.
- Verify table-column widths during feedback and drop animation. Start with library feedback; if a custom overlay is necessary, render valid table markup with measured column widths through its overlay API.
- Respect reduced motion. Verify keyboard pickup/movement/drop/cancel and touch scrolling. Do not add a second independent reorder system.

## 8. Implementation sequence and files

1. Reproduce checkbox drift with 200 variable-content tasks and zoom; record row/control center measurements at top/middle/bottom. Confirm the proposed personal scope and capacity assumptions against actual product needs.
2. Add comparator, filter-projection merge, and restore helpers in `src/lib/task-list-order.ts` with focused unit tests. Encode the explicit defaults and missing/multi-assignee rules first.
3. Add preference validators/schema/index and the three endpoints. Add public Convex tests with `createAuthzFixture`; generate API/types on the development target through the normal project procedure.
4. Make `TaskListPage` distinguish complete data loading from display pagination. Subscribe to preferences, scope/reset state correctly, and centralize the sorted/filtered/rendered pipeline.
5. Replace the rail with the actual controls column and fix interactive keyboard event boundaries. Validate alignment before introducing drag transforms.
6. Add `TaskSortHeader` and the mode menu, wired to the same state/comparators as the list.
7. Extract `SortableTaskRow`, wire dnd-kit, filtered-order merge, optimistic Custom state, save/rollback, and revision conflicts.
8. Verify all affected interaction and authorization boundaries. Keep shared rails elsewhere and unrelated task APIs untouched.

Expected changed files: `src/components/app/task-pages.tsx`, `src/app/globals.css`, new focused task sort/row components if needed, `src/lib/task-list-order.ts` and tests, a shared sort contract module, `convex/schema.ts`, `convex/tasks.ts`, focused Convex preference tests, and generated Convex types only as required. The package/lockfile should remain unchanged unless a browser regression runner is deliberately added in step 9. There is no task-document backfill: missing preferences mean Default, and records are created lazily on an explicit sort/reorder write.

## 9. Verification that proves the behavior

### Pure outcome tests

- Default JD chronology through all eight frequencies; one-time high/medium/low, with newest-first ties.
- Numeric code boundary, text direction, multi-assignee order independent of assignment insertion, missing dates last in both directions.
- Restoring saved order after adding/deleting tasks; field sorting does not mutate the saved vector.
- Filtered example from section 5, plus first drag from a non-default field sort. Include a row beyond the first displayed 200 to prove it is retained.
- Canceled/no-op drag produces no new state to persist.

### Public Convex tests

Use existing fixture identities and actual endpoints, not mocks of authorization helpers:

- Missing preference yields Default; saving an order persists Custom and restores identical IDs/revision; setting a field retains the vector.
- Another user, another company, and the other task type get independent state.
- Wrong-company/wrong-type/inaccessible IDs, duplicates, malformed fields, and oversize requests fail without changing saved state. Include a manager with partially scoped assignees.
- Deactivated membership/company access denied; task update permission is not required for an otherwise visible personal reorder.
- Two saves based on the same revision: first succeeds, second fails without overwriting it. Mode and order are atomic.
- Existing search/pagination/assignee-hiding tests remain green. Follow continuation cursors through an empty page rather than assuming empty means exhausted.

### Real browser regression

The current edge-runtime DOM mock cannot test layout or drag physics. Use an existing external browser harness if available; otherwise add a narrowly scoped Playwright development harness during implementation, not during this planning task. Use disposable development fixtures/auth, never production seed data.

At minimum automate the original defect: 200 rows, hover/focus row 1/100/200, compare checkbox center to its own row center with a <=1 CSS-pixel tolerance. Add one taller middle row and repeat. The original separate rail should fail this case. Check 100%, 125%, and 150% zoom manually if the runner cannot reproduce actual browser zoom.

Exercise both task types with more than 200 records, ensuring a later-fetched task sorts to the top. Then verify:

- Drag row near the bottom upward, Custom appears, reload restores it.
- Field sort → drag → Custom; field sort → Custom restores previous manual order.
- Filtered reorder, clear filters, and return to the filter match the specified slot semantics.
- Header keyboard controls and `aria-sort`; keyboard drag cancel/drop and focus restoration.
- Checkbox, select-all, inline editors, status controls, detail link, and noneditable row navigation do not accidentally drag/open each other.
- Mobile/coarse pointer, horizontal overflow, reduced motion, loading/empty states, selection colors, hidden columns.
- Failed/conflicting save rolls back cleanly; deletion or permission loss during drag cancels safely; late save after company switch cannot affect the new list.

### Commands and release gate

During implementation run focused helper and Convex tests first (`npx vitest run <changed test files>`), then existing `convex/productionFixes.test.ts`, `convex/tasksHardening.test.ts`, `convex/taskImports.test.ts`, and `convex/jdTaskCycles.test.ts`. Finish with `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run audit:authz`; run `npm run build` with the expected development build environment for this cross-boundary UI change. Run the real-browser regression separately.

Before release measure complete-list load latency, subscribed payload/read cost, sort latency, and reorder mutation read/byte limits at the intended maximum. Test unusually large task descriptions and many assignees. The vector design is acceptable only if the agreed production size fits both the validated capacity and measured Convex transaction headroom. If not, revise storage/loading before shipping; raising the array cap alone does not solve enrichment cost or transaction limits.

This planning pass did not install dependencies, run the app/tests, deploy Convex, or reproduce the UI in a browser. These are future implementation checks, not claims of completed validation.

## 10. Research and rationale

- [dnd-kit React useSortable](https://dndkit.com/react/hooks/use-sortable/): supports dedicated handles, row refs, grouping, disabled state, and library modifiers/sensors. The local company structure is the strongest integration precedent; 0.5.0 package types and React peer versions were checked against the lockfile.
- [dnd-kit sortable state management](https://dndkit.com/react/guides/sortable-state-management/): controlled state can be committed from sortable drag events. The application owns persistence and the change to Custom; the library owns drag interaction.
- [Convex pagination](https://docs.convex.dev/database/pagination): preserve bounded reactive pages and continuation semantics. Client sorting requires the complete candidate set; a page-local comparator cannot establish global order.
- [Convex limits](https://docs.convex.dev/production/state/limits): document and transaction limits motivate a validated vector bound and measurements. An atomic vector is intentionally a small-list design, not an unlimited ordering system.
- [Notion views, filters, and sorts](https://www.notion.com/help/views-filters-and-sorts): a useful product precedent for explicit view controls and property sorting. This plan deliberately adds the user's requested automatic switch to Custom after a manual move.

Rejected for this scope: per-row pixel corrections/ResizeObserver synchronization; handwritten drag sensors; a second drag library; a whole table framework; localStorage as the authoritative order; global task rank fields for a personal preference; and sorting only the currently loaded page. Each either misses a required invariant or adds more machinery than the current task warrants.
