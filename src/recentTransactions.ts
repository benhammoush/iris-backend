import {
  STALE_AFTER_MS,
  V3_HELIUS_DASHBOARD_KEY,
  V3_RECENT_TRANSACTIONS_FRESH_AFTER_MS,
  V3_RECENT_TRANSACTIONS_KEY,
  V3_RECENT_TRANSACTIONS_MAX,
} from './constants.ts';
import { heliusRpc } from './v3.ts';
import { providerJson } from './providerRequest.ts';
import { singleFlight, providerKey } from './singleFlight.ts';
import {
  refreshDashboardNetworkMetrics,
  staleDashboardNetwork,
} from './network.ts';
import { array, record, isRecord } from './record.ts';
import type { Env } from './env.ts';
import type { ProviderConfig as WorkerConfig } from './config.ts';

interface Sample extends Record<string, unknown> {
  asOf: string;
  slot: number;
  transactions: unknown[];
}

function usableSample(sample: unknown): sample is Sample {
  return (
    isRecord(sample) &&
    typeof sample.asOf === 'string' &&
    Number.isFinite(Date.parse(sample.asOf)) &&
    Number.isInteger(sample.slot) &&
    Array.isArray(sample.transactions)
  );
}

function usableDashboardSample(sample: unknown): sample is Sample {
  return (
    usableSample(sample) &&
    isRecord(sample.network) &&
    isRecord(sample.network.chain) &&
    isRecord(sample.network.performance) &&
    isRecord(sample.network.fees)
  );
}

/**
 * Bounds a failed block read's fallback by the original transaction timestamp.
 * Partial network refreshes renew the envelope, not the sampled block's lifetime.
 * Legacy envelopes that omit the sample timestamp use their envelope timestamp;
 * explicit null, invalid, future or expired timestamps cannot prove usable data.
 */
function precedingTransactions(previous: unknown, now: Date) {
  const prior = record(previous);
  const asOf = Object.hasOwn(prior, 'transactionAsOf')
    ? prior.transactionAsOf
    : prior.asOf;
  const age =
    typeof asOf === 'string' ? now.getTime() - Date.parse(asOf) : Infinity;
  return Number.isFinite(age) && age >= 0 && age <= STALE_AFTER_MS
    ? { transactions: array(prior.transactions), transactionAsOf: asOf }
    : { transactions: [], transactionAsOf: null };
}

/**
 * Reads one bounded dashboard recovery input for both forced and on-traffic work.
 * This does not suppress a forced provider refresh or renew stored timestamps.
 * KV read errors propagate; malformed envelopes are treated as absent data.
 */
async function precedingDashboard(env: Env, now: Date) {
  const stored = env.SNAPSHOTS?.get
    ? await env.SNAPSHOTS.get(V3_HELIUS_DASHBOARD_KEY, 'json')
    : null;
  const age = usableDashboardSample(stored)
    ? now.getTime() - Date.parse(stored.asOf)
    : Infinity;
  const preceding = precedingTransactions(stored, now);
  const cached =
    age >= 0 && age <= STALE_AFTER_MS
      ? {
          ...record(stored),
          ...preceding,
          transactionsFreshness:
            preceding.transactionAsOf === null
              ? 'unavailable'
              : record(stored).transactionsFreshness,
        }
      : null;
  return { cached, age };
}

function signaturesFromBlock(value: unknown): string[] {
  const block = record(value);
  const signatures = Array.isArray(block?.signatures)
    ? block.signatures
    : Array.isArray(block?.transactions)
      ? block.transactions
      : [];
  return [
    ...new Set(
      array(signatures).filter(
        (signature): signature is string =>
          typeof signature === 'string' && Boolean(signature),
      ),
    ),
  ];
}

function actionFromParsedEvent(event: unknown): string | null {
  const parsed = record(record(event).parsed);
  const type = record(parsed.summary).type;
  if (typeof type === 'string' && type) return type;
  const instruction = array(parsed.instructions)
    .map(record)
    .find(
      (item) =>
        typeof item.instructionName === 'string' && item.instructionName,
    );
  return typeof instruction?.instructionName === 'string'
    ? instruction.instructionName
    : null;
}

