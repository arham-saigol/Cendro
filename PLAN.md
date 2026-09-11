# SOP sorting implementation plan

## Objective

Bring Tasks sorting behavior to the SOP list: sortable columns, personal manual ordering, drag-and-drop, optimistic updates, and persistent preferences. Do not implement application changes as part of creating this plan.

Final columns, in order:

1. Code
2. Title
3. Assigned To
4. Created At
5. Updated

Remove the Type column entirely. Keep the Type filter, scope data, creation controls, and detail editing.

## Reference implementation and current gaps

Tasks is the behavioral reference:

- `src/components/app/task-pages.tsx`: loads all accessible pages, sorts and filters in the browser, renders incrementally, and connects preferences to dragging.
- `src/lib/task-list-sort.ts`: sort modes, fields, and initial directions.
- `src/lib/task-list-order.ts`: comparisons, custom-order restoration, filtered-order merging, and legacy fractional keys.
- `src/lib/task-list-preference-controller.ts`: optimistic updates, serialized saves, queued moves, rollback, and concurrent-session handling.
- `src/components/app/task-list-dnd.tsx`: pointer and keyboard dragging, measured checkbox rail, previews, overlay, and cancellation.
- `src/lib/task-list-drag.ts`: insertion and geometry helpers.
- `convex/tasks.ts`: `getListPreference`, `setListSort`, and `saveListOrder`.
- `convex/taskListPreferences.ts`: preference validators.
- `src/app/globals.css`: sorting header, rail, row transition, and overlay styles.

Tasks currently saves manual order as a complete ID vector through `saveListOrder`. Fractional order keys, per-task order-entry documents, and cleanup are legacy compatibility paths. Do not introduce these legacy paths for SOPs.

SOP integration points:

- `src/components/app/sop-pages.tsx`, especially `SopList`.
- `convex/sops.ts`, especially `withScopes`, `sopMatchesFilters`, `sopVisibleForView`, `filteredSopRows`, `list`, and `listRows`.
- `convex/permissions.ts`: `visibleSop`, `visibleSopForSelf`, and `buildSopVisibilityContext`.
- `convex/schema.ts`.

SOPs currently fetch `api.sops.listRows`, which applies visibility, search, and filters on the server and stops after 200 matching SOPs. They have no persistent sorting preference or dragging and position checkboxes using fixed 41-pixel rail rows. Their current columns are Code, Title, Type, Assigned To, Updated, Created At.

Sorting only the current 200-row response would be incomplete. Saving only filtered IDs would lose hidden-row ordering. The implementation must address both boundaries.

Before editing Convex code, read the applicable Convex skill instructions and `convex/_generated/ai/guidelines.md`. The generated guidelines target Convex `^1.41.0`. Use the existing dependencies; no new package is required.

## 1. Behavior contract

```ts
type SopListSort =
  | { mode: "default" }
  | { mode: "custom" }
  | {
      mode: "field";
      field: "code" | "title" | "assignedTo" | "createdAt" | "updatedAt";
      direction: "asc" | "desc";
    };
```

| Column | Sort field | Initial direction |
| --- | --- | --- |
| Code | `code` | Ascending |
| Title | `title` | Ascending |
| Assigned To | `assignedTo` | Ascending |
| Created At | `createdAt` | Descending |
| Updated | `updatedAt` | Descending |

- Default means `createdAt` descending, preserving the existing newest-created presentation with deterministic ties. Show Created At as descending in default mode.
- Clicking the active column reverses direction. Clicking another column uses its initial direction.
- Date columns start descending, consistent with Tasks' Date Assigned.
- Custom mode has no active column indicator.
- Dragging works from default, field, or custom sorting. A meaningful drop activates custom mode.
- Canceled and unchanged drops make no mutation and do not change the mode.
- Column sorting preserves the saved custom vector.
- Preferences belong to the authenticated company membership and are shared across All/My views, filters, browser sessions, and devices.
- Any member may organize SOPs they can view, including read-only members. Ordering does not require SOP editing permissions.
- Reordering updates preference data only. It must not change SOP `updatedAt`, authorship, content, audit events, or embeddings.

