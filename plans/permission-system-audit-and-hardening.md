# Cendro permission-system audit and hardening plan

## Goal

Replace Cendro's partly role-driven, resource-specific authorization with one explicit, deny-aware permission model that is enforced at every backend entry point. The finished system must make direct Convex calls safe, prevent cross-company access and stale-authority reuse, expose only data the caller may see, and keep the frontend consistent with backend decisions.

This is a hardening pass, not a redesign of product roles. Admin, Manager, and Employee remain useful bundles of defaults. Effective capabilities, resource relationships, and current scope become the only authorization inputs after those defaults are calculated.

## Scope and non-goals

This pass covers the complete authorization surface: Convex functions and storage references, Next.js server routes, tenant and relationship integrity, roles and overrides, manager scopes, tasks, SOPs, company administration, invitations, analytics, AI, platform administration, response redaction, frontend action gates, audit trails, and regression guardrails.

It does not replace Clerk, introduce a general-purpose policy language, add user-created roles, split task editing into field-level permissions, or redesign task/SOP product workflows. Those are separate product decisions. The implementation should add only the policy structure needed by Cendro's current resources and actions.

## Decisions and rejected alternatives

- Fixing only known missing checks, such as task deletion, is rejected because shared raw-role and scope helpers would preserve bypasses in other modules.
- A role-only matrix is rejected because Cendro already supports per-member allow/deny overrides and managed scopes.
- A generic ACL engine or external authorization service is rejected. The current domain fits a typed capability catalog plus resource-specific policy helpers inside the existing transactional backend.
- Renaming all existing capabilities is rejected because it would create a needless deployed-data migration. Missing semantics are added with new names; existing names receive precise definitions.
- Keeping email as a platform-admin fallback is rejected because the fallback would preserve the vulnerable identity path indefinitely.
- Reimplementing scope rules in React is rejected. The backend returns effective global capabilities and per-resource decisions.
- A pending-upload ownership subsystem is rejected for attachments. A unique storage-object claim closes the identified cross-company reuse path with less state and fewer failure modes.
- Compatibility for pre-hardening invitation links is rejected. Their authorization snapshots are incomplete, so they fail closed and must be reissued.

## Current baseline

- `npm run typecheck` passes.
- `npm test -- --run` passes all 102 tests in 12 files.
- `npm run lint` passes with 12 existing warnings and no errors.
- Convex authentication is correctly founded on Clerk JWTs and `ctx.auth.getUserIdentity()`.
- `appUsers.clerkSubject` stores Convex's stable `tokenIdentifier`, and company access is represented by active `companyMemberships`.
- Existing tests cover several important cases, including analytics permission denies, SOP scopes, task import scope, the last permission-manager invariant, invitation application, and basic AI cross-company isolation. Coverage is fragmented rather than systematic.

## Audit findings

### Effective permission bypasses

Several paths treat the stored role as authority after permission overrides have been applied elsewhere:

- `convex/permissions.ts` gives a raw Admin every active membership in `scopedMembershipIds` and every SOP in the SOP visibility helper.
- `convex/sops.ts:getManagedScopeTargets` treats a raw Admin as unrestricted.
- `convex/analytics.ts:analyticsSummary` exposes audit events to a raw Admin even if the corresponding effective capability is denied.
- `src/components/app/task-pages.tsx` and `src/components/app/sop-pages.tsx` use raw Admin or Manager roles for all-resource views and editing controls.

A deny override therefore does not consistently deny access. A grant to a non-default role also does not consistently enable the matching UI or scope.

### Task permissions are incomplete and overloaded

- There are no task view capabilities. Lists infer visibility from creator, assignee, assignment, and update rules.
- There are no task delete capabilities. Permanent deletion currently reuses update authorization, so an Employee with `update:self` can delete an assigned task.
- Export is authorized with create permission rather than a read/export permission.
- Import uses create as its entry check even though a batch can update, reassign, and change status.
- Direct mutations, imports, and AI tools implement overlapping versions of task policy.
- Frontend row editing uses broad role or capability shortcuts instead of a decision for the actual row.

Status and notes should remain part of task update permission. Existing product tests establish that an assignee with `update:self` may update these fields; splitting every task field into a new capability would add complexity without a current product requirement.

