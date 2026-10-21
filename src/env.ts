import type {
  KVNamespace,
  KVNamespacePutOptions,
  D1Database,
  RateLimit,
} from '@cloudflare/workers-types';

// JSON/string operations consumed by Iris; a Cloudflare KVNamespace implements this surface.
export interface SnapshotStore {
  get(key: string, type: 'json'): Promise<unknown>;
  put(
    key: string,
    value: string,
    options?: Pick<KVNamespacePutOptions, 'expirationTtl'>,
  ): Promise<unknown>;
}

export type CloudflareSnapshotStore = KVNamespace extends SnapshotStore
  ? SnapshotStore
  : never;

export interface WorkerVariables {
  CORS_ORIGINS?: string;
  HELIUS_API_KEY?: string;
  JUPITER_API_KEY?: string;
  BIRDEYE_API_KEY?: string;
  PROVIDER_MODE?: string;
  RETAIN_STALE_MARKET_DATA?: string;
  WATCHLIST_ENABLED?: string;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
}

export interface Env extends WorkerVariables {
  SNAPSHOTS: CloudflareSnapshotStore;
  REFRESH_TOKEN?: string;
  WATCHLIST_DB?: D1Database;
  WATCHLIST_RATE_LIMITER?: RateLimit;
}
