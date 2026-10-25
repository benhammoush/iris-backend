# Iris private watchlists

Status: WL-T0 design accepted by the owner, 2026-10-21, including persistent
sign-in, a five-minute reauthentication limit for deletion, and 31-day retention
of deletion-status metadata (not saved items), with provider-backup limitations
disclosed. WL-1 is implemented locally as described below; the full feature is
not provisioned, hosted-certified or authorized for release. This is the intended
behavioral contract for the frontend and Worker; `openapi.yaml` remains the
contract for implemented API behavior. The former board is historical reference.

## WL-1 local implementation

Worker 3.16.0 adds list/save/remove routes and `migrations/0001_watchlists.sql`.
Account deletion/status receipts, cleanup jobs, browser accounts and save controls
remain later WL-2–5 work; their descriptions below are requirements, not delivered
features. No hosted bindings, secrets, authentication projects, database resources
or cleanup schedules were created. `WATCHLIST_ENABLED` is unset everywhere.

Private routes fail closed unless explicitly enabled with all of:

- `WATCHLIST_DB`: migrated D1 binding, isolated from market KV.
- `WATCHLIST_RATE_LIMITER`: Workers rate-limit binding, proposed 60 checks/minute
  per key. Each call checks an IP key before token work and a UID key before the
  privileged account lookup. Keys are SHA-256 digests with separate IP/UID inputs.
  This is approximate, per-location abuse protection, not a global quota. Shared
  IPs may be throttled together. Verify namespace isolation/settings in WL-O1.
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`: exact
  environment project and dedicated service identity. Keep the private key in
  Worker secrets as PKCS8 PEM, not a browser value. WL-1 needs only the
  `firebaseauth.users.get` permission; deletion permission belongs to WL-4.

The application logs sanitized request outcomes. Automatic invocation logs are
disabled in source because full URLs include saved addresses; audit other
provider logging/trace settings before enabling private traffic. Certificate
and service OAuth token caches are configuration-scoped in isolate memory;
per-user account status is never cached. Certificate keys honor published
max-age with a six-hour cap; unknown-key refreshes have a 30-second cooldown.
No emulator/unsigned-token mode is implemented or accepted by these routes.

`npm test` includes signed JWT negative cases and an isolated Miniflare/workerd
suite. It runs the real D1 migration and constraint/concurrency checks, validates
API envelopes against OpenAPI and intercepts every outbound auth request with
test-only responses. OAuth assertions and ID-token signatures are cryptographically
verified using an explicitly public test key. This is not real Firebase/IAM or
hosted lifecycle acceptance. Miniflare and esbuild are direct test dependencies
pinned to the versions already used transitively by the existing Wrangler.

Do not enable hosted watchlists until lifecycle, privacy and dev acceptance gates
below are satisfied. WL-1 alone does not make permanent account deletion available.

## Product scope

- Public market and wallet browsing stays anonymous. No wallet connection,
  signatures, private keys, magic-link login or paid upgrade is required.
- Firebase Auth provides Google and email/password accounts. Password accounts
  must verify their email before private watchlist access. Verification and
  password-reset emails are not magic-link login. Deletion remains available to
  unverified users after reauthentication.
- One private Watchlist page has Assets and Wallets sections, newest saves first.
  Each section holds at most 100 references. No sharing, multiple lists, custom
  labels, imports, export UI, reordering, alerts or portfolio aggregation in v1.
- Identity is `(kind, address)`, where kind is `asset` or `wallet`. Addresses
  retain case and must decode as a 32-byte Base58 Solana public key. Native SOL
  uses the existing wrapped-SOL mint identity. The same address can occur once
  in each section; duplicates within a section do not change saved time/order.
- Saving requires an explicit click while signed in and verified. A logged-out
  save action offers sign-in, but successful login does not execute the save.
- Save/remove controls appear on asset and wallet detail pages. Removing is
  permanent; saving again creates a new timestamp. Pending/error states are
  visible and never silently report a failed mutation as successful.
- Owner-approved WL-3 revision, 2026-10-22: wallet rows automatically load public
  balance/holding summaries through the Worker, with at most four concurrent reads,
  per-row loading/failure states and no activity requests until wallet detail entry.
  This replaces the earlier address-only/no-wallet-provider-work rule. Asset rows
  use the existing loaded Jupiter catalog. Owner-approved compact rows show asset
  name/24h volume/price and wallet truncated address/returned holdings count/priced
  subtotal; full addresses remain accessible through labels and detail links.
  Use Jupiter/Helius branding when their data is displayed; wallet valuations may
  include Jupiter pricing. Unknown assets remain address links. Missing values are
  never zero; disclose partial valuation and truncated holdings. Reference API
  reads/writes themselves remain independent of public-provider availability.
- Cross-device updates appear on page entry, focus return and successful
  mutation; no realtime service, background polling or offline mutation queue.

## Account lifecycle and browser state

- Firebase Web SDK owns credentials and session persistence; Iris does not copy
  tokens into its own localStorage keys. Accepted default: persistent browser
  sign-in, with explicit sign-out. Watchlist data is memory-only in the app.
- UI waits for auth initialization, then obtains an ID token via the SDK.
  Passwords go directly to Firebase, never the Worker. Firebase public web config
  is not a secret; admin credentials and market-provider keys stay Worker-only.
- Verification resend and password reset use Firebase's email flows, allowed
  return URLs and generic messages that do not disclose account existence.
- Sign-out/account switch immediately clears private UI state, aborts pending
  requests and discards responses belonging to the old UID. A network failure
  must not let one user's list appear under another account.
- Explicit linking adds Google/password credentials to the same Firebase UID
  after appropriate authentication. No merging by matching email and no copying
  watchlists between UIDs. A credential already owned by another UID produces a
  clear conflict, without changing either list. Provider unlinking is out of v1.
- Sign-out affects this browser, not all devices. Password reset/revocation,
  disabled accounts and deleted accounts must be rejected by private API checks.
- Permanent account deletion requires confirmation and reauthentication; the
  maximum `auth_time` age at acceptance is five minutes. Refreshing an
  ID token alone does not count as reauthentication. No undo or restore period.

## Worker authentication and privacy boundary

- Public `/v1`, `/v2`, `/v3` and authenticated operator refresh behavior remain
  separate. Proposed private routes are `/v3/me/...`, not a replacement API.
- Each private call carries `Authorization: Bearer <Firebase ID token>`. Reject
  custom tokens, Google OAuth access tokens, emulator tokens in hosted targets,
  malformed/oversized tokens and client-supplied owner/project identifiers.
- Verify RS256 signature and trusted key ID against Google's fixed key endpoint,
  exact configured project audience/issuer, nonempty UID (at most 128 chars),
  expiry, issued-at and authentication-time claims. Check `nbf` if present; allow
  only a documented small clock tolerance. Never trust a token-supplied key URL.
- Use a maintained Workers-compatible JWT library, not a handwritten verifier or
  assumed Firebase Admin Node SDK compatibility. Cache signing keys according to
  their published lifetime, scoped by project/config; bound key refreshes and
  concurrent work. Fail closed on unresolvable keys or verification failures.
- Signature validation alone is insufficient: perform a privileged Firebase
  account lookup on every private request, check existence, disabled state and
  `auth_time` against the account's current `validSince` revocation boundary,
  and enforce current email verification for watchlist operations. Do not cache
  successful account-status checks in v1. Provider propagation and already
  in-flight requests remain limits; do not promise instantaneous global revocation.
- A narrowly permissioned, environment-specific service account supplies lookup
  and deletion via Google OAuth/Identity Toolkit REST. Use Web Crypto/fetch for
  OAuth signing/exchange; never persist user bearer tokens for cleanup. Exact
  least-privilege IAM and runtime integration need dev proof before activation.
- Authentication outages return 503, not an empty list or anonymous fallback.
  Invalid/deleted/disabled/revoked identities return 401; unverified watchlist
  access returns 403. D1 deletion-pending accounts cannot read/write watchlists.
- Every SQL statement derives UID from verified identity. D1 constraints, not
  client-side state or CORS, enforce isolation and capacity. Never use the market
  KV, shared cache or CDN to store private responses. Use `Cache-Control: no-store`.
- Add PUT/DELETE only to the private route policy and applicable preflights;
  preserve current public method restrictions and origin allowlists. Bearer auth
  does not require cookies or `Access-Control-Allow-Credentials`.
- Logs contain operation category, request ID and sanitized error code only:
  no tokens, passwords, email, UID, watchlist addresses or upstream response body.
  Review existing request/exception logging before enabling private routes.
- Enforce request/body/token limits and bounded UID/IP abuse controls before
  expensive lookups. No per-isolate limiter may be presented as a global quota.
  Choose and test the available platform mechanism in WL-1/WL-O1; configuration
  and quota feasibility are activation gates, not reasons to change public APIs.

## Proposed private API

Responses follow existing `{ data, meta }` / `{ error: { code, message,
requestId } }` conventions. Metadata includes request ID; account/UID details are
not needed in watchlist responses. No user ID is accepted in paths or bodies.

| Operation                                | Result                                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v3/me/watchlist`                   | 200, `data: { assets: [...], wallets: [...] }`; each entry is `{ address, savedAt }`. At most 200 references total, including when public providers are unavailable.                              |
| `PUT /v3/me/watchlist/:kind/:address`    | 200, `{ kind, address, savedAt }`, both for a new save and an existing duplicate. Empty body. Duplicates succeed even at capacity; a new item at the limit returns 409 `WATCHLIST_LIMIT_REACHED`. |
| `DELETE /v3/me/watchlist/:kind/:address` | 200, `{ removed: true }`, including an already absent reference; empty body.                                                                                                                      |
| `DELETE /v3/me/account`                  | 202, `{ status: "deleting" }` once the deletion intent and removal of live watchlist rows are committed; no success claim for Firebase cleanup yet. Empty body.                                   |
| `GET /v3/me/account/deletion`            | 200, `{ status: "deleting" }` or `{ status: "deleted" }` for the same signed deletion receipt; no UID or watchlist data.                                                                          |

