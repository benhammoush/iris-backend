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
