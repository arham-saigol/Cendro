# Fix: frequency/priority pill overflow breaking the task toolbar

## Goal

The JD Tasks and One-Time Tasks pages render a row of view pills (All Tasks / My Tasks / one per
frequency or priority) on the left of a toolbar, and page actions (search, filter menu, Import /
Export, New task) on the right. When a user has tasks in many frequencies, the pills wrap onto
multiple lines, squeeze the right cluster, break the "Import / Export" and "+ New task" buttons
onto two lines each, and with more pills push the whole action cluster off its line (see reported
screenshots).

Fix so that:

- The action cluster (search icon, filter icon, Import/Export, New task) never wraps or moves.
- Toolbar height stays constant regardless of how many pills exist.
- All pills remain reachable when they don't fit.

## Decision

**Make the pill strip a single-line horizontally scrollable rail that yields space to the action
cluster, with fade edges indicating overflow.**

Why this over the alternatives:

- *Horizontal scroll rail* is the established pattern for mutually-exclusive filter/view chips
  (YouTube filter chips, Linear, Asana view bars). Pills here are view switchers, not multi-select
  filters, so a tab-strip-like rail is idiomatic.
- Fixed height means zero layout jump as a user's assigned frequencies change (pills are already
  conditional per user via `personalFilterOptions`).
- Search expanding (`width: min(240px, 46vw)` when open) simply narrows the rail; the rail scrolls
  more. Graceful degradation instead of breakage.
- Cheapest robust option: CSS-first, ~10 lines of JS for fade affordances.

Rejected alternatives:

- **Always-two-rows** (pills row + actions row): burns vertical space in the common case where
  everything fits on one line today, and can still overflow past two rows at narrow widths.
- **"More ▾" overflow dropdown**: needs ResizeObserver measurement of how many pills fit plus
  active-state handling inside the collapsed section — the most complexity for marginal gain.
- **Removing pills in favor of the existing Frequency submenu in `TaskFilterMenu`**: the pills are
  a deliberate quick-access product feature; this changes product behavior rather than fixing
  layout.

## Current structure

All three toolbars below share the same skeleton and the same CSS classes in
`src/app/globals.css:1046–1130` (`.task-view-toggle`, `.task-view-button`, `.task-search-control`):

- `src/components/app/task-pages.tsx:1394–1456` — JD Tasks (`kind="jd"`, frequency pills from
  `ownFrequencyValues`) and One-Time Tasks (`kind="one"`, priority pills from `ownPriorityValues`)
  share one `TaskList` component.
  - Outer row: `<div className="mb-3 flex flex-wrap items-center gap-2">`
  - Left: `<div className="task-view-toggle">` — currently `display:inline-flex; flex-wrap:wrap`
    (globals.css:1046–1051), so pills wrap within their own box.
  - Right: `<div className="ml-auto flex flex-1 items-center justify-end gap-2">` — has `flex-1`,
    no internal wrap; when squeezed, its buttons wrap internally / get pushed to a new outer line.
- `src/components/app/sop-pages.tsx:831` — same pattern (SOP views).
- `src/components/app/company-pages.tsx:1107` — same pattern (Members / Invitations).

## Implementation

### 1. Toolbar layout — `src/components/app/task-pages.tsx:1394–1456`

- Outer row: change to stack below `md`, single non-wrapping line at `md`+:
  `mb-3 flex flex-col items-stretch gap-2 md:flex-row md:flex-nowrap md:items-center`.
  Rationale: `flex-wrap` must go on desktop because flex wrapping decides on hypothetical widths
  before shrinking — with it, the action cluster still wraps instead of letting the rail scroll.
  On narrow (<768px) screens, stacking pills above actions is the honest layout anyway.
- Pill strip wrapper: add `min-w-0 flex-1` to the `.task-view-toggle` div so it absorbs leftover
  width, shrinks under pressure, and scrolls internally.
- Right cluster: drop `flex-1` (the rail now takes the free space), add `shrink-0`:
  `md:ml-auto flex items-center justify-end gap-2 shrink-0`. Belt-and-braces: ensure the
  Import/Export trigger button can never wrap internally (`whitespace-nowrap` on its Button in
  `src/components/app/task-import-dialog.tsx:282–306`) and same for the "New task" button.
- Mobile (<md): the right cluster becomes its own full-width, right-aligned row under the pills;
  verify nothing else needed there.

### 2. Rail behavior — `src/app/globals.css:1046–1051`

Update `.task-view-toggle`:

- `flex-wrap: nowrap`
- `overflow-x: auto`, hidden scrollbar (`scrollbar-width: none` + `::-webkit-scrollbar { display:none }`)
- `scroll-behavior: smooth`
- Small block padding (e.g., 2–4px) so pill hover backgrounds/focus rings aren't clipped by the
  scroll container; compensate visually if it shifts alignment.
- Edge fades only while scrollable in that direction: apply `mask-image` linear-gradient fades via
  `[data-scroll-start="true"]` / `[data-scroll-end="true"]` attributes (left fade when scrolled in,
  right fade when more content exists). A permanently-on mask looks broken when nothing overflows,
  so gate it.

Note: sop-pages and company-pages use the identical markup/classes, so this CSS applies there too.
Their lists are tiny (2 pills max) and will simply never scroll — verify they render unchanged,
and give them the same wrapper class treatment for consistency (one shared pattern, no divergent
copies).

### 3. Fade + active-pill affordance JS — `task-pages.tsx`

- Small `onScroll` handler (~10 lines) on the toggle container sets `data-scroll-start` /
  `data-scroll-end`; also run once on mount and when `ownFrequencyValues` / `ownPriorityValues`
  length changes (pill set is data-driven). Keep it inline-local; no new dependency.
- When `personalFrequencyView` / `personalPriorityView` changes programmatically (e.g., the
  self-heal reset back to "all" at task-pages.tsx:1212–1218), scroll the active pill into view:
  `useEffect` → query `[data-active="true"]` inside the container →
  `el.scrollIntoView({ block: "nearest", inline: "nearest" })`. Keyboard focus already does this
  natively in scroll containers.

### 4. No backend changes

Pills are already driven by `convex/tasks.ts:210–230` (`personalFilterOptions`) and filtered to
frequencies/priorities the user actually has. Nothing to change server-side.

## Verification

- `npm run lint`, `npm run typecheck`.
- Manual pass (dev server), seeded user with tasks in all 7 JD frequencies → 9 pills:
  - At full pane width (~1120px list pane per `detail-drawer-layout.tsx:30`): all pills visible,
    single line, actions pinned right — matches current good state.
  - Progressively narrow viewport: pills get cut at the rail edge with a right fade; Import/Export
    and New task stay intact on one line; scrolling the rail (wheel/trackpad/drag scrollbar-free)
    reveals remaining pills with a left fade appearing.
  - Open search (expands to 240px): rail narrows further, still scrolls, actions unmoved.
  - Clicking a frequency pill partially cut by the edge scrolls it fully into view and activates.
  - One-Time page: same behavior with priority pills.
  - People page (company-pages) and SOP pages: visually unchanged.
  - <768px: pills row stacked above actions row, both usable.
