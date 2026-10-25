/**
 * Versioned asset, wallet and event resource contracts with scoped caching.
 * @packageDocumentation
 */

import {
  SOL_MINT,
  V3_ASSET_DISTRIBUTION_KEY_PREFIX,
  V3_ASSET_DISTRIBUTION_SIZE,
  V3_ASSET_HOLDER_PAGE_SIZE,
  V3_ASSET_HOLDERS_KEY_PREFIX,
  V3_ASSET_ONCHAIN_CACHE_SECONDS,
  V3_ASSET_TRANSACTION_PAGE_SIZE,
  V3_ASSET_TRANSACTIONS_KEY_PREFIX,
  V3_WALLET_CACHE_SECONDS,
  V3_WALLET_EVENTS_KEY_PREFIX,
  V3_WALLET_KEY_PREFIX,
} from './constants.ts';
import { refreshMarket } from './market.ts';
import { providerJson } from './providerRequest.ts';
import { singleFlight, providerKey } from './singleFlight.ts';
import { decimalValue, formatAtomicAmount } from './transforms.ts';
import { array, record, isRecord } from './record.ts';
import type { Env } from './env.ts';
import type { ProviderConfig as WorkerConfig } from './config.ts';

/** Accept only timestamps that can be represented by the response contract. */
function validDate(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

const HELIUS_RPC = 'https://mainnet.helius-rpc.com/';

/** Normalize finite numeric provider values and preserve unavailable data as null. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Build asset identity with unavailable metrics represented as null, not fabricated zero values. */
function fallbackAsset(mint: string, decimals: unknown) {
  return {
    mint,
    symbol: null,
    name: null,
    decimals:
      typeof decimals === 'number' &&
      Number.isInteger(decimals) &&
      decimals >= 0
        ? decimals
        : null,
    iconUrl: null,
    priceUsd: null,
  };
}

/** Normalize an asset into the v3 response contract, preserving unavailable fields. */
export function v3Asset(value: unknown): Record<string, unknown> {
  const asset = record(value);
  if (isRecord(asset.v3)) return asset.v3;
  return {
    mint: asset?.mint ?? null,
    symbol: typeof asset?.symbol === 'string' ? asset.symbol : null,
    name: typeof asset?.name === 'string' ? asset.name : null,
    decimals:
      typeof asset.decimals === 'number' &&
      Number.isInteger(asset.decimals) &&
      asset.decimals >= 0
        ? asset.decimals
        : null,
    iconUrl: typeof asset?.imageUrl === 'string' ? asset.imageUrl : null,
    priceUsd: finiteOrNull(asset?.price),
    marketCapUsd: finiteOrNull(asset?.marketCap),
    circulatingSupply: finiteOrNull(asset?.supply),
    totalSupply: finiteOrNull(asset?.totalSupply),
    fullyDilutedValuationUsd: null,
    change24hPct: finiteOrNull(asset?.change24h),
    liquidityUsd: null,
    holderCount: null,
    verification: { isVerified: false, tags: [] },
    quality: { organicScore: null, organicScoreLabel: null, audit: null },
    activity: {
      buyVolume24hUsd: null,
      sellVolume24hUsd: null,
      volume24hUsd: null,
    },
  };
}

/** Normalize usable history observations without inventing missing time or price values. */
export function mapV3HistoryPoints(points: unknown) {
  if (!Array.isArray(points)) return null;
  return array(points)
    .map(record)
    .flatMap((point) => {
      const timestamp =
        typeof point?.date === 'string' &&
        Number.isFinite(Date.parse(point.date))
          ? point.date
          : null;
      const priceUsd = finiteOrNull(point?.price);
      return timestamp !== null && priceUsd !== null
        ? [{ timestamp, priceUsd }]
        : [];
    });
}

/** Call the configured Solana RPC provider with a bounded request deadline. */
export async function heliusRpc(
  method: string,
  params: unknown[] | Record<string, unknown>,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<unknown> {
  const payload = record(
    await providerJson(
      `${HELIUS_RPC}?api-key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
      },
      { provider: 'Helius RPC', readOnlyPost: true, timeoutMs },
    ),
  );
  if (payload.error)
    throw new Error(
      `Helius RPC error: ${record(payload.error).message || 'unknown'}`,
    );
  return payload.result;
}

/** Preserve unavailable text as null rather than inventing a value. */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** Validate the string representation of an exact atomic quantity. */
function atomicString(value: unknown): string | null {
  return typeof value === 'string' && /^\d+$/.test(value)
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : null;
}

/** Read a cached value only when its resource-specific validator accepts it. */
async function cachedValue(
  env: Env,
  key: string,
  validate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | null> {
  const cached = env.SNAPSHOTS?.get
    ? await env.SNAPSHOTS.get(key, 'json')
    : null;
  return isRecord(cached) && validate(cached) ? cached : null;
}

/** Label this response fresh and forward its observation time unchanged; this helper does not check age. */
function cachedFreshness(asOf: unknown) {
  return { cacheState: 'fresh', asOf };
}

/** Determine whether this configuration forbids live provider refreshes. */
function cacheOnly(config: WorkerConfig) {
  return config.providerMode === 'cache-only';
}

/** Combine independent supply and account evidence into the on-chain asset profile. */
function assetOnchainProfile(
  mint: string,
  assetValue: unknown,
  supplyValue: unknown,
  account: unknown,
) {
  const asset = record(assetValue);
  const supply = record(supplyValue);
  const content = record(asset.content);
  const metadata = record(content.metadata);
  const tokenInfo = record(asset.token_info);
  const parsedMint = record(
    record(record(record(account).value).data).parsed,
  ).info;
  const parsedInfo = record(parsedMint);
  const decimals =
    typeof tokenInfo.decimals === 'number' &&
    Number.isInteger(tokenInfo.decimals)
      ? tokenInfo.decimals
      : typeof parsedInfo.decimals === 'number' &&
          Number.isInteger(parsedInfo.decimals)
        ? parsedInfo.decimals
        : null;
  const supplyAtomic =
    atomicString(tokenInfo.supply) ||
    atomicString(record(supply.value).amount) ||
    atomicString(parsedInfo.supply);
  const extensions = Array.isArray(tokenInfo.extensions)
    ? array(tokenInfo.extensions).filter(
        (extension): extension is string => typeof extension === 'string',
      )
    : [];
  return {
    mint,
    interface: stringOrNull(asset?.interface),
    tokenProgram:
      stringOrNull(tokenInfo.token_program) ||
      stringOrNull(record(asset.ownership).owner),
    lastIndexedSlot: Number.isSafeInteger(asset?.last_indexed_slot)
      ? asset.last_indexed_slot
      : null,
    metadata: {
      name: stringOrNull(metadata.name),
      symbol: stringOrNull(metadata.symbol),
      description: stringOrNull(metadata.description),
      uri: stringOrNull(content.json_uri),
      image: stringOrNull(record(content.links).image),
      externalUrl: stringOrNull(metadata.external_url),
    },
    mintState: {
      decimals,
      supplyAtomic,
      supply:
        supplyAtomic !== null && decimals !== null
          ? formatAtomicAmount(supplyAtomic, decimals)
          : null,
      mintAuthority:
        stringOrNull(tokenInfo.mint_authority) ||
        stringOrNull(parsedInfo.mintAuthority),
      freezeAuthority:
        stringOrNull(tokenInfo.freeze_authority) ||
        stringOrNull(parsedInfo.freezeAuthority),
      isMutable: typeof asset?.mutable === 'boolean' ? asset.mutable : null,
      extensions,
    },
  };
}

/** Normalize an asset-provider holder record into the public holder contract. */
function holderFromDas(value: unknown) {
  const item = record(value);
  const tokenInfo = record(item.token_info);
  const atomicAmount = atomicString(tokenInfo.balance);
  const decimals =
    typeof tokenInfo.decimals === 'number' &&
    Number.isInteger(tokenInfo.decimals) &&
    tokenInfo.decimals >= 0
      ? tokenInfo.decimals
      : null;
  if (!atomicAmount || decimals === null) return null;
  return {
    tokenAccount: stringOrNull(item?.id),
    owner: stringOrNull(record(item.ownership).owner),
    atomicAmount,
    amount: formatAtomicAmount(atomicAmount, decimals),
    decimals,
    frozen: typeof item?.frozen === 'boolean' ? item.frozen : null,
    delegated:
      typeof tokenInfo.delegated_amount === 'string'
        ? tokenInfo.delegated_amount
        : null,
  };
}

/** Normalize a token-account holder using the asset decimal precision. */
function holderFromTokenAccount(value: unknown, decimals: unknown) {
  const item = record(value);
  const atomicAmount = atomicString(item?.amount);
  if (
    !atomicAmount ||
    typeof decimals !== 'number' ||
    !Number.isInteger(decimals) ||
    decimals < 0
  )
    return null;
  return {
    tokenAccount: stringOrNull(item?.address),
    owner: stringOrNull(item?.owner),
    atomicAmount,
    amount: formatAtomicAmount(atomicAmount, decimals),
    decimals,
    frozen: typeof item?.frozen === 'boolean' ? item.frozen : null,
    delegated: atomicString(item?.delegated_amount),
  };
}

/** Compute a display percentage from exact atomic amounts without changing the stored quantities. */
function percentageOfSupply(amount: string | null, supply: string | null) {
  if (
    !amount ||
    !supply ||
    !/^\d+$/.test(amount || '') ||
    !/^\d+$/.test(supply || '') ||
    supply === '0'
  )
    return null;
  // Round half up to two decimal places without converting atomic token values to Number.
  const hundredths =
    (BigInt(amount) * 10_000n + BigInt(supply) / 2n) / BigInt(supply);
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
}

/** Combine RPC account evidence with supply data for a distribution row. */
function largestAccountFromRpc(
  value: unknown,
  account: unknown,
  supplyAtomic: string | null,
) {
  const item = record(value);
  const atomicAmount = atomicString(item?.amount);
  const decimals =
    typeof item.decimals === 'number' &&
    Number.isInteger(item.decimals) &&
    item.decimals >= 0
      ? item.decimals
      : null;
  const parsed = record(record(record(account).data).parsed).info;
  const info = record(parsed);
  if (!atomicAmount || decimals === null) return null;
  return {
    tokenAccount: stringOrNull(item?.address),
    owner: stringOrNull(info.owner),
    atomicAmount,
    amount: formatAtomicAmount(atomicAmount, decimals),
    decimals,
    frozen: typeof info.state === 'string' ? info.state === 'frozen' : null,
    supplyPercent: percentageOfSupply(atomicAmount, supplyAtomic),
  };
}

/** Resolve on-chain asset details with explicit cache and provider-failure semantics. */
async function assetOnchainWork(env: Env, config: WorkerConfig, mint: string) {
  const key = `asset:v3:onchain:${mint}`;
  const cached = await cachedValue(
    env,
    key,
    (value) => record(value.profile).mint === mint && validDate(value.asOf),
  );
  if (cached)
    return { profile: cached.profile, freshness: cachedFreshness(cached.asOf) };
  if (cacheOnly(config)) {
    const cause = Object.assign(
      new Error('Seeded on-chain asset data is unavailable.'),
      { code: 'ASSET_ONCHAIN_UNAVAILABLE' },
    );
    throw cause;
  }
  const apiKey = config.heliusApiKey || env.HELIUS_API_KEY;
  if (!apiKey) {
    const cause = Object.assign(new Error('Helius is not configured.'), {
      code: 'ASSET_ONCHAIN_UNAVAILABLE',
    });
    throw cause;
  }
  const [asset, supply, account] = await Promise.all([
    heliusRpc('getAsset', { id: mint }, apiKey),
    heliusRpc('getTokenSupply', [mint], apiKey),
    heliusRpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }], apiKey),
  ]);
  const profile = assetOnchainProfile(mint, asset, supply, account);
  const asOf = new Date().toISOString();
  if (env.SNAPSHOTS?.put)
    await env.SNAPSHOTS.put(key, JSON.stringify({ profile, asOf }), {
      expirationTtl: V3_ASSET_ONCHAIN_CACHE_SECONDS,
    });
  return { profile, freshness: { cacheState: 'miss', asOf } };
}

/** Resolve one bounded page of asset holders. */
async function assetHoldersWork(
  env: Env,
  config: WorkerConfig,
  mint: string,
  page = 1,
) {
  const key = `${V3_ASSET_HOLDERS_KEY_PREFIX}${mint}:${page}`;
  const cached = await cachedValue(
    env,
    key,
    (value) =>
      value?.page === page &&
      Array.isArray(value.holders) &&
      validDate(value.asOf),
  );
  if (cached)
    return {
      holders: cached.holders,
      page: cached.page,
      total: cached.total ?? null,
      cursor: cached.cursor ?? null,
    };
  if (cacheOnly(config)) {
    const cause = Object.assign(
      new Error('Seeded asset holder data is unavailable.'),
      { code: 'ASSET_ONCHAIN_UNAVAILABLE' },
    );
    throw cause;
  }
  const apiKey = config.heliusApiKey || env.HELIUS_API_KEY;
  if (!apiKey) {
    const cause = Object.assign(new Error('Helius is not configured.'), {
      code: 'ASSET_ONCHAIN_UNAVAILABLE',
    });
    throw cause;
  }
  const [result, asset] = await Promise.all([
    heliusRpc(
      'getTokenAccounts',
      {
        mint,
        page,
        limit: V3_ASSET_HOLDER_PAGE_SIZE,
        options: { showZeroBalance: false },
      },
      apiKey,
    ),
    heliusRpc(
      'getAsset',
      { id: mint, options: { showFungible: true } },
      apiKey,
    ),
  ]);
  const resultData = record(result);
  const tokenInfo = record(record(asset).token_info);
  const decimals =
    typeof tokenInfo.decimals === 'number' &&
    Number.isInteger(tokenInfo.decimals)
      ? tokenInfo.decimals
      : null;
  const items = Array.isArray(resultData.token_accounts)
    ? array(resultData.token_accounts)
        .map((item) => holderFromTokenAccount(item, decimals))
        .filter(Boolean)
    : Array.isArray(resultData.items)
      ? array(resultData.items)
          .map(holderFromDas)
          .filter((holder) => holder !== null)
      : [];
  return {
    holders: items,
    page,
    total:
      typeof resultData.total === 'number' &&
      Number.isInteger(resultData.total) &&
      resultData.total >= 0
        ? resultData.total
        : null,
    cursor: stringOrNull(resultData.cursor),
  };
}

/** Resolve the supported largest-account distribution for one mint. */
async function assetDistributionWork(
  env: Env,
  config: WorkerConfig,
  mint: string,
) {
  const key = `${V3_ASSET_DISTRIBUTION_KEY_PREFIX}${mint}`;
  const cached = await cachedValue(
    env,
    key,
    (value) => Array.isArray(value.accounts) && validDate(value.asOf),
  );
  if (cached)
    return {
      accounts: cached.accounts,
      supplyAtomic: cached.supplyAtomic ?? null,
      slot: cached.slot ?? null,
    };
  if (cacheOnly(config)) {
    const cause = Object.assign(
      new Error('Seeded asset distribution data is unavailable.'),
      { code: 'ASSET_ONCHAIN_UNAVAILABLE' },
    );
    throw cause;
  }
  const apiKey = config.heliusApiKey || env.HELIUS_API_KEY;
  if (!apiKey) {
    const cause = Object.assign(new Error('Helius is not configured.'), {
      code: 'ASSET_ONCHAIN_UNAVAILABLE',
    });
    throw cause;
  }
  const [largest, supply] = await Promise.all([
    heliusRpc(
      'getTokenLargestAccounts',
      [mint, { commitment: 'confirmed' }],
      apiKey,
    ),
    heliusRpc('getTokenSupply', [mint, { commitment: 'confirmed' }], apiKey),
  ]);
  const largestData = record(largest);
  const accounts = array(largestData.value).slice(
    0,
    V3_ASSET_DISTRIBUTION_SIZE,
  );
  const addresses = accounts
    .map((item) => record(item).address)
    .filter((address): address is string => typeof address === 'string');
  const details = addresses.length
    ? await heliusRpc(
        'getMultipleAccounts',
        [addresses, { encoding: 'jsonParsed', commitment: 'confirmed' }],
        apiKey,
      )
    : null;
  const byAddress = new Map(
    addresses.map((address, index) => [
      address,
      array(record(details).value)[index] || null,
    ]),
  );
  const supplyAtomic = atomicString(record(record(supply).value).amount);
  return {
    accounts: accounts
      .map((item, index) => ({
        rank: index + 1,
        ...largestAccountFromRpc(
          item,
          byAddress.get(stringOrNull(record(item).address) ?? ''),
          supplyAtomic,
        ),
      }))
      .filter((item) => record(item).tokenAccount),
    supplyAtomic,
    slot: Number.isSafeInteger(record(largestData.context).slot)
      ? record(largestData.context).slot
      : null,
  };
}

/** Fetch bounded parsed transaction events from the configured provider. */
async function parsedEvents(
  address: string,
  apiKey: string,
  limit: number,
  cursor: string | null,
) {
  const body: Record<string, unknown> = {
    address,
    limit,
    sortOrder: 'desc',
    commitment: 'confirmed',
  };
  if (cursor) body.paginationToken = cursor;
  const page = record(
    await providerJson(
      `${HELIUS_RPC}v1/parsed-events/transaction-history?api-key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      { provider: 'Helius parsed events', readOnlyPost: true },
    ),
  );
  return {
    data: array(page.data),
    paginationToken:
      typeof page?.paginationToken === 'string' ? page.paginationToken : null,
  };
}

/** Extract a transfer for the requested mint from a parsed transaction. */
function transferFromParsed(value: unknown, mint: string) {
  const transfer = record(value);
  const atomicAmount = atomicString(
    transfer?.rawTokenAmount ?? transfer?.tokenAmount ?? transfer?.amount,
  );
  const decimals =
    typeof transfer.decimals === 'number' &&
    Number.isInteger(transfer.decimals) &&
    transfer.decimals >= 0
      ? transfer.decimals
      : null;
  if (transfer?.mint !== mint || !atomicAmount || decimals === null)
    return null;
  return {
    from: stringOrNull(transfer?.fromUserAccount),
    to: stringOrNull(transfer?.toUserAccount),
    fromTokenAccount: stringOrNull(transfer?.fromTokenAccount),
    toTokenAccount: stringOrNull(transfer?.toTokenAccount),
    atomicAmount,
    amount: formatAtomicAmount(atomicAmount, decimals),
    decimals,
  };
}

/** Normalize a parsed transaction into the asset transaction contract. */
function assetTransactionFrom(value: unknown, mint: string) {
  const event = record(value);
  const parsed = record(event.parsed);
  const transfers = array(parsed.tokenTransfers)
    .map((transfer) => transferFromParsed(transfer, mint))
    .filter((transfer) => transfer !== null);
  return {
    signature: stringOrNull(event?.signature),
    slot: Number.isSafeInteger(parsed?.slot) ? parsed.slot : null,
    timestamp: Number.isFinite(parsed?.blockTime)
      ? new Date(Number(parsed.blockTime) * 1000).toISOString()
      : null,
    status:
      parsed?.transactionStatus === 'OK'
        ? 'success'
        : parsed?.transactionStatus === 'ERROR'
          ? 'failed'
          : null,
    action:
      stringOrNull(record(parsed.summary).type) ||
      stringOrNull(record(array(parsed.instructions)[0]).instructionName),
    protocol: stringOrNull(record(record(parsed.summary).parsedData).protocol),
    summary: stringOrNull(record(parsed.summary).description),
    transfers,
  };
}

/** Resolve a bounded cursor page of asset transaction history. */
async function assetTransactionsWork(
  env: Env,
  config: WorkerConfig,
  mint: string,
  limit = V3_ASSET_TRANSACTION_PAGE_SIZE,
  cursor: string | null = null,
) {
  const key = `${V3_ASSET_TRANSACTIONS_KEY_PREFIX}${mint}:${limit}:${cursor || 'initial'}`;
  const cached = await cachedValue(
    env,
    key,
    (value) => Array.isArray(value?.transactions) && validDate(value.asOf),
  );
  if (cached)
    return {
      transactions: cached.transactions,
      nextCursor: cached.nextCursor ?? null,
    };
  if (cacheOnly(config)) {
    const cause = Object.assign(
      new Error('Seeded asset transaction data is unavailable.'),
      { code: 'ASSET_ONCHAIN_UNAVAILABLE' },
    );
    throw cause;
  }
  const apiKey = config.heliusApiKey || env.HELIUS_API_KEY;
  if (!apiKey) {
    const cause = Object.assign(new Error('Helius is not configured.'), {
      code: 'ASSET_ONCHAIN_UNAVAILABLE',
    });
    throw cause;
  }
  const page = await parsedEvents(mint, apiKey, limit, cursor);
  return {
    transactions: page.data
      .map((event) => assetTransactionFrom(event, mint))
      .filter((transaction) => transaction.signature),
    nextCursor: page.paginationToken,
  };
}

/** Normalize an asset-provider wallet holding while preserving exact quantity fields. */
function dasHolding(value: unknown) {
  const item = record(value);
  const mint = item?.id;
  const rawAmount = record(item.token_info).balance;
  const decimals =
    record(item.token_info).decimals ??
    record(record(item.content).metadata).decimals;
  if (
    typeof mint !== 'string' ||
    !/^\d+$/.test(String(rawAmount)) ||
    typeof decimals !== 'number' ||
    !Number.isInteger(decimals) ||
    decimals < 0
  )
    return null;
  return { mint, rawAmount: String(rawAmount), decimals };
}

/** Combine wallet holdings and market metadata without treating missing prices as zero. */
export function mapDasWallet(
  address: string,
  value: unknown,
  marketAssets: Record<string, unknown>[],
) {
  const result = record(value);
  const items = array(result.items);
  const nativeRawAmount = record(result.nativeBalance).lamports;
  const native =
    /^\d+$/.test(String(nativeRawAmount)) && String(nativeRawAmount) !== '0'
      ? [{ mint: SOL_MINT, rawAmount: String(nativeRawAmount), decimals: 9 }]
      : [];
  const holdings = [
    ...native,
    ...items
      .map(dasHolding)
      .filter(
        (holding): holding is NonNullable<ReturnType<typeof dasHolding>> =>
          holding !== null && holding.rawAmount !== '0',
      ),
  ];
  const balancesTruncated =
    holdings.length >= 100 ||
    (typeof result.total === 'number' &&
      Number.isInteger(result.total) &&
      result.total > items.length);
  const returned = holdings.slice(0, 40);
  const assetByMint = new Map(marketAssets.map((asset) => [asset.mint, asset]));
  let pricedHoldingCount = 0;
  let pricedSubtotalUsd = 0;
  const balances = returned.map((holding) => {
    const asset =
      assetByMint.get(holding.mint) ||
      fallbackAsset(holding.mint, holding.decimals);
    const decimals = asset.decimals ?? holding.decimals;
    const amount = formatAtomicAmount(holding.rawAmount, decimals);
    const amountNumber = decimalValue(amount);
    const priceUsd = finiteOrNull(asset.priceUsd);
    const valueUsd =
      amountNumber === null || priceUsd === null
        ? null
        : amountNumber * priceUsd;
    if (valueUsd !== null && Number.isFinite(valueUsd)) {
      pricedHoldingCount += 1;
      pricedSubtotalUsd += valueUsd;
    }
    return {
      mint: holding.mint,
      symbol: asset.symbol,
      name: asset.name,
      decimals,
      iconUrl: asset.iconUrl,
      atomicAmount: holding.rawAmount,
      amount,
      priceUsd,
      valueUsd: Number.isFinite(valueUsd) ? valueUsd : null,
    };
  });
  const unpricedHoldingCount = balances.length - pricedHoldingCount;
  return {
    address,
    balances,
    holdingsTruncated: holdings.length > 40 || balancesTruncated,
    valuation: {
      pricedSubtotalUsd,
      holdingCount: balances.length,
      pricedHoldingCount,
      unpricedHoldingCount,
      complete: !balancesTruncated && !unpricedHoldingCount,
    },
  };
}

/** Resolve wallet data and optionally refresh the market metadata used for valuation. */
async function walletWork(
  env: Env,
  config: WorkerConfig,
  address: string,
  marketRefresh = refreshMarket,
) {
  const key = `${V3_WALLET_KEY_PREFIX}${address}`;
  const cached = await cachedValue(
    env,
    key,
    (value) =>
      record(value.wallet).address === address && validDate(value.asOf),
  );
  if (cached)
    return { wallet: cached.wallet, freshness: cachedFreshness(cached.asOf) };
  if (cacheOnly(config)) {
    const cause = Object.assign(
      new Error('Seeded wallet data is unavailable.'),
      { code: 'WALLET_LOOKUP_UNAVAILABLE' },
    );
    throw cause;
  }
  const apiKey = config.heliusApiKey || env.HELIUS_API_KEY;
  if (!apiKey) {
    const cause = Object.assign(new Error('Helius is not configured.'), {
      code: 'WALLET_LOOKUP_UNAVAILABLE',
    });
    throw cause;
  }
  const result = await heliusRpc(
    'getAssetsByOwner',
    {
      ownerAddress: address,
      page: 1,
      limit: 100,
      displayOptions: {
        showFungible: true,
        showNativeBalance: true,
        showGrandTotal: true,
      },
    },
    apiKey,
  );
  const mints = array(record(result).items)
    .map((item) => record(item).id)
    .filter((mint): mint is string => typeof mint === 'string')
    .slice(0, 40);
  if (!mints.includes(SOL_MINT)) mints.unshift(SOL_MINT);
  let market = null;
  try {
    market = await marketRefresh(
      config.jupiterApiKey || env.JUPITER_API_KEY,
      mints.slice(0, 40),
    );
  } catch (cause) {
    unavailable('wallet-enrichment', 'Jupiter', cause);
  }
  const wallet = mapDasWallet(
    address,
    result,
    (market?.assets || []).map(v3Asset),
  );
  const asOf = new Date().toISOString();
  if (env.SNAPSHOTS?.put)
    await env.SNAPSHOTS.put(key, JSON.stringify({ wallet, asOf }), {
      expirationTtl: V3_WALLET_CACHE_SECONDS,
    });
  return { wallet, freshness: { cacheState: 'miss', asOf } };
}

/** Normalize an exact atomic quantity without a lossy floating-point conversion. */
function atomicAmount(value: unknown): string | null {
  const raw = record(value).tokenAmount ?? record(value).amount ?? value;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return raw;
  if (typeof raw === 'bigint') return raw.toString();
  // JSON numbers above this boundary have already lost integer precision.
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
    ? String(raw)
    : null;
}

/** Extract supported transfer details from parsed transaction evidence. */
function transferDetails(parsed: Record<string, unknown>) {
  return {
    native: array(parsed.nativeTransfers)
      .map(record)
      .map((transfer) => ({
        from: transfer.fromUserAccount ?? null,
        to: transfer.toUserAccount ?? null,
        atomicAmount: atomicAmount(
          transfer.amount ?? transfer.lamports ?? transfer.rawAmount,
        ),
        decimals: 9,
      })),
    tokens: array(parsed.tokenTransfers)
      .map(record)
      .map((transfer) => {
        const raw =
          transfer.rawTokenAmount ?? transfer.tokenAmount ?? transfer.amount;
        const decimals = transfer.decimals ?? record(raw).decimals;
        return {
          mint: transfer.mint ?? null,
          from: transfer.fromUserAccount ?? null,
          to: transfer.toUserAccount ?? null,
          fromTokenAccount: transfer.fromTokenAccount ?? null,
          toTokenAccount: transfer.toTokenAccount ?? null,
          atomicAmount: atomicAmount(raw),
          decimals:
            typeof decimals === 'number' &&
            Number.isInteger(decimals) &&
            decimals >= 0
              ? decimals
              : null,
          tokenStandard:
            typeof transfer.tokenStandard === 'string'
              ? transfer.tokenStandard
              : null,
        };
      }),
  };
}

/** Normalize provider transaction evidence into the v3 event contract. */
export function mapV3Event(value: unknown) {
  const event = record(value);
  const parsed = record(event.parsed);
  const summary = record(parsed.summary);
  return {
    id: typeof event?.signature === 'string' ? event.signature : null,
    timestamp: Number.isFinite(parsed?.blockTime)
      ? new Date(Number(parsed.blockTime) * 1000).toISOString()
      : null,
    type: typeof summary?.type === 'string' ? summary.type : null,
    source:
      typeof record(summary.parsedData).protocol === 'string'
        ? record(summary.parsedData).protocol
        : null,
    status:
      event?.parserStatus === 'OK' && parsed?.transactionStatus === 'OK'
        ? 'success'
        : 'failed',
    summary:
      typeof summary?.description === 'string' ? summary.description : null,
    description:
      typeof summary?.description === 'string' ? summary.description : null,
    transfers: transferDetails(parsed),
  };
}

/** Resolve a bounded cursor page of address events. */
async function eventsWork(
  env: Env,
  config: WorkerConfig,
  address: string,
  limit: number,
  cursor: string | null,
) {
  const key = `${V3_WALLET_EVENTS_KEY_PREFIX}${address}:${limit}:${cursor || 'initial'}`;
  const cached = await cachedValue(
    env,
    key,
    (value) => Array.isArray(value.events) && validDate(value.asOf),
  );
  if (cached)
    return { events: cached.events, nextCursor: cached.nextCursor ?? null };
  if (cacheOnly(config)) {
    const cause = Object.assign(
      new Error('Seeded wallet activity is unavailable.'),
      { code: 'WALLET_LOOKUP_UNAVAILABLE' },
    );
    throw cause;
  }
  const apiKey = config.heliusApiKey || env.HELIUS_API_KEY;
  if (!apiKey) {
    const cause = Object.assign(new Error('Helius is not configured.'), {
      code: 'WALLET_LOOKUP_UNAVAILABLE',
    });
    throw cause;
  }
  const page = await parsedEvents(address, apiKey, limit, cursor);
  const data = page.data.map(mapV3Event);
  return { events: data, nextCursor: page.paginationToken };
}

/** Coalesce equivalent on-chain asset reads under the complete resource and provider identity. */
export function loadV3AssetOnchain(
  env: Env,
  config: WorkerConfig,
  mint: string,
) {
  return singleFlight(
    env.SNAPSHOTS ?? env,
    ['onchain', ...providerKey(env, config), mint],
    () => assetOnchainWork(env, config, mint),
  );
}

/** Coalesce equivalent holder-page reads under the complete resource and provider identity. */
export function loadV3AssetHolders(
  env: Env,
  config: WorkerConfig,
  mint: string,
  page = 1,
) {
  return singleFlight(
    env.SNAPSHOTS ?? env,
    ['holders', ...providerKey(env, config), mint, page],
    () => assetHoldersWork(env, config, mint, page),
  );
}

/** Coalesce equivalent distribution reads under the complete resource and provider identity. */
export function loadV3AssetDistribution(
  env: Env,
  config: WorkerConfig,
  mint: string,
) {
  return singleFlight(
    env.SNAPSHOTS ?? env,
    ['distribution', ...providerKey(env, config), mint],
    () => assetDistributionWork(env, config, mint),
  );
}

/** Coalesce equivalent asset transaction pages without mixing cursors or limits. */
export function loadV3AssetTransactions(
  env: Env,
  config: WorkerConfig,
  mint: string,
  limit = V3_ASSET_TRANSACTION_PAGE_SIZE,
  cursor: string | null = null,
) {
  return singleFlight(
    env.SNAPSHOTS ?? env,
    ['asset-transactions', ...providerKey(env, config), mint, limit, cursor],
    () => assetTransactionsWork(env, config, mint, limit, cursor),
  );
}

/** Coalesce equivalent wallet reads without mixing market-refresh policies. */
export function loadV3Wallet(
  env: Env,
  config: WorkerConfig,
  address: string,
  marketRefresh = refreshMarket,
) {
  return singleFlight(
    env.SNAPSHOTS ?? env,
    ['wallet', ...providerKey(env, config), address, marketRefresh],
    () => walletWork(env, config, address, marketRefresh),
  );
}

/** Coalesce equivalent event pages without mixing address, cursor or limit. */
export function loadV3Events(
  env: Env,
  config: WorkerConfig,
  address: string,
  limit: number,
  cursor: string | null,
) {
  return singleFlight(
    env.SNAPSHOTS ?? env,
    ['wallet-events', ...providerKey(env, config), address, limit, cursor],
    () => eventsWork(env, config, address, limit, cursor),
  );
}
import { unavailable } from './diagnostics.ts';
