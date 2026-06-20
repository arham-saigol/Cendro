# Codebase Review Report

## 1. Summary of Findings

The codebase is small and cohesive, and basic static checks passed (`npx tsc --noEmit --incremental false`, `npm run lint -- --no-cache`). The highest-impact issues are around permission semantics, invitation/email reliability, and incomplete features that are modeled but not implemented. Several Convex queries also rely on unbounded `collect()` calls and N+1 enrichment patterns that will become unreliable as company data grows.

## 2. Detailed Issues

### Bugs and broken behavior

#### Multi-assignee tasks can block assignees from completing their own work
- **Severity:** High
- **Location or reference:** `convex/permissions.ts:12`, used by `convex/tasks.ts:32` and `convex/tasks.ts:37`
- **Evidence from the code:** `assertCanUpdateTask` only allows `update:self` when `assignees.every(id => id === m._id)`. Task visibility uses `some(...)`, so a user can see a task assigned to them plus others but fail completion.
- **Impact:** Employees or managers with self-update permissions cannot complete/comment-adjacent workflows for shared tasks they are assigned to.
- **Suggested fix:** For completion, allow self-update when `assignees.includes(m._id)`. If full task editing needs stricter rules, split completion permissions from broader update permissions.

#### Self-assignment UI and backend permission checks disagree
- **Severity:** Medium
- **Location or reference:** `convex/tasks.ts:39-56`, `convex/permissions.ts:11`
- **Evidence from the code:** `assignableUsers` returns the current membership in the fallback branch when the user has create permission but no assign permission. `assertCanAssign` has no equivalent self-assignment fallback and throws unless `assign:any` or `assign:managed` is present.
- **Impact:** A user granted task creation without assignment capabilities can see themselves as assignable but task creation fails.
- **Suggested fix:** Either require an assignment capability for task creation, or explicitly allow self-assignment in `assertCanAssign` when all assignees are the current membership.

#### Invitation sending can silently fail while the app reports success
- **Severity:** High
- **Location or reference:** `convex/email.ts:3`, `convex/platform.ts:55-61`, `convex/companyManagement.ts:94`
- **Evidence from the code:** `sendInvitation` returns `{ skipped: true }` when `RESEND_API_KEY` or `RESEND_FROM` is missing. Callers ignore this result and still return success.
- **Impact:** Admins can create companies or invite users and believe email was sent when no invitation email was delivered.
- **Suggested fix:** Treat missing email configuration as an actionable error, or return the invite link/status to the UI. Record `sentAt` only after successful email delivery.

### Reliability and edge cases

#### Core list/detail queries are unbounded and N+1 heavy
- **Severity:** High
- **Location or reference:** `convex/tasks.ts:29-35,59`, `convex/sops.ts:15,20`, `convex/analytics.ts:10-16`, `convex/companyManagement.ts:28-40`, `convex/platform.ts:24-27`
- **Evidence from the code:** Many functions call `.collect()` for entire company tables, then filter/enrich in memory. Task listing also calls `jdState` and `enrich` per task, each doing additional reads.
- **Impact:** Large companies can hit Convex function limits, slow subscriptions, and excessive recomputation/read amplification.
- **Suggested fix:** Add pagination and bounded `.take()` limits for lists, denormalize lightweight display fields where appropriate, and use indexes that match common filters.

#### Public mutations accept malformed or blank operational data
- **Severity:** Medium
- **Location or reference:** `convex/companyManagement.ts:45,47,92`, `convex/sops.ts:17-18`, `convex/tasks.ts:38`, `convex/platform.ts:35-49`
- **Evidence from the code:** Branch/department/SOP titles are trimmed before insert but not checked for emptiness in several mutations. Comments insert `args.body.trim()` without rejecting empty bodies. Invitation/company admin emails are only lowercased, not trimmed or validated.
- **Impact:** Direct API calls can create empty branch names, blank SOP titles/comments, invalid invite emails, or companies with poor data quality.
- **Suggested fix:** Add server-side validation for non-empty names/titles/bodies and valid normalized emails in every public mutation/action.

#### Manager scope and SOP scope store growing ID lists inside single documents
- **Severity:** Medium
- **Location or reference:** `convex/schema.ts:11,19`
- **Evidence from the code:** `managerScopes` stores `branchIds`, `departmentIds`, and `userMembershipIds` arrays. `sops` stores branch/department/user membership scope arrays.
- **Impact:** Large scopes can approach Convex document size limits and require full-document rewrites for small scope changes.
- **Suggested fix:** Move large scope memberships to join tables keyed by manager/SOP and target ID, or enforce small bounded limits.

### Architecture and structure

