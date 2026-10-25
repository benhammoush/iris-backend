/**
 * Complete-before-pointer snapshot publication, refresh and wallet normalization.
 * @packageDocumentation
 */

import { FIXTURE_SNAPSHOT, MARKET_SNAPSHOT } from './fixtures.ts';
import { singleFlight, providerKey } from './singleFlight.ts';
import {
  MAX_DISCOVERED_ASSETS,
  MAX_SWAPS,
  MAX_TRACKED_POOL_TRANSACTIONS,
  MAX_TRANSACTIONS_PER_WALLET,
  MAX_TRANSACTION_SCAN_PER_WALLET,
  SNAPSHOT_FRESH_AFTER_MS,
  SNAPSHOT_KEY_PREFIX,
  SNAPSHOT_POINTER_KEY,
  SOL_MINT,
  STALE_AFTER_MS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './constants.ts';
import {
  refreshDiscoveryCatalogs,
  refreshMarket,
  type MarketAsset,
} from './market.ts';
import type { Env } from './env.ts';
import type { ProviderConfig as WorkerConfig } from './config.ts';
import { array, record, isRecord, scalarText } from './record.ts';
import { refreshNetworkMetrics } from './network.ts';
import { providerJson } from './providerRequest.ts';
import {
  isRegisteredDexSwap,
  protocolForSwap,
  registeredDexRoutes,
} from './dexRegistry.ts';
import {
  addAtomicAmounts,
  assetIdentity,
  decimalValue,
  formatAtomicAmount,
  isBase58PublicKey,
} from './transforms.ts';

const HELIUS_RPC = 'https://mainnet.helius-rpc.com/';
const HELIUS_ENHANCED = 'https://api.helius.xyz/v0';

/** Asset fields required before a persisted snapshot is safe to serve. */
interface SnapshotAsset extends Record<string, unknown> {
  mint: string;
  symbol: string;
  name: string;
  contractId: string;
  priceHistory: unknown[] | null;
}

/** Published market snapshot with freshness and resource data. */
export interface Snapshot extends Record<string, unknown> {
  createdAt: string;
  market: Record<string, unknown> & { source: string; asOf: string };
  assets: SnapshotAsset[];
  wallets: Record<string, unknown>;
  swaps: unknown[];
}

/** Tracked wallet address and its display metadata. */
interface WalletIdentity {
  address: string;
  label?: string;
  description?: string;
}

/** Validate the fields required to reuse an asset from a stored snapshot.
 * @param asset - Unknown asset loaded from snapshot storage.
 * @returns Whether its identity and history fields satisfy the serving contract.
 */
function isSnapshotAsset(asset: unknown): asset is SnapshotAsset {
  return (
    isRecord(asset) &&
    typeof asset.symbol === 'string' &&
    typeof asset.name === 'string' &&
    typeof asset.mint === 'string' &&
    isBase58PublicKey(asset.mint) &&
    asset.contractId === asset.mint &&
    (asset.priceHistory === null || Array.isArray(asset.priceHistory))
  );
}

/** Call the configured Solana RPC provider with a bounded request deadline.
 * @param method - Read-only RPC method selected by trusted code.
 * @param params - Method-specific request parameters.
 * @param apiKey - Server-only operator RPC credential.
 * @param timeoutMs - Maximum request duration in milliseconds.
 * @returns Unknown RPC result for subsequent domain normalization.
 */
async function heliusRpc(
  method: string,
  params: unknown[],
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
      `Helius RPC error: ${scalarText(record(payload.error).message, 'unknown') || 'unknown'}`,
    );
  return payload.result;
}

/** Fetch enhanced provider data through the bounded request boundary.
 * @param path - Trusted enhanced-provider resource path.
 * @param apiKey - Server-only operator provider credential.
 * @returns Unknown provider JSON for subsequent domain normalization.
 */
async function heliusEnhanced(path: string, apiKey: string): Promise<unknown> {
  return providerJson(
    `${HELIUS_ENHANCED}${path}${path.includes('?') ? '&' : '?'}api-key=${encodeURIComponent(apiKey)}`,
    {},
    { provider: 'Helius enhanced' },
  );
}

/** Validate snapshot structure before exposing cached data to callers.
 * @param snapshot - Unknown stored snapshot payload.
 * @returns Whether its timestamps and resource fields satisfy the serving contract.
 */
