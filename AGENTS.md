# Cendro

Management workspace for tasks, SOPs, employees, and companies. Fast, collaborative operations tooling with clear ownership, real-time updates, and minimal administrative friction.

---

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```text
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Performance Above All Else

**When in doubt, do the thing that makes the app feel the fastest to use.**

This includes things like:
- Optimistic updates everywhere (task status changes, SOP edits, employee assignments, company settings reflect instantly)
- Leverage Convex real-time subscriptions — never poll, never show stale data
- Avoid waterfalls: parallel data fetching, no sequential requests that could be concurrent
- Prefetch where possible (task details, SOP content, employee profiles on hover)
- Skeleton screens over loading spinners — the UI should never feel "stuck"

## 6. Good Defaults, Minimal Friction

**Users should get value with zero configuration. Less config is best.**

This means things like:
- Onboarding does the thinking: company details in → workspace, roles, and starter workflows out. User just reviews.
- Tasks appear ready to triage or complete. Editing is optional, not required.
- SOP workflows "just work" — sensible ordering, ownership, and reminders are automatic where possible.
- The daily workflow should take under 5 minutes. If it takes longer, something is wrong.
- Getting from login to the most important open tasks should be one click (max two).

## 7. Security

**Convenient but never insecure.**

This includes things like:
- All Convex mutations/queries must verify the authenticated user owns or belongs to the company/resource they're accessing.
- Employee and company data are sensitive — never expose private fields in client responses, never log.
- Validate that users have the correct role/permissions before allowing task, SOP, employee, or company changes.
- Public-facing API routes (webhooks, callbacks) must be validated and rate-limited.
- Never trust client-submitted task IDs, SOP IDs, employee IDs, company IDs, or role names without validation.

## 8. Development-stage codebase

- This app is still in active development and has no production users. Do not optimize for backward compatibility, legacy data, or preserving old behavior unless explicitly requested.
- Be willing to recommend large, clean changes when they improve the product or codebase, even if they touch many files or change existing flows.
- Do not add data migrations, backfills, compatibility layers, dual-write paths, or transitional legacy handling. When a schema, model, or flow needs to change, update it directly to the desired clean state.