### Scoped task reads leak related people

Managed task visibility is granted when at least one assignee is in scope, but enriched task results and exports can include all co-assignees and their email addresses. A manager can therefore discover people outside the manager's scope through a shared task. `filterableAssignees` also returns people from stored manager scopes without requiring the effective task capability that justifies the lookup.

Many task query results spread database documents, exposing internal membership IDs and fields that are not part of a deliberate client contract.

### Attachment authorization is unsafe

- `tasks:attachment:add` also permits deletion of any attachment on a visible task. Creation and destructive moderation are different actions.
- `addAttachment` validates that a storage object exists but not that it is unclaimed. A user who belongs to two companies and knows a storage ID can attach the same file record across company boundaries.

The narrow fix is to make a storage object claimable once through a `taskAttachments.by_storageId` index. A second pending-upload subsystem is not required.

### SOP capabilities conflate four decisions

`sops:manage:*` currently means some combination of visibility, creation, update, rescoping, and deletion. This makes read-only delegated access impossible, makes destructive authority implicit, and encourages raw-role shortcuts. SOP queries also spread database documents and internal scope records rather than returning explicit client data.

### Permission administration is not a defined trust boundary

`company:manage_permissions` can grant itself or another member every capability, including `company:manage_users`. That is acceptable only if the product explicitly defines this capability as the company's permission-administration trust root.

Related gaps make that root easier to bypass or disrupt:

- A caller with only `company:invite_users` can invite a Manager and thereby grant the Manager's default capabilities.
- A caller with `company:manage_users` can deactivate or remove a permission administrator when another one remains, even without permission-administration authority.
- Placement, role, scope, and override changes have inconsistent compound checks across company-management mutations.
- Security-sensitive changes are not consistently written to `auditEvents`.
- Reading audit events is controlled by a raw Admin check instead of a capability.

### Invitations preserve stale authority

Invitation acceptance can reactivate an existing membership and overwrite its role, scopes, and overrides. A pending invitation can therefore restore privileges after an administrator has deactivated, removed, or deliberately changed that user. Reissuing or editing a pending invitation can reuse the old bearer token. An already-active member can be reinvited and later accept the link to change their own access.

Acceptance checks the email claim but does not require `emailVerified`. The invitation is single-status in ordinary execution, but the intended replay and concurrent-accept behavior is not specified or tested.

### Platform administration relies on mutable email

`PLATFORM_ADMIN_EMAIL` authorizes both server pages and Convex functions through an email claim. Email is a mutable display and delivery attribute, not a stable principal ID. Platform administration should use the Clerk user ID from the JWT subject, with the configured Clerk issuer providing the identity-provider boundary.

### AI access is implicit and some scope is unrelated to the requested operation

- There is no `ai:use` capability, so every active member can consume paid AI and web-search resources.
- `aiWorkspace.peopleInScope` exposes names and emails based on stored manager scopes without requiring a task, analytics, SOP, or company-management capability that needs those identities.
- AI context labels use raw role checks in places.
- The UI tool registry prechecks operations, but only the backend calls are authoritative.
- The public chat append mutation accepts `assistant` and `tool` roles from the browser. This cannot bypass backend resource authorization today, but it lets a client forge server-generated history and weakens the integrity boundary.

### Cross-company graph integrity is repeated rather than guaranteed

Most writers correctly compare referenced branches, departments, memberships, tasks, SOPs, and companies. The checks are repeated, however, and some readers trust redundant `companyId` or relationship rows. Several relationship tables lack composite indexes for their logical uniqueness. Permission-override duplicates can be interpreted in query-order-dependent ways unless resolution is made deterministic.

### Denial behavior and client contracts are inconsistent

Some paths reveal that an out-of-company resource exists while others return not found. UI buttons are based on broad roles or global capabilities and can disagree with row-level backend policy. Backend responses often return raw documents, which makes future schema fields accidentally public.

## Target authorization contract

### Core invariants

