/**
 * Worker binding contracts and cache-store interfaces.
 * @packageDocumentation
 */

import type {
  KVNamespace,
  KVNamespacePutOptions,
  D1Database,
  RateLimit,
} from '@cloudflare/workers-types';

// JSON/string operations consumed by Iris; a Cloudflare KVNamespace implements this surface.
/** Minimal cache-store capabilities used by snapshot readers and writers. */
export interface SnapshotStore {
  /** Read a cached JSON value; missing entries remain unavailable to the caller. */
  get(key: string, type: 'json'): Promise<unknown>;
  /** Persist the cache entry using the supplied key and optional expiry policy. */
  put(
    key: string,
    value: string,
    options?: Pick<KVNamespacePutOptions, 'expirationTtl'>,
  ): Promise<unknown>;
}

/** Worker KV binding shape supported by the snapshot-store abstraction. */
export type CloudflareSnapshotStore = KVNamespace extends SnapshotStore
  ? SnapshotStore
  : never;

/** Runtime configuration variables resolved separately from storage bindings. */
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

/** Bindings supplied to the Worker; provider credentials remain server-side. */
export interface Env extends WorkerVariables {
  SNAPSHOTS: CloudflareSnapshotStore;
  REFRESH_TOKEN?: string;
  WATCHLIST_DB?: D1Database;
  WATCHLIST_RATE_LIMITER?: RateLimit;
}
