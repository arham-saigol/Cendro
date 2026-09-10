# Task drag-and-drop: review and implementation plan

Status: implementation plan only. Reviewed against commit `1e3f422` on 2026-09-09.
No application code, backend data, or UI was changed during this review.

## 1. Scope and non-negotiable behavior

Make JD and one-time task reordering reliable without redesigning either screen.

- Keep the existing grip, checkbox, spacing, table columns, selection styling, and drag preview appearance.
- Keep the handle beside the checkbox in the external gutter, not in a new table column.
- On a fine pointer, unchecked row controls appear on hover and disappear when hover ends. Pointer drops must not leave controls visible through incidental focus.
- Preserve keyboard-visible focus, checked-checkbox visibility, and usable controls on touch devices. These are necessary exceptions to literal hover-only visibility.
- A completed drag resolves immediately to the sensible position indicated by the preview, including between rows and just above/below the list. No dwell at the destination.
- Cancel and genuine no-op drops do not change sort mode or write preferences.
- Reorder one task, not the checked selection. Retain selection and side-peek identity by task ID.
- Ordering stays personal to `(companyId, membershipId, taskType)`.

This plan supersedes the incompatible UI recommendations in root `PLAN.md`, especially its proposal to put controls in a table column and add a sort-mode menu. Do not implement those UI changes. That earlier document is historical context, not an implementation checklist for this request.

## 2. Findings

Line references below refer to the reviewed commit. Confidence distinguishes source-confirmed behavior from browser-dependent effects.

### F1. High: move and release coordinates can be stale

**Locations:** `src/components/app/task-pages.tsx:2014`, `:2031`.

The move handler projects `event.operation.position.current.y`. In the installed dnd-kit 0.5.0, `DragActions.move` dispatches `dragmove` **before** updating `position.current` in a microtask. The incoming coordinates are in `event.to`, or represented by `event.by`. Consequently the current preview reads the previous processed position, not the movement being handled.

There is a separate release race. `PointerSensor.handlePointerMove` schedules a move, but `handlePointerUp` calls `actions.stop` without flushing that scheduled movement or copying pointer-up coordinates into the operation. The task handler's comment that `position.current` is accurate at drag end is therefore not a valid guarantee. A quick move/release can be interpreted at an earlier slot, including the original slot, and return without saving.

This is a source-confirmed integration defect consistent with quick-release failures. Its frequency and the reported half-second experience require browser reproduction. There is no configured half-second destination dwell: the library's 500 ms value is accessibility announcement debouncing, mouse activation on a registered handle has no delay, and touch activation delay is a separate concern.

### F2. High: the previewed order is not the order being persisted

**Locations:** `src/components/app/task-pages.tsx:1919`, `:2058`; `src/lib/task-list-order.ts:184`, `:236`; `convex/tasks.ts:660`.

Drag end builds an entire desired order from the displayed snapshot. Saving then derives keys from an older Custom/default baseline and usually patches only the dragged task's key. Switching to Custom does not save the displayed baseline. A field-sorted sequence and these keys need not agree.

Executed against the actual helper implementations:

```text
Default baseline:                  A B C D
Displayed field order:             D C B A
Move A to C's slot, desired:       D A C B
Result: "The custom task order keys are not ordered."

Same baseline/display, move A top:
Desired:                          A D C B
Restored after the saved key:      B A C D
```

This causes failed saves or incorrect placement independently of pointer accuracy. Increasing drop tolerance cannot fix it.

### F3. High: implicit ranks are unstable as tasks change

**Locations:** `src/lib/task-list-order.ts:165`, `:184`, `:314`; `convex/tasks.ts:464`, `:522`.

Tasks without explicit keys receive keys from their current index in the restored/default sequence. Newly created tasks, deletions, or edits to default-sort fields can change those keys. Existing explicit keys are not rebased with them. Even Custom order can move untouched tasks.

Executed example: with default `A B C D` and C explicitly placed between A/B, Custom is `A C B D`. Adding a new default-first task produces `N C A B D`, moving C ahead of A without a reorder action.

Also, row queries return saved keys only while the subscribed sort is Custom. After a field sort, the client cannot reliably reconstruct previously keyed Custom order for another move. The vector and per-task-key representations currently act as competing authorities.

### F4. Medium: successful pointer drops explicitly focus the handle

**Locations:** `src/components/app/task-pages.tsx:1870`, `:1972`; `src/app/globals.css:331`.

