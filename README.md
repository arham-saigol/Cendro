# Cendro

Cendro is a Notion-like internal operations workspace for company-scoped tasks, SOPs, employee/company management, analytics, and a permission-aware AI panel.

## Local setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and fill in Clerk, Convex, Resend, Fireworks, and platform admin values.
3. Configure Clerk Google OAuth and a Clerk JWT template named `convex` with audience/application ID `convex` and the `email_verified` claim (`email_verified: {{user.email_verified}}`) so invitation acceptance can verify email status.
4. Create/connect a Convex deployment: `npx convex dev`.
5. Before deploying/generating Convex functions, configure runtime environment variables:
   - `CLERK_JWT_ISSUER_DOMAIN` is required by `convex/auth.config.ts`.
   - Set `PLATFORM_ADMIN_CLERK_USER_IDS` and `AI_CHAT_PERSISTENCE_SECRET` with identical effective values in both the Convex deployment environment and the Next.js host environment (`.env.local`): the same administrator user-ID set for `PLATFORM_ADMIN_CLERK_USER_IDS` (comma-separated Clerk user IDs, e.g. `user_2...`) and the same value for `AI_CHAT_PERSISTENCE_SECRET`.
   - Also set `RESEND_API_KEY`, `RESEND_FROM`, and `APP_URL` in Convex.
6. Run the app: `npm run dev`.

## Validation

- `npm run audit:authz`
- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm audit --audit-level=high`
- `npm run convex:codegen` after Convex env vars are configured

## JD pause/resume rollout

Paused JD tasks retain their activity, comments, attachments, completions, and missed-cycle history. The “Paused tasks” filter replaces the active list in every non-Custom JD view without changing visibility scope. Bulk pause/resume is atomic for up to 100 selected tasks. Resume rejoins the current working-calendar cycle; suspended cycles are not replayed, and same-cycle completions remain completed. There is currently no task reminder sender in this repository.

New default Admin roles include independent `tasks:jd:pause` and `tasks:jd:resume` grants; Manager and Employee defaults do not. After deploying the additive schema/index changes, run `npx convex run roles:enableJdLifecycleDefaults '{}'` against the explicitly chosen deployment **once during rollout** to upgrade existing untouched default Admin roles. Customized roles are left unchanged and can be granted either permission in Roles. Do not rerun this release backfill after administrators deliberately revoke both grants.

Company deletion in `/admin` is a soft delete: the company becomes inaccessible and hidden from normal company selection, while child records are retained for audit.