Deletion acceptance also returns a short-lived signed receipt valid only for
polling deletion status for that UID, never authentication or cancellation. It
lets the initiating browser confirm completion after Firebase deletion invalidates
normal auth. Keep it in memory; refreshing/closing the browser may lose status,
not the durable job. No receipt means no unauthenticated status disclosure.
Receipt lifetime, signing-key handling and polling bounds are WL-4 security tests.

Other errors: 400 `INVALID_WATCHLIST_ITEM`, 401 `AUTH_REQUIRED` or
`AUTH_INVALID`, 403 `EMAIL_VERIFICATION_REQUIRED` or `ACCOUNT_DELETING`,
403 `REAUTHENTICATION_REQUIRED`, 429 `RATE_LIMITED` (with `Retry-After`),
503 `AUTH_UNAVAILABLE` / `WATCHLIST_UNAVAILABLE`. Do not echo credentials or raw
provider errors. Repeat account-delete requests with an accepted receipt may
return the current state without a new identity check or changing the target;
no other private operation accepts that receipt.

## D1 data and concurrency requirements

- Proposed `watchlist_accounts`: Firebase UID primary key and lifecycle state
  (`active`, `deleting`, `deleted`), lifecycle timestamps and bounded cleanup
  retry metadata. No email/name/avatar/password/token storage in D1.