export function isUsableSnapshot(snapshot: unknown): snapshot is Snapshot {
  if (
    !isRecord(snapshot) ||
    typeof snapshot.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.createdAt))
  )
    return false;
  return (
    isRecord(snapshot.market) &&
    typeof snapshot.market.source === 'string' &&
    typeof snapshot.market.asOf === 'string' &&
    Number.isFinite(Date.parse(snapshot.market.asOf)) &&
    Array.isArray(snapshot.assets) &&
    array(snapshot.assets).every(isSnapshotAsset) &&
    isRecord(snapshot.wallets) &&
    Array.isArray(snapshot.swaps)
  );
}

/** Resolve the published snapshot pointer with explicit fresh, stale and fixture fallback states.
 * @param kv - Optional JSON snapshot store; absent storage selects explicit fixtures.
 * @param now - Current time in milliseconds for age classification.
 * @param retainStale - Whether usable snapshots beyond the normal stale limit remain eligible.
 * @returns The selected snapshot and its explicit fixture/fresh/stale classification.
 */
export async function resolveSnapshot(
  kv?: {
    /** Read the published pointer or snapshot payload as JSON.
     * @param key - Pointer or immutable snapshot key.
     * @param type - JSON decoding selector.
     * @returns Unknown stored JSON, or null when missing.
     */
    get: (key: string, type: 'json') => Promise<unknown>;
  } | null,
  now = Date.now(),
  retainStale = false,
): Promise<{ snapshot: Snapshot; state: 'fixture' | 'fresh' | 'stale' }> {
  if (!kv) return { snapshot: FIXTURE_SNAPSHOT, state: 'fixture' };
  const pointer = record(await kv.get(SNAPSHOT_POINTER_KEY, 'json'));
  if (typeof pointer.key !== 'string' || !pointer.key)
    return { snapshot: FIXTURE_SNAPSHOT, state: 'fixture' };
  const snapshot = await kv.get(pointer.key, 'json');
  if (!isUsableSnapshot(snapshot))
    return { snapshot: FIXTURE_SNAPSHOT, state: 'fixture' };
  const age = now - Date.parse(snapshot.createdAt);
  if (age < 0 || (!retainStale && age > STALE_AFTER_MS))
    return { snapshot: FIXTURE_SNAPSHOT, state: 'fixture' };
  return {
    snapshot,
    state: age <= SNAPSHOT_FRESH_AFTER_MS ? 'fresh' : 'stale',
  };
}

/** Normalize one provider token-balance change without losing atomic quantity precision.
 * @param change - Provider record whose individual fields remain unknown.
 * @returns The supported token change with exact scalar quantity text.
 */
function normalizeTokenChange(change: Record<string, unknown>) {
  const rawAmount =
    record(change.rawTokenAmount).tokenAmount ??
    change.tokenAmount ??
    change.rawAmount ??
    change.amount ??
    '0';
  return {
    mint: change.mint,
    assetId: change.mint,
    rawAmount: scalarText(rawAmount, 'invalid'),
    decimals: record(change.rawTokenAmount).decimals ?? change.decimals ?? null,
    userAccount:
      change.userAccount ??
      change.fromUserAccount ??
      change.toUserAccount ??
      null,
  };
}

/** Normalize provider transaction fields into the public transaction contract.
 * @param transaction - Object-shaped provider transaction with unknown field values.
 * @returns Supported identity, timing and transfer fields without quantity rounding.
 */
function normalizeTransaction(transaction: Record<string, unknown>) {
  return {
    id: transaction.signature,
    txId: transaction.signature,
    chain: 'solana',
    timestamp: transaction.timestamp
      ? new Date(Number(transaction.timestamp) * 1000).toISOString()
      : null,
    blockHeight: transaction.slot ?? null,
    type: transaction.type ?? null,
    status: transaction.transactionError ? 'failed' : 'success',
    source: transaction.source ?? null,
    nativeTransfers: array(transaction.nativeTransfers)
      .filter(isRecord)
      .map((transfer) => ({
        ...transfer,
        amount: scalarText(transfer.amount ?? '0', 'invalid'),
      })),
    tokenTransfers: array(transaction.tokenTransfers)
      .filter(isRecord)
      .map(normalizeTokenChange),
  };
}

/** Normalize a supported swap while retaining its optional wallet association.
 * @param wallet - Optional wallet association, absent for globally tracked pools.
 * @param transaction - Object-shaped decoded provider transaction.
 * @returns Normalized transaction and swap legs without inventing pricing or side.
 */
function normalizeSwap(
  wallet: string | null,
  transaction: Record<string, unknown>,
) {
  const swap = record(record(transaction.events).swap);
  const input = array(swap.tokenInputs)[0] || swap.nativeInput;
  const output = array(swap.tokenOutputs)[0] || swap.nativeOutput;
  return {
    ...normalizeTransaction(transaction),
    wallet,
    protocol: protocolForSwap(transaction),
    input: input ? normalizeTokenChange(record(input)) : null,
    output: output ? normalizeTokenChange(record(output)) : null,
    side: null,
    value: null,
  };
}

