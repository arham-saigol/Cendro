# Loading investigation

## September 30: native sockets never open on build 58bf13a

The new report records seven native connection attempts, zero opens, zero
messages and zero authentication sends. Clerk returned a token in 410 ms.
The four retained attempts fail after 1,179, 1,207, 1,164 and 1,186 ms with an
error followed by unclean close 1006. The earlier saved report independently
records six attempts and zero opens. This establishes a failure before the
WebSocket opens, rather than the earlier ambiguous SDK connection flags.
It does not identify the DNS, TLS, browser, routing, or HTTP upgrade cause.
Capture times are 2026-09-30 12:40:15.459 UTC and 12:17:31.911 UTC.

### Performance PR review

Reviewed the complete file lists for PRs #28 and #30 and their changes to the
startup path. Neither PR changed the shared Convex client, the Clerk adapter,
root provider order, deployment URL handling, dependencies, or connection
timeouts. PR #28 lazy-loaded the optional AI panel, optimized list/details
rendering, added optimistic updates and batched backend reads. PR #30 changed
backend indexes and read batching. The changed workspace query and profile
mutation are downstream of server-confirmed auth and cannot run in this
reported boot state. No matching transport regression was established in
these PRs. The timing of first reports alone cannot establish causation.

Also reviewed subsequent auth recovery and PWA changes. The service worker
handles same-origin static assets and navigation requests; it does not handle
the cross-origin Convex WebSocket. The current source has one module-scoped
client beneath Clerk. Workspace queries and user sync wait for Convex's
server-confirmed authentication, consistent with the official integration.

### Timeout and version checks

- The installed Convex 1.41.0 WebSocket manager uses a 60,000 ms inactivity
  threshold, including during connection establishment. Its reconnect backoff
  is not a connection deadline. Cendro has no added WebSocket deadline.
- The 10,000 ms Clerk deadline bounds token acquisition, which completed in
  410 ms in this report. The shell warns after 20 seconds and can reload after
  45 seconds, neither of which explains repeated failures around 1.2 seconds.
- The bounded trace records native `close()` calls as `client-close`. No such
  event appears before the four retained failures. Zero opens also excludes
  the SDK path that waits for an opening socket before closing it.
- A real-SDK regression test holds the connection unopened for 15 seconds
  with a token returned after 410 ms. The application retains one connection
  attempt and remains pending; opening the socket and delivering the identity
  transition authenticates successfully. This test also passed on 1.41.0.
- npm's latest stable Convex version was 1.46.0 at this review. The project's
  lockfile used 1.41.0, with a single deduplicated Convex copy. The published
  `web_socket_manager.ts` source is unchanged between those versions.
  There is no evidence that this report represents a protocol version mismatch.
- Newer releases fix Clerk session-change handling in 1.42.2 and auth-context
  referential stability in 1.44.0. The custom adapter already tracks session
  changes and uses the supported `ConvexProviderWithAuth` interface. Its
  bounded token acquisition and terminal-auth retry remain necessary because
  the latest auth manager still awaits the supplied token fetcher without an
  application deadline or automatic retry after terminal failure.
- The branch updates only Convex to 1.46.0, obtains those upstream fixes, fixes
  the obsolete adapter comment, and tests the reported SDK version against
  Convex's public version export. Fixtures representing reports from 1.41.0
  remain intentional. This upgrade is maintenance, not a verified fix for the
  reported failed connection openings.

Other relevant npm versions were Clerk Next.js 7.5.6 versus latest 7.9.8, Next
16.3.0 versus 16.3.7, React/React DOM 19.2.7 versus 19.3.0, and convex-test
0.0.53 versus 0.0.60. Several UI and AI dependencies are also behind current
releases. They were not upgraded without a demonstrated relationship to this
failure. The existing test dependency accepts the upgraded Convex package.

### Independent production check and remaining evidence

The production sign-in page responded with HTTP 200. Its observed response
had no Content-Security-Policy header. A credential-free HTTP/1.1 WebSocket
upgrade to `animated-opossum-192.convex.cloud/api/1.41.0/sync`, with Origin
`https://www.cendro.app`, returned **101 Switching Protocols** at
2026-09-30 13:56:57 UTC through the engineering environment's normal network
proxy. The server accepted that versioned endpoint and origin. The probe
sent no Convex protocol messages or credentials, and was stopped after
12 seconds. That stop is not a measured connection-establishment timeout.
This is point-in-time engineering reachability, not affected-user verification.

The connected Vercel API confirms production deployment
`dpl_Fakd32weXg6dQbqZYGj1mHpPkqgx` is READY on commit `58bf13a`, with
`www.cendro.app` and `cendro.app` among its aliases. Its function region is
`iad1`; that region is not a browser-to-Convex connection timeout. The runtime
error query for the past 24 hours returned no errors. Accessible recent request
logs include HTTP 200 responses for sign-in, dashboard and task pages, plus
successful cached service-worker requests. A separate recent warning/error
query returned no matching logs. These observations do not verify an affected
browser's direct WebSocket or authenticated startup.

The incident-time runtime log query returned `ExceedsBillingLimitError` rather
than log entries. The connector's project-detail call fails argument validation,
and its advertised build-log call returns `Tool ... not found`. Deployment
environment values and Convex edge logs have therefore not been inspected.
No browser login was attempted, as requested.

The incident remains unresolved. The missing evidence is still the failed
upgrade response or browser network error, or matching Convex edge evidence.
The existing same-origin diagnostic reports can be correlated by episode
`620f7455-1f8c-4e58-aaac-2e533247898c` and the UTC times above. Vercel logs can
provide context for report delivery and frontend requests; the direct Convex
WebSocket does not traverse Vercel.

Sources: https://docs.convex.dev/auth/clerk and the published Convex 1.41.0 /
1.46.0 packages, compared with
https://github.com/get-convex/convex-js/blob/main/CHANGELOG.md.

Upgrade validation: 37 test files / 307 tests passed; frontend and Convex
TypeScript checks passed; ESLint passed with six existing warnings; production
build passed using a placeholder Clerk publishable key and the reported public
Convex URL. No authenticated end-to-end or affected-device check was performed.
No backend functions, schema, production settings, or deployment were changed.

## Previous investigation: build 9296c7f

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
- `messages` / `authSends` / `authErrors`: received native messages, successful calls to native `send` for user authentication, and observed server `AuthError` frames. After a Clerk session switch on a reused socket, only auth-update errors matching an unambiguous version sent in the new session are counted; ambiguous or late old-session responses are omitted. A successful `send` means queued by the browser, **not** acknowledgement by the server.
- `events`: last 12 allowlisted events with elapsed milliseconds and socket identifiers where applicable: connecting/open/error/close, constructor/send failures, SDK-initiated close, enforced CSP block, first server message, authenticate/clear-auth, server auth rejection, token start/outcome, and confirmed React auth state. CSP events are endpoint-level because overlapping reconnects cannot be distinguished by browser policy events. Auth-control events include numeric identity versions when available, never identities or tokens.
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
