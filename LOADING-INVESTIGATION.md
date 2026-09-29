# Loading incident: build 9296c7f

## Result

The supplied snapshot establishes a **pending Convex authentication with unavailable transport**, not a hung Clerk token request or failed profile sync. It does not establish why transport is unavailable. No production fix is justified by the available evidence yet. No timeout, fallback, auth bypass, provider reset, deployment, or production configuration change was added.

The employee was still affected during investigation. Only the screenshot and JSON were available; no affected-device network/console error was available. Existing `REVIEW.md` was read as historical context, not treated as current production verification.

## Trace of this failure

- `build=9296c7f...` identifies the latest diagnostic build; this is not evidence of an older app build.
- `stage=convex-auth`: `CompanyProvider` sees Clerk loaded/signed in and Convex still loading, not authenticated.
- `token={result:obtained,durationMs:397,refresh:false,attempt:1}`: the bounded Clerk request returned a nonempty token promptly. This does **not** prove the JWT is valid, but acquisition did not hang for that attempt.
- Convex 1.41.0 `AuthenticationManager.setConfig` pauses sending while acquiring a token, queues `Authenticate`, then resumes sending. It only reports authentication after a server `Transition` advances the identity version. An obtained token is not server confirmation.
- `webSocketConnected=false`, `everConnected=false`, `connectionRetries=44`: transport is disconnected at the snapshot and the SDK is retrying. `online=true` is only `navigator.onLine`; it does not establish Convex reachability.
- SDK nuance: `hasEverConnected` is set on an **unpaused** open/resume. It is not a raw history of successful HTTP upgrades. These fields cannot uniquely identify DNS, TLS, proxy/filtering, server/edge, or lifecycle failure.
- `confirmation=pending` is derived by Cendro from the stage, not a separately observed protocol event. There is no evidence here of an `AuthError` or a rejected JWT.
- `profile=null`: `UserSync` correctly waits for `useConvexAuth().isAuthenticated`. `companies.accessStatus` is also skipped until then. Email claims, membership and query performance are downstream, not explanations for this pending stage.
- `elapsedSeconds=712` is the shell wait duration, not token-request duration. `autoRetries=2` is the exhausted persisted shell reload budget. `RetryFailedAuth` deliberately does not retry while Convex remains loading; the SDK owns connection retries.

## Last four loading fixes

| PR / commits | Actual change | Why this report can still happen |
| --- | --- | --- |
| #32: `353fcde`, `c8db7e8` | Stage-aware stall card; 20-second warning; 45-second reload with persisted two-reload cap; bounded profile retries. | Exposes an outage but cannot restore an unavailable connection. The two reloads have already been used. |
| #34: `dc45d7c`, `9be86e3` | Ten-second bound on Clerk token acquisition; continuous stall clock across waiting states. | This token arrived in 397 ms. The bound does not apply to socket establishment or server confirmation. The intentionally hung-token reproduction in that PR was a possible failure, not evidence for this employee. |
| #35: `8cb2aa5`, `b3cdb0c` | Supported custom Convex auth adapter; session/org invalidation; backoff after terminal token/auth failure; ongoing transient profile retries; permanent missing-email handling. | The snapshot is pending, not terminal. Starting more `setAuth` calls while the SDK reconnects would not establish the network connection. Profile retries cannot run yet. |
| #37: `8edd2f6`, `4fc21a2`, `fedd020` | Redacted token/profile/build/episode diagnostics; real SDK confirmation test; session-scoped token diagnostics; recovered-after-reload reporting. | Now distinguishes prompt token acquisition from pending confirmation, but does not capture the failed upgrade/status/close cause. It did not repair an identified transport defect. |

## Clerk / Convex misuse and races checked

Read installed Convex 1.41.0's `ConvexAuthState.tsx`, `authentication_manager.ts`, `web_socket_manager.ts`, and stock Clerk adapter, plus installed Clerk's `useAuth`/`createGetToken` implementation.

