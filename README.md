# Cendro

Cendro is a Notion-like internal operations workspace for company-scoped tasks, SOPs, employee/company management, analytics, and a permission-aware AI panel.

## Local setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and fill in Clerk, Convex, Resend, AI Gateway, Voyage, and platform admin values.
3. Configure Clerk Google OAuth and a Clerk JWT template named `convex` with audience/application ID `convex`.
4. Create/connect a Convex deployment: `npx convex dev`.
5. Before deploying/generating Convex functions, set Convex environment variables: `CLERK_JWT_ISSUER_DOMAIN` is required by `convex/auth.config.ts`; also set `PLATFORM_ADMIN_EMAIL`, `RESEND_API_KEY`, `RESEND_FROM`, `APP_URL`, `VOYAGE_API_KEY`, and `VOYAGE_EMBEDDING_MODEL`.
6. Run the app: `npm run dev`.

## Validation

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm audit --audit-level=high`
- `npm run convex:codegen` after Convex env vars are configured

Company deletion in `/admin` is a soft delete: the company becomes inaccessible and hidden from normal company selection, while child records are retained for audit.
