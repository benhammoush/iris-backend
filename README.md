# Iris — backend

A read-only API for Solana market data, token details and public-wallet activity.
It powers the [Iris dashboard](https://github.com/benhammoush/iris-frontend)
without requiring wallet connections or signatures.

## Tech stack and system design

| Layer               | Tools                               |
| ------------------- | ----------------------------------- |
| API runtime         | TypeScript, Cloudflare Workers      |
| Cache and snapshots | Cloudflare KV                       |
| Data providers      | Helius, Jupiter, Birdeye, DefiLlama |
| API contract        | OpenAPI                             |
| Testing             | Node.js test runner, AJV            |

The frontend sends market and wallet requests to the Worker, which handles
provider access and keeps credentials server-side. Scheduled jobs publish complete
versioned snapshots to KV; other requests fetch and cache data on demand.

Responses preserve freshness information and unavailable values rather than
presenting missing data as zero. The service exposes public information only:
it does not sign transactions or move funds.

The [OpenAPI contract](openapi.yaml) defines the endpoints, and
[ARCHITECTURE.md](ARCHITECTURE.md) describes the request and cache flows.

[Private watchlists](WATCHLISTS.md) have a local Worker API and D1 migration,
disabled by default. Browser accounts, permanent account deletion and hosted
setup/acceptance remain separate work; public browsing does not require login.

## Local development and checks

Run `npm ci` and `npm run dev` to start the local Worker on port 8787. Its default
local KV is separate from hosted storage. From the frontend repository, configure
`VITE_API_BASE=http://localhost:8787` to use it. See the frontend's
[environment runbook](https://github.com/benhammoush/iris-frontend/blob/main/ENVIRONMENTS.md)
before changing hosted environments or releasing.

Run `npm run check` for the complete Worker gate: lint and formatting, tooling,
dependency audit, version and type checks, OpenAPI lint, unit and merge-policy
tests, and a production bundle dry-run. The bundle step does not deploy the
Worker.