Every successful save schedules `handle.focus()`, regardless of input modality or whether the user has since focused something else. The rail's `:focus-within` rule reveals both controls. This directly explains controls that disappear only after clicking elsewhere and can also steal focus after a slow response.

The installed library already restores focus for keyboard operations only. Preserve that distinction. Changing only the focus call is insufficient if ordinary pointer focus still activates the broad `:focus-within` selector.

### F5. Medium: drop geometry, visual feedback, and library targets disagree

**Locations:** `src/components/app/task-pages.tsx:148`, `:777`, `:2003`, `:2228`, `:2414`; `src/app/globals.css:286`, `:341`, `:382`, `:586`.

- Task sortables disable `OptimisticSortingPlugin`, while keeping the default feedback, sortable keyboard plugin, collision detection, and sortable transitions.
- The custom preview transforms rows and a separately laid-out rail. The library detects collisions against row geometry that those transforms affect.
- Projection assumes a uniform 41 px pitch. Native table cell `height` is not a maximum: content, the 41 px inner title cell, borders, zoom, and other controls can affect actual row height. Rail rows and table rows are separate layout systems. Exact drift is not yet browser-measured.
- Projection considers only Y, so a drag far into unrelated horizontal UI can still reorder the list.
- The current code already clamps above/below the list and allows `target === null`. It is inaccurate to diagnose the current version as merely requiring a row collision.
- Default dnd-kit feedback moves the live source element into fixed/popover feedback and inserts a placeholder. Disabling the optimistic sorting plugin does not disable that mechanism. Its table measurement, placeholder ownership, and drop-animation interaction with React need an explicit integration test; a DOM/React failure has not been reproduced in this audit.
- Projection, React preview state, and collision-target fallbacks are three possible answers at release. Geometry-unavailable cases can commit a different answer from the last meaningful preview.

The fixed-pitch layout is a maintenance risk, and the split ownership is unnecessarily difficult to reason about. Do not just turn the sorting plugin back on: it would move table rows without moving the external React-owned rail.

### F6. Medium: drag snapshots are not actually stable

**Locations:** `src/components/app/task-pages.tsx:1578`, `:1627`, `:1660`, `:1690`, `:1984`.

The snapshot captures IDs, but rendering resolves those IDs through the *current filtered* result. Changing filters or a task's matching attributes during a drag can remove rows and shift indexes. The reveal observer can add mounted rows during the operation. Source deletion only clears the snapshot, not the library operation or preview.

The snapshot does not capture a preference revision or view identity. A same-user reorder in another tab can arrive during dragging; the final move uses the old order with the newer revision and can overwrite that order without triggering the expected-revision conflict.

Scope protection compares a scope string only. A late response from an earlier visit can match after A -> B -> A navigation. Use an operation/generation identity, not just equality of current company/type/membership.

### F7. Medium: filtered moves disagree with the existing tested contract

**Locations:** `src/components/app/task-pages.tsx:2059`; `src/lib/task-list-order.ts:354`; `src/lib/task-list-order.test.ts:108`.

The helper/test contract preserves the slots of nonmatching rows, but the actual drop handler moves one ID through the whole list and never calls `mergeFilteredTaskListOrder`.

```text
Full:             A X B Y C
Visible:          A B C
Move C before A:
Current handler:  C A X B Y
Tested contract:  C X A Y B
```

Both filter to `C A B`, concealing the difference until filters are cleared. Adopt the existing documented/tested slot-preserving contract unless product explicitly chooses otherwise; do not leave a test proving an unused behavior.

### F8. Medium: persistence locks, reconciliation, and capacity can cause later friction

**Locations:** `src/components/app/task-pages.tsx:1539`, `:1597`, `:1641`, `:1933`; `convex/tasks.ts:403`, `:1248`.

- Dragging is disabled until every save finishes, tying repeat gestures to network latency.
- Optimistic key overlays clear only when the subscribed key exactly matches. A newer remote key, deletion, or leaving Custom mode can leave an overlay lingering; the overlays are not revision-tagged.
- Error rollback restores captured optimistic state rather than necessarily showing the latest authoritative result.
- Every single-key move reads up to 2,001 order-entry documents. Deleted tasks' entries are never removed by either purge path. The 2,000-entry check therefore counts historical entries and can eventually reject a small current list.
- The UI loads all authorized rows before it becomes ready, then disables custom ordering above 2,000. This is an existing bounded-product assumption, not proof of scalable end-to-end operation. All enriched pages still cost reads and subscriptions.
- Rebalance submits potentially 2,000 concurrent writes through `Promise.all`; the official current limit is 1,000 concurrent IO operations. This path needs removal or bounded execution, not just key-length tests.