1. Every public Convex query, mutation, action, and HTTP endpoint is an untrusted internet entry point. It must be either intentionally anonymous or classified under an authorization policy.
2. Authentication comes only from the verified Clerk JWT. Client-supplied user, membership, role, company, email, or scope values never establish identity or authority.
3. Every company operation first resolves one current authorization context: active app user, non-deleted company, active company membership, effective capabilities, and relevant current scopes.
4. Roles only supply default capabilities. After defaults and overrides are resolved, no authorization decision branches on raw role.
5. A deny override wins over an allow for the same capability. Duplicate rows cannot make the result depend on database order. Unknown capability strings never grant access.
6. Scope is evaluated for the requested action and resource. Possessing a manager-scope row alone never grants data access.
7. Every referenced document or relationship used by a write is checked against the authorized company. Readers validate relationship integrity before using it to expand access.
8. Destructive actions have explicit capabilities. Update, create, import, export, attachment add, and attachment delete do not stand in for one another.
9. Authorization is re-evaluated in the transaction that commits a mutation. A preview, UI check, or earlier action does not reserve authority.
10. Out-of-company or inaccessible resource identifiers return the same not-found result. A valid in-company resource with a disallowed action returns forbidden.
11. Backend queries return explicit DTOs. Internal IDs, emails, scope rows, and future schema fields are exposed only when part of the operation's contract.
12. At least one active member retains `company:manage_permissions`. Only a current permission administrator can grant or remove that trust-root capability or alter another permission administrator's authority.
13. Invitations convey only the authority approved in their current issuance. Later membership changes, revocation, token rotation, or one successful acceptance invalidate older links.
14. UI permission checks are usability hints. The backend remains authoritative, and the UI consumes the same effective-capability vocabulary and server-computed row decisions.

### Scope semantics

Use the same ordered scope vocabulary for tasks, SOPs, and analytics:

- `any` or `company`: every valid resource in the company.
- `managed`: resources related to the caller's current managed user, branch, or department scopes.
- `self`: resources created by, assigned to, or explicitly targeted to the caller, as defined for each resource below.

For reads, a task is visible through `managed` when at least one assignee is in the caller's managed scope. Co-assignees outside that scope are redacted unless another effective capability makes them visible. For task mutation and deletion, every resulting assignee must be authorized by the applicable assignment or update scope. An unassigned legacy task falls back to its creator for scope decisions.

For SOPs, `self` includes company-wide SOPs and SOPs explicitly targeted to the caller through user, current branch, or current department assignments. `managed` adds SOPs targeted to the caller's current managed users, branches, or departments. Updating an SOP's scope requires authority for both its current scope and its proposed scope, so rescoping cannot be used to capture or disclose an otherwise inaccessible SOP.

### Capability catalog and defaults

Keep existing capability names to avoid a deployed override migration. Add the missing capabilities below and define the existing names narrowly.

| Area | Capabilities | Admin defaults | Manager defaults | Employee defaults |
| --- | --- | --- | --- | --- |
| Analytics | Existing `view:company`, `view:managed`, `view:self` | All | Managed and self | Self |
| JD task visibility | New `tasks:jd:view:any`, `view:managed`, `view:self` | All | Managed and self | Self |
| One-time task visibility | New `tasks:one_time:view:any`, `view:managed`, `view:self` | All | Managed and self | Self |
| Task creation | Existing `tasks:{kind}:create` | Yes | Yes | No |
| Task assignment | Existing `assign:any`, `assign:managed`, `assign:self` | All | Managed and self | No |
| Task update | Existing `update:any`, `update:managed`, `update:self` | All | Managed and self | Self |
| Task deletion | New `delete:any`, `delete:managed`, `delete:self` for each kind | All | Managed and self | No |
| Task transfer | New `tasks:{kind}:import` and `tasks:{kind}:export` | Both | Both | Neither |
| Comments | Existing `tasks:comment` | Yes | Yes | Yes |
| Attachments | Existing `tasks:attachment:add`; new `delete:own` and `delete:any` | All | Add, own delete, and any delete on an otherwise updatable task | Add and own delete |
| SOP visibility | New `sops:view:company`, `view:managed`, `view:self` | All | Managed and self | Self |
| SOP creation and update | Existing `sops:create` and `sops:manage:{company,branch,department,user}` | All | Create, branch, and department | None |
| SOP deletion | New `sops:delete:{company,branch,department,user}` | All | Branch and department | None |
| Company structure | Existing settings, branches, and departments capabilities | All | None | None |
| Company people | Existing invite, manage users, and manage permissions capabilities | All | None | None |
| Audit log | New `company:view_audit_log` | Yes | No | No |
| AI | New `ai:use` | Yes | Yes | Yes |