/** Fetch bounded balances and transaction evidence for one wallet.
 * @param wallet - Wallet identity whose balance and bounded activity are requested.
 * @param apiKey - Server-only operator provider credential.
 * @returns Exact grouped balances and object-shaped transaction evidence.
 */
async function fetchWalletSource(wallet: WalletIdentity, apiKey: string) {
  const [balance, classicAccounts, token2022Accounts, transactions] =
    await Promise.all([
      heliusRpc('getBalance', [wallet.address], apiKey),
      heliusRpc(
        'getTokenAccountsByOwner',
        [
          wallet.address,
          { programId: TOKEN_PROGRAM_ID },
          { encoding: 'jsonParsed' },
        ],
        apiKey,
      ),
      heliusRpc(
        'getTokenAccountsByOwner',
        [
          wallet.address,
          { programId: TOKEN_2022_PROGRAM_ID },
          { encoding: 'jsonParsed' },
        ],
        apiKey,
      ),
      heliusEnhanced(
        `/addresses/${wallet.address}/transactions?limit=${MAX_TRANSACTION_SCAN_PER_WALLET}`,
        apiKey,
      ),
    ]);
  const accountInfos = [
    ...array(record(classicAccounts).value),
    ...array(record(token2022Accounts).value),
  ]
    .map(
      (account) =>
        record(record(record(record(account).account).data).parsed).info,
    )
    .filter(isRecord);
  const grouped = new Map<string, { amounts: string[]; decimals: number }>();
  for (const info of accountInfos) {
    if (typeof info.mint !== 'string') continue;
    const tokenAmount = record(info.tokenAmount);
    const current = grouped.get(info.mint) || {
      amounts: [],
      decimals:
        typeof tokenAmount.decimals === 'number' ? tokenAmount.decimals : 0,
    };
    current.amounts.push(scalarText(tokenAmount.amount ?? '0', 'invalid'));
    grouped.set(info.mint, current);
  }
  const tokenBalances = [...grouped.entries()].flatMap(([mint, value]) => {
    const rawAmount = addAtomicAmounts(value.amounts);
    return rawAmount === null || rawAmount === '0'
      ? []
      : [{ mint, rawAmount, decimals: value.decimals }];
  });
  return {
    nativeRawAmount: scalarText(record(balance).value ?? '0', 'invalid'),
    tokenBalances,
    transactions: array(transactions).filter(isRecord),
  };
}

/** Refresh registered pools and reject partial refreshes rather than publish an incomplete success.
 * @param apiKey - Server-only operator provider credential.
 * @returns Deduplicated supported swaps only when every tracked pool read succeeds.
 */
async function fetchTrackedPoolSwaps(apiKey: string) {
  const routes = registeredDexRoutes();
  const results = await Promise.allSettled(
    routes.flatMap((route) =>
      route.pools.map((pool) =>
        heliusEnhanced(
          `/addresses/${pool}/transactions?limit=${MAX_TRACKED_POOL_TRANSACTIONS}`,
          apiKey,
        ),
      ),
    ),
  );
  const bySignature = new Map<string, Record<string, unknown>>();
  let succeeded = 0;
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    succeeded += 1;
    for (const transaction of array(result.value).filter(isRecord)) {
      if (
        isRegisteredDexSwap(transaction) &&
        typeof transaction.signature === 'string' &&
        transaction.signature
      )
        bySignature.set(transaction.signature, transaction);
    }
  }
  if (succeeded !== results.length)
    throw new Error('A tracked pool refresh failed.');
  return [...bySignature.values()].map((transaction) =>
    normalizeSwap(null, transaction),
  );
}

/** Build asset identity with unavailable metrics represented as null, not fabricated zero values.
 * @param mint - Solana mint identity.
 * @param decimals - Decimal context available from the token account.
 * @returns Existing fixture metadata or identity-only metadata with unavailable metrics.
 */
function fallbackAsset(mint: string, decimals = 0) {
  const existing = MARKET_SNAPSHOT.assets.find((asset) => asset.mint === mint);
  return (
    existing || {
      ...assetIdentity(mint),
      symbol: mint.slice(0, 8),
      name: mint,
      imageUrl: '',
      decimals,
      price: null,
      supply: null,
      totalSupply: null,
      marketCap: null,
      change24h: null,
      change7d: null,
      change30d: null,
      priceHistory: null,
      actualprice: null,
      image: '',
      marketcap: null,
      pricedayminusone: null,
      percentdayminusone: null,
      priceweekminusone: null,
      percentweekminusone: null,
      pricemonthminusone: null,
      percentmonthminusone: null,
      contractname: mint,
    }
  );
}

