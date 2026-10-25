/**
 * Seed deterministic data into the isolated local end-to-end KV environment.
 * @file
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CANDLE_KEY_PREFIX,
  CANDLE_PAGE_SIZE,
  SNAPSHOT_KEY_PREFIX,
  SNAPSHOT_POINTER_KEY,
  SOL_MINT,
  V3_ASSET_DISTRIBUTION_KEY_PREFIX,
  V3_ASSET_HOLDERS_KEY_PREFIX,
  V3_ASSET_TRANSACTIONS_KEY_PREFIX,
  V3_HELIUS_DASHBOARD_KEY,
  V3_WALLET_EVENTS_KEY_PREFIX,
  V3_WALLET_KEY_PREFIX,
  DEFILLAMA_DASHBOARD_KEY,
} from '../src/constants.ts';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const walletAddress = '7Yk4L5M6N7P8Q9R2tB6dF8gH1jK4L5M6N7P8Q9R2tB6d';
const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Build deterministic asset fixture data for the isolated test environment. */
function asset(mint, symbol, name, decimals, priceUsd, marketCapUsd) {
  return {
    mint,
    symbol,
    name,
    decimals,
    iconUrl: null,
    priceUsd,
    marketCapUsd,
    circulatingSupply: null,
    totalSupply: null,
    fullyDilutedValuationUsd: null,
    change24hPct: 2.5,
    liquidityUsd: null,
    holderCount: null,
    verification: { isVerified: true, tags: ['verified'] },
    quality: { organicScore: null, organicScoreLabel: null, audit: null },
    activity: {
      buyVolume24hUsd: 500_000_000,
      sellVolume24hUsd: 750_000_000,
      volume24hUsd: 1_250_000_000,
    },
  };
}

/** Build a deterministic candle fixture with the requested observation time. */
function candle(timestamp, closeUsd) {
  return {
    timestamp,
    openUsd: closeUsd - 1,
    highUsd: closeUsd + 2,
    lowUsd: closeUsd - 2,
    closeUsd,
    volume: 1_000,
    volumeUsd: closeUsd * 1_000,
  };
}