The default `ai:use` grant preserves current behavior while making an explicit deny possible. Admin receives all scope levels so a deny of the broadest level can intentionally downgrade access to narrower levels. Scope precedence is broadest effective grant first; a deny affects only the named capability.

`tasks:{kind}:import` permits opening and parsing an import flow. Committing each row must also pass the same create, update, assignment, status/update, and visibility policies used by direct mutations. `tasks:{kind}:export` permits exporting only the tasks and related people visible through the effective view capabilities.

`sops:manage:*` will mean create or update at that target scope. It will no longer imply visibility or deletion. The additive view and delete capabilities avoid renaming existing deployed overrides.

### Company-administration rules

- `company:manage_permissions` is the explicit permission-administration trust root. A holder can set roles, manager scopes, and capability overrides, including granting that root to another user.
- `company:manage_users` manages names, active state, organization assignments, and removal for ordinary members.
- Changing or removing a member who effectively holds `company:manage_permissions` also requires `company:manage_permissions`, and the last-active-root invariant must still pass in the same transaction.
- Setting branch or department placement requires `company:manage_users`. Setting role, manager scopes, or overrides requires `company:manage_permissions`. A compound mutation must require the union of the affected authorities.
- A caller with only `company:invite_users` may invite a new Employee with the Employee defaults, ordinary placement, no manager scopes, and no overrides.
- Any invitation that selects Admin or Manager, supplies manager scopes, supplies overrides, or reactivates a membership also requires `company:manage_permissions`. Reactivation additionally requires `company:manage_users`.
- Active members cannot be reinvited to change access. Their access must be changed through audited company-management mutations.

### Invitation lifecycle

Add a versioned authorization snapshot to invitations. New or reissued links receive a fresh cryptographically random token, `issuedAt`, authorization version, target-membership ID when reactivating, and the target membership's current `updatedAt` value.

Acceptance must require:

- an authenticated user with a verified email claim;
- exact normalized email equality;
- pending status, supported authorization version, and unexpired issuance;
- no active membership for a new-member invitation;
- for reactivation, the exact inactive target membership and an unchanged `updatedAt` value;
- all referenced branches, departments, and managed targets still active and in the invitation's company;
- a transaction that marks the invitation accepted exactly once while applying membership state.

Deactivation, removal, role changes, scope changes, and override changes revoke pending invitations for that company and email. Reissuing or editing an invitation revokes the old token and creates or replaces it with a newly generated token. Pre-hardening pending invitations lack the new authorization version and must fail closed; administrators can reissue them.

### Platform-admin identity

Replace `PLATFORM_ADMIN_EMAIL` with `PLATFORM_ADMIN_CLERK_USER_IDS`, a comma-separated allowlist of stable Clerk user IDs. A pure shared parser/check accepts the environment value as input. Next.js compares Clerk's `userId`; Convex compares `identity.subject`. The configured Clerk issuer pins the identity-provider boundary. Missing or malformed configuration fails closed, duplicate values are harmless, and email is used only for display.

Do not retain email as a fallback after rollout. Document how to obtain the current Clerk user ID and stage the production environment change before deploying code that removes the old check.

## Implementation plan

### 1. Make the shared catalog the policy vocabulary

Update `src/lib/permissions.ts` to:

- add the task view, delete, import, export, attachment delete, SOP view, SOP delete, audit-log, and AI capabilities;
- keep capability values as the shared backend/frontend source of truth;
- encode and test role defaults explicitly;
- add small pure helpers for capability resolution, scope precedence, labels, and permission grouping;
- resolve duplicate allow/deny entries deterministically with deny winning;
- ignore unknown stored strings so they can never grant access, while surfacing them in an administrative data-integrity report;
- remove UI-facing helpers that infer authority from role.

Add focused unit tests in `src/lib/permissions.test.ts` for every default role, additive grants, denies, duplicate conflicts, unknown strings, and scope precedence. Expected sets should be declared independently from the implementation arrays.

### 2. Add indexes that support authorization invariants

Update `convex/schema.ts` with composite indexes for logical relationships used in authorization and idempotent writes, including:

