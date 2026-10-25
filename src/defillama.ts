/**
 * External dashboard normalization, caching and explicit stale-data handling.
 * @packageDocumentation
 */

import {
  DEFILLAMA_DASHBOARD_KEY,
  DEFILLAMA_FRESH_AFTER_MS,
  STALE_AFTER_MS,
} from './constants.ts';
import { isRecord } from './record.ts';
import { providerJson } from './providerRequest.ts';
import { singleFlight } from './singleFlight.ts';

/** Cache binding operations needed by the external dashboard resource. */
export interface DefiLlamaCache {
  /** Read the JSON cache entry for this dashboard key. */
  get?: (key: string, type: 'json') => Promise<unknown>;
  /** Persist the cache entry using the supplied key and optional expiry policy. */
  put?: (
    key: string,
    value: string,
    options: { expirationTtl?: number },
  ) => Promise<unknown>;
}

// Cache readiness validates the envelope only; cached item fields stay unknown.
/** Stored dashboard payload and the timestamp used to classify freshness. */
export interface CachedDefiLlamaDashboard extends Record<string, unknown> {
  source: 'defillama';
  fetchedAt: string;
  dexes: Record<string, unknown> & { items: unknown[] };
  protocols: Record<string, unknown> & { items: unknown[] };
}

const DEFILLAMA = 'https://api.llama.fi';

/** Coerce with Number and return null only for non-finite results; null and empty text coerce to zero. */
function finiteOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Normalize the provider timestamp for cache and freshness calculations. */
function timestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

/** Normalize supported exchange metrics from the upstream dashboard payload. */
function dexesFrom(payload: unknown) {
  const items: unknown[] | null =
    isRecord(payload) && Array.isArray(payload.protocols)
      ? payload.protocols
      : null;
  if (!items) throw new Error('DefiLlama DEX overview payload is invalid.');
  const normalized = items
    .flatMap((item) => {
      if (
        !isRecord(item) ||
        typeof item.name !== 'string' ||
        !item.name ||
        typeof item.slug !== 'string' ||
        !item.slug
      )
        return [];
      return [
        {
          name: item.name,
          slug: item.slug,
          logo: typeof item.logo === 'string' && item.logo ? item.logo : null,
          total24hUsd: finiteOrNull(item.total24h),
          total7dUsd: finiteOrNull(item.total7d),
          change1dPct: finiteOrNull(item.change_1d),
        },
      ];
    })
    .sort(
      (left, right) =>
        (right.total24hUsd ?? -Infinity) - (left.total24hUsd ?? -Infinity),
    );
  return {
    total24hUsd: normalized.reduce(
      (total, item) => total + (item.total24hUsd ?? 0),
      0,
    ),
    total7dUsd: normalized.reduce(
      (total, item) => total + (item.total7dUsd ?? 0),
      0,
    ),
    items: normalized,
  };
}

/** Normalize supported protocol metrics from the upstream dashboard payload. */
function protocolsFrom(payload: unknown) {
  if (!Array.isArray(payload))
    throw new Error('DefiLlama protocol payload is invalid.');
  const items: unknown[] = payload;
  const normalized = items
    .flatMap((item) => {
      if (!isRecord(item)) return [];
      const chainTvls = isRecord(item.chainTvls) ? item.chainTvls : {};
      const solanaTvlUsd = finiteOrNull(chainTvls.Solana);
      if (
        !item ||
        !Array.isArray(item.chains) ||
        !item.chains.includes('Solana') ||
        typeof item.name !== 'string' ||
        !item.name ||
        typeof item.slug !== 'string' ||
        !item.slug ||
        solanaTvlUsd === null
      )
        return [];
      return [
        {
          name: item.name,
          slug: item.slug,
          logo: typeof item.logo === 'string' && item.logo ? item.logo : null,
          category: typeof item.category === 'string' ? item.category : null,
          solanaTvlUsd,
          change1dPct: finiteOrNull(item.change_1d),
          change7dPct: finiteOrNull(item.change_7d),
        },
      ];
    })
    .sort((left, right) => right.solanaTvlUsd - left.solanaTvlUsd);
  return { total: normalized.length, items: normalized };
}

/** Check that cached dashboard data has the fields required for safe reuse. */
export function isUsableDefiLlamaDashboard(
  dashboard: unknown,
): dashboard is CachedDefiLlamaDashboard {
  return Boolean(
    isRecord(dashboard) &&
    timestamp(dashboard.fetchedAt) &&
    dashboard.source === 'defillama' &&
    isRecord(dashboard.dexes) &&
    Array.isArray(dashboard.dexes.items) &&
    isRecord(dashboard.protocols) &&
    Array.isArray(dashboard.protocols.items),
  );
}

/** Refresh the dashboard and retain usable cached data according to the stale-data policy. */
async function defiLlamaWork(
  kv: DefiLlamaCache | null | undefined,
  now: Date,
  retainStale: boolean,
) {
  const [dexPayload, protocolPayload] = await Promise.all([
    providerJson(
      `${DEFILLAMA}/overview/dexs/Solana?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`,
      {},
      { provider: 'DefiLlama DEX overview' },
    ),
    providerJson(
      `${DEFILLAMA}/protocols`,
      {},
      { provider: 'DefiLlama protocol' },
    ),
  ]);
  const dashboard = {
    source: 'defillama',
    fetchedAt: now.toISOString(),
    dexes: dexesFrom(dexPayload),
    protocols: protocolsFrom(protocolPayload),
  };
  if (kv?.put)
    await kv.put(
      DEFILLAMA_DASHBOARD_KEY,
      JSON.stringify(dashboard),
      retainStale ? {} : { expirationTtl: Math.ceil(STALE_AFTER_MS / 1000) },
    );
  return dashboard;
}

/** Coalesce equivalent dashboard refreshes within the same cache binding. */
export function refreshDefiLlamaDashboard(
  kv?: DefiLlamaCache | null,
  now = new Date(),
  retainStale = false,
) {
  return singleFlight(kv, ['defillama-refresh', retainStale], () =>
    refreshDiagnostic('defillama-refresh', () =>
      defiLlamaWork(kv, now, retainStale),
    ),
  );
}

/** Resolve dashboard data with explicit cache freshness and fallback semantics. */
export async function loadDefiLlamaDashboard(
  kv?: DefiLlamaCache | null,
  now = Date.now(),
  retainStale = false,
): Promise<{
  dashboard: CachedDefiLlamaDashboard | null;
  state: 'unavailable' | 'fresh' | 'stale';
}> {
  const cached: unknown = kv?.get
    ? await kv.get(DEFILLAMA_DASHBOARD_KEY, 'json')
    : null;
  if (!isUsableDefiLlamaDashboard(cached))
    return { dashboard: null, state: 'unavailable' };
  const age = now - Date.parse(cached.fetchedAt);
  if (age < 0 || (!retainStale && age > STALE_AFTER_MS))
    return { dashboard: null, state: 'unavailable' };
  return {
    dashboard: cached,
    state: age <= DEFILLAMA_FRESH_AFTER_MS ? 'fresh' : 'stale',
  };
}
import { refreshDiagnostic } from './diagnostics.ts';