- Proposed `watchlist_items`: owner UID, kind, address and server-created saved
  timestamp. Unique `(owner_uid, kind, address)`, owner foreign key with cascade,
  kind constraint and an index supporting owner/kind/newest-first retrieval.
  Equal timestamps sort by address for deterministic order.
- Enforce 100 items per kind in the database write path, including concurrent
  requests (for example a guarded insert/trigger). Active lifecycle state must
  also be checked in the write itself. Never separate a JS count check from an
  unguarded insert. Use bound parameters and atomic batches where needed.
- Normal list reads use primary-consistent D1 access; no read replicas or KV
  caching in v1. Cross-device refresh must see successful completed mutations.
- A successful duplicate save preserves the original timestamp. A write racing
  deletion must either precede the atomic purge or be rejected after it; it
  must never recreate rows for a deleting/deleted account.

## Permanent deletion, not recovery

1. Before accepting a new deletion, validate identity, current account status,
   explicit confirmation and recent authentication. Atomically mark the D1
   account deleting, purge its watchlist rows and persist cleanup work. If D1
   cannot commit, return an error and do not delete Firebase first.
2. Return 202 only after that commit. All subsequent watchlist calls deny access.
   The browser clears its list and shows that deletion is underway, not complete.
3. Attempt privileged Firebase deletion by the job's UID. It is independent of
   the browser's session. Confirm success or independently confirmed absence;
   timeouts, permission failures and generic upstream errors are not absence.
