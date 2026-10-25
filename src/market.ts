/**
 * Bounded market discovery, provider normalization and candle retrieval.
 * @packageDocumentation
 */

import {
  CANDLE_PAGE_SIZE,
  MAX_CATALOG_ASSETS,
  MIN_RECENT_CATALOG_VOLUME_USD,
  SOL_MINT,
} from './constants.ts';
import { assetIdentity } from './transforms.ts';
import { isRecord, record, array } from './record.ts';
import { providerJson } from './providerRequest.ts';

/** Normalize an unknown scalar to the supported string representation.
 * @param value - Unknown provider text field.
 * @returns Its string value, or null without coercion.
 */
function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

const JUPITER = 'https://api.jup.ag';
const BIRDEYE = 'https://public-api.birdeye.so';

/** Fetch provider JSON through the bounded request and error-classification boundary.
 * @param url - Trusted provider read endpoint.
 * @param apiKey - Optional server-only API credential.
 * @param provider - Trusted provider label for controlled diagnostics.
 * @returns Unknown provider JSON for subsequent field normalization.
 */
async function fetchJson(
  url: string,
  apiKey: string | undefined,
  provider: string,
): Promise<unknown> {
  return providerJson(
    url,
    { headers: apiKey ? { 'x-api-key': apiKey } : undefined },
    { provider },
  );
}

/** Map provider work with a bounded worker pool instead of unbounded parallel requests.
 * @param items - Input records to process in their existing order.
 * @param limit - Maximum concurrent operations.
 * @param operation - Provider read to perform for each input.
 * @returns Results in input order, rejecting if any operation fails.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  /** Drain queued items while respecting the shared concurrency limit. */
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/** Normalize the token record into the market asset contract.
 * @param token - Object-shaped provider token record with unknown field values.
 * @returns The normalized asset, or null when no mint identity is present.
 */
function tokenAsset(token: Record<string, unknown>) {
  const mint = string(token.id) || string(token.address) || string(token.mint);
  if (!mint) return null;
  return {
    ...assetIdentity(mint),
    symbol: string(token.symbol) || mint.slice(0, 8),
    name: string(token.name) || string(token.symbol) || mint,
    imageUrl: string(token.icon) || string(token.logoURI) || '',
    decimals:
      typeof token.decimals === 'number' && Number.isInteger(token.decimals)
        ? token.decimals
        : 0,
    price: typeof token.usdPrice === 'number' ? token.usdPrice : null,
    supply: token.circSupply ?? null,
    totalSupply: token.totalSupply ?? null,
    marketCap: token.mcap ?? null,
    change24h:
      record(token.stats24h).priceChange ?? token.priceChange24h ?? null,
    change7d: null,
    change30d: null,
    priceHistory: null,
    actualprice: typeof token.usdPrice === 'number' ? token.usdPrice : null,
    image: string(token.icon) || string(token.logoURI) || '',
    marketcap: token.mcap ?? null,
    pricedayminusone: null,
    percentdayminusone:
      record(token.stats24h).priceChange ?? token.priceChange24h ?? null,
    priceweekminusone: null,
    percentweekminusone: null,
    pricemonthminusone: null,
    percentmonthminusone: null,
    contractname: mint,
    metadataSource: 'jupiter',
    marketDataSource: 'jupiter',
    historyDataSource: null,
    v3: mapV3Asset(token),
  };
}

/** Normalized market asset with exact identity and explicitly nullable metrics. */
export type MarketAsset = NonNullable<ReturnType<typeof tokenAsset>>;

/** Normalize finite numeric provider values and preserve unavailable data as null.
 * @param value - Unknown numeric provider field.
 * @returns A finite numeric primitive, or null without coercion.
 */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Map upstream asset data into the v3 contract without fabricating unavailable metrics.
 * @param value - Unknown provider asset value.
 * @returns Supported v3 asset fields with explicit unavailable metrics.
 */