## 2. SOP ordering rules

Create `src/lib/sop-list-sort.ts` and `src/lib/sop-list-order.ts` with typed, immutable ordering helpers.

### Field comparisons

- **Code:** trim and parse `/^SOP-(\d+)$/i`; compare positive safe integers numerically. `SOP-2` precedes `SOP-10`. Missing or malformed codes sort last in both directions.
- **Title:** compare trimmed text with `Intl.Collator("en", { sensitivity: "base", numeric: true })`, matching Tasks.
- **Assigned To:** compare the full target name rendered by the list, including company, branch, department, and user targets. Do not group by scope type or compare IDs. Use `scopeTargetName` with the same fallback rules as `sopTargetName`. User sorting uses the full name, not a first-name abbreviation.
- **Created At / Updated:** compare raw numeric timestamps, never relative-time strings.
- Missing text and invalid timestamps sort last in either direction.
- Break equal primary values by `createdAt` descending, then `_id.localeCompare`, matching Tasks.

Move the target-name resolution currently in `sopTargetName` into a typed shared SOP helper so rendering and sorting agree. Preserve company-name and unknown-target fallbacks.

### Custom restoration

- Keep saved IDs present in the accessible dataset, in saved order.
- Ignore absent IDs and deduplicate defensively.
- Append newly accessible or newly created SOPs in default order.
- Do not modify the persisted vector during reads. A subsequent manual save naturally removes stale IDs.

Extract only reusable vector operations from Tasks into `src/lib/list-order.ts`: order equality, filtered-slot merging, and restoration against an explicitly provided default-ordered row list. Tasks retains its existing fractional-key layer around the shared vector logic. Keep task-specific rank comparisons and legacy key calculations in `task-list-order.ts`.

## 3. Complete, authorized ordering dataset

Add `api.sops.listOrderingRows` in `convex/sops.ts`:

```ts
args: {
  companyId: v.id("companies"),
  paginationOpts: paginationOptsValidator,
}
```

### Query implementation

1. Authenticate with `requireMembership`.
2. Build capabilities and SOP visibility context once per invocation.
3. Paginate `sops.by_company` in descending order.
4. Apply `visibleSop` before returning any row.
5. Preserve all pagination metadata with `{ ...page, page: authorizedRows }`.
6. Return existing hydrated SOP fields, including permission flags, plus:
   - `matchesMyView: boolean`
   - `filterBranchIds: Id<"branches">[]`
7. Include explicit argument and return validators.

Compute `matchesMyView` as `caps.has("sops:view:self") && await visibleSopForSelf(...)`. The capability check is necessary: `visibleSopForSelf` alone does not enforce that capability.

Compute `filterBranchIds` to reproduce the existing Branch filter:

- Branch SOP: branch scope IDs.
- Department SOP: parent branch IDs of scoped departments, checking company ownership.
- Company or user SOP: empty array.

Reuse scope hydration and cache repeated department lookups within the invocation. Keep full `content` available because existing SOP search matches content as well as code and title.

Preserve existing `list`, `listRows`, and search endpoint contracts; other callers and authorization tests use them. Only the SOP list UI switches to the new endpoint.

### Client loading and filtering