- Provider ordering is Clerk outside Convex; the shared Convex client is module-scoped, consistent with the official Next.js integration.
- Session-token versus `convex` template selection and `forceRefreshToken` → `skipCache` match the installed stock adapter.
- Clerk memoizes `getToken` against its Clerk instance. Depending on it here is not evidence of render-by-render auth churn. The report also shows only one token attempt.
- The application gates workspace queries and profile writes on **Convex** authentication, not merely Clerk sign-in.
- Convex guards superseded token fetches by configuration version. The added real-SDK test exercises a pending old-session fetch, session replacement, and late old-token completion: only the new session's token is sent, and it still needs server acknowledgement.
- A paused socket can still be physically connected. A paused token fetch alone must not be equated to these disconnected diagnostics.

No matching Clerk/Convex race was reproduced. This is not a claim that all possible SDK races have been ruled out.

Official contract checked: https://docs.convex.dev/auth/clerk (in addition to installed source).

## Reproduction and current reachability

Added tests at the existing public seam in `src/components/app/convex-clerk-auth.test.ts`; the actual installed Convex React provider, client, and auth state machine run against controlled Clerk tokens and a controlled socket:

1. Successful initial token, 44 failed upgrades, 712 seconds of simulated elapsed time: exactly the supplied connection flags/retry count and pending auth, with one token request and no sent protocol messages. Open the transport and deliver server confirmation: authentication recovers without an application reset or reload.
2. Late old-session token cannot overwrite the replacement session's handshake.

This proves failed upgrades are **sufficient** to produce the report and that the current provider can recover from them. It does not prove that the employee experienced those exact simulated failures. Existing tests still cover token acquisition versus confirmation and terminal-token retry.

At **2026-09-29 08:39:05 UTC**, a credential-free Node WebSocket probe to the production endpoint identified in the prior review, `wss://animated-opossum-192.convex.cloud/api/1.41.0/sync`, with Origin `https://www.cendro.app`, opened in **681 ms**. The probe then deliberately closed without sending authentication. This demonstrates point-in-time reachability from the engineering machine only, not employee reachability, authentication health, or a fresh audit of deployment configuration. No browser automation was used.

## What is needed to implement the root fix

One affected-device WebSocket failure's URL host/path, UTC time, HTTP upgrade status or browser network error, and close code/reason (if available). Do **not** share tokens, cookies, authorization headers, or `Authenticate` payloads. If upgrade succeeds, determine whether `Authenticate` is sent and whether an `AuthError` or identity `Transition` follows, without sharing credentials.

- Failed upgrade: correct the demonstrated endpoint/network/TLS/proxy/edge condition; escalate with timing and error to the appropriate operator.
- Upgrade succeeds but client never sends authentication: reproduce that lifecycle/protocol sequence and fix the shared adapter/SDK boundary.
- `AuthError`: correct the evidenced issuer/audience/expiry/session mismatch, not guessed production settings.

Without that distinction, another reset/timeout, speculative dependency update, or HTTP fallback would be a fifth workaround rather than an evidence-backed repair. The employee incident remains open.

## Checks

- Focused auth, shell, token, company-context and diagnostics-route suite: **6 files, 39 tests passed**.
- ESLint on the changed test: passed.
- `git diff --check`: passed (pre-existing skill files emit line-ending warnings).
- `npm run typecheck` (`next typegen && tsc --noEmit`): passed.

## Follow-up: remote diagnostics without developer tools

The employee cannot reasonably supply console/network captures. Added passive observation of the **actual Convex socket**, using the supported `webSocketConstructor` option. This is instrumentation, not a connection/auth workaround. It does not change timeouts, retries, authorization, or the native WebSocket globally.

After deploying this change, ask the employee to refresh Cendro once to load the new build. If it stalls, click **Copy support diagnostic** on the error card and paste it into a message. The button is no longer hidden in the expandable detail section; it reports clipboard success or gives manual-copy instructions if copying is blocked. An already-open old build cannot gain this instrumentation until refreshed.