async function parsedEvents(
  signatures: string[],
  apiKey: string,
): Promise<unknown[]> {
  const body = await providerJson(
    `https://mainnet.helius-rpc.com/v1/parsed-events/transactions?api-key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transactions: signatures }),
    },
    { provider: 'Helius Parsed Events', readOnlyPost: true },
  );
  return Array.isArray(record(body).data)
    ? array(record(body).data)
    : Array.isArray(body)
      ? body
      : [];
}

async function recentSampleWork(
  env: Env,
  config: WorkerConfig,
  now = new Date(),
  confirmedSlot: number | null = null,
  persist = true,
) {
  const apiKey = config.heliusApiKey || env.HELIUS_API_KEY;
  if (!apiKey) throw new Error('Helius is not configured.');
  const slot =
    confirmedSlot ??
    (await heliusRpc('getSlot', [{ commitment: 'confirmed' }], apiKey));
  if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0)
    throw new Error('Helius returned an invalid confirmed slot.');
  const block = await heliusRpc(
    'getBlock',
    [
      slot,
      {
        commitment: 'confirmed',
        transactionDetails: 'signatures',
        rewards: false,
        maxSupportedTransactionVersion: 1,
      },
    ],
    apiKey,
  );
  const blockTimeValue = record(block).blockTime;
  const blockTime =
    typeof blockTimeValue === 'number' && Number.isFinite(blockTimeValue)
      ? new Date(blockTimeValue * 1000).toISOString()
      : null;
  const signatures = signaturesFromBlock(block).slice(
    0,
    V3_RECENT_TRANSACTIONS_MAX,
  );
  let parsed: unknown[] | null = null;
  try {
    parsed = await parsedEvents(signatures, apiKey);
  } catch (cause) {
    // A parser outage must not stop the lightweight block sample from advancing.
    unavailable('parsed-events', 'Helius', cause);
  }
  const parsedBySignature = new Map(
    (parsed || [])
      .filter(
        (event): event is Record<string, unknown> & { signature: string } =>
          isRecord(event) && typeof event.signature === 'string',
      )
      .map((event) => [event.signature, event]),
  );
  const transactions = signatures.map((signature) => ({
    signature,
    slot,
    blockTime,
    status: 'confirmed',
    action: actionFromParsedEvent(parsedBySignature.get(signature)),
  }));
  const sample = {
    version: 2,
    source: parsed ? 'helius-rpc-parsed-events' : 'helius-rpc',
    asOf: now.toISOString(),
    slot,
    transactions,
  };
  if (persist && env.SNAPSHOTS?.put)
    await env.SNAPSHOTS.put(
      V3_RECENT_TRANSACTIONS_KEY,
      JSON.stringify(sample),
      { expirationTtl: Math.ceil(STALE_AFTER_MS / 1000) },
    );
  return sample;
}

async function dashboardSampleWork(
  env: Env,
  config: WorkerConfig,
  previous: unknown = undefined,
  now = new Date(),
) {
  const apiKey = config.heliusApiKey || env.HELIUS_API_KEY;
  if (!apiKey) throw new Error('Helius is not configured.');
  // Cron/authenticated callers omit fallback data. Read it inside the actual
  // coalesced operation, so all waiters use the first caller's bounded input.
  if (previous === undefined)
    previous = (await precedingDashboard(env, now)).cached;
  const confirmedSlot = await heliusRpc(
    'getSlot',
    [{ commitment: 'confirmed' }],
    apiKey,
  );
  if (
    typeof confirmedSlot !== 'number' ||
    !Number.isInteger(confirmedSlot) ||
    confirmedSlot < 0
  )
    throw new Error('Helius returned an invalid confirmed slot.');
  const [transactionsResult, networkResult] = await Promise.allSettled([
    refreshRecentTransactionSample(env, config, now, confirmedSlot, false),
    refreshDashboardNetworkMetrics(
      (method, params, timeoutMs) =>
        heliusRpc(method, params, apiKey, timeoutMs),
      confirmedSlot,
      record(previous).network,
      now,
    ),
  ]);
  if (transactionsResult.status === 'rejected')
    unavailable('recent-refresh', 'Helius', transactionsResult.reason);
  if (networkResult.status === 'rejected')
    unavailable('network-refresh', 'Helius', networkResult.reason);
  if (
    transactionsResult.status === 'rejected' &&
    networkResult.status === 'rejected'
  )
    throw new Error('Helius dashboard refresh failed.');
  const fallback = precedingTransactions(previous, now);
  const transactions =
    transactionsResult.status === 'fulfilled'
      ? transactionsResult.value.transactions
      : fallback.transactions;
  const network =
    networkResult.status === 'fulfilled'
      ? networkResult.value
      : staleDashboardNetwork(record(previous).network);
  const transactionsFreshness =
    transactionsResult.status === 'fulfilled'
      ? 'fresh'
      : transactions.length
        ? 'stale'
        : 'unavailable';
  const transactionAsOf =
    transactionsResult.status === 'fulfilled'
      ? now.toISOString()
      : fallback.transactionAsOf;
  const sample = {
    version: 1,
    source: 'helius-rpc',
    asOf: now.toISOString(),
    slot: confirmedSlot,
    transactionAsOf,
    transactionsFreshness,
    transactions,
    network,
  };
  if (env.SNAPSHOTS?.put)
    await env.SNAPSHOTS.put(V3_HELIUS_DASHBOARD_KEY, JSON.stringify(sample), {
      expirationTtl: Math.ceil(STALE_AFTER_MS / 1000),
    });
  return sample;
}

export function refreshRecentTransactionSample(
  env: Env,
  config: WorkerConfig,
  now = new Date(),
  confirmedSlot: number | null = null,
  persist = true,
) {
  return singleFlight(
    env.SNAPSHOTS ?? env,
    ['recent-refresh', ...providerKey(env, config), confirmedSlot, persist],
    () =>
      refreshDiagnostic('recent-refresh', () =>
        recentSampleWork(env, config, now, confirmedSlot, persist),
      ),
  );
}

export function refreshHeliusDashboardSample(
  env: Env,
  config: WorkerConfig,
  previous: unknown = undefined,
  now = new Date(),
) {
  return singleFlight(
    env.SNAPSHOTS ?? env,
    ['dashboard-refresh', ...providerKey(env, config)],
    () =>
      refreshDiagnostic('dashboard-refresh', () =>
        dashboardSampleWork(env, config, previous, now),
      ),
  );
}

export async function loadHeliusDashboardSample(
  env: Env,
  config: WorkerConfig,
  now = new Date(),
  refreshIfStale = false,
  cacheOnly = false,
) {
  const { cached, age } = await precedingDashboard(env, now);
  if (age >= 0 && age <= V3_RECENT_TRANSACTIONS_FRESH_AFTER_MS)
    return { ...record(cached), freshness: 'fresh' };
  if (refreshIfStale && !cacheOnly) {
    try {
      const sample = await refreshHeliusDashboardSample(
        env,
        config,
        cached,
        now,
      );
      return { ...sample, freshness: 'fresh' };
    } catch (cause) {
      unavailable('dashboard-refresh', 'Helius', cause);
    }
  }
  if (age >= 0 && age <= STALE_AFTER_MS)
    return { ...record(cached), freshness: 'stale' };
  return {
    source: 'helius-rpc',
    asOf: null,
    slot: null,
    transactionAsOf: null,
    transactionsFreshness: 'unavailable',
    transactions: [],
    network: staleDashboardNetwork(),
    freshness: 'unavailable',
  };
}

export async function loadRecentTransactionSample(
  env: Env,
  config: WorkerConfig,
  now = new Date(),
  refreshIfStale = false,
) {
  const cached = env.SNAPSHOTS?.get
    ? await env.SNAPSHOTS.get(V3_RECENT_TRANSACTIONS_KEY, 'json')
    : null;
  const age = usableSample(cached)
    ? now.getTime() - Date.parse(cached.asOf)
    : Infinity;
  if (age >= 0 && age <= V3_RECENT_TRANSACTIONS_FRESH_AFTER_MS)
    return { ...record(cached), freshness: 'fresh' };
  if (refreshIfStale) {
    try {
      const sample = await refreshRecentTransactionSample(env, config, now);
      return { ...sample, freshness: 'fresh' };
    } catch (cause) {
      unavailable('recent-refresh', 'Helius', cause);
    }
  }
  if (age >= 0 && age <= STALE_AFTER_MS)
    return { ...record(cached), freshness: 'stale' };
  return {
    source: 'helius-rpc-parsed-events',
    asOf: null,
    slot: null,
    transactions: [],
    freshness: 'unavailable',
  };
}
import { unavailable, refreshDiagnostic } from './diagnostics.ts';
