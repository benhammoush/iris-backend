# Iris Backend

Source bootstrap for `benhammoush/iris-backend`, paired with `benhammoush/iris-frontend`. The application/API version is retained; the new repository history is not an API release. Hosted targets reference fresh isolated namespaces and the new frontend origins. The declared workers.dev URLs are deployment targets, not proof that Workers exist or have passed acceptance. Credentials and explicit activation remain separate prerequisites. No credentials or old Git history are included.

Cloudflare Worker API for cached Solana market data and on-demand public-wallet lookups. It uses Cloudflare KV only; it does not use Express, D1, or R2.

## System Architecture

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the detailed frontend-to-Worker organigram, route mapping, provider boundaries, caches, refresh sequence, and failure behavior.

## Local development

1. Run `npm ci`.
2. Copy `.dev.vars.example` to `.dev.vars` and set only local values. Do not commit `.dev.vars`.
3. Local KV requires no remote namespace. `npm run dev` uses `--local --env local`, port 8787, and isolated `.wrangler/local` persistence.
4. Set `HELIUS_API_KEY`, `JUPITER_API_KEY`, and `BIRDEYE_API_KEY` for live data and on-demand USD OHLCV candles. Never commit secrets or private wallet information.
5. Run `npm run dev` or `npm test`.

Any valid public Solana address can be looked up; Iris never requests wallet signing or private keys.

## Vertical testing

`npm run seed:e2e` writes fresh deterministic records to local Wrangler KV at `.wrangler/e2e`. `npm run e2e:serve` seeds that store and starts the Worker on `127.0.0.1:8787` using the `e2e` environment. That environment sets `PROVIDER_MODE=cache-only`, so it reads seeded KV data and cannot call market or chain providers.

The frontend repository's `npm run test:vertical` uses this command to verify browser-to-Worker journeys. Frontend CI pins an explicit compatible Worker SHA. Local E2E data is never written to a remote KV namespace.

## Deployment

After explicit activation, pushes to `main` deploy dev after existing CI passes. Keep `DEPLOY_ENABLED` unset or `false` during bootstrap; publish this backend first and explicitly configure the frontend's compatible new `IRIS_WORKER_SHA`. For production, manually run CI from `main`, select the exact merged commit SHA accepted in dev, and explicitly approve through its protected GitHub environment. Manual exact-SHA dev redeployment remains available. See the frontend [environment setup runbook](https://github.com/benhammoush/iris-frontend/blob/main/ENVIRONMENTS.md) for provisioning, candidate identity/configuration checks, browser/API acceptance and recovery evidence. Source selection alone is not acceptance. The repositories deploy independently; keep API changes backward-compatible and deploy the Worker first when both change.

The dev and production declarations in `wrangler.toml` are configuration, not a live deployment inventory. Reverify the new namespace bindings, frontend origins, workers.dev endpoints, remote secrets, native gates and isolation before enabling or promoting a target. The default/local/E2E namespace placeholders remain deliberately unconfigured for hosted use. Configure provider keys and `REFRESH_TOKEN` separately as remote Worker secrets; environment-scoped `IRIS_REFRESH_TOKEN` must match `REFRESH_TOKEN`. Existing Helius, Jupiter and Birdeye keys may be reused from the maintainer's password manager, entered directly into each new Worker's secret settings; never copy them into Git, chat or browser configuration. Generate a distinct refresh token for each new environment. Worker creation, initial deployment and secret entry are operator actions, not effects of publishing this configuration. Set `DEPLOY_ENABLED=true` only after setup and separate activation approval. Dev refresh is explicitly requested with `refresh_dev`; production refreshes on release and retains hourly Cron. This bootstrap does not stop old deployed Cron or delete old Workers/KV: inventory consumers and preserve evidence before separately authorized retirement.

## Engineering checks

Use Node 22.13+ within the 22.x line (`.nvmrc` and CI). The frontend independently uses Node 24. Run `npm ci`, `npm run lint`, `npm run format:check`, `npm run check:tooling`, `npm run audit:dependencies`, `npm run check:versions`, `npm run check:types`, `npm run lint:openapi`, `npm test` and `npm run check`. The last command is a production bundle **dry-run**, not a deployment. `npm run format` applies mechanical formatting; review that diff separately from behavior changes. `check:tooling` verifies that the configured guards actually reject invalid code and formatting. See [SECURITY.md](./SECURITY.md) for dependency and operator-only secret-scanning checks.