### F9. Coverage gap

The focused suite passed: 12 tests across `task-list-order.test.ts` and `taskListPreferences.test.ts`.
It does not exercise the actual drag handlers, pointer coordinates, hover/focus cleanup, browser geometry, field-sort-to-drag persistence, or the ordinary single-key move authorization/conflict path. Most persistence tests call `saveListOrder`, which the current task UI does not use.

No production interaction or exact timing was reproduced. The collaborative browser's status and open calls both reported no automation host, and this checkout has no configured app credentials.

## 3. What to reuse from Hierarchy

**Reference:** `src/components/app/company-pages.tsx:534`, `:596`, `:671`, `:757`; `convex/companyManagement.ts:239`, `:256`.

Hierarchy uses the same installed dnd-kit 0.5.0 family:

| Concern | Hierarchy | Tasks today |
| --- | --- | --- |
| Handle | Direct `handleRef` within item | Sibling rail joined with callback-ref maps |
| Sorting | Default optimistic sorting plugin | Plugin disabled, custom pixel projection |
| Drop result | Source `initialIndex/index` and group | Geometry, preview, then target fallbacks |
| Persistence | Explicit ordered IDs | Desired vector reduced to sparse key updates |
| Realtime | Local arrays, suppress reseed during drag | Partial ID freeze over changing filters |

Hierarchy's plugin updates the source index as the item moves. Release commits that index without requiring a precise final target for branch reordering. This is an important explanation for its forgiving behavior, not evidence that it uses a custom nearest-center detector. Its actual default detector is pointer intersection with shape-intersection fallback.

Reuse handle-only sensors, keyboard support, scoped IDs, a stable active-drag sequence, immediate local feedback, and one final explicit ordered result. Do not copy hierarchy's nested-group zones or shared company-order permissions into personal task ordering.

Do not treat hierarchy as a complete production architecture: its captured-array rollback and effect that skips realtime reseeding during drag can retain stale data; it also has no ordering revision and uses bounded 500-item backend scans. Record those as separate hierarchy follow-up work, not changes in this task.

## 4. Chosen interaction architecture

Keep dnd-kit and the external rail. Use its supported **application-controlled sorting** path, with one task-specific drag controller and a `DragOverlay` that looks like the existing dragged row.

Do not re-enable DOM optimistic sorting while the sortable row and rail have separate owners. Do not migrate to legacy `@dnd-kit/core`, introduce a second drag library, rewrite the table, or add a generic drag framework.

The task-specific boundary should own only:

1. An immutable drag session and its current ID-based insertion intent.
2. A measured row-layout snapshot shared by preview and the gutter.
3. The adapter between dnd-kit events and that intent.
4. Finish/cancel cleanup and the call to save the resulting order.

Keep ordering/filter semantics in `src/lib/task-list-order.ts`; keep persistence separate from drag mechanics. Suggested extraction: `src/components/app/task-list-dnd.tsx` plus a small pure `src/lib/task-list-drag.ts` only if the resolver needs its own testable module. Do not move unrelated dialogs/editors out of `task-pages.tsx`.

### 4.1 Establish correct geometry without changing appearance

Add stable `data-task-id` attributes to real rows. Use their actual layout to position the external controls, not independent `h-[41px]` accumulation.

- Measure mounted row offsets/heights relative to a stable list wrapper and the header's actual height, excluding the add-task row, placeholders, and overlay.
- At rest, align rail controls from these row metrics. Batch layout reads; remeasure on relevant table size/content changes with a shared observer. Scroll offsets should be handled at the wrapper level rather than reading every row each pointer frame.
- Capture baseline row metrics before drag feedback transforms. Never measure transformed preview rectangles as the next baseline.
- Freeze mounted IDs while dragging. Translate baseline metrics by scroll deltas. A structural resize invalidates the session and cancels cleanly; do not commit against obsolete geometry.
- Compute preview translations from measured source/target offsets and heights. Apply the same logical permutation to table rows and rail controls. Preserve the existing moving-gap appearance.
- Give the source one valid, noninteractive overlay with measured column widths and proper `<table><tbody><tr>` markup. Do not mount duplicate editors, checkboxes, subscriptions, IDs, or sortable hooks in it.
- Keep the source's layout slot stable during dragging; avoid a second hand-made placeholder competing with the library.
- Disable overlapping sortable transition ownership where custom preview translations are used. Use one animation path per element and respect reduced motion.
- Commit the React order before the library settles its drop animation, so feedback ends at the final source position, not its old placeholder.