- permission override by membership and capability;
- manager user, branch, and department scope by manager plus target;
- branch and department assignment by membership plus target;
- SOP branch, department, and user scope by SOP plus target;
- task attachment by storage ID;
- invitation by company, normalized email, and status where the current access patterns require it.

Do not narrow the persisted capability field to a literal validator during this pass. Existing unknown or duplicate data must not block deployment. New writers query all rows for a logical key, remove duplicates, and leave one canonical row. Readers remain safe before cleanup because deny wins regardless of row order.

Extend the invitation schema with optional versioned fields so schema deployment is additive. The acceptance code requires the new version, making old pending invitations unusable without a data backfill or unsafe compatibility branch.

### 3. Centralize backend authorization context and resource decisions

Refactor `convex/permissions.ts` into the narrow shared boundary for authorization:

- retain one `requireCompanyAccess` path that loads authenticated app user, live company, active membership, and effective capability set;
- provide typed, reusable loaders for a company-owned document, membership, branch, department, and relationship edge;
- provide `can` and `require` task decisions for view, create, assign, update, delete, import, export, comment, and attachment actions;
- provide `can` and `require` SOP decisions for view, create, update/current-and-next-scope, and delete;
- calculate current managed targets only after the requested effective capability justifies their use;
- make analytics scope derive only from effective capabilities;
- preserve and strengthen the last active permission-administrator assertion;
- return typed decisions that can be projected into DTO flags without duplicating policy in queries.

Delete raw-role shortcuts from authorization helpers. Role may remain in membership/admin-display DTOs and in the calculation of default capabilities only.

Use a small, consistent error API: authenticated but unauthorized in-company action is `FORBIDDEN`; missing, deleted, out-of-company, or invisible resource is `NOT_FOUND`; unauthenticated is `UNAUTHENTICATED`; invalid input is `INVALID_ARGUMENT`.

### 4. Route every task path through one policy

Update `convex/tasks.ts` so that:

- all list, get, filter-option, assignee-option, completion, comment, attachment, and AI-facing reads use explicit view policy;
- all task DTOs enumerate allowed fields and carry server-computed `canUpdate`, `canDelete`, and relevant attachment-delete flags;
- user DTOs reveal email only where the operation needs it, such as a permitted export or invitation workflow;
- co-assignees outside contextual scope are redacted from scoped reads and exports;
- direct creation, assignment, update, status, deletion, comment, and attachment mutations call the shared decision functions;
- permanent task deletion requires the new delete capability and authorizes before cascading related records;
- attachment deletion distinguishes the uploader's own attachment from moderation of another user's attachment;
- attachment creation atomically rejects a storage ID already claimed by any attachment, including another company;
- file URL generation happens only after attachment visibility is established.

Update `convex/taskImports.ts` to use import as the flow entry permission and re-authorize every row at commit using the same task helpers as direct mutations. Preview may report prospective row errors but cannot grant authority. Commit handles partial/stale previews according to the existing import contract and fails any row whose current state no longer passes.

Export should require the matching export capability and apply the same view and people-redaction rules as the task list. If the current export is generated in a frontend component, move only the authorization-sensitive selection and DTO construction to a backend query; formatting can remain client-side.

### 5. Separate SOP visibility, mutation, and deletion

Update `convex/sops.ts` so all list, get, option, search, semantic-search, AI, create, update, scope-update, and delete paths call shared SOP policy.

- Visibility comes only from `sops:view:*`.
- `sops:create` allows entering creation, while the chosen targets must also pass the applicable `sops:manage:*` capabilities.
- Update requires visibility, authority over current targets, and authority over every proposed target.
- Deletion requires the matching `sops:delete:*` capability for all current targets.
- Company-wide, branch, department, and user targets are all validated as current members/resources of the same company.
- DTOs explicitly return content, safe target summaries, and server-computed action flags rather than raw documents and edges.

Remove all raw Admin/Manager frontend gates from `src/components/app/sop-pages.tsx`. Global create/filter controls use effective capabilities; row actions use the flags returned for that SOP.

### 6. Harden company management and audit security changes

Update `convex/companyManagement.ts` so each mutation maps to the company-administration rules above. Centralize target-membership validation and revoke pending invitations when a membership security change would make an earlier invite stale.