/** Combine exact balances with available prices; keep the total unknown if any holding cannot be valued.
 * @param wallet - Wallet display identity.
 * @param source - Exact balances and activity, or null when unavailable.
 * @param assets - Available market or identity-only asset metadata.
 * @returns Holdings, activity and a total only when every holding can be valued.
 */
function buildWalletData(
  wallet: WalletIdentity,
  source: Awaited<ReturnType<typeof fetchWalletSource>> | null,
  assets: (MarketAsset | ReturnType<typeof fallbackAsset>)[],
) {
  if (!source)
    return {
      label: wallet.label,
      description: wallet.description,
      chain: 'solana',
      assets: [],
      totalValue: null,
      portfolioTotal: null,
      activity: [],
      transactions: [],
      swaps: [],
    };
  const balances = [
    { mint: SOL_MINT, rawAmount: source.nativeRawAmount, decimals: 9 },
    ...source.tokenBalances,
  ];
  const assetByMint = new Map(assets.map((asset) => [asset.mint, asset]));
  const walletAssets = balances.map(({ mint, rawAmount, decimals }) => {
    const asset = assetByMint.get(mint) || fallbackAsset(mint, decimals);
    const displayBalance = formatAtomicAmount(rawAmount, asset.decimals);
    const numericBalance = decimalValue(displayBalance);
    const price = typeof asset.price === 'number' ? asset.price : null;
    return {
      ...assetIdentity(mint),
      symbol: asset.symbol,
      name: asset.name,
      imageUrl: asset.imageUrl,
      decimals: asset.decimals,
      rawBalance: rawAmount,
      balance: displayBalance,
      displayBalance,
      price,
      value:
        numericBalance === null || price === null
          ? null
          : numericBalance * price,
    };
  });
  const transactions = source.transactions
    .slice(0, MAX_TRANSACTIONS_PER_WALLET)
    .map(normalizeTransaction);
  const swaps = source.transactions
    .filter(isRegisteredDexSwap)
    .map((transaction) => normalizeSwap(wallet.address, transaction));
  const totalValue = walletAssets.every(
    (asset) => typeof asset.value === 'number',
  )
    ? walletAssets.reduce((total, asset) => total + (asset.value ?? 0), 0)
    : null;
  return {
    label: wallet.label,
    description: wallet.description,
    chain: 'solana',
    assets: walletAssets,
    totalValue,
    portfolioTotal: totalValue,
    activity: transactions,
    transactions,
    swaps,
  };
}

/** Resolve wallet balances and bounded market metadata using the effective provider configuration.
 * @param env - Binding-scoped provider configuration.
 * @param config - Effective selected provider settings.
 * @param address - Wallet identity to inspect.
 * @returns Exact balances enriched with available market metadata.
 */
async function walletDataWork(env: Env, config: WorkerConfig, address: string) {
  const apiKey = config.heliusApiKey || env.HELIUS_API_KEY;
  if (!apiKey) {
    const cause = Object.assign(new Error('Helius is not configured.'), {
      code: 'WALLET_LOOKUP_UNAVAILABLE',
    });
    throw cause;
  }
  const source = await fetchWalletSource({ address }, apiKey);
  const mints = [
    ...new Set([
      SOL_MINT,
      ...source.tokenBalances.map((balance) => balance.mint),
    ]),
  ].slice(0, MAX_DISCOVERED_ASSETS);
  const market = await refreshMarket(
    config.jupiterApiKey || env.JUPITER_API_KEY,
    mints,
  );
  const marketAssetsByMint = new Map(
    (market?.assets || []).map((asset) => [asset.mint, asset]),
  );
  const assets = mints.map(
    (mint) => marketAssetsByMint.get(mint) || fallbackAsset(mint),
  );
  return {
    address,
    ...buildWalletData(
      { address, label: address, description: '' },
      source,
      assets,
    ),
  };
}

/** Build a complete snapshot before publishing its cache pointer; retain usable previous data on supported failures.
 * @param env - Snapshot storage and provider bindings.
 * @param config - Effective selected provider settings.
 * @param now - Timestamp used for the snapshot and immutable storage key.
 * @returns A fully published snapshot or an explicitly eligible previous/fixture snapshot.
 */