This measured adapter is justified by the explicit external-rail requirement. It should replace fixed offsets and duplicated layout assumptions, not grow into a virtual-table engine.

### 4.2 One forgiving insertion policy

Use one pure resolver for pointer preview and pointer release. Inputs: source ID, frozen mounted IDs, baseline row bounds, current scroll offset, and current pointer position. Output: a valid `{beforeId}`/`{afterId}` insertion intent or no-op/cancel, never a stale numeric index.

Define the policy explicitly:

- The drop envelope is the visible table plus external rail. Extend horizontally by 12 CSS px and vertically by one measured edge-row height at top/bottom, without treating unrelated toolbar/sidebar controls as valid drop areas.
- Above the first row within this envelope means before the first task. Below the last mounted row means after that task. It does not mean after unmounted tasks.
- All row space and inter-row gaps are valid. Choose the nearest insertion position using actual row centers and deterministic midpoint ties. Account for removing the source before computing the insertion index.
- Return an ID intent, convert it to an order, and compare orders for no-op detection. Do not equate "pointer is in source's old floor-divided slot" with no-op.
- Outside the envelope, show no valid preview and cancel on release. Do not keep a sticky target when the user deliberately leaves the list.
- No hover dwell, debounce, or timer determines whether a destination is accepted.

First use the library's nearest-target facilities where they fit (`collisionDetector`, measured `targetRef`, `closestCenter`/`pointerDistance`). The narrow list-envelope and before/after policy is application-specific. If a custom detector adapter is needed, it must call the same resolver, not maintain a second ranking algorithm. Verify the installed exports/types; add a direct `@dnd-kit/collision` dependency only if importing it directly.

For events:

- On pointer move, use `event.to` where present; for relative movement use current position plus `event.by`. Do not read the pre-move snapshot as the incoming position.
- On pointer drop, derive the final client coordinates from the native pointer-up event when available, normalized into the same coordinate space as measurements. Do not depend on a scheduled move having run.
- Keep the latest session/intent in refs, mirrored to React only for visuals. Transition scheduling must not decide whether a drop exists.
- Explicit cancel always wins. Validate source identity, task type, scope, and session generation; a missing row collision is not itself cancellation.
- Geometry unavailable means cancel, not "try preview, then collision, then another answer." This removes ambiguous successful writes.

### 4.3 Keyboard, touch, focus, and cleanup

Retain the library's pointer/keyboard sensors. Keyboard movement is item-based through its sortable target events, not synthetic pointer-up logic. Convert keyboard target changes into the same ID insertion intent; exercise repeated arrows and both directions with optimistic sorting disabled.

- Keep pickup/drop/cancel announcements meaningful; use accessible task references/titles and position counts through the library's supported accessibility configuration.
- Remove focus calls from asynchronous persistence completion.
- Rely on the library's keyboard-only restoration after drop/cancel, adding an application fallback only if the external handle requires it and the same session is still current.
- Fine-pointer visibility should use hover and `:focus-visible`, or parent `:has(:focus-visible)`, not unconditional `:focus-within`. A selected checkbox may remain visible; selection alone must not pin an unfocused grip open.
- Do not blur the whole document or suppress keyboard focus outlines. Pointer-origin incidental handle focus must not pin controls.
- Keep touch controls discoverable; verify activation delay, cancellation, and page scrolling. Do not "fix" destination lag by setting all activation delays to zero.
- Replace per-render inline handle ref callbacks with a small stable handle component or equivalent stable callback. Keep the external binding explicit and test null/unmount cleanup.
- One finish/cancel path clears session, preview, layout snapshot, pending animation callbacks, and any temporary listeners. Cancel the actual manager operation on source removal, access loss, view/scope changes, and unmount.
- A source/filter membership change invalidates the geometry snapshot; cancel rather than retaining inaccessible content. Ordinary cell-value changes that preserve IDs may render without changing order.
- Suspend reveal observers and load-more actions during a gesture. Resume immediately afterwards.

