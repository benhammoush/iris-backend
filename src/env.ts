import type {
  KVNamespace,
  KVNamespacePutOptions,
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
}

export interface Env extends WorkerVariables {
  SNAPSHOTS: CloudflareSnapshotStore;
  REFRESH_TOKEN?: string;
}