`test/delivery.test.ts` exercises the workflow's manual-input guard with valid and invalid public fixtures and checks source/configuration controls structurally. It uses Bash on CI/Linux and Git Bash on Windows; set `IRIS_TEST_BASH` to the executable path for a nonstandard Windows installation. It performs no Git/provider operations and cannot certify native approval, merged ancestry or deployed acceptance.

## TypeScript migration status

All application modules under `src/` now use strict TypeScript, including Worker entrypoints, route dispatch, snapshot publication, v3 provider adapters and recent-transaction refresh/coalescing. Provider/cache JSON enters as `unknown`; consumed fields are narrowed rather than cast to trusted endpoint models. Existing cache-envelope checks remain shallow, so unvalidated cached fields stay unknown. This is not a claim of deep cache validation.

Weighted TPS, production shares, lamport conversion, BigInt token quantities, candle OHLC rules, cache age limits and tracked-pool allow-list behavior retain their existing formulas. All unit tests are now TypeScript. Canonical endpoint schemas describe nested fields and nullable/optional cache compatibility; AJV tests validate fixture and fresh provider serializers, reject wrong atomic-number shapes, and cover partial cached wallet/profile records. Deprecated compatibility envelopes deliberately retain unknown data shapes.

`check:types` checks all application and test `.ts` modules with `allowJs: false`. The tooling guard rejects reintroduced application/test JavaScript. No explicit `any`, non-null assertions or TypeScript suppression comments are permitted. Operational `.mjs` scripts remain JavaScript by design.

`scripts/test.mjs` explicitly discovers both `.test.js` and `.test.ts` files and runs Node's built-in test runner with the pinned `tsx` loader, so migrating a test cannot silently remove it from Node 22 discovery. Local E2E seeding uses the same loader for TypeScript constants. Wrangler remains the application bundler; `tsx` is development/test tooling, not an added Worker runtime dependency. Test helpers/configuration scripts can remain `.mjs` where appropriate. Tests and the dry-run must pass before the next migration slice.

## Market data

Jupiter supplies token metadata, current prices, provider-reported market cap and supply, liquidity, and 24-hour activity. Birdeye supplies on-demand USD token-market OHLCV candles. The Worker supports Birdeye's exact native `1s`, `15s`, `30s`, `1m`, `3m`, `5m`, `15m`, `30m`, `1H`, `2H`, `4H`, `6H`, `8H`, `12H`, `1D`, `3D`, `1W`, and `1M` durations. Candles are cached for 30 minutes and may be served stale for 24 hours; unavailable data remains null rather than fabricated.

`GET /v3/assets/mint/:mint/candles?timeframe=<native-Birdeye-type>` returns one validated 300-candle USD OHLCV page. Its optional `before=<unix-seconds>` query loads the preceding page for backward chart pagination. `GET /v3/assets/mint/:mint/history?range=1d|7d` remains a compatibility route and projects each candle's USD close to `{ timestamp, priceUsd }`. The asset route accepts `includeHistory=false` to avoid loading compatibility history with its metadata.

Birdeye token candles are provider-defined market aggregation and are not a selected Raydium pool. The browser never calls Birdeye directly or receives the API key.

## Provider request resilience

Provider JSON reads use at most two attempts within one 10-second deadline, including body reading and retry delay. Helius `getSupply` uses the specified 20-second budget. These are per-request budgets, not whole-route deadlines. Only fetch transport TypeErrors and HTTP 429/502/503/504 are retried; exhausted deadlines, other HTTP errors, malformed JSON and provider application errors are not. Read-only Helius POST requests explicitly opt in; mutation requests are excluded.

The single retry waits 250–500 ms with jitter, or longer when a valid `Retry-After` (seconds or HTTP date) requires it. If the delay cannot fit within the remaining deadline, no retry occurs. Errors classify HTTP, network, timeout and JSON failures without embedding provider URLs or response bodies. Existing cache freshness, stale/unavailable fallbacks and snapshot publication ordering remain unchanged. A retry may double provider calls for a failing read; there is no new quota, global concurrency cap or cross-isolate lock.

## Operational diagnostics

Worker console logs use structured schema-version-1 objects: event, operation, outcome, provider, requestId, operationId, durationMs, status, attempt, method and failure. Inapplicable values are null. Summary logging records request completion (including denied/preflight/error responses), actual coalesced refresh completion/failure, and provider retry/failure; successful provider reads do not log. A completed refresh means the operation returned, not that every source is fresh or a new snapshot was published. Separate fallback records identify optional-source failures.