## 5. Ordering and persistence design

### 5.1 Reuse the bounded full-vector endpoint

For the current maximum of 2,000 tasks, make `taskListPreferences.customOrder` the single ordering authority and route the task UI through the existing `saveListOrder` endpoint. Retain the existing personal scope, revision compare-and-set, ID validation, and task visibility authorization.

This is a consequential but simpler correction: the system already computes the complete authorized order, already stores an ID vector, already exposes a vector mutation, and already has tests for it. Sparse rational keys currently add failure modes without eliminating full-list reads or preference-level contention.

Do not just switch the frontend mutation: old `taskListOrderEntries` would still override the new vector until their read/write behavior is retired.

Settled rules:

- Custom restores surviving IDs in saved order. New or newly visible IDs append in Default order.
- Task edits do not reorder saved Custom IDs. Deletion/access loss removes only those IDs from the visible result.
- Unfiltered field/default -> drag saves the entire displayed order with the move applied.
- Filtered drag uses `mergeFilteredTaskListOrder`: preserve nonmatching slots, replace matching slots with the newly ordered full filtered sequence. Use restored Custom (or Default without saved Custom) as the slot baseline and the active field-sorted visible sequence as replacement input.
- Include all authorized/matching IDs, not just mounted rows. Only mounted rows can be drag targets.
- At release reconcile additions/removals by IDs and recheck source/anchor validity. Do not save an index from an old array against a new one.
- Never use stored preference IDs to bypass task visibility authorization.

### 5.2 Preserve deployed data during consolidation

Before backend implementation, read the Convex expert and migration skills and the repository's generated guidelines. Confirm whether the rank-entry format is deployed; do not assume recent code means no saved data.

Use a finite compatibility rollout if entries exist:

1. Introduce an explicit canonical-format marker on preferences. Absence means the existing vector-plus-keys format; presence means vector-only.
2. While legacy preferences remain, make their keys available independently of active sort mode so the client can reconstruct the saved Custom sequence from the complete authorized dataset. Do not silently lose old Custom when currently field-sorted.
3. On the next explicit reorder, the new frontend sends the complete desired vector. The mutation validates it, sets canonical format, writes mode/order/revision atomically, and makes legacy keys irrelevant immediately.
4. For old clients, the old key mutation must refuse writes to canonical preferences with a reload-required error, or be retired once active old-client lifetime is accounted for. It must never silently reintroduce keys after conversion.
5. Preserve untouched legacy preferences until converted by a bounded migration or an explicit user operation. Do not run writes from queries or overwrite a stored order with Default.
6. Clean obsolete entries in bounded internal batches, with a canonical-marker check so cleanup cannot delete an active legacy order. Remove legacy queries, key helpers, schema, and compatibility code in a follow-up deployment after conversion is verified.

If there is provably no deployed data/client compatibility requirement, remove the rank path directly instead of introducing a marker and migration machinery.

Canonical reads no longer perform per-task key lookups. Canonical moves no longer scan historical entries or fan out rank writes. Stale vector IDs can be ignored on read and pruned on the next save; task deletion does not require cross-user synchronous cleanup.

### 5.3 Revisioned local state and rapid repeated moves

Use one scoped, revision-aware order overlay instead of separate preference/key overlays. The optimistic order must be exactly the vector submitted to the server.

- Capture drag-start base revision and a mount/scope generation token.
- If an external order revision arrives during a gesture, cancel that gesture and reconcile rather than committing the old snapshot with the new revision.
- Distinguish a known acknowledgement of this client's in-flight write from an external revision; the former need not cancel a later gesture based on its optimistic result.
- Settle locally on release without waiting for a network response.
- Allow the next gesture once local drop animation settles. Keep at most one persistence write in flight and one coalesced latest desired vector per scope. This is a small persistence coordinator, not an offline command queue.
- After an acknowledgement, send the latest queued vector with the acknowledged revision if it still differs. Header sort mutations use the same serialization boundary; keeping those buttons disabled while saving is acceptable.
- On rejection/conflict, cancel any dependent active gesture, discard queued/optimistic state, show the latest subscribed order and the existing inline error. Do not automatically replay stale intent over someone else's order.
- Compare identical already-persisted state before presenting a retry/ambiguous acknowledgement as failure. Rely on Convex's normal transport retry behavior; do not add blind mutation retries.
- Ignore completions from obsolete generations, including A -> B -> A navigation. Cancel queued work on unmount/scope change; already-sent server work may finish but cannot change another screen.