export function mapV3Asset(value: unknown) {
  const token = record(value);
  const mint = string(token.id) || string(token.mint) || null;
  const stats = record(token.stats24h);
  const buyVolume24hUsd = finiteOrNull(
    stats.buyVolume ?? token?.buyVolume24hUsd,
  );
  const sellVolume24hUsd = finiteOrNull(
    stats.sellVolume ?? token?.sellVolume24hUsd,
  );
  return {
    mint,
    symbol: typeof token?.symbol === 'string' ? token.symbol : null,
    name: typeof token?.name === 'string' ? token.name : null,
    decimals:
      typeof token.decimals === 'number' &&
      Number.isInteger(token.decimals) &&
      token.decimals >= 0
        ? token.decimals
        : null,
    iconUrl: string(token.iconUrl ?? token.icon),
    priceUsd: finiteOrNull(token?.usdPrice),
    marketCapUsd: finiteOrNull(token?.mcap),
    circulatingSupply: finiteOrNull(token?.circSupply),
    totalSupply: finiteOrNull(token?.totalSupply),
    fullyDilutedValuationUsd: finiteOrNull(token?.fdv),
    change24hPct: finiteOrNull(stats.priceChange ?? token?.priceChange24h),
    liquidityUsd: finiteOrNull(token?.liquidity),
    holderCount: finiteOrNull(token?.holderCount),
    verification: {
      isVerified: token?.isVerified === true,
      tags: Array.isArray(token?.tags)
        ? array(token.tags).filter(
            (tag): tag is string => typeof tag === 'string',
          )
        : [],
    },
    quality: {
      organicScore: finiteOrNull(token?.organicScore),
      organicScoreLabel:
        typeof token?.organicScoreLabel === 'string'
          ? token.organicScoreLabel
          : null,
      audit:
        token?.audit && typeof token.audit === 'object' ? token.audit : null,
    },
    activity: {
      buyVolume24hUsd,
      sellVolume24hUsd,
      volume24hUsd:
        buyVolume24hUsd !== null && sellVolume24hUsd !== null
          ? buyVolume24hUsd + sellVolume24hUsd
          : null,
    },
  };
}

/** Extract provider result items from the supported response envelope shapes.
 * @param payload - Unknown array or data-envelope response.
 * @returns Only object-shaped provider result records.
 */
function payloadItems(payload: unknown): Record<string, unknown>[] {
  const items = Array.isArray(payload)
    ? array(payload)
    : array(record(payload).data);
  return items.filter(isRecord);
}

/** Resolve a token by mint through the configured provider.
 * @param mint - Exact case-sensitive mint identity to find.
 * @param apiKey - Optional server-only Jupiter credential.
 * @returns A matching provider record, or null without substituting another token.
 */
export async function tokenByMint(mint: string, apiKey?: string) {
  const items = payloadItems(
    await fetchJson(
      `${JUPITER}/tokens/v2/search?query=${encodeURIComponent(mint)}`,
      apiKey,
      'Jupiter',
    ),
  );
  return (
    items.find((item) => (item.id || item.address || item.mint) === mint) ||
    null
  );
}

/** Filter and normalize discovered tokens according to the catalog verification policy.
 * @param tokens - Object-shaped provider token records.
 * @param verifiedOnly - Whether unverified non-native tokens must be excluded.
 * @returns A bounded, mint-deduplicated list preserving discovery order.
 */
function catalogTokens(tokens: Record<string, unknown>[], verifiedOnly = true) {
  const byMint = new Map<string, Record<string, unknown>>();
  for (const token of tokens) {
    const mint =
      string(token.id) || string(token.address) || string(token.mint);
    if (
      !mint ||
      (verifiedOnly && !token.isVerified && mint !== SOL_MINT) ||
      byMint.has(mint)
    )
      continue;
    byMint.set(mint, token);
  }
  return [...byMint.values()].slice(0, MAX_CATALOG_ASSETS);
}

