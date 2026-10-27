/**
 * Public resource routing, cache policy and response-contract adaptation.
 * @packageDocumentation
 */

import {
  API_VERSION,
  CANDLE_KEY_PREFIX,
  CANDLE_PAGE_SIZE,
  REFRESH_INTERVAL_MINUTES,
  REFRESH_INTERVAL_MS,
} from './constants.ts';
import { error, json } from './http.ts';
import { ProviderRequestError, providerStop } from './providerRequest.ts';
import {
  candlePlan,
  fetchCandles,
  legacyHistoryPlan,
  mapV3Asset,
  tokenByMint,
} from './market.ts';
import {
  isUsableSnapshot,
  loadWalletData,
  resolveSnapshot,
} from './snapshot.ts';
import { isBase58PublicKey } from './transforms.ts';
import {
  loadV3AssetDistribution,
  loadV3AssetHolders,
  loadV3AssetOnchain,
  loadV3AssetTransactions,
  loadV3Events,
  loadV3Wallet,
  mapV3HistoryPoints,
  v3Asset,
} from './v3.ts';
import { loadHeliusDashboardSample } from './recentTransactions.ts';
import { loadDefiLlamaDashboard } from './defillama.ts';
import { singleFlight, providerKey } from './singleFlight.ts';
import { array, record, scalarText } from './record.ts';
import type { Env, SnapshotStore } from './env.ts';
import type { WorkerConfig } from './config.ts';

/** Read-only store used exclusively for explicit local/CI candle fixtures. */
type CandleFixtures = Pick<SnapshotStore, 'get'>;

/** Validate and normalize a timestamp before using it in the response contract.
 * @param value - Unknown timestamp field.
 * @returns Parseable timestamp text, or null without coercion.
 */
