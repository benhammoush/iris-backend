/**
 * Regression coverage and controlled fixtures for market.
 * @packageDocumentation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRequestError } from '../../src/providerRequest.ts';
import { MAX_CATALOG_ASSETS, SOL_MINT } from '../../src/constants.ts';
import {
  CANDLE_TIMEFRAMES,
  fetchCandles,
  refreshDiscoveryCatalogs,
  refreshMarket,
} from '../../src/market.ts';

void test('market refresh uses Jupiter Tokens V2 fields for the verified ranked catalog', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) =>
    Promise.resolve(
      Response.json(
        (url instanceof Request ? url.url : url.toString()).includes(
          '/toptraded/',
        )
          ? [
              {
                id: 'UnverifiedMint1111111111111111111111111111111',
                symbol: 'RISK',
                isVerified: false,
              },
              {
                id: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
                symbol: 'JUP',
                name: 'Jupiter',
                decimals: 6,
                icon: 'https://assets.example/jup.png',
                isVerified: true,
                usdPrice: 0.7,
                mcap: 700000000,
                circSupply: 1000000000,
                totalSupply: 1000000000,
                stats24h: { priceChange: 2.5 },
              },
            ]
          : [
              {
                id: SOL_MINT,
                symbol: 'SOL',
                name: 'Solana',
                decimals: 9,
                isVerified: true,
                usdPrice: 150,
                mcap: 80000000000,
                circSupply: 500000000,
                totalSupply: 600000000,
                stats24h: { priceChange: 1.5 },
              },
            ],
      ),
    );
  try {
    const market = await refreshMarket('jupiter-key');
    assert.ok(market);
    const sol = market.assets.find((asset) => asset.mint === SOL_MINT);
    assert.ok(sol);
    assert.equal(market.source, 'jupiter');
    assert.equal(sol.price, 150);
    assert.equal(sol.marketCap, 80000000000);
    assert.equal(sol.supply, 500000000);
    assert.equal(sol.totalSupply, 600000000);
    assert.equal(sol.contractId, SOL_MINT);
    assert.equal(sol.marketDataSource, 'jupiter');
    assert.equal(
      market.assets.some((asset) => asset.symbol === 'RISK'),
      false,
    );
    assert.ok(market.assets.length <= MAX_CATALOG_ASSETS);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('market refresh preserves missing provider values as null', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      Response.json([{ id: SOL_MINT, symbol: 'SOL', isVerified: true }]),
    );
  try {
    const market = await refreshMarket('jupiter-key', [SOL_MINT]);
    assert.ok(market);
    const [sol] = market.assets;
    assert.ok(sol);
    assert.equal(sol.price, null);
    assert.equal(sol.marketCap, null);
    assert.equal(sol.supply, null);
    assert.equal(sol.priceHistory, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('market refresh falls back when no Jupiter key is configured', async () => {
  assert.equal(await refreshMarket(undefined), null);
});

void test('failed mint enrichment stops queued work and drains dispatched workers before rejecting', async () => {
  const originalFetch = globalThis.fetch;
  const releases: ((response: Response) => void)[] = [];
  const mints = Array.from({ length: 12 }, (_, index) => `Mint${index}`);
  globalThis.fetch = () =>
    new Promise<Response>((resolve) => releases.push(resolve));
  try {
    let settled = false;
    const pending = refreshMarket('test-key', mints, true).finally(() => {
      settled = true;
    });
    const rejected = assert.rejects(
      pending,
      (cause: unknown) =>
        cause instanceof ProviderRequestError &&
        cause.provider === 'Jupiter' &&
        cause.status === 500,
    );
    assert.equal(releases.length, 5);
    releases[0](new Response(null, { status: 500 }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(releases.length, 5);
    for (const release of releases.slice(1)) release(Response.json([]));
    await rejected;
    assert.equal(settled, true);
    assert.equal(releases.length, 5);
  } finally {
    for (const release of releases) release(Response.json([]));
    globalThis.fetch = originalFetch;
  }
});

void test('market catalog callers retain their null fallback on provider failure', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(null, { status: 500 }));
  try {
    assert.equal(await refreshMarket('test-key', [SOL_MINT]), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('discovery catalogs use Jupiter Trending and Recent endpoints', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (url) => {
    const value = url instanceof Request ? url.url : url.toString();
    requests.push(value);
    const token = value.includes('/toptrending/')
      ? {
          id: 'Trend1111111111111111111111111111111111111',
          symbol: 'TREND',
          isVerified: false,
        }
      : [
          {
            id: 'LowRecent1111111111111111111111111111111111',
            symbol: 'LOW',
            isVerified: false,
            stats24h: { buyVolume: 40, sellVolume: 59 },
          },
          {
            id: 'Recent111111111111111111111111111111111111',
            symbol: 'RECENT',
            isVerified: false,
            stats24h: { buyVolume: 40, sellVolume: 60 },
          },
        ];
    return Promise.resolve(
      Response.json(Array.isArray(token) ? token : [token]),
    );
  };
  try {
    const catalogs = await refreshDiscoveryCatalogs('jupiter-key');
    assert.equal(catalogs.trending[0].symbol, 'TREND');
    assert.equal(catalogs.recent[0].symbol, 'RECENT');
    assert.equal(catalogs.recent.length, 1);
    assert.equal(catalogs.trending[0].v3.verification.isVerified, false);
    assert.ok(requests.some((url) => url.endsWith('/toptrending/24h')));
    assert.ok(requests.some((url) => url.endsWith('/recent')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('Birdeye requests USD Solana candles with the configured interval and preserves valid OHLCV data', async () => {
  const originalFetch = globalThis.fetch;
  let request: { url: string; options?: RequestInit } | undefined;
  const timestamp = Math.floor(Date.now() / 1000);
  globalThis.fetch = (url, options) => {
    request = {
      url: url instanceof Request ? url.url : url.toString(),
      options,
    };
    return Promise.resolve(
      Response.json({
        success: true,
        data: {
          items: [
            {
              unix_time: timestamp - 60,
              o: 149,
              h: 152,
              l: 148,
              c: 150,
              v: 20,
              v_usd: 3000,
            },
            {
              unix_time: timestamp,
              o: 150,
              h: 153,
              l: 149,
              c: 151,
              v: 21,
              v_usd: 3200,
            },
          ],
        },
      }),
    );
  };
  try {
    const candles = await fetchCandles(
      SOL_MINT,
      'birdeye-key',
      '1D',
      1_760_086_400_000,
    );
    assert.ok(request);
    assert.ok(candles);
    assert.match(request.url, /public-api\.birdeye\.so\/defi\/v3\/ohlcv/);
    assert.match(request.url, /type=1D/);
    assert.match(request.url, /mode=count/);
    assert.match(request.url, /count_limit=300/);
    assert.match(request.url, /currency=usd/);
    const headers = new Headers(request.options?.headers);
    assert.equal(headers.get('X-API-KEY'), 'birdeye-key');
    assert.equal(headers.get('x-chain'), 'solana');
    assert.equal(candles.timeframe, '1D');
    assert.equal(candles.candles[0].closeUsd, 150);
    assert.equal(candles.candles[0].volumeUsd, 3000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('Birdeye exposes the complete exact-case supported timeframe allowlist', () => {
  assert.deepEqual(CANDLE_TIMEFRAMES, [
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
  ]);
});