Write an audit event in the same transaction for:

- invitation issuance, reissue, revocation, and acceptance;
- role changes;
- activation and deactivation;
- removal;
- branch and department assignment changes;
- manager scope changes;
- permission allow, deny, and reset operations;
- protected company settings changes;
- blocked attempts to remove the last permission administrator if the current audit model records denied operations safely.

Audit metadata must contain stable IDs and non-secret summaries, never invitation tokens, JWT claims, storage IDs, prompt content, or provider credentials. Add `company:view_audit_log` to the analytics/audit query and remove the raw Admin check.

Keep separate narrow mutations where they make required authority obvious. If `setUserPermissions` remains as a compound operation, derive and require the union of permissions for the fields that actually change.

### 7. Replace invitation authority snapshots safely

Update `convex/invitations.ts` and the invitation creation action in `convex/companyManagement.ts` to implement the versioned lifecycle.

- Generate a fresh token for every issuance or change.
- Store only the token form already required by the current preview/accept design; never log or include it in audit metadata.
- Require `identity.emailVerified === true` before acceptance.
- Reject invitations for an already-active member.
- Require the explicit reactivation snapshot for an inactive member.
- Validate current creator authority again when changing or reissuing an invitation.
- Consume the invitation and change membership state transactionally so concurrent accepts have one winner.
- Return the same safe error for an expired, revoked, superseded, unsupported-version, or already-consumed token.

Update `.env.example`, README/setup guidance, and Clerk JWT-template documentation to require the verified-email claim used by Convex. The frontend preview may describe an invalid link but must not disclose membership state or whether an email already belongs to the company.

### 8. Move platform administration to stable identity

Add a pure shared platform-admin identifier helper and update `convex/platform.ts` plus the platform administration page/server guard to use Clerk user IDs. Update `.env.example` and README deployment instructions.

Roll this out in this order:

1. Resolve the production platform administrator's Clerk user ID.
2. Set `PLATFORM_ADMIN_CLERK_USER_IDS` in both relevant runtime environments.
3. Verify a read-only platform access check in the target deployment.
4. Deploy code that uses only the stable ID.
5. Remove `PLATFORM_ADMIN_EMAIL` from the environments and documentation.

### 9. Put AI behind explicit permission and purpose-bound data

Update `convex/aiWorkspace.ts`, `convex/aiChat.ts`, AI task/SOP/analytics helpers, and the Next.js AI API route so that:

- every paid/provider-backed entry requires `ai:use` before an external call;
- each tool then requires the ordinary resource capability for the operation it performs;
- scope labels and context are derived from effective capabilities, not role;
- generic `peopleInScope` access is removed unless a live UI/tool requirement is found during implementation. Existing task-assignee and analytics tools should supply purpose-bound people data instead;
- rate-limit/session access is checked in company context before provider work;
- tool registry checks remain for UX but are never treated as authorization.

Restrict the public browser mutation to appending a `user` message to a session the caller owns. Persist `assistant` and `tool` messages through a narrow server-authenticated boundary used only by the AI route, then an internal Convex mutation. Use a timestamped HMAC request with a dedicated `AI_CHAT_PERSISTENCE_SECRET`, constant-time signature verification, a short expiry, and one-time request IDs to prevent replay. Keep this boundary limited to chat persistence; it must not confer arbitrary Convex authority. Assistant history must remain non-authoritative and must never influence permission decisions.

### 10. Align frontend behavior with backend decisions

Update task, SOP, analytics, company-settings, and AI components to:

- use effective capabilities returned by company overview/access queries for global navigation and create controls;
- use server-computed per-resource action flags for edit, delete, attachment moderation, and sensitive row actions;
- remove raw-role permission branches;
- hide or disable actions consistently while still handling backend denial after stale state or concurrent changes;
- avoid caching permission decisions beyond the reactive Convex query that produced them;
- present generic not-found behavior for invisible resources and a clear forbidden message for a visible resource whose action is denied.

Do not replicate scope algorithms in React. The frontend may format or group decisions but cannot recalculate them.

### 11. Add a public-function authorization inventory

Add `scripts/audit-convex-authz.mjs` using the already-installed TypeScript compiler API, plus an `audit:authz` package script. It should enumerate every exported public Convex query, mutation, action, and HTTP route and require one of:

- an approved company/resource authorization helper call;
- an approved authenticated-user helper call for user-global operations;
- explicit placement in a short intentional-anonymous allowlist with a reason.

The allowlist should cover only endpoints such as invitation preview or pre-membership access status that are intentionally callable without company membership. Internal functions and generated files are excluded. The script is a guardrail rather than proof, so it runs alongside behavior tests and the deterministic audit described below.

Prefer helper names and direct calls that are statically recognizable. Do not build a complex framework or add a package solely for this check.

## Test plan

### Shared fixture and matrix

Create one small Convex test fixture builder for the genuinely repeated authorization setup: two companies; Admin, Manager, and Employee memberships; managed and unmanaged branches/departments/users; active and inactive memberships; and helpers to apply allow/deny overrides. Keep expected policy tables in tests independent of production catalog construction.

For every public resource operation, cover at least:

- unauthenticated caller;
- authenticated user with no company membership;
- inactive membership;
- deleted company;
- default allowed role;
- default denied role;
- explicit allow that enables an action;
- explicit deny that disables a role default;
- allow plus deny duplicate where deny wins;
- same-company resource outside scope;
- other-company resource with a valid-looking ID;
- stale authorization changed between preview/read and mutation;
- malformed or cross-company relationship data where the test harness can insert it directly.

Do not generate a test for every Cartesian permutation. Use table-driven cases for the policy matrix and separate regression tests for distinct bypasses or transaction behavior.

### Task regressions

Add direct-backend tests for JD and one-time tasks proving:

- each view, assignment, update, and delete scope;
- an Employee may update an assigned task but cannot delete it;
- Manager managed mutation requires every resulting assignee to be authorized;
- a shared task does not reveal an unmanaged co-assignee or email;
- export cannot exceed ordinary visibility and cannot be authorized by create alone;
- import entry and each row operation require their respective capabilities;
- preview does not survive later permission, scope, membership, or task-state changes;
- comment and attachment access follows task visibility;
- attachment owners and moderators have distinct delete behavior;
- a storage ID cannot be claimed twice or across companies;
- deletion authorizes before cascading and cannot delete another company's descendants.

Preserve existing observable behavior for assignee status and notes updates.

### SOP regressions

Test all company, managed, and self visibility combinations independently from create, update, and delete. Include multi-target SOPs, old-to-new scope transitions, mixed authorized/unauthorized targets, deleted targets, malformed cross-company edges, semantic search, options, and direct ID lookup. Prove a deny applies to an Admin and an allow can enable a non-default role.

### Company, permission-root, and invitation regressions

Test:

- the last active permission administrator cannot be denied, downgraded, deactivated, or removed;
- another permission administrator is required to change a permission administrator;
- `manage_users` alone cannot change role, scope, overrides, or protected permission administrators;
- `invite_users` alone can issue only the constrained Employee invitation;
- high-role, scoped, overridden, and reactivation invitations require the full authority union;
- active-member reinvites fail;
- old links fail after reissue, member mutation, deactivation, removal, or revocation;
- unverified and mismatched emails fail without leaking membership state;
- concurrent and repeated acceptance yields exactly one membership transition;
- every successful security mutation creates the expected secret-safe audit event;
- reading audit events follows the new capability and respects an Admin deny.

### Platform and AI regressions

Test platform access with the same email but a different Clerk subject, the configured subject, multiple configured subjects, whitespace/duplicates, and missing/malformed configuration.

Test AI denial before mocked provider calls, session isolation across users and companies, each tool's ordinary resource permission, removal of generic people leakage, raw-role deny behavior, forged assistant/tool append rejection, invalid or replayed server persistence signatures, and rate-limit behavior after a permission change.

### Static and validation checks

Before completion:

1. Run `npm run audit:authz` and review every intentional-anonymous entry.
2. Repeat the four deterministic scans from the Convex authorization audit: identity from arguments, document loads before mutation, public queries returning user/company data, and writes that accept parent or related IDs.
3. Search authorization-sensitive code for raw role comparisons. Remaining comparisons must be limited to role display, default-capability calculation, or tests that assert those boundaries.
4. Search all public Convex registrations and verify the inventory has no unexplained endpoint.
5. Run `npx convex codegen`, `npm run typecheck`, `npm test -- --run`, `npm run lint`, and `npm run build`.
6. Exercise invitation preview/accept, permission changes, representative task/SOP operations, and platform access against a disposable development deployment before production rollout.