4. Mark deleted only after confirmation. A durable scheduled cleanup pass retries
   unfinished jobs with bounded backoff and visible failure counts; no reliance
   on browser retries, `waitUntil` alone or an in-memory queue. New cleanup
   scheduling in dev/production needs explicit setup authorization, separate
   from production's market-refresh schedule. Pending jobs survive deployments.
5. Account deletion has no cancellation/undo. Re-signup creates a different UID
   and an empty list, never restoring the old watchlist. A completed lifecycle
   marker blocks old in-flight requests from recreating data; retain it for a
   period of 31 days, then purge it after ensuring cleanup completed.

Out-of-band Firebase deletion also needs orphan cleanup: check D1 account UIDs
against Firebase in bounded scheduled pages and purge references only on confirmed
absence, never on network/auth errors. External account deletion can race requests;
tests must cover it, and cleanup must not depend on the user logging in again.

D1 Time Travel is always on: currently up to 7 days on Free and 30 on Paid.
Deleting active rows is not immediate erasure from provider backup history.
Disclose this limitation; no extra watchlist exports/backups are proposed. Firebase
provider retention also needs confirmation before public privacy wording is
accepted. Completed marker retention is operational metadata, not recoverable
watchlist data. The owner accepted its 31-day retention period.

Do not restore a watchlist database into service: an old snapshot could revive
deleted data or erase pending cleanup work. Future disaster restoration requires
an independently retained deletion journal and reconciliation before serving
traffic. That facility is not part of v1; restoring an old app artifact must not
restore D1 or remove the private-route lifecycle checks.

## Feasibility and setup gates

WL-T0 source baseline: frontend React 18/Vite 6, backend Wrangler 4, Worker
compatibility date `2026-10-02`, no Node compatibility flag and no D1 binding.
At T0 no Firebase/JWT dependency or auth integration had been selected or tested.
WL-1 now uses jose 6.2.13 and adds private-only PUT/DELETE preflights; public
GET/POST/OPTIONS preflights and no-store JSON handling are preserved.

Documentation supports the design: Workers provides Web Crypto RSA verification
and signing; Firebase documents third-party JWT verification and privileged REST
lookup/delete; D1 provides SQL constraints and transactional batches. WL-1 proves
workerd/local-D1 integration with mocked Google endpoints, not hosted Firebase/IAM.
React/Vite major migrations are not prerequisites for this design.

WL-O1 must separately authorize isolated dev Firebase project + D1 database,
Google/email providers, allowed domains/return URLs, email templates, least-privilege
service credentials, cleanup scheduling and rate-limit setup. Production uses
different Firebase project, D1 database, IAM identity and keys; no dev audience
is accepted there. Local/CI currently use signed test fixtures, intercepted Google
endpoints and local D1 only, with no emulator/unsigned verifier mode. Firebase's
unsigned emulator tokens must never be accepted by hosted targets.

Choose exact Firebase Web/JWT package versions during WL-1/2; prove bundling and
runtime/browser compatibility, especially email/password linking (current Firebase
docs flag a known linking issue) and mobile/Safari Google auth flows on Vercel.
No installed Admin SDK or paid Identity Platform features are assumed.

Published D1 Free allowances are 5 million rows read/day, 100,000 written/day,
5 GB account storage; indexes add write cost. Firebase Spark documents 1,000
verification emails/day and 150 reset emails/day; upgraded Identity Platform
Spark has a separate 3,000 tier-1 daily-active-user limit. Check the actual product
and account quotas before setup. Illustratively, 100 users loading 200 references
10 times/day produces about 200,000 returned item rows/day, before account checks,
indexes, cleanup and abuse; this is not a measured bill or capacity guarantee.
There is no usage forecast yet. Keep no-billing setup unless separately approved;
quota exhaustion must degrade private features without breaking public browsing.
Automatic wallet summaries add up to 100 public Worker wallet reads per page
refresh, not 100 provider calls. Current uncached `walletWork` permits one Helius
read and up to 40 distinct Jupiter mint lookups per wallet. Each read can attempt
twice, so the worst-case request budgets are **2 Helius + 80 Jupiter attempts per
wallet**, or **200 Helius + 8,000 Jupiter attempts per 100-wallet refresh**. Cache
hits/single-flight may reduce usage; they are not a guaranteed quota reduction.
Four concurrent wallet reads nominally schedule four Helius or 20 Jupiter requests
in flight per page, not a global limit. Twenty is not a guaranteed failure-path
ceiling: `mapWithConcurrency` can reject before its other mint workers finish,
and `refreshMarket` can return a partial wallet while those workers continue. The
next wallet can then overlap surviving enrichment work. Activation acceptance must
bound that overlap by cancelling or draining failed enrichment before releasing
its scheduling slot, rather than treating nominal concurrency as enforced usage.
The attempt ceilings above are not accepted hosted allowances. Before activation,
WL-O1 must approve explicit per-provider attempt budgets per refresh and shared
rate limits against actual account quotas, counting retries and mint fanout;
enforcement must stop before spending an exhausted budget. Repeated focus/manual
refreshes and multiple users/tabs also consume those shared budgets.