#### Permission model has capabilities that are not consistently enforced
- **Severity:** High
- **Location or reference:** `src/lib/permissions.ts:2-4`, `convex/analytics.ts:5-22`, `convex/sops.ts:17`
- **Evidence from the code:** Analytics capabilities are defined and overrideable, but `analytics.summary` only calls `requireMembership` and derives access from role/scope. `sops:create` is defined and granted to managers but SOP creation checks only `sops:manage:*` via `manageCapability`.
- **Impact:** Permission overrides can appear to grant or deny access but have no effect in important flows, making admin controls misleading and risky.
- **Suggested fix:** Audit every capability and either enforce it at the relevant query/mutation boundary or remove it from the exposed permissions list.

#### Invitation creation is exposed as a public mutation with caller-controlled provenance
- **Severity:** Medium
- **Location or reference:** `convex/companyManagement.ts:92-94`
- **Evidence from the code:** `createInvitationRecord` is a public `mutation` and accepts optional `invitedBy`; authorized callers can pass an arbitrary `appUsers` ID. The action `inviteUser` already performs the intended flow.
- **Impact:** Invitation audit/provenance data can be spoofed by any user with invite permission.
- **Suggested fix:** Make the record-creation function internal, derive `invitedBy` from authenticated identity inside the mutation, and expose only the action/API intended for clients.

### Over-engineering and simplification

#### SOP embedding pipeline is built but search does not use embeddings
- **Severity:** Medium
- **Location or reference:** `convex/schema.ts:20`, `convex/sops.ts:20,23-24`, `src/app/api/ai/chat/route.ts:36`
- **Evidence from the code:** SOP embeddings are stored by `indexSop`, but `searchAccessible` performs plain lowercase substring matching over collected SOPs and the AI tool calls that query.
- **Impact:** The app pays complexity and external API cost for embeddings without improving user-visible search.
- **Suggested fix:** Either remove the embedding path until semantic search is implemented, or add a real vector-search flow with clear fallback behavior.

### Incomplete work and TODOs

#### Attachments and AI chat persistence are modeled but not implemented
- **Severity:** Low
- **Location or reference:** `convex/schema.ts:18,22-23`, `src/components/app/task-pages.tsx:109-110`
- **Evidence from the code:** `taskAttachments`, `aiChatSessions`, and `aiChatMessages` tables exist, and the UI says “Attachment metadata is modeled in Convex; connect storage upload when a storage provider is selected.” No upload, attachment mutation, or chat persistence functions are present.
- **Impact:** Users see a feature foundation but cannot use attachments or persistent AI chat history; schema surface adds maintenance cost.
- **Suggested fix:** Either complete the missing flows or remove/hide the unused schema/UI until implementation is scheduled.

### Security, permissions, and data integrity

#### Permission overrides can lock out the last effective company admin
- **Severity:** High
- **Location or reference:** `convex/companyManagement.ts:49,80-88`, `convex/permissions.ts:7-8`
- **Evidence from the code:** `setUserRole` prevents demoting the last active Admin, but `setPermissionOverride` can insert a `deny` for `company:manage_permissions` on any membership, including the only Admin. Capability checks honor deny overrides.
- **Impact:** A company can be left with no user able to manage permissions, users, or company management UI access.
- **Suggested fix:** Before applying permission overrides, ensure at least one active membership will retain `company:manage_permissions`. Consider preventing self-denial of the last admin-management path.

## 3. Risks If Left Unaddressed

1. Assigned users may be unable to complete shared tasks, undermining a core task workflow.
2. Admins may unknowingly create invitations that are never emailed.
3. Permission overrides may mislead admins or lock companies out of management.
4. Larger companies may hit Convex read/function limits due to unbounded queries and N+1 reads.
5. Incomplete schema/features will continue to add maintenance burden and confuse product expectations.

## 4. Suggested Fixes and Improvements

- Write targeted tests for task permission edge cases, especially multi-assignee completion and self-assignment.
- Normalize and validate all public mutation inputs server-side.
- Make invitation record creation internal and make email delivery status visible to callers.
- Audit capabilities end-to-end: enforce, rename, or remove unused permissions.
- Replace unbounded list queries with pagination/bounded reads and reduce per-row database lookups.
- Decide whether embeddings, attachments, and AI chat persistence are immediate features or should be removed until needed.

## 5. Prioritized Roadmap

### Immediate fixes
- Fix `assertCanUpdateTask` for multi-assignee self completion.
- Surface or fail invitation email delivery when Resend is not configured or sending fails.
- Prevent permission overrides from removing the last effective `company:manage_permissions` holder.

### Next fixes
- Add server-side validation for branch/department/SOP/comment/company/invitation inputs.
- Resolve capability enforcement gaps in analytics and SOP creation.
- Make invitation record creation internal and derive `invitedBy` server-side.

### Later cleanup
- Paginate and optimize high-cardinality Convex queries.
- Replace large scope arrays with join tables or bounded limits.
- Remove or finish unused embeddings, attachments, and AI chat persistence foundations.