/** Build the deterministic records needed by the isolated test fixture. */
function records(now) {
  const sol = asset(SOL_MINT, 'SOL', 'Solana', 9, 150.25, 75_000_000_000);
  const usdc = asset(usdcMint, 'USDC', 'USD Coin', 6, 1, 61_000_000_000);
  const snapshot = {
    version: 2,
    createdAt: now,
    source: 'e2e-seed',
    market: {
      source: 'e2e-seed',
      asOf: now,
      swaps: { count: 0, source: 'e2e-seed', scope: 'registered-liquid-pools' },
    },
    network: {
      source: 'e2e-seed',
      fetchedAt: now,
      chain: { state: 'fresh', asOf: now },
      performance: { state: 'fresh', asOf: now },
      production: { state: 'fresh', asOf: now },
      fees: { state: 'fresh', asOf: now },
      validators: { state: 'fresh', asOf: now },
      economics: { state: 'fresh', asOf: now },
      reliability: { state: 'fresh', asOf: now },
    },
    assets: [
      {
        mint: SOL_MINT,
        symbol: 'SOL',
        name: 'Solana',
        contractId: SOL_MINT,
        priceHistory: null,
        v3: sol,
      },
      {
        mint: usdcMint,
        symbol: 'USDC',
        name: 'USD Coin',
        contractId: usdcMint,
        priceHistory: null,
        v3: usdc,
      },
    ],
    catalogs: {
      topTraded: [
        {
          mint: SOL_MINT,
          symbol: 'SOL',
          name: 'Solana',
          contractId: SOL_MINT,
          priceHistory: null,
          v3: sol,
        },
      ],
      trending: [],
      recent: [],
    },
    wallets: {},
    swaps: [],
  };
  const snapshotKey = `${SNAPSHOT_KEY_PREFIX}e2e`;
  const candles = [
    candle(new Date(Date.now() - 3_600_000).toISOString(), 149),
    candle(now, 150.25),
  ];
  const wallet = {
    address: walletAddress,
    label: 'Treasury Wallet',
    description: 'Seeded public portfolio',
    balances: [
      {
        mint: SOL_MINT,
        symbol: 'SOL',
        name: 'Solana',
        decimals: 9,
        iconUrl: null,
        atomicAmount: '42500000000',
        amount: '42.5',
        priceUsd: 150.25,
        valueUsd: 6385.625,
      },
      {
        mint: usdcMint,
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        iconUrl: null,
        atomicAmount: '2000000',
        amount: '2',
        priceUsd: null,
        valueUsd: null,
      },
    ],
    holdingsTruncated: true,
    valuation: {
      pricedSubtotalUsd: 6385.625,
      holdingCount: 2,
      pricedHoldingCount: 1,
      unpricedHoldingCount: 1,
      complete: false,
    },
  };
  /** Build a deterministic transaction-event fixture. */
  const event = (id, amount) => ({
    id,
    timestamp: now,
    type: 'TRANSFER',
    source: 'seed',
    status: 'success',
    description: 'Seeded transfer',
    transfers: {
      native: [
        { from: null, to: walletAddress, atomicAmount: amount, decimals: 9 },
      ],
      tokens: [],
    },
  });
  return new Map([
    [SNAPSHOT_POINTER_KEY, { key: snapshotKey, createdAt: now }],
    [snapshotKey, snapshot],
    [
      V3_HELIUS_DASHBOARD_KEY,
      {
        version: 1,
        source: 'e2e-seed',
        asOf: now,
        slot: 1,
        transactionAsOf: now,
        transactionsFreshness: 'fresh',
        transactions: [],
        network: {
          source: 'e2e-seed',
          fetchedAt: now,
          chain: { state: 'fresh' },
          performance: { state: 'fresh' },
          fees: { state: 'fresh' },
        },
      },
    ],
    [
      DEFILLAMA_DASHBOARD_KEY,
      {
        source: 'e2e-seed',
        fetchedAt: now,
        dexes: { total24hUsd: 0, total7dUsd: 0, items: [] },
        protocols: { total: 0, items: [] },
      },
    ],
    [
      `${CANDLE_KEY_PREFIX}${SOL_MINT}:1H:${CANDLE_PAGE_SIZE}:usd:latest`,
      {
        version: 2,
        mint: SOL_MINT,
        source: 'birdeye',
        timeframe: '1H',
        count: CANDLE_PAGE_SIZE,
        fetchedAt: now,
        candles,
      },
    ],
    [
      `${CANDLE_KEY_PREFIX}${SOL_MINT}:30m:${CANDLE_PAGE_SIZE}:usd:latest`,
      {
        version: 2,
        mint: SOL_MINT,
        source: 'birdeye',
        timeframe: '30m',
        count: CANDLE_PAGE_SIZE,
        fetchedAt: now,
        candles,
      },
    ],
    [
      `asset:v3:onchain:${SOL_MINT}`,
      {
        asOf: now,
        profile: {
          mint: SOL_MINT,
          metadata: { name: 'Solana', symbol: 'SOL' },
          mintState: { decimals: 9, supplyAtomic: '1', supply: '0.000000001' },
        },
      },
    ],
    [
      `${V3_ASSET_HOLDERS_KEY_PREFIX}${SOL_MINT}:1`,
      { asOf: now, page: 1, holders: [], total: 0, cursor: null },
    ],
    [
      `${V3_ASSET_DISTRIBUTION_KEY_PREFIX}${SOL_MINT}`,
      {
        asOf: now,
        accounts: [
          {
            rank: 1,
            tokenAccount: '8qbHbw2BbbTHBW1sBXgze1XNp82btd5Jpi1LjYp5Vh7e',
            owner: walletAddress,
            atomicAmount: '5000000',
            amount: '5000000',
            decimals: 9,
            frozen: false,
            supplyPercent: '1.25',
          },
        ],
        supplyAtomic: '400000000000000000',
        slot: 1,
      },
    ],
    [
      `${V3_ASSET_TRANSACTIONS_KEY_PREFIX}${SOL_MINT}:50:initial`,
      {
        asOf: now,
        transactions: [
          {
            signature: '5N6n8Xq2w4cP1V3s9Yk7mR2tB6dF8gH1jK4L5M6N7P8Q',
            timestamp: now,
            action: 'TRANSFER',
            protocol: 'seed',
            summary: 'Seeded asset transfer',
            transfers: [
              {
                from: null,
                to: walletAddress,
                atomicAmount: '12500000000',
                amount: '12.5',
                decimals: 9,
              },
            ],
          },
        ],
        nextCursor: null,
      },
    ],
    [`${V3_WALLET_KEY_PREFIX}${walletAddress}`, { asOf: now, wallet }],
    [
      `${V3_WALLET_EVENTS_KEY_PREFIX}${walletAddress}:25:initial`,
      {
        asOf: now,
        events: [event('seed-tx-1', '42500000000')],
        nextCursor: 'next-page',
      },
    ],
    [
      `${V3_WALLET_EVENTS_KEY_PREFIX}${walletAddress}:25:next-page`,
      {
        asOf: now,
        events: [event('seed-tx-2', '1000000000')],
        nextCursor: null,
      },
    ],
  ]);
}

const directory = await mkdtemp(join(tmpdir(), 'iris-e2e-kv-'));
try {
  for (const [key, value] of records(new Date().toISOString())) {
    const path = join(directory, `${encodeURIComponent(key)}.json`);
    await writeFile(path, JSON.stringify(value));
    await run(
      process.execPath,
      [
        wrangler,
        'kv',
        'key',
        'put',
        key,
        '--binding',
        'SNAPSHOTS',
        '--env',
        'e2e',
        '--local',
        '--persist-to',
        '.wrangler/e2e',
        '--path',
        path,
      ],
      { cwd: root },
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