Hosted activation additionally requires a typed provider stop signal to survive
the Worker boundary, including partial wallet responses: identify the provider
(`helius` or `jupiter`) and reason (`throttled`, `unavailable` or `budget-exhausted`).
Propagate terminal 429, provider 5xx/network/timeout and budget exhaustion from
`walletWork`/`refreshMarket`, and stop scheduling both queued mint enrichment and
queued wallet reads on either provider's signal. Do not infer outage from missing
prices alone; legitimate unpriced holdings remain usable partial results. Keep
valid balances visible with a partial valuation when Jupiter fails, but do not
swallow that provider failure as an ordinary success for queue scheduling.
Already dispatched requests may finish within their bounds; no automatic new
batch may bypass a stop signal or accepted shared budget. Provider signals must
contain no credentials or raw upstream bodies.

This documentation PR defines the acceptance requirement, not its implementation:
today `refreshMarket` can swallow Jupiter failures and return a partial wallet
without a typed stop signal. Existing frontend queue stopping covers surfaced
Worker failures only. Provider budget enforcement and end-to-end stop propagation
need separate implementation/acceptance before hosted activation. Helius/Jupiter
quota and provider logging/privacy acceptance remain WL-O1 gates.

## Acceptance and handoff

- WL-T0: owner accepted the product scope, persistence and deletion
  metadata/backup policy. Independent security/lifecycle design review found no
  blockers. Runtime
  prerequisites above remain explicit gates rather than claimed passes.
- WL-1: contract/OpenAPI tests; wrong project, algorithm, issuer, key, expiry,
  revocation, disabled/deleted user and unverified-email tests; A/B ownership and
  injection tests; concurrent duplicate/capacity/deletion tests; missing D1/auth
  configuration must not disable public APIs; production cannot accept emulators.
- WL-2/3: verification/reset/linking flows; credential conflicts without UID/list
  merging; explicit save after login; newest-first/limits; bounded automatic wallet
  summaries with per-row failures, no wallet-activity reads and no stale responses
  after sign-out/account switch; keyboard/mobile
  acceptance and preservation of anonymous browsing.
- WL-4: permanent deletion, fresh authentication, status receipt constraints,
  commit failure, Firebase success + D1 completion failure, ambiguous timeout,
  expired browser session, concurrent save/delete, job retries, orphan handling
  and old-token replay. Never restore private data to repair a cleanup failure.
- WL-5: isolated real Google/password accounts, email verification/reset,
  same-UID linking, cross-device save/remove, account deletion and eventual
  cleanup observed without an open browser. Emulator tests are not hosted proof.
- Activation: approve exact dev-accepted sources, configuration, privacy wording,
  cleanup ownership/monitoring and required quotas before a separate production
  release. No account creation/deletion or provider mutation is authorized by T0.

## Sources checked 2026-10-21

Context7 was out of quota; direct official documentation was used instead.

- [Firebase token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
- [Firebase session revocation](https://firebase.google.com/docs/auth/admin/manage-sessions)
- [Firebase users and reauthentication](https://firebase.google.com/docs/auth/web/manage-users)
- [Firebase account linking](https://firebase.google.com/docs/auth/web/account-linking)
- [Firebase usage limits](https://firebase.google.com/docs/auth/limits)
- [Privileged account lookup](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/lookup)
- [Privileged account deletion](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/delete)
- [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