### 5.4 Capacity and authorization release gate

Keep 2,000 as the existing reviewed capacity until product requirements and measurements say otherwise. Do not silently truncate or increase it to hide a failing test. Above the limit, preserve existing non-drag task functions and expose the reason through the existing affordance's accessible description/tooltip rather than a redesigned screen.

Measure full-list loading and vector-save authorization at 200, 1,000, and 2,000 tasks, including long descriptions, multiple assignees, and managed visibility. A vector fits the 1 MiB document/8,192-element limits, but validating task documents can still hit transaction byte/query limits. The current official limits include 16 MiB read, 4,096 index ranges, and 1,000 concurrent IO operations.

If the authorized bounded vector cannot fit with headroom, stop this storage change before rollout and design a lightweight authorization/order projection. Do not split one logical order publication across non-atomic writes or weaken visibility checks to force it through. Unlimited/server-paginated ordering is a separate product-scale design, not a hidden addition to this fix.

## 6. Implementation sequence and acceptance gates

### Step 1: failing evidence first

Add focused helper regressions for the two field-sort examples, stable Custom after insertion/deletion/edit, and the filtered public behavior. Exercise the actual vector submitted by the task adapter, not an otherwise unused helper.

Add a narrow real-browser harness because the current edge-runtime suite cannot prove drag physics. Use disposable development fixtures and development auth, never production task mutations. Start with fast release at the top and pointer-focus cleanup using the current implementation.

Gate: capture failures with coordinates, IDs, intended/result order, and whether any mutation was sent. Distinguish a no-op, canceled drag, rejected save, and incorrect successful save.

### Step 2: correct and consolidate persistence

Implement section 5 using `convex/tasks.ts`, `convex/taskListPreferences.ts`, `convex/schema.ts` as required for compatibility, `src/lib/task-list-order.ts`, and the TaskList save adapter. Preserve existing authorization helpers and personal scope.

Gate: reload produces exactly the saved vector; field-sort -> drag preserves unaffected order; new tasks do not move saved tasks; two stale-revision writes cannot overwrite each other.

### Step 3: isolate drag lifecycle and focus

Extract the task-specific controller, stable handle binding, generation/ref session state, explicit cancellation, and modality-correct focus rules. Freeze rendered IDs and prevent changes in view or layout from being interpreted as movement.

Gate: success, failure, no-op, Escape, pointer cancellation, filter change, source deletion, and scope switch all return to a clean state without a second click. No async completion steals focus.

### Step 4: unify geometry, preview, and drop

Implement measured rail alignment, the shared ID resolver, correct incoming/final event coordinates, explicit drop envelope, and overlay/animation ownership. Browser-test the real 0.5.0 integration before polishing transitions.

Gate: a valid fast release commits the displayed destination without a dwell. Row, rail, preview, announced destination, and saved order refer to the same task and position.

### Step 5: rapid moves, realtime, and rollout

Complete the small serialized persistence coordinator and run the browser/network/concurrency matrix below. Measure capacity before enabling the new persistence format for real users. No new telemetry service is required; test traces and existing error reporting are sufficient. Avoid logging task titles or user contents.

Gate: all original complaints pass, Hierarchy remains unchanged, and legacy orders survive conversion. Roll back UI changes only to a version that understands canonical preferences; do not roll back to an old writer that can overwrite the new format.

## 7. Tests that prove the result

### Pure and public backend tests

Extend existing tests instead of creating a parallel order harness:

- `src/lib/task-list-order.test.ts`: field/default -> Custom full-sequence preservation, actual filtered merge, stable restoration through new/deleted/edited tasks, retention beyond the first 200.
- A resolver test at its public seam: first/last tolerance, exact gaps, source removal/no-op, unequal heights, scroll offsets, and outside-envelope cancellation. Use independently specified expected ID orders.
- `convex/taskListPreferences.test.ts`: save/reload, per-user/company/type isolation, wrong-type/foreign/invisible IDs, visible read-only member, stale revision and unchanged state, capacity rejection.
- If legacy data exists: conversion from keys while Custom and while field-sorted, canonical format ignoring old keys, old-client rejection, repeated conversion/retry, and cleanup not touching active legacy data.
- A coordinator test: two rapid desired orders, one in-flight write, newer remote revision, rejection of a dependent queued move, and late A -> B -> A response. Assert visible and persisted outcomes, not internal call ordering.