## Likely files to change

- `src/lib/permissions.ts`
- `src/lib/permissions.test.ts`
- `src/lib/platform-admin.ts`
- `convex/schema.ts`
- `convex/permissions.ts`
- `convex/tasks.ts`
- `convex/taskImports.ts`
- `convex/sops.ts`
- `convex/analytics.ts`
- `convex/companyManagement.ts`
- `convex/invitations.ts`
- `convex/platform.ts`
- `convex/aiWorkspace.ts`
- `convex/aiChat.ts`
- the Next.js AI API route and platform server guard
- task, SOP, analytics, company-management, and AI UI components that currently infer permission from role
- existing Convex test files plus a focused authorization matrix/fixture module
- `scripts/audit-convex-authz.mjs`
- `package.json`
- `.env.example`
- `README.md`

Keep file additions limited to shared policy tests/fixtures, the platform-ID helper, and the static audit script. Extend existing modules and tests where they already own the behavior.

## Rollout and rollback

1. Add schema indexes and optional invitation fields first.
2. Configure stable platform-admin Clerk IDs and the AI chat persistence secret before code paths require them.
3. Deploy policy/catalog and backend enforcement together with the frontend capability/DTO changes. Do not deploy a frontend that assumes capabilities the backend does not yet return.
4. Treat old pending invitations as revoked by the new version check and notify administrators to reissue them.
5. Inspect the administrative data-integrity report for unknown capabilities, duplicate overrides, duplicate scope edges, and cross-company relationships. Canonicalize duplicates through bounded internal maintenance operations; never repair a cross-company edge by guessing its intended tenant.
6. Run the full validation suite and a disposable-deployment rehearsal.
7. In production, monitor authorization errors, invitation failures, AI denial counts, and audit-event creation. Do not log tokens, signed persistence payloads, or JWTs.

Rollback is code rollback plus restoration of the immediately preceding frontend/backend pair. Keep `PLATFORM_ADMIN_CLERK_USER_IDS` and the new secret configured during rollback because they are harmless to older code. Old invitation links intentionally remain unsupported by the hardened version; rollback must not be used to reactivate them.

## Acceptance criteria

- Every public Convex function and HTTP entry is authenticated/authorized or explicitly documented as intentionally anonymous.
- No permission decision depends on raw role after effective capabilities are calculated.
- An explicit deny reliably removes a role default across queries, mutations, actions, AI tools, analytics, and UI controls.
- Task view, update, assignment, delete, import, export, comment, and attachment actions are separately and consistently authorized for both task kinds.
- SOP visibility, creation/update, and deletion are separately authorized across company, managed, and self scopes.
- Cross-company IDs, malformed relationship rows, scoped co-assignees, attachment storage IDs, exports, semantic search, and AI tools cannot leak or mutate another tenant's data.
- Permission administration is an explicit protected trust root with a transaction-safe last-holder invariant.
- Stale, reissued, replayed, unverified-email, and active-member invitation paths fail closed.
- Platform administration uses a stable Clerk subject and has no email authorization fallback.
- AI usage has an effective capability check before provider spend, and browser clients cannot forge server-authored chat roles.
- Security-sensitive company changes produce complete, secret-safe audit events viewable only with an effective capability.
- The frontend uses server policy decisions and has no independent scope algorithm or raw-role authorization gate.
- The authorization matrix, targeted regression tests, static inventory, code generation, typecheck, test suite, lint, and production build all pass.

## References

- Repository-specific Convex rules: `convex/_generated/ai/guidelines.md`
- Convex best practices, including treating all public functions as internet-exposed and applying access control: <https://docs.convex.dev/understanding/best-practices>
- Convex authentication API: <https://docs.convex.dev/api/interfaces/server.Auth>
- Convex and Clerk integration: <https://clerk.com/docs/guides/development/integrations/databases/convex>
- Clerk session-token claims and JWT customization: <https://clerk.com/docs/guides/sessions/jwt-templates>