function dateString(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

/** Read the classified error code or use the explicit fallback.
 * @param value - Unknown operation failure.
 * @param fallback - Controlled classification for unrecognized failures.
 * @returns Its nonempty string code, or the supplied fallback.
 */
function failureCode(value: unknown, fallback: string): string {
  const code = record(value).code;
  return typeof code === 'string' && code ? code : fallback;
}

/** Fetch candles on demand, or read seeded fixtures only in explicit cache-only mode.
 * @param kv - Optional local/CI fixture store; never read or written in live mode.
 * @param mint - Exact requested mint identity.
 * @param apiKey - Optional server-only Birdeye credential.
 * @param timeframe - Supported candle interval.
 * @param endTimestamp - Exclusive earlier-history boundary in Unix seconds, or null for latest.
 * @param providerMode - Live-read or cache-only policy.
 * @returns Fresh provider candles or an explicit unavailable result, without stored fallbacks.
 */
async function candlesWork(
  kv: CandleFixtures | null | undefined,
  mint: string,
  apiKey?: string,
  timeframe = '1H',
  endTimestamp: number | null = null,
  providerMode = 'live',
) {
  const plan = candlePlan(timeframe);
  if (!plan) throw new Error('Unsupported candle timeframe.');
  if (providerMode === 'cache-only') {
    const endKey = endTimestamp === null ? 'latest' : String(endTimestamp);
    const key = `${CANDLE_KEY_PREFIX}${mint}:${plan.timeframe}:${CANDLE_PAGE_SIZE}:usd:${endKey}`;
    const fixture = record(kv ? await kv.get(key, 'json') : null);
    const fetchedAt = dateString(fixture.fetchedAt);
    const available = fetchedAt !== null && Array.isArray(fixture.candles);
    return {
      candles: available ? array(fixture.candles) : null,
      timeframe: plan.timeframe,
      state: available ? 'fixture' : 'unavailable',
      fetchedAt: available ? fetchedAt : null,
      source: 'birdeye',
    };
  }
  try {
    const result = await fetchCandles(
      mint,
      apiKey,
      plan.timeframe,
      endTimestamp === null ? Date.now() : endTimestamp * 1000,
    );
    return {
      candles: result?.candles ?? null,
      timeframe: result?.timeframe ?? plan.timeframe,
      state: result ? 'fresh' : 'unavailable',
      fetchedAt: result ? new Date().toISOString() : null,
      source: 'birdeye',
    };
  } catch (cause) {
    unavailable('candles', 'Birdeye', cause);
    return {
      candles: null,
      timeframe: plan.timeframe,
      state: 'unavailable',
      fetchedAt: null,
      source: 'birdeye',
    };
  }
}

/** Share only in-flight identical candle requests; completed results are never retained.
 * @param kv - Optional fixture binding also identifying the environment scope.
 * @param mint - Exact requested mint identity.
 * @param apiKey - Optional server-only credential included in sharing identity.
 * @param timeframe - Supported candle interval.
 * @param endTimestamp - Earlier-history boundary in Unix seconds, or null for latest.
 * @param providerMode - Live-read or cache-only policy included in sharing identity.
 * @returns The coalesced candle result without mixing windows or provider configurations.
 */
export function candlesForAsset(
  kv: CandleFixtures | null | undefined,
  mint: string,
  apiKey?: string,
  timeframe = '1H',
  endTimestamp: number | null = null,
  providerMode = 'live',
) {
  return singleFlight(
    kv,
    [
      'candles',
      mint,
      apiKey,
      timeframe,
      CANDLE_PAGE_SIZE,
      endTimestamp,
      providerMode,
    ],
    () => candlesWork(kv, mint, apiKey, timeframe, endTimestamp, providerMode),
  );
}

/** Adapt the legacy history range to the asset candle contract.
 * @param kv - Optional local/CI candle fixture binding.
 * @param mint - Exact requested mint identity.
 * @param apiKey - Optional server-only Birdeye credential.
 * @param range - Supported legacy history range.
 * @param providerMode - Live-read or cache-only policy.
 * @returns Range-filtered closing-price points with the candle result's freshness metadata.
 */
export async function historyForAsset(
  kv: CandleFixtures | null | undefined,
  mint: string,
  apiKey?: string,
  range = '7d',
  providerMode = 'live',
) {
  const plan = legacyHistoryPlan(range);
  if (!plan) throw new Error('Unsupported price-history range.');
  const history = await candlesForAsset(
    kv,
    mint,
    apiKey,
    plan.timeframe,
    null,
    providerMode,
  );
  const cutoff = Date.now() - plan.durationMs;
  return {
    ...history,
    points:
      history.candles
        ?.map(record)
        .filter(
          (candle) =>
            typeof candle.timestamp === 'string' &&
            Date.parse(candle.timestamp) >= cutoff,
        )
        .map((candle) => ({
          date: candle.timestamp,
          price: candle.closeUsd,
        })) || null,
  };
}

/** Build v3 response metadata while preserving freshness and history availability.
 * @param meta - Snapshot and request-correlation metadata.
 * @param historyValue - Optional history/candle result with its own observation and state.
 * @returns Combined provenance and freshness without inventing unavailable history.
 */
function v3Meta(meta: Record<string, unknown>, historyValue: unknown = null) {
  const history = record(historyValue);
  return {
    ...meta,
    provenance: {
      snapshot: meta.snapshotState,
      market: meta.marketDataSource,
      history: history?.points || history?.candles ? history.source : null,
    },
    freshness: {
      snapshot: meta.snapshotState,
      history: history?.state ?? null,
      historyFetchedAt: history?.fetchedAt ?? null,
    },
  };
}

/** Normalize a swap into the v3 response contract.
 * @param value - Unknown stored swap record.
 * @returns Supported identity and exact scalar leg quantities with decimal context.
 */
function v3Swap(value: unknown) {
  const swap = record(value);
  const input = record(swap.input);
  const output = record(swap.output);
  return {
    id: swap.id ?? null,
    timestamp: swap.timestamp ?? null,
    protocol: swap.protocol ?? null,
    wallet: swap.wallet ?? null,
    input: swap.input
      ? {
          mint: input.mint ?? null,
          atomicAmount: scalarText(input.rawAmount ?? '0', 'invalid'),
          decimals: Number.isInteger(input.decimals) ? input.decimals : null,
        }
      : null,
    output: swap.output
      ? {
          mint: output.mint ?? null,
          atomicAmount: scalarText(output.rawAmount ?? '0', 'invalid'),
          decimals: Number.isInteger(output.decimals) ? output.decimals : null,
        }
      : null,
  };
}

/** Dispatch the validated public API request to its resource handler.
 * @param request - Incoming public request URL after method/origin guards.
 * @param env - Selected cache and provider bindings.
 * @param config - Validated effective provider and cache-only policy settings.
 * @param id - Request correlation identifier.
 * @param origin - Optional validated allowed browser origin.
 * @returns A correlated public response with resource-specific cache and failure semantics.
 */
export async function route(
  request: Pick<Request, 'url'>,
  env: Env,
  config: WorkerConfig,
  id: string,
  origin?: string | null,
): Promise<Response> {
  const url = new URL(request.url);
  const retainStale = env.RETAIN_STALE_MARKET_DATA === 'true';
  if (url.pathname === '/health')
    return json(
      { data: { status: 'ok', version: API_VERSION }, meta: { requestId: id } },
      200,
      id,
      origin,
    );
  if (url.pathname === '/ready') {
    if (!env.SNAPSHOTS)
      return error(
        'NOT_READY',
        'Snapshot KV binding is unavailable.',
        503,
        id,
        origin,
      );
    try {
      const { snapshot, state } = await resolveSnapshot(
        env.SNAPSHOTS,
        Date.now(),
        retainStale,
      );
      if (!isUsableSnapshot(snapshot))
        return error(
          'NOT_READY',
          'No usable snapshot is available.',
          503,
          id,
          origin,
        );
      return json(
        {
          data: { status: 'ready', snapshotState: state },
          meta: { requestId: id },
        },
        200,
        id,
        origin,
        { 'cache-control': 'no-store', 'x-snapshot-state': state },
      );
    } catch {
      return error(
        'NOT_READY',
        'Snapshot KV binding is unavailable.',
        503,
        id,
        origin,
      );
    }
  }
  const { snapshot, state } = await resolveSnapshot(
    env.SNAPSHOTS,
    Date.now(),
    retainStale,
  );
  const meta = {
    requestId: id,
    snapshotState: state,
    snapshotCreatedAt: snapshot.createdAt,
    marketDataSource: snapshot.market.source,
    marketDataAsOf: snapshot.market.asOf,
    refreshIntervalMinutes: REFRESH_INTERVAL_MINUTES,
    nextScheduledRefreshAt: new Date(
      (Math.floor(Date.now() / REFRESH_INTERVAL_MS) + 1) * REFRESH_INTERVAL_MS,
    ).toISOString(),
  };
  /** Build explicit cache lifetimes including the allowed stale-revalidation window.
   * @param maxAge - Fresh browser/shared cache lifetime in seconds.
   * @param staleWhileRevalidate - Permitted stale-revalidation window in seconds.
   * @returns Scoped public cache headers retaining origin variance and snapshot state.
   */
  const cacheHeaders = (maxAge: number, staleWhileRevalidate: number) => ({
    'cache-control': `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`,
    vary: 'Origin',
    'x-snapshot-state': state,
  });
  const snapshotHeaders = cacheHeaders(60, 300);
  const dashboardHeaders = cacheHeaders(60, 60);
  const defillamaHeaders = cacheHeaders(300, 900);
  const noStoreSnapshotHeaders = {
    'cache-control': 'no-store',
    'x-snapshot-state': state,
  };
  if (url.pathname === '/v3/status')
    return json(
      {
        data: {
          version: API_VERSION,
          chain: 'solana',
          provenance: {
            snapshot: snapshot.source,
            market: snapshot.market.source,
            reviewedSwaps: record(snapshot.market.swaps).source ?? 'unknown',
          },
          freshness: {
            snapshot: state,
            snapshotCreatedAt: snapshot.createdAt,
            marketDataAsOf: snapshot.market.asOf,
          },
          reviewedSwaps: {
            scope:
              record(snapshot.market.swaps).scope ?? 'registered-liquid-pools',
            count: record(snapshot.market.swaps).count ?? snapshot.swaps.length,
          },
        },
        meta: v3Meta(meta),
      },
      200,
      id,
      origin,
      snapshotHeaders,
    );
  if (url.pathname === '/v3/network')
    return json(
      {
        data: snapshot.network || {
          source: 'fixture',
          fetchedAt: null,
          chain: { state: 'unavailable', asOf: null },
          performance: { state: 'unavailable', asOf: null },
          production: { state: 'unavailable', asOf: null },
          fees: { state: 'unavailable', asOf: null },
          validators: { state: 'unavailable', asOf: null },
          economics: { state: 'unavailable', asOf: null },
          reliability: { state: 'unavailable', asOf: null },
        },
        meta: v3Meta(meta),
      },
      200,
      id,
      origin,
      snapshotHeaders,
    );
  if (url.pathname === '/v3/assets')
    return json(
      { data: snapshot.assets.map(v3Asset), meta: v3Meta(meta) },
      200,
      id,
      origin,
      snapshotHeaders,
    );
  if (url.pathname === '/v3/catalogs') {
    const catalogs = record(
      snapshot.catalogs || {
        topTraded: snapshot.assets,
        trending: [],
        recent: [],
      },
    );
    return json(
      {
        data: {
          topTraded: array(catalogs.topTraded).map(v3Asset),
          trending: array(catalogs.trending).map(v3Asset),
          recent: array(catalogs.recent).map(v3Asset),
        },
        meta: v3Meta(meta),
      },
      200,
      id,
      origin,
      snapshotHeaders,
    );
  }
  if (url.pathname === '/v3/defillama') {
    const { dashboard, state: freshness } = await loadDefiLlamaDashboard(
      env.SNAPSHOTS,
      Date.now(),
      retainStale,
    );
    const data = dashboard || {
      source: 'defillama',
      fetchedAt: null,
      dexes: { total24hUsd: null, total7dUsd: null, items: [] },
      protocols: { total: 0, items: [] },
    };
    return json(
      {
        data,
        meta: {
          ...v3Meta(meta),
          defillama: {
            source: 'defillama',
            freshness,
            fetchedAt: data.fetchedAt,
          },
        },
      },
      200,
      id,
      origin,
      defillamaHeaders,
    );
  }
  if (url.pathname === '/v3/swaps')
    return json(
      {
        data: {
          scope:
            record(snapshot.market.swaps).scope ?? 'registered-liquid-pools',
          swaps: snapshot.swaps.map(v3Swap),
        },
        meta: v3Meta(meta),
      },
      200,
      id,
      origin,
      snapshotHeaders,
    );
  if (url.pathname === '/v3/transactions/recent') {
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 15 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 10 || limit > 20)
      return error(
        'INVALID_RECENT_TRANSACTION_LIMIT',
        'limit must be an integer from 10 to 20.',
        400,
        id,
        origin,
      );
    const sample = record(
      await loadHeliusDashboardSample(
        env,
        config,
        new Date(),
        true,
        config.providerMode === 'cache-only',
      ),
    );
    const sampleNetwork = record(sample.network);
    return json(
      {
        data: {
          network: sample.network,
          transactions: array(sample.transactions).slice(0, limit),
        },
        meta: {
          ...v3Meta(meta),
          recentTransactions: {
            source: sample.source,
            freshness: sample.transactionsFreshness ?? sample.freshness,
            // Null means no usable transaction sample; it is not a missing
            // legacy field and must not inherit the network refresh timestamp.
            asOf: Object.hasOwn(sample, 'transactionAsOf')
              ? sample.transactionAsOf
              : sample.asOf,
            slot: sample.slot,
            sampled: true,
            limit,
          },
          network: {
            source: sampleNetwork.source,
            freshness: {
              chain: record(sampleNetwork.chain).state,
              performance: record(sampleNetwork.performance).state,
              fees: record(sampleNetwork.fees).state,
            },
            asOf: sampleNetwork.fetchedAt,
          },
        },
      },
      200,
      id,
      origin,
      dashboardHeaders,
    );
  }
  if (url.pathname.startsWith('/v3/assets/mint/')) {
    const suffix = url.pathname.slice('/v3/assets/mint/'.length);
    const historySuffix = suffix.endsWith('/history');
    const candleSuffix = suffix.endsWith('/candles');
    const onchainSuffix = suffix.endsWith('/onchain');
    const holdersSuffix = suffix.endsWith('/holders');
    const distributionSuffix = suffix.endsWith('/distribution');
    const transactionsSuffix = suffix.endsWith('/transactions');
    const encodedMint = historySuffix
      ? suffix.slice(0, -'/history'.length)
      : candleSuffix
        ? suffix.slice(0, -'/candles'.length)
        : onchainSuffix
          ? suffix.slice(0, -'/onchain'.length)
          : holdersSuffix
            ? suffix.slice(0, -'/holders'.length)
            : distributionSuffix
              ? suffix.slice(0, -'/distribution'.length)
              : transactionsSuffix
                ? suffix.slice(0, -'/transactions'.length)
                : suffix;
    let mint;
    try {
      mint = decodeURIComponent(encodedMint);
    } catch {
      return error('ASSET_NOT_FOUND', 'Asset was not found.', 404, id, origin);
    }
    if (!mint || mint.includes('/') || !isBase58PublicKey(mint))
      return error('ASSET_NOT_FOUND', 'Asset was not found.', 404, id, origin);
    if (!encodedMint || encodedMint.includes('/'))
      return error('ASSET_NOT_FOUND', 'Asset was not found.', 404, id, origin);
    if (onchainSuffix) {
      try {
        const result = await loadV3AssetOnchain(env, config, mint);
        return json(
          {
            data: result.profile,
            meta: {
              ...v3Meta(meta),
              onchain: { source: 'helius', ...result.freshness },
            },
          },
          200,
          id,
          origin,
          noStoreSnapshotHeaders,
        );
      } catch (cause) {
        return error(
          failureCode(cause, 'ASSET_ONCHAIN_UNAVAILABLE'),
          'On-chain asset data is currently unavailable.',
          503,
          id,
          origin,
        );
      }
    }
    if (holdersSuffix) {
      const page =
        url.searchParams.get('page') === null
          ? 1
          : Number(url.searchParams.get('page'));
      if (!Number.isSafeInteger(page) || page < 1)
        return error(
          'INVALID_HOLDER_PAGE',
          'page must be a positive integer.',
          400,
          id,
          origin,
        );
      try {
        const result = await loadV3AssetHolders(env, config, mint, page);
        return json(
          {
            data: result,
            meta: {
              ...v3Meta(meta),
              holders: { source: 'helius', derived: false },
            },
          },
          200,
          id,
          origin,
          noStoreSnapshotHeaders,
        );
      } catch (cause) {
        return error(
          failureCode(cause, 'ASSET_ONCHAIN_UNAVAILABLE'),
          'On-chain holder data is currently unavailable.',
          503,
          id,
          origin,
        );
      }
    }
    if (distributionSuffix) {
      try {
        const result = await loadV3AssetDistribution(env, config, mint);
        return json(
          {
            data: result,
            meta: {
              ...v3Meta(meta),
              distribution: { source: 'helius', derived: false },
            },
          },
          200,
          id,
          origin,
          noStoreSnapshotHeaders,
        );
      } catch (cause) {
        return error(
          failureCode(cause, 'ASSET_ONCHAIN_UNAVAILABLE'),
          'On-chain distribution data is currently unavailable.',
          503,
          id,
          origin,
        );
      }
    }
    if (transactionsSuffix) {
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 25 : Number(rawLimit);
      const cursor = url.searchParams.get('cursor');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return error(
          'INVALID_ASSET_TRANSACTION_LIMIT',
          'limit must be an integer from 1 to 100.',
          400,
          id,
          origin,
        );
      if (cursor !== null && !cursor)
        return error(
          'INVALID_ASSET_TRANSACTION_CURSOR',
          'cursor must not be empty.',
          400,
          id,
          origin,
        );
      try {
        const result = await loadV3AssetTransactions(
          env,
          config,
          mint,
          limit,
          cursor,
        );
        return json(
          {
            data: result,
            meta: {
              ...v3Meta(meta),
              assetTransactions: {
                source: 'helius-parsed-events',
                scope: 'mint-address-history',
                limit,
              },
            },
          },
          200,
          id,
          origin,
          noStoreSnapshotHeaders,
        );
      } catch (cause) {
        return error(
          failureCode(cause, 'ASSET_ONCHAIN_UNAVAILABLE'),
          'On-chain transaction data is currently unavailable.',
          503,
          id,
          origin,
        );
      }
    }
    let asset: Record<string, unknown> | undefined = snapshot.assets.find(
      (item) => item.mint === mint,
    );
    if (!asset) {
      try {
        const token = await singleFlight(
          env.SNAPSHOTS ?? env,
          ['token', ...providerKey(env, config), mint],
          () => tokenByMint(mint, config.jupiterApiKey || env.JUPITER_API_KEY),
        );
        if (!token)
          return error(
            'ASSET_NOT_FOUND',
            'Asset was not found.',
            404,
            id,
            origin,
          );
        asset = { v3: mapV3Asset(token) };
      } catch (cause) {
        unavailable('asset-lookup', 'Jupiter', cause, id);
        return error(
          'ASSET_LOOKUP_UNAVAILABLE',
          'Asset data is currently unavailable.',
          503,
          id,
          origin,
        );
      }
    }
    const before = url.searchParams.get('before');
    if (!candleSuffix && before !== null)
      return error(
        'INVALID_CANDLE_BEFORE',
        'before is supported only by the candles route.',
        400,
        id,
        origin,
      );
    if (
      before !== null &&
      (!/^\d+$/.test(before) ||
        !Number.isSafeInteger(Number(before)) ||
        Number(before) <= 0)
    )
      return error(
        'INVALID_CANDLE_BEFORE',
        'before must be a positive Unix timestamp in seconds.',
        400,
        id,
        origin,
      );
    const endTimestamp = before === null ? null : Number(before);
    const includeHistory = url.searchParams.get('includeHistory') !== 'false';
    if (!historySuffix && !candleSuffix && !includeHistory)
      return json(
        { data: v3Asset(asset), meta: v3Meta(meta) },
        200,
        id,
        origin,
        snapshotHeaders,
      );
    if (candleSuffix) {
      const timeframe = url.searchParams.get('timeframe') || '1H';
      if (!candlePlan(timeframe))
        return error(
          'INVALID_CANDLE_TIMEFRAME',
          'timeframe must be an exact supported Birdeye candle timeframe.',
          400,
          id,
          origin,
        );
      const candles = await candlesForAsset(
        env.SNAPSHOTS,
        mint,
        config.birdeyeApiKey,
        timeframe,
        endTimestamp,
        config.providerMode,
      );
      return json(
        {
          data: {
            mint,
            timeframe: candles.timeframe,
            count: CANDLE_PAGE_SIZE,
            candles: candles.candles,
          },
          meta: v3Meta(meta, candles),
        },
        200,
        id,
        origin,
        noStoreSnapshotHeaders,
      );
    }
    const range = url.searchParams.get('range') || '7d';
    if (!legacyHistoryPlan(range))
      return error(
        'INVALID_HISTORY_RANGE',
        'range must be 1d or 7d.',
        400,
        id,
        origin,
      );
    const history = await historyForAsset(
      env.SNAPSHOTS,
      mint,
      config.birdeyeApiKey,
      range,
      config.providerMode,
    );
    const points = mapV3HistoryPoints(history.points);
    if (historySuffix)
      return json(
        { data: { mint, range, points }, meta: v3Meta(meta, history) },
        200,
        id,
        origin,
        noStoreSnapshotHeaders,
      );
    return json(
      {
        data: {
          ...v3Asset(asset),
          history: {
            points,
            state: state === 'fixture' ? 'fixture' : history.state,
            fetchedAt: history.fetchedAt,
          },
        },
        meta: v3Meta(meta, history),
      },
      200,
      id,
      origin,
      noStoreSnapshotHeaders,
    );
  }
  if (url.pathname.startsWith('/v3/wallets/')) {
    const suffix = url.pathname.slice('/v3/wallets/'.length);
    const segments = suffix.split('/');
    const activityRoute =
      segments.length === 2 &&
      (segments[1] === 'transactions' || segments[1] === 'events');
    if (segments.length !== 1 && !activityRoute)
      return error('NOT_FOUND', 'Route was not found.', 404, id, origin);
    const encodedAddress = segments[0];
    let address;
    try {
      address = decodeURIComponent(encodedAddress);
    } catch {
      return error(
        'INVALID_WALLET_ADDRESS',
        'Wallet address is invalid.',
        400,
        id,
        origin,
      );
    }
    if (!address || address.includes('/') || !isBase58PublicKey(address))
      return error(
        'INVALID_WALLET_ADDRESS',
        'Wallet address is invalid.',
        400,
        id,
        origin,
      );
    if (activityRoute) {
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 25 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return error(
          'INVALID_EVENT_LIMIT',
          'limit must be an integer from 1 to 100.',
          400,
          id,
          origin,
        );
      const cursor = url.searchParams.get('cursor');
      if (cursor !== null && !cursor)
        return error(
          'INVALID_EVENT_CURSOR',
          'cursor must not be empty.',
          400,
          id,
          origin,
        );
      try {
        return json(
          {
            data: await loadV3Events(env, config, address, limit, cursor),
            meta: v3Meta(meta),
          },
          200,
          id,
          origin,
          noStoreSnapshotHeaders,
        );
      } catch (cause) {
        return error(
          failureCode(cause, 'WALLET_LOOKUP_UNAVAILABLE'),
          'Public wallet data is currently unavailable.',
          503,
          id,
          origin,
        );
      }
    }
    try {
      const result = await loadV3Wallet(env, config, address);
      return json(
        {
          data: result.wallet,
          meta: {
            ...v3Meta(meta),
            wallet: { source: 'helius-das', ...result.freshness },
            ...(result.providerStop
              ? { providerStop: result.providerStop }
              : {}),
          },
        },
        200,
        id,
        origin,
        noStoreSnapshotHeaders,
      );
    } catch (cause) {
      return error(
        failureCode(cause, 'WALLET_LOOKUP_UNAVAILABLE'),
        'Public wallet data is currently unavailable.',
        503,
        id,
        origin,
        cause instanceof ProviderRequestError && cause.provider === 'Helius RPC'
          ? providerStop(cause, 'helius')
          : undefined,
      );
    }
  }
  const versionPrefix = url.pathname.startsWith('/v2/')
    ? '/v2'
    : url.pathname.startsWith('/v1/')
      ? '/v1'
      : null;
  if (!versionPrefix)
    return error('NOT_FOUND', 'Route was not found.', 404, id, origin);
  if (url.pathname === `${versionPrefix}/status`)
    return json(
      {
        data: {
          version: API_VERSION,
          chain: 'solana',
          snapshot: {
            state,
            createdAt: snapshot.createdAt,
            source: snapshot.source,
          },
          marketData: {
            source: snapshot.market.source,
            asOf: snapshot.market.asOf,
          },
          swaps: snapshot.market.swaps || {
            count: snapshot.swaps.length,
            asOf: null,
            source: 'unknown',
            error: null,
          },
        },
        meta,
      },
      200,
      id,
      origin,
      snapshotHeaders,
    );
  if (url.pathname === `${versionPrefix}/market`)
    return json(
      { data: snapshot.market, meta },
      200,
      id,
      origin,
      snapshotHeaders,
    );
  if (url.pathname === `${versionPrefix}/assets`)
    return json(
      { data: snapshot.assets, meta },
      200,
      id,
      origin,
      snapshotHeaders,
    );
  const mintPrefix = `${versionPrefix}/assets/mint/`;
  const legacyIdPrefix = `${versionPrefix}/assets/id/`;
  if (
    url.pathname.startsWith(mintPrefix) ||
    url.pathname.startsWith(legacyIdPrefix)
  ) {
    const encodedId = url.pathname.slice(
      (url.pathname.startsWith(mintPrefix) ? mintPrefix : legacyIdPrefix)
        .length,
    );
    let mint;
    try {
      mint = decodeURIComponent(encodedId);
    } catch {
      return error('ASSET_NOT_FOUND', 'Asset was not found.', 404, id, origin);
    }
    if (!isBase58PublicKey(mint))
      return error('ASSET_NOT_FOUND', 'Asset was not found.', 404, id, origin);
    const asset = snapshot.assets.find((item) => item.mint === mint);
    if (!asset)
      return error('ASSET_NOT_FOUND', 'Asset was not found.', 404, id, origin);
    const history = await historyForAsset(
      env.SNAPSHOTS,
      mint,
      config.birdeyeApiKey,
      '7d',
      config.providerMode,
    );
    return json(
      {
        data: {
          ...asset,
          priceHistory: history.points,
          historyDataSource: history.points ? 'birdeye' : null,
        },
        meta: {
          ...meta,
          historyDataSource: history.points ? 'birdeye' : null,
          historyState: state === 'fixture' ? 'fixture' : history.state,
          historyFetchedAt: history.fetchedAt,
        },
      },
      200,
      id,
      origin,
      noStoreSnapshotHeaders,
    );
  }
  if (url.pathname.startsWith(`${versionPrefix}/assets/`)) {
    const assetPath = url.pathname.slice(`${versionPrefix}/assets/`.length);
    if (!assetPath || assetPath.includes('/'))
      return error('ASSET_NOT_FOUND', 'Asset was not found.', 404, id, origin);
    let symbol;
    try {
      symbol = decodeURIComponent(assetPath).toUpperCase();
    } catch {
      return error('ASSET_NOT_FOUND', 'Asset was not found.', 404, id, origin);
    }
    const assets = snapshot.assets.filter(
      (item) => item.symbol.toUpperCase() === symbol,
    );
    if (assets.length > 1)
      return error(
        'ASSET_SYMBOL_AMBIGUOUS',
        'Asset symbol matches multiple mints. Use the mint address.',
        409,
        id,
        origin,
      );
    return assets[0]
      ? json({ data: assets[0], meta }, 200, id, origin, snapshotHeaders)
      : error('ASSET_NOT_FOUND', 'Asset was not found.', 404, id, origin);
  }
  if (url.pathname === `${versionPrefix}/swaps`)
    return json(
      { data: snapshot.swaps, meta },
      200,
      id,
      origin,
      snapshotHeaders,
    );
  if (url.pathname === `${versionPrefix}/wallets`) {
    return json({ data: [], meta }, 200, id, origin, snapshotHeaders);
  }
  if (url.pathname.startsWith(`${versionPrefix}/wallets/`)) {
    let address;
    try {
      address = decodeURIComponent(
        url.pathname.slice(`${versionPrefix}/wallets/`.length),
      );
    } catch {
      return error(
        'INVALID_WALLET_ADDRESS',
        'Wallet address is invalid.',
        400,
        id,
        origin,
      );
    }
    if (!isBase58PublicKey(address))
      return error(
        'INVALID_WALLET_ADDRESS',
        'Wallet address is invalid.',
        400,
        id,
        origin,
      );
    try {
      const wallet = await loadWalletData(env, config, address);
      return json(
        { data: wallet, meta: { ...meta, walletDataSource: 'helius-live' } },
        200,
        id,
        origin,
        noStoreSnapshotHeaders,
      );
    } catch (cause) {
      if (record(cause).code === 'WALLET_LOOKUP_UNAVAILABLE')
        return error(
          'WALLET_LOOKUP_UNAVAILABLE',
          'Public wallet lookup is unavailable until Helius is configured.',
          503,
          id,
          origin,
        );
      unavailable('wallet-lookup', 'Helius', cause, id);
      return error(
        'WALLET_LOOKUP_UNAVAILABLE',
        'Public wallet data is currently unavailable.',
        503,
        id,
        origin,
      );
    }
  }
  return error('NOT_FOUND', 'Route was not found.', 404, id, origin);
}
import { unavailable } from './diagnostics.ts';