/** Refresh bounded market discovery and normalize available asset metrics.
 * @param apiKey - Optional server-only Jupiter credential; absent credentials disable refresh.
 * @param candidateMints - Optional explicit mint list to resolve with bounded concurrency.
 * @returns Available normalized market data, or null on unavailable configuration/provider work.
 */
export async function refreshMarket(
  apiKey?: string,
  candidateMints: string[] | null = null,
) {
  if (!apiKey) return null;
  try {
    let tokens;
    if (Array.isArray(candidateMints)) {
      tokens = (
        await mapWithConcurrency([...new Set(candidateMints)], 5, (mint) =>
          tokenByMint(mint, apiKey),
        )
      ).filter((token): token is Record<string, unknown> => token !== null);
    } else {
      tokens = payloadItems(
        await fetchJson(
          `${JUPITER}/tokens/v2/toptraded/24h?limit=${MAX_CATALOG_ASSETS}`,
          apiKey,
          'Jupiter',
        ),
      );
      if (
        !tokens.some(
          (token) => (token.id || token.address || token.mint) === SOL_MINT,
        )
      ) {
        const sol = await tokenByMint(SOL_MINT, apiKey);
        if (sol) tokens = [sol, ...tokens];
      }
      tokens = catalogTokens(tokens);
    }
    const assets = tokens.map(tokenAsset).filter((asset) => asset !== null);
    return {
      assets,
      source: 'jupiter',
      asOf: new Date().toISOString(),
      liveAssetCount: assets.length,
      historySource: null,
    };
  } catch (cause) {
    unavailable('market-refresh', 'Jupiter', cause);
    return null;
  }
}

/** Load one discovery catalog and apply its minimum-volume boundary.
 * @param apiKey - Server-only Jupiter credential.
 * @param path - Trusted discovery-catalog path.
 * @param minVolumeUsd - Optional minimum observed daily USD volume.
 * @returns Normalized catalog assets, or an empty list after a controlled provider failure.
 */
async function refreshDiscoveryCatalog(
  apiKey: string,
  path: string,
  minVolumeUsd: number | null = null,
) {
  try {
    const tokens = payloadItems(
      await fetchJson(`${JUPITER}/tokens/v2/${path}`, apiKey, 'Jupiter'),
    );
    return catalogTokens(tokens, false)
      .map(tokenAsset)
      .filter((asset) => asset !== null)
      .filter(
        (asset) =>
          asset &&
          (minVolumeUsd === null ||
            (asset.v3.activity.volume24hUsd ?? 0) >= minVolumeUsd),
      );
  } catch (cause) {
    unavailable('discovery-refresh', 'Jupiter', cause);
    return [];
  }
}

/** Refresh the configured discovery catalogs without merging their identities.
 * @param apiKey - Optional server-only Jupiter credential.
 * @returns Separate trending and recent lists, empty when configuration is unavailable.
 */
export async function refreshDiscoveryCatalogs(apiKey?: string) {
  if (!apiKey) return { trending: [], recent: [] };
  const [trending, recent] = await Promise.all([
    refreshDiscoveryCatalog(apiKey, 'toptrending/24h'),
    refreshDiscoveryCatalog(apiKey, 'recent', MIN_RECENT_CATALOG_VOLUME_USD),
  ]);
  return { trending, recent };
}

export const CANDLE_TIMEFRAMES = [
  '1s',
  '15s',
  '30s',
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1H',
  '2H',
  '4H',
  '6H',
  '8H',
  '12H',
  '1D',
  '3D',
  '1W',
  '1M',
];

const legacyHistoryPlans: Record<
  string,
  { timeframe: string; durationMs: number }
> = {
  '1d': { timeframe: '15m', durationMs: 24 * 60 * 60 * 1000 },
  '7d': { timeframe: '1H', durationMs: 7 * 24 * 60 * 60 * 1000 },
};