Request summaries correlate with the existing response request ID when it has a valid UUID/Cloudflare-Ray shape. Provider retries and final failures share a generated operation ID; refresh summaries have their own operation ID. There is no implicit cross-request/global correlation or attribution of shared work to every caller. Logs omit URLs, query strings, authentication headers, credentials, raw payloads/error messages/stacks, mint/wallet identifiers and coordinator keys. Only allowlisted labels and bounded scalar fields are serialized; unknown failures are classified as unknown. Diagnostic sink failure must not alter responses, retries, cache writes or snapshot pointer ordering. Existing Wrangler console-log observability is used; no monitoring service or public diagnostic API is added.

## Snapshot behavior

The production Cron runs at the start of every hour. Each run refreshes the complete Jupiter/Helius snapshot, the Helius dashboard cache, and a separate DefiLlama dashboard cache. A complete versioned snapshot is written to KV before its pointer is published, so readers never receive a partial refresh.

## Recovery and diagnosis

`test/recovery.test.ts` uses stubbed providers and retained local KV records to verify outage, partial-refresh, expiry and write-failure recovery. It does not certify live-provider behavior or Cloudflare KV propagation across locations.

- Failed versioned-snapshot writes do not attempt pointer publication. A rejected pointer write can leave an unreferenced complete record; the preceding pointer remains readable in the test store. Later refreshes can retry. This is ordered publication, not a distributed transaction or lock.
- Market outages retain the preceding usable snapshot without renewing its timestamp. Once it exceeds 24 hours, snapshot reads use the bundled fixture; unavailable optional discovery categories instead publish empty lists alongside the valid primary catalog.
- The Helius dashboard treats invalid, future and expired cache envelopes as unusable fallback input. A partial network refresh does not extend the transaction sample's lifetime: retained transactions use their original `transactionAsOf`, remain stale through 24 hours inclusive, then become empty/unavailable with a null timestamp. Legacy envelopes that omit `transactionAsOf` use their bounded envelope `asOf`; an explicit null or invalid sample timestamp never receives that fallback. Network groups keep their independent freshness labels; a fresh dashboard envelope does not mean every group is fresh.
- Failed dashboard/DefiLlama/candle cache writes do not establish a fresh cached result. Existing loader fallbacks retain preceding usable data or return the resource's unavailable shape; a later successful refresh can recover.
- Scheduled/authenticated dashboard work reads bounded preceding cache data when the caller supplies none. It still forces provider reads; partial failures preserve the preceding sample rather than clearing it. Optional dashboard/DefiLlama outages do not block valid core snapshot publication. Public transaction metadata preserves an explicit null sample timestamp.

For operator diagnosis, inspect the structured refresh failure and fallback records described above, then the affected resource's freshness metadata. `/ready` alone does not establish Helius-dashboard, chart or DefiLlama health. Core publication failures surface as `REFRESH_FAILED` from authenticated refreshes; inspect the preceding snapshot before considering another explicitly authorized refresh. No destructive cache repair or automatic deployment rollback is introduced.

## API versions

`/v3` is the canonical contract. It exposes Jupiter asset fields, Birdeye candles, compatibility history points, reviewed-pool swaps, and DAS wallet balances. `/v2` and `/v1` remain supported but deprecated compatibility surfaces. The `/v3/wallets/:address/events` route is also deprecated; use `/v3/wallets/:address/transactions` instead.

Responses are JSON envelopes with `meta.requestId`; errors use `error.code`. Snapshot-backed routes include freshness metadata and use public cache-control headers; on-demand wallet and on-chain routes use `Cache-Control: no-store`. See `openapi.yaml` for the complete API contract. The Worker package version, runtime API version, and OpenAPI version are validated together in CI.

Concurrent identical on-demand loads and snapshot/dashboard refreshes share in-flight work within one Worker isolate and KV binding. Keys distinguish provider configuration, exact mint/address, candle timeframe/ending page, holder page, and transaction limit/cursor; injected wallet enrichment functions are also kept separate. Scheduled, authenticated and on-traffic dashboard refreshes use the same coordinator. The first refresh caller supplies the timestamp and preceding data. Entries are removed on success or failure, so later calls can retry; this is not a result cache, distributed lock, global quota or cross-isolate guarantee. Cache lifetimes, response shapes and complete-snapshot-before-pointer ordering remain unchanged.