### Browser matrix

Use true pointer events (`down`, movement, immediate `up`) on the custom handle, not native HTML `dragTo` assumptions. Synchronize on activation/render readiness, but never add a sleep over the destination to make a test pass.

| Scenario | Required outcome |
| --- | --- |
| Move last to 1/8/20 px above first row | Top position on first attempt, inside the defined envelope |
| Exact border and gaps, both directions | Nearest insertion, no snap-back |
| Rail-only vertical drag | Works without pointer entering a table cell |
| Large last movement immediately followed by release | Release coordinates determine the final position |
| Return to original position | No write and no sort-mode change |
| Move outside horizontal envelope or onto toolbar | Cancel; do not reorder |
| Drop, move pointer away, wait for save | Unchecked controls hide without clicking elsewhere |
| Slow save while user focuses another control | Focus remains where the user put it |
| Keyboard Space/arrows/drop and Escape | Correct item movement, focus restored, sensible announcements |
| Several rapid moves with slow/offline-then-recovered transport | Immediate local feedback; latest desired order persists or explicit rollback |
| Wheel/autoscroll with pointer stationary, then release | Preview and final destination agree |
| Filter/view change, deletion/access loss, scope change | Safe cancellation, no stale preview or write |
| Same user in two tabs, reorder mid-drag | Conflict/cancel instead of silent overwrite |
| 200+ rows; reveal after ending gesture | Mounted target semantics and untouched later IDs retained |
| 100/125/150% zoom, tall row, horizontal scroll, side peek | Rail centered within 1 CSS px of its task; no clipping or misattributed controls |
| Touch/coarse pointer and reduced motion | Discoverable handles, normal scrolling, usable cancellation, reduced animation |
| Checkbox, selection, title/status editor, details button | No accidental drag or navigation |

Run both task types. Repeat rapid top/between/bottom gestures at least 20 times per direction without destination dwell. Include Chromium and one other engine in the automated suite; check the deployed supported browsers manually where automation cannot represent real zoom/touch.

### Commands

During implementation:

```sh
npx vitest run src/lib/task-list-order.test.ts convex/taskListPreferences.test.ts
npm run typecheck
npm run lint
```

Before release: run the full test suite, authorization audit, production build with development build configuration, and the browser suite. Include `convex/productionFixes.test.ts` for hierarchy/backend regression coverage. Run Convex codegen only when needed and only against the explicitly selected development deployment. This planning task does not authorize deployment.

## 8. Review evidence and references

Completed here:

- Read both drag flows, relevant CSS/ref ownership, recent fixes `fa3c815`/`aafaadd`, ordering helpers, both persistence formats, deletion paths, and existing tests.
- Installed exact lockfile dependencies with `npm ci --ignore-scripts --no-audit --no-fund`; lockfile unchanged.
- Checked installed `@dnd-kit/react`, `@dnd-kit/dom`, `@dnd-kit/abstract`, and collision 0.5.0 source/types rather than legacy API documentation.
- Ran focused suite: **2 files, 12 tests passed**.
- Executed independent ordering scenarios through the repository's actual helper exports; failures are recorded in F2/F3/F7.
- Browser status/open both reported no automation host. No browser timings, production behavior, migration, or maximum-size backend performance have been claimed as verified.

Official references consulted:

- [React useSortable](https://dndkit.com/react/hooks/use-sortable)
- [Sortable state management](https://dndkit.com/react/guides/sortable-state-management)
- [Optimistic sorting and controlled alternative](https://dndkit.com/concepts/sortable)
- [Droppable collision detection](https://dndkit.com/concepts/droppable)
- [DragOverlay and drop animation](https://dndkit.com/react/components/drag-overlay)
- [Convex limits](https://docs.convex.dev/production/state/limits)
- Repository Convex guidance: `convex/_generated/ai/guidelines.md`

Installed source anchors for the event conclusions: `@dnd-kit/abstract/index.js` (`DragActions.move`, `stop`), `@dnd-kit/dom/index.js` (`PointerSensor.handlePointerMove/handlePointerUp`, feedback, keyboard-only `restoreFocus`), `@dnd-kit/dom/sortable.js` (`OptimisticSortingPlugin`, `SortableKeyboardPlugin`), and `@dnd-kit/react/index.js` (transition-tracked event callbacks). Preserve these checks when changing dnd-kit versions.