async function snapshotWork(env: Env, config: WorkerConfig, now = new Date()) {
  const apiKey = config.heliusApiKey || env.HELIUS_API_KEY;
  const retainStale = env.RETAIN_STALE_MARKET_DATA === 'true';
  const existing = await resolveSnapshot(
    env.SNAPSHOTS,
    now.getTime(),
    retainStale,
  );
  if (!apiKey)
    return existing.state === 'fixture' ? FIXTURE_SNAPSHOT : existing.snapshot;
  const [trackedPoolResult, network] = await Promise.all([
    fetchTrackedPoolSwaps(apiKey).catch((cause) => {
      unavailable('tracked-swaps', 'Helius', cause);
      return existing.state === 'fixture' ? [] : existing.snapshot.swaps;
    }),
    refreshNetworkMetrics(
      (method, params, timeoutMs) =>
        heliusRpc(method, params, apiKey, timeoutMs),
      existing.snapshot.network,
      now,
    ).catch((cause) => {
      unavailable('network-refresh', 'Helius', cause);
      return existing.snapshot.network || FIXTURE_SNAPSHOT.network;
    }),
  ]);
  const jupiterApiKey = config.jupiterApiKey || env.JUPITER_API_KEY;
  const market = await refreshMarket(jupiterApiKey);
  if (!market || !market.assets.length) {
    if (existing.state !== 'fixture') return existing.snapshot;
    throw new Error(
      'Jupiter market discovery is unavailable and no usable snapshot exists.',
    );
  }
  const assets = market.assets;
  const discoveryCatalogs = await refreshDiscoveryCatalogs(jupiterApiKey);
  const wallets = {};
  const swaps = trackedPoolResult
    .sort((left, right) =>
      scalarText(record(right).timestamp, '').localeCompare(
        scalarText(record(left).timestamp, ''),
      ),
    )
    .slice(0, MAX_SWAPS);
  const snapshot = {
    version: 2,
    createdAt: now.toISOString(),
    source: 'helius-jupiter',
    market: {
      fees: null,
      slot: record(record(network).chain).finalizedSlot ?? null,
      block_height: record(record(network).chain).blockHeight ?? null,
      source: market.source,
      asOf: market.asOf,
      historySource: null,
      liveAssetCount: market.liveAssetCount,
      swaps: {
        count: swaps.length,
        asOf: new Date().toISOString(),
        source: 'helius-decoded-tracked-pools',
        scope: 'registered-liquid-pools',
        error: null,
      },
      history: [],
    },
    network,
    assets,
    catalogs: { topTraded: assets, ...discoveryCatalogs },
    wallets,
    swaps,
  };
  const key = `${SNAPSHOT_KEY_PREFIX}${now.getTime()}`;
  await env.SNAPSHOTS.put(
    key,
    JSON.stringify(snapshot),
    retainStale ? {} : { expirationTtl: Math.ceil(STALE_AFTER_MS / 1000) },
  );
  // Publish only after the complete payload exists; readers follow this pointer and
  // must never observe a new identity whose snapshot write has not finished.
  await env.SNAPSHOTS.put(
    SNAPSHOT_POINTER_KEY,
    JSON.stringify({ key, createdAt: snapshot.createdAt }),
  );
  return snapshot;
}

/** Coalesce wallet reads only within the same binding, provider configuration and address.
 * @param env - Snapshot and provider bindings identifying the request scope.
 * @param config - Effective selected provider settings.
 * @param address - Wallet identity to inspect.
 * @returns The coalesced wallet lookup without sharing across identities/configurations.
 */
export function loadWalletData(
  env: Env,
  config: WorkerConfig,
  address: string,
) {
  return singleFlight(
    env.SNAPSHOTS ?? env,
    ['legacy-wallet', ...providerKey(env, config), address],
    () => walletDataWork(env, config, address),
  );
}

/** Coalesce snapshot refreshes using binding, provider and stale-retention policy identity.
 * @param env - Snapshot/provider bindings and stale-retention policy.
 * @param config - Effective selected provider settings.
 * @param now - Snapshot timestamp supplied to the refresh.
 * @returns The coalesced complete-before-pointer refresh result.
 */
export function refreshSnapshot(
  env: Env,
  config: WorkerConfig,
  now = new Date(),
) {
  return singleFlight(
    env.SNAPSHOTS ?? env,
    [
      'snapshot-refresh',
      ...providerKey(env, config),
      env.RETAIN_STALE_MARKET_DATA === 'true',
    ],
    () =>
      refreshDiagnostic('snapshot-refresh', () =>
        snapshotWork(env, config, now),
      ),
  );
}
import { unavailable, refreshDiagnostic } from './diagnostics.ts';