- Use `usePaginatedQuery` with 200-item requests.
- Automatically load subsequent pages until `Exhausted`, including after empty authorized pages.
- Require exhausted pagination and a loaded preference before enabling sort controls or dragging. Show a loading-all-SOPs status while incomplete; do not present an incomplete response as a final empty result.
- Apply All/My, Type, Branch, Person, and search filters locally to authorized rows.
- My view uses `matchesMyView`; All uses all authorized rows and remains available only under the existing capability checks.
- Type compares `scopeType`; Branch checks `filterBranchIds`; Person checks `userMembershipIds` and remains ignored in My view.
- Preserve search semantics: trimmed, case-insensitive substring matching against reference, title, and content.
- Preserve the existing 220 ms debounce. Include raw search text in drag cancellation state.
- Render the first 200 filtered rows, then progressively reveal more using Tasks' intersection observer and fallback button pattern. Pause progressive rendering during dragging.
- Select-all selects rendered rows and its accessible label says so, as in Tasks. Preserve SOP selection behavior across filters; sorting alone must not clear selection.

This follows [Convex's pagination documentation](https://docs.convex.dev/database/pagination): pages may be transformed before return, continuation metadata must survive filtering, and `Exhausted` identifies complete loading.

The deliberate ceiling matches Tasks: sorting loads the accessible dataset into browser memory; manual ordering supports at most 2,000 accessible rows. Above that limit, field sorting remains available and drag handles are disabled with an explanatory tooltip. Do not silently truncate results or save a partial order. Paginated reads bound each base-table fetch; do not replace them with an unbounded collection.

## 4. Preference persistence and validation

Add `convex/sopListPreferences.ts` for validators. Add this table to `convex/schema.ts`:

```ts
type SopListPreferenceDocument = {
  companyId: Id<"companies">;
  membershipId: Id<"companyMemberships">;
  sort: SopListSort;
  customOrder?: Id<"sops">[];
  revision: number;
  updatedAt: number;
};
```

Index: `by_companyId_and_membershipId`, covering `companyId` and `membershipId`. Resolve a preference with that index and `.unique()`.

Add public functions in `convex/sops.ts`:

| Function | Arguments beyond `companyId` | Behavior |
| --- | --- | --- |
| `getListPreference` | None | Return saved preference or lazy default |
| `setListSort` | `sort`, `expectedRevision` | Change sort while retaining custom order |
| `saveListOrder` | `orderedIds`, `expectedRevision` | Save vector and activate custom mode |

All three return:

```ts
{
  sort: SopListSort;
  customOrder: Id<"sops">[] | null;
  revision: number;
  updatedAt: number | null;
}
```

An absent preference returns default mode, `customOrder: null`, revision `0`, and `updatedAt: null`. Reads do not create documents.

### Mutation requirements

- Derive membership from authentication; never accept a membership ID from the client.
- Require a non-negative safe integer revision equal to the stored revision, or zero for a missing document.
- Save and increment revision atomically.
- Reject duplicate IDs, more than 2,000 IDs, and serialized vectors exceeding 128 KiB. Use a shared SOP limit constant for client gating and backend validation. SOP IDs are ASCII, so JSON string length corresponds to bytes for this payload.
- Validate `orderedIds` with `v.array(v.id("sops"))`.
- Check every submitted SOP still exists, belongs to the company, and passes `visibleSop`.
- Build authorization context once per save and reuse it across checks.
- Reject the entire save if any ID is invalid or inaccessible. Use a generic `SOP not found` error for object-access failures.
- Do not require update or delete permissions.
- Validate submitted IDs without requiring the vector to equal a fresh company-wide scan. Concurrently created SOPs are appended by restoration.
- Return SOP-specific conflict and validation messages.

No SOP backfill, fractional keys, order-entry table, or migration job is needed. Do not write to SOP documents when saving preferences.

## 5. Shared preference controller

Extract the existing controller into `src/lib/list-preference-controller.ts`, parameterized by sort type. Its generic constraint must support `{ mode: "custom" }`.

Preserve existing behavior:

- One in-flight write and one latest queued manual order.
- Immediate optimistic display.
- Header sorting blocked while a write is pending.
- Dragging allowed while a manual save is pending, but blocked during a sort save.
- Revision conflicts discard dependent queued work and restore the latest authoritative state.
- Subscription-confirmed saves remain successful if their acknowledgement is lost.
- Late results after cancellation cannot change another mounted scope.

Parameterize user-facing error messages so SOP failures do not mention Tasks. Preserve Tasks' optional `orderFormat` handling. SOP adapters normalize controller snapshots to `orderFormat: "vector"` without persisting a format marker; apply this normalization to both subscription results and mutation results so acknowledgement comparison remains consistent.

Update Tasks to use the extracted controller and retain its behavior. Move or update controller tests with the extraction; do not duplicate the state machine.

## 6. Shared header and drag machinery

Move existing drag implementation and geometry helpers to neutral shared files:

- `src/components/app/list-dnd.tsx`
- `src/lib/list-drag.ts`

Update Tasks imports and SOP integration together. Preserve the existing algorithms instead of building a second drag system.

During extraction:

- Rename `data-task-id` to `data-list-item-id` consistently in measurement, resize observation, row binding, and overlay lookup.
- Use the company/member/entity list scope for drag grouping and accepted item type, preventing cross-list drops.
- Retain visual CSS classes already suitable for both lists.
- Update the row-transition selector in `globals.css` so SOP rows receive the same preview animation as Tasks.
- Retain measured layout offsets, pointer-release positioning, keyboard sorting, out-of-bounds cancellation, scroll reprojection, resize cancellation, inert overlay cloning, drop animation, and reduced-motion handling.
- Preserve handle-only drag activation and accessible reorder labels.

Extract the presentation from `TaskSortHeader` into `src/components/app/list-sort-header.tsx`. Pass active and next directions from each domain caller. Preserve arrow styling and `aria-sort`; accessible labels must describe the actual initial direction, including descending date sorts.

Keep task-specific default-field decisions outside the shared header. Update Tasks to use the shared header without changing its direction rules.

## 7. SOP list integration

Split `SopList` into a company-context wrapper and keyed content component, matching Tasks. Key by company ID and membership ID so switching scope remounts preferences, optimistic state, selections, and drag bindings. Preserve the public `selectedId` prop and existing drawer layout integration.

Use this row pipeline:

```text
authorized paginated rows
→ existing optimistic SOP field patches
→ active default / field / custom ordering
→ search and view filters
→ progressive rendering
```

Instantiate the shared controller with adapters for the new SOP mutations. Subscribe through `useSyncExternalStore`, receive Convex updates in a layout effect, and cancel on unmount. Report save failures through the existing `inlineError` alert. Preserve existing optimistic edit reconciliation.

### Drop persistence algorithm

Reproduce Tasks' filtered merge:

```text
visible = all filtered IDs in current display order
nextVisible = insert source before/after the chosen anchor

if unchanged:
  return

baseline = restored custom order of every accessible SOP
nextFullOrder = replace visible slots in baseline with nextVisible
controller.saveOrder(nextFullOrder)
```

The baseline is the saved custom order plus default-ordered missing rows, even when dragging from field sorting. Hidden rows retain their baseline slots; visible rows adopt displayed order with the requested move.

Example: baseline `[A, H, B, C]`, filtered rows `[A, B, C]`, dragging C before A saves `[C, H, A, B]`.

Use all filtered IDs for the merge, even if only the first rendered chunk is draggable. The drag engine measures rendered rows and produces the source/anchor insertion; the persistence layer applies that insertion to the complete filtered order.

The drag session key includes company/member scope, controller drag version, raw and debounced search, view and filter values, ordered IDs, filtered IDs, and rendered IDs. Relevant changes cancel an active drag. Shared geometry handling also cancels resize-invalidated sessions.

### Table and rail

- Replace fixed-height SOP checkbox rail rows with the shared measured rail.
- Use Tasks' outer 56-pixel gutter, inner horizontal table scroller, provider, sortable rows, and overlay placement.
- Preserve row navigation, inline title editing, drawer behavior, selection controls, and `data-row="sop"` attributes. Only the grip starts dragging.
- Render all five remaining headers using the shared sortable header.
- Remove the Type header and body cell.
- Put Created At before Updated in both header and body.
- Change skeleton, empty, and add-row `colSpan` from six to five.
- Keep `ScopePill` and `Layers` usages needed by dialogs and details; remove only imports that become genuinely unused.

## 8. Implementation sequence

1. Extract shared controller, vector, header, and drag primitives; keep Tasks behavior passing.
2. Add SOP sort types, comparator, and custom restoration.
3. Add preference validators, schema, query, and mutations.
4. Add paginated ordering rows and filter metadata.
5. Integrate SOP state, columns, shared drag UI, and progressive rendering.
6. Complete automated and browser verification.

Every changed line should support SOP sorting or the necessary shared extraction. Do not redesign unrelated task ordering, permissions, SOP content, or scope management.

## 9. Verification

### Automated coverage

Use existing Vitest and Convex fixtures and public seams. Add focused examples for distinct behaviors rather than mirroring implementation branches.

- `src/lib/sop-list-order.test.ts`: numeric codes, full target-name sorting across scope types, timestamp directions, missing values, deterministic ties, and new/deleted-row custom restoration.
- Shared vector tests: filtered dragging retains hidden slots, including a drag starting from field sorting.
- Existing controller tests: preserve rapid-move coalescing, conflicts, rollback, lost acknowledgement, and unmount protection; add SOP sort/message coverage.
- Existing drag helper tests: preserve geometry and insertion behavior through extraction.
- `convex/sopListPreferences.test.ts`: lazy defaults, persistence, preservation across field sorting, member/company isolation, read-only member ordering, revision conflicts, duplicate/oversized vectors, and inaccessible or deleted SOP rejection.
- Existing SOP hardening tests: new endpoint respects self-view denial and managed-scope boundaries.
- Pagination/filter tests: more than 200 SOPs, empty authorized pages with continuation, content search, department-to-branch filtering, and My-view semantics.
- Verify preference mutations leave SOP timestamps and content unchanged.

Keep expected orders explicit and independent of the comparator implementation. Existing backend references include `convex/taskListPreferences.test.ts`, `convex/sopsHardening.test.ts`, and SOP cases in `convex/productionFixes.test.ts`.

### Browser acceptance

- Five sortable columns are in the required order; Type is absent and Updated is final.
- Initial directions and subsequent toggles are correct, including default Created At indication.
- Pointer, touch, and keyboard dragging match Tasks.
- Dragging from field sorting enters custom mode without losing filtered-out rows.
- Reloads retain preferences; another member has independent preferences.
- Conflicting session updates cancel stale work and report errors.
- Switching company during a pending save cannot leak state.
- Selection, inline editing, row navigation, horizontal scrolling, and overlays work.
- Loading and over-limit lists cannot submit incomplete manual orders.
- Progressive rendering does not change the persisted full-list result.
- Tasks and JD Tasks remain unchanged after shared extraction.

### Commands

Install dependencies using the lockfile if needed. Regenerate Convex types using the repository workflow after backend additions; do not hand-edit generated files. Run the narrow relevant tests while iterating. Before completion, run:

```sh
npm test
npm run typecheck
npm run lint
npm run audit:authz
npm run build
```

Repository-wide checks are appropriate because shared primitives affect both Tasks and SOPs. Resolve failures attributable to the change and report unrelated existing failures separately.

## 10. Rollout and completion criteria

The schema change is additive and preferences initialize lazily. Deploy backend additions before the frontend that calls them, using the project's deployment authorization workflow. No existing SOP data needs conversion. Preserve deployed Tasks legacy compatibility.

The work is complete when all five requested sorts and personal drag ordering persist correctly, filtered moves preserve hidden rows, authorization and concurrent-session behavior are verified, the SOP column changes are correct, and Tasks remains behaviorally consistent after extraction.