### What the new fields establish

- `capturedAt`: capture time in Unix milliseconds, for correlating service/edge logs.
- `transport.startedAt`: start of the current transport/token trace. Counts reset after a completed boot or a new Clerk session, not on every socket reconnect; each socket has a local numeric identifier.
- `endpoint` / `sdk`: public Convex deployment hostname and SDK version extracted from the sync endpoint, without its full URL/query.
- `attempts` / `opens`: actual constructor attempts and native socket open events. Unlike the SDK's `hasEverConnected`, `opens` includes a socket that opened while auth sending was paused.
- `messages` / `authSends` / `authErrors`: received native messages, successful calls to native `send` for user authentication, and observed server `AuthError` frames. A successful `send` means queued by the browser, **not** acknowledgement by the server.
- `events`: last 12 allowlisted events with elapsed milliseconds and socket identifiers where applicable: connecting/open/error/close, constructor/send failures, SDK-initiated close, enforced CSP block, first server message, authenticate/clear-auth, server auth rejection, token start/outcome, and confirmed React auth state. Auth-control events include numeric identity versions when available, never identities or tokens.
- `previousTransport`: the last pre-reload trace, with its build and capture time. It is bounded, validated when read from session storage, episode-scoped, expires after a day, and is removed when the boot episode ends. Storage being blocked cannot break boot or copying the current trace.

### Reading a report

| Evidence | Meaning / next action |
| --- | --- |
| `opens=0`, repeated error + close `1006`, no auth sends | Connection is failing before a native open event. Investigate reachability/upgrade for the reported deployment and time; not a hung Clerk token. |
| `csp-blocked` | The browser explicitly reported an enforced `connect-src` violation for that endpoint. Inspect the response's CSP / deployment policy. Report-only policies are not labelled blocked. |
| Native open, token obtained, no `authenticate` | Sending/auth lifecycle is stalled; reproduce the token/socket ordering rather than assuming the network never opened. |
| `authenticate` followed by `auth-error` | Server-side authentication rejection observed; check the matching identity version and deployed auth settings. `authUpdateAttempted` distinguishes a rejected update from another auth error. |
| Native open + auth send, no received messages | Transport established, but no server message observed; investigate post-upgrade connection/server path. |
| `auth-confirmed`, stage `data` or `profileMissing` | The initial auth boundary succeeded; investigate workspace/profile behavior instead. |
| `client-close` before close | The client/SDK initiated a close; distinguish lifecycle/re-authentication from a remote close. |

**Browser limit:** JavaScript's WebSocket error event does not expose failed-upgrade HTTP status, DNS/TLS errors, or the browser console's network error text. `1006` alone does not identify a firewall, VPN, certificate failure, or outage. The trace narrows the boundary but does not manufacture those missing details. `AuthError` classification inspects only small auth-control frames; workspace payloads and chunked transitions are not recorded.

The same extra fields go to the existing authenticated, same-origin `/api/auth-diagnostics` endpoint on stall/retry/recovery. Search deployment runtime logs for `[cendro] auth diagnostic` and the copied episode ID. Delivery is best-effort and retention remains the hosting platform's responsibility; a copied report works even if delivery fails. The existing request quota/deduplication remain; the bounded body limit is now 8 KiB to accommodate current and previous traces. Previous-build payloads remain accepted for already-open tabs.

No raw token, claims, session/user ID, full URL, workspace payload, provider error text, or close reason is collected. Close codes and clean/unclean flags are retained instead of potentially sensitive reason strings.

Tests exercise the instrumented real Convex SDK, credential redaction, native-handler/message preservation, CSP filtering, bounded history, storage surviving failed report delivery, recovery cleanup, and strict ingestion validation.

Follow-up verification: full suite **37 files / 300 tests passed**; final focused suite **7 files / 44 tests passed**; package typecheck, ESLint on changed source/tests, production build, and scoped diff checks passed. No browser automation or production deployment was performed.
