# Add Quarterly Frequency

## Goal
Add a `"quarterly"` recurrence (every 3 months, calendar quarters starting Jan 1 / Apr 1 / Jul 1 / Oct 1) to JD tasks, mirroring how `"semiannually"` works today.

The recurrence value is a string union repeated in many files. Add `"quarterly"` between `"monthly"` and `"semiannually"` in **every** list below so ordering and types stay consistent. No data migration needed — it's a new literal in validators.

## Backend (`convex/`)
Read `convex/_generated/ai/guidelines.md` before editing.

- **`convex/schema.ts` (~line 6)**: add `v.literal("quarterly")` to `rec`.
- **`convex/taskCycles.ts`**: add `"quarterly"` to `jdRecurrences`; add a switch case in each of:
  - `nextJdCycleStart`: `boundaryUtc(zone, localMonthAdd(parts, 3))`
  - `previousJdCycleStart`: `localMonthAdd(parts, -3)`
  - `currentJdCycle`: anchor to quarter start — `{ year: parts.year, month: Math.floor((parts.month - 1) / 3) * 3 + 1, day: 1 }` (same shape as the `"semiannually"` case).
- **`convex/tasks.ts` (~17, ~20)**: add literal to `recurrenceValidator` and `jdFrequencyFilterValidator`.
- **`convex/taskImports.ts` (~13)**: add literal to `recurrenceValidator`.
- **`convex/analytics.ts` (13, 80, 631)**: extend the local `Frequency` type, `frequencyFilterValidator`, and the `makeBreakdown` label map with `quarterly: "Quarterly"`.

## Frontend (`src/`)
- **`src/lib/ai/registry.ts` (~43)**: add `"quarterly"` to the `z.enum`.
- **`src/lib/task-import/schema.ts` (~5)**: add to `frequencies`.
- **`src/lib/task-import/workbook.ts`**: add `quarterly: "Quarterly"` to `recurrenceLabels`; add aliases to `normalizeFrequency`: `quarterly`, `quarter`, `qtr`, `"every3months"`, `"everythreemonths"` → `"quarterly"`.
- **`src/components/app/task-pages.tsx` (~46, 68–71)**: extend the `Frequency` type; add `{ value: "quarterly", label: "Quarterly" }` after Monthly.
- **`src/components/app/dashboard-pages.tsx` (~39)**: add `"quarterly"` to `FrequencyFilter`.
- **`src/components/app/task-import-dialog.tsx` (~48–52)**: add `"quarterly"` to `recurrenceOptions`.

## Tests
- **`convex/jdTaskCycles.test.ts`**: follow the existing `"semiannually"` tests — `currentJdCycle("quarterly", …)` returns quarter-start boundaries (e.g., mid-May 2026 → start Apr 1, end Jul 1), plus next/previous across a quarter boundary.
- **`src/lib/task-import/workbook.test.ts`**: one assertion that `normalizeFrequency("qtr")` → `"quarterly"` alongside the existing alias tests.

## Verify
```sh
npm run typecheck
npx vitest run convex/jdTaskCycles.test.ts src/lib/task-import/workbook.test.ts
npm run lint
```
Then manually: create a JD task with Quarterly frequency, confirm it appears due in the current calendar quarter, and check the dashboard frequency filter/breakdown includes Quarterly.