/** Resolve provider interval and request sizing for the requested candle timeframe.
 * @param timeframe - Exact-case requested provider interval.
 * @returns Its supported timeframe plan, or null for an unsupported interval.
 */
export function candlePlan(timeframe: string) {
  return CANDLE_TIMEFRAMES.includes(timeframe) ? { timeframe } : null;
}

/** Translate a legacy history range into the supported candle request plan.
 * @param range - Legacy history range identifier.
 * @returns Its timeframe/duration plan, or null for an unsupported range.
 */
export function legacyHistoryPlan(range: string) {
  return legacyHistoryPlans[range] || null;
}

/** Accept only finite numeric values from the provider boundary.
 * @param value - Unknown candle metric.
 * @returns The finite numeric primitive, or null without coercion.
 */
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Normalize one provider candle and reject unusable OHLC data.
 * @param value - Unknown provider candle record.
 * @returns A timestamped candle with consistent OHLC and volume data, or null.
 */
function birdeyeCandle(value: unknown) {
  const item = record(value);
  const unixTime = item?.unix_time;
  const openUsd = finite(item?.o);
  const highUsd = finite(item?.h);
  const lowUsd = finite(item?.l);
  const closeUsd = finite(item?.c);
  const volume = finite(item?.v);
  const volumeUsd = finite(item?.v_usd);
  if (
    typeof unixTime !== 'number' ||
    !Number.isInteger(unixTime) ||
    unixTime < 0 ||
    openUsd === null ||
    highUsd === null ||
    lowUsd === null ||
    closeUsd === null ||
    volume === null ||
    volumeUsd === null
  )
    return null;
  if (
    highUsd < openUsd ||
    highUsd < closeUsd ||
    lowUsd > openUsd ||
    lowUsd > closeUsd
  )
    return null;
  return {
    timestamp: new Date(unixTime * 1000).toISOString(),
    openUsd,
    highUsd,
    lowUsd,
    closeUsd,
    volume,
    volumeUsd,
  };
}

/** Fetch bounded historical candles for the requested mint, timeframe and end time.
 * @param mint - Exact requested mint identity.
 * @param apiKey - Optional server-only Birdeye credential.
 * @param timeframe - Supported exact-case candle interval.
 * @param endTime - End time in milliseconds since epoch, converted to provider seconds.
 * @param count - Bounded maximum candle count to request.
 * @returns Sorted, deduplicated usable candles, or null when configuration/data is unavailable.
 */
export async function fetchCandles(
  mint: string,
  apiKey?: string,
  timeframe = '1H',
  endTime = Date.now(),
  count = CANDLE_PAGE_SIZE,
) {
  if (!apiKey) return null;
  const plan = candlePlan(timeframe);
  if (!plan) throw new Error('Unsupported candle timeframe.');
  const timeTo = Math.floor(endTime / 1000);
  const query = new URLSearchParams({
    address: mint,
    type: plan.timeframe,
    mode: 'count',
    count_limit: String(count),
    time_to: String(timeTo),
    currency: 'usd',
    chart_type: 'price',
  });
  const payload = record(
    await providerJson(
      `${BIRDEYE}/defi/v3/ohlcv?${query}`,
      {
        headers: {
          'X-API-KEY': apiKey,
          'x-chain': 'solana',
          accept: 'application/json',
        },
      },
      { provider: 'Birdeye' },
    ),
  );
  const data = record(payload.data);
  if (payload.success !== true || !Array.isArray(data.items)) return null;
  const byTimestamp = new Map<
    string,
    NonNullable<ReturnType<typeof birdeyeCandle>>
  >();
  const items: unknown[] = data.items;
  for (const item of items) {
    const candle = birdeyeCandle(item);
    if (candle) byTimestamp.set(candle.timestamp, candle);
  }
  const candles = [...byTimestamp.values()].sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
  return candles.length ? { timeframe: plan.timeframe, candles } : null;
}

import { unavailable } from './diagnostics.ts';
