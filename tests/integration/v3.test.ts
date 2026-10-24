import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchStub,
  testEnv,
  type FetchStubOptions,
} from '../support/support.ts';
import { array, record } from '../../src/record.ts';
import type { SnapshotStore } from '../../src/env.ts';
import worker from '../../src/index.ts';
import { SOL_MINT } from '../../src/constants.ts';
import { mapV3Asset } from '../../src/market.ts';
import { candlesForAsset, historyForAsset } from '../../src/routes.ts';
import {
  loadV3AssetDistribution,
  loadV3AssetHolders,
  loadV3AssetOnchain,
  loadV3AssetTransactions,
  loadV3Wallet,
  mapDasWallet,
  mapV3Event,
  mapV3HistoryPoints,
} from '../../src/v3.ts';
import {
  loadHeliusDashboardSample,
  loadRecentTransactionSample,
  refreshHeliusDashboardSample,
  refreshRecentTransactionSample,
} from '../../src/recentTransactions.ts';

const env = testEnv;

test('v3 asset mapping has only canonical fields and exact finite volume behavior', () => {
  const asset = mapV3Asset({
    id: SOL_MINT,
    symbol: 'SOL',
    name: 'Solana',
    decimals: 9,
    iconUrl: 'https://icon',
    usdPrice: Infinity,
    mcap: 1,
    stats24h: { buyVolume: 2, sellVolume: 3 },
    isVerified: true,
    tags: ['verified', 4],
    organicScore: NaN,
  });
  assert.deepEqual(Object.keys(asset), [
    'mint',
    'symbol',
    'name',
    'decimals',
    'iconUrl',
    'priceUsd',
    'marketCapUsd',
    'circulatingSupply',
    'totalSupply',
    'fullyDilutedValuationUsd',
    'change24hPct',
    'liquidityUsd',
    'holderCount',
    'verification',
    'quality',
    'activity',
  ]);
  assert.equal(asset.priceUsd, null);
  assert.equal(asset.activity.volume24hUsd, 5);
  assert.equal(
    mapV3Asset({
      id: SOL_MINT,
      stats24h: { buyVolume: 2, sellVolume: Infinity },
    }).activity.volume24hUsd,
    null,
  );
});

test('v3 history points use timestamp and priceUsd without changing v2 cache points', () => {
  const points = [
    { date: '2026-10-01T00:00:00.000Z', price: 1.25 },
    { date: 'invalid', price: 2 },
    { date: '2026-10-02T00:00:00.000Z', price: Infinity },
  ];
  assert.deepEqual(mapV3HistoryPoints(points), [
    { timestamp: '2026-10-01T00:00:00.000Z', priceUsd: 1.25 },
  ]);
  assert.deepEqual(points[0], {
    date: '2026-10-01T00:00:00.000Z',
    price: 1.25,
  });
  assert.equal(mapV3HistoryPoints(null), null);
});

test('v3 canonical mint routes return range-aware Birdeye close-price history and OHLCV candles', async () => {
  const originalFetch = fetchStub.fetch;
  const timestamp = Math.floor(Date.now() / 1000);
  fetchStub.fetch = async () => ({
    ok: true,
    json: async () => ({
      success: true,
      data: {
        items: [
          {
            unix_time: timestamp,
            o: 149,
            h: 151,
            l: 148,
            c: 150,
            v: 1,
            v_usd: 150,
          },
        ],
      },
    }),
  });
  try {
    const history = await worker.fetch(
      new Request(
        `https://api.example/v3/assets/mint/${SOL_MINT}/history?range=1d`,
      ),
      env({ BIRDEYE_API_KEY: 'key' }),
      {},
    );
    const candles = await worker.fetch(
      new Request(
        `https://api.example/v3/assets/mint/${SOL_MINT}/candles?timeframe=1D`,
      ),
      env({ BIRDEYE_API_KEY: 'key' }),
      {},
    );
    const detail = await worker.fetch(
      new Request(`https://api.example/v3/assets/mint/${SOL_MINT}`),
      env({ BIRDEYE_API_KEY: 'key' }),
      {},
    );
    const historyPoint = (await history.json()).data.points[0];
    const detailPoint = (await detail.json()).data.history.points[0];
    assert.deepEqual(historyPoint, {
      timestamp: new Date(timestamp * 1000).toISOString(),
      priceUsd: 150,
    });
    assert.deepEqual(detailPoint, historyPoint);
    const candleBody = await candles.json();
    assert.equal(candleBody.data.timeframe, '1D');
    assert.equal(candleBody.data.count, 300);
    assert.equal(candleBody.data.candles[0].volumeUsd, 150);
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('v3 candle pagination requests the preceding provider window and rejects invalid cursors', async () => {
  const originalFetch = fetchStub.fetch;
  let requestUrl = '';
  fetchStub.fetch = async (url) => {
    requestUrl = String(url);
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: {
          items: [
            {
              unix_time: 1_760_000_000,
              o: 149,
              h: 151,
              l: 148,
              c: 150,
              v: 1,
              v_usd: 150,
            },
          ],
        },
      }),
    };
  };
  try {
    const response = await worker.fetch(
      new Request(
        `https://api.example/v3/assets/mint/${SOL_MINT}/candles?timeframe=1H&before=1760000000`,
      ),
      env({ BIRDEYE_API_KEY: 'key' }),
      {},
    );
    assert.equal(response.status, 200);
    assert.match(requestUrl, /type=1H/);
    assert.match(requestUrl, /count_limit=300/);
    assert.match(requestUrl, /time_to=1760000000/);
    const invalid = await worker.fetch(
      new Request(
        `https://api.example/v3/assets/mint/${SOL_MINT}/candles?before=invalid`,
      ),
      env({ BIRDEYE_API_KEY: 'key' }),
      {},
    );
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'INVALID_CANDLE_BEFORE');
    const invalidTimeframe = await worker.fetch(
      new Request(
        `https://api.example/v3/assets/mint/${SOL_MINT}/candles?timeframe=1h`,
      ),
      env({ BIRDEYE_API_KEY: 'key' }),
      {},
    );
    assert.equal(invalidTimeframe.status, 400);
    assert.equal(
      (await invalidTimeframe.json()).error.code,
      'INVALID_CANDLE_TIMEFRAME',
    );
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('candle cache records expire after the existing stale window', async () => {
  const originalFetch = fetchStub.fetch;
  const writes: {
    key: string;
    value: string;
    options?: { expirationTtl?: number };
  }[] = [];
  fetchStub.fetch = async () => ({
    ok: true,
    json: async () => ({
      success: true,
      data: {
        items: [
          { unix_time: 1_760_000_000, o: 1, h: 2, l: 1, c: 2, v: 3, v_usd: 6 },
        ],
      },
    }),
  });
  try {
    await candlesForAsset(
      {
        get: async () => null,
        put: async (key, value, options) =>
          writes.push({ key, value, options }),
      },
      SOL_MINT,
      'key',
      '1H',
    );
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].options, { expirationTtl: 86_400 });
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('v3 resolves a valid mint outside the snapshot through Jupiter', async () => {
  const mint = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
  const originalFetch = fetchStub.fetch;
  fetchStub.fetch = async (url) =>
    String(url).includes('/tokens/v2/search')
      ? {
          ok: true,
          json: async () => [
            {
              id: mint,
              symbol: 'JUP',
              name: 'Jupiter',
              decimals: 6,
              isVerified: true,
              usdPrice: 1,
            },
          ],
        }
      : {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              items: [
                {
                  unix_time: 1_760_000_000,
                  o: 1,
                  h: 1,
                  l: 1,
                  c: 1,
                  v: 1,
                  v_usd: 1,
                },
              ],
            },
          }),
        };
  try {
    const response = await worker.fetch(
      new Request(`https://api.example/v3/assets/mint/${mint}`),
      env({ BIRDEYE_API_KEY: 'key', JUPITER_API_KEY: 'key' }),
      {},
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.mint, mint);
    assert.equal(body.data.symbol, 'JUP');
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('v3 history rejects unsupported ranges', async () => {
  const response = await worker.fetch(
    new Request(
      `https://api.example/v3/assets/mint/${SOL_MINT}/history?range=30d`,
    ),
    env(),
    {},
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_HISTORY_RANGE');
});

test('v3 Parsed Events mapping preserves string raw amounts and rejects unsafe numbers', () => {
  const event = mapV3Event({
    parserStatus: 'OK',
    signature: 'signature',
    parsed: {
      transactionStatus: 'OK',
      nativeTransfers: [
        { amount: '9007199254740993123' },
        { amount: Number.MAX_SAFE_INTEGER + 1 },
      ],
      tokenTransfers: [
        {
          mint: SOL_MINT,
          rawTokenAmount: { tokenAmount: '2500000', decimals: 6 },
        },
        { mint: SOL_MINT, rawTokenAmount: '7', decimals: 9 },
      ],
    },
  });
  assert.equal(event.transfers.native[0].atomicAmount, '9007199254740993123');
  assert.equal(event.transfers.native[0].decimals, 9);
  assert.equal(event.transfers.native[1].atomicAmount, null);
  assert.equal(event.transfers.tokens[0].atomicAmount, '2500000');
  assert.equal(event.transfers.tokens[0].decimals, 6);
  assert.equal(event.transfers.tokens[1].atomicAmount, '7');
});

test('Helius on-chain profile preserves atomic supply and exposes only provider-backed mint fields', async () => {
  const originalFetch = fetchStub.fetch;
  fetchStub.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'getAsset')
      return {
        ok: true,
        json: async () => ({
          result: {
            interface: 'FungibleToken',
            last_indexed_slot: 123,
            mutable: false,
            content: {
              json_uri: 'https://metadata.example',
              links: { image: 'https://image.example' },
              metadata: {
                name: 'Example',
                symbol: 'EX',
                description: 'An example',
                external_url: 'https://example.com',
              },
            },
            token_info: {
              decimals: 6,
              supply: '9007199254740993123',
              mint_authority: 'mint-authority',
              freeze_authority: null,
              token_program: 'Tokenkeg',
              extensions: ['transferFeeConfig'],
            },
          },
        }),
      };
    if (request.method === 'getTokenSupply')
      return {
        ok: true,
        json: async () => ({
          result: { value: { amount: '9007199254740993123' } },
        }),
      };
    if (request.method === 'getAccountInfo')
      return {
        ok: true,
        json: async () => ({
          result: { value: { data: { parsed: { info: { decimals: 6 } } } } },
        }),
      };
    throw new Error(`Unexpected ${request.method}`);
  };
  try {
    const { profile, freshness } = await loadV3AssetOnchain(
      env({ HELIUS_API_KEY: 'h' }),
      {},
      SOL_MINT,
    );
    assert.deepEqual(record(profile).mintState, {
      decimals: 6,
      supplyAtomic: '9007199254740993123',
      supply: '9007199254740.993123',
      mintAuthority: 'mint-authority',
      freezeAuthority: null,
      isMutable: false,
      extensions: ['transferFeeConfig'],
    });
    assert.equal(record(record(profile).metadata).name, 'Example');
    assert.equal(freshness.cacheState, 'miss');
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('Helius holder pages preserve atomic balances without claiming unique holders', async () => {
  const originalFetch = fetchStub.fetch;
  fetchStub.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'getTokenAccounts') {
      assert.deepEqual(request.params, {
        mint: SOL_MINT,
        page: 2,
        limit: 25,
        options: { showZeroBalance: false },
      });
      return {
        ok: true,
        json: async () => ({
          result: {
            total: 31,
            cursor: 'cursor',
            token_accounts: [
              {
                address: 'token-account',
                owner: 'owner',
                amount: '2500000',
                frozen: false,
              },
            ],
          },
        }),
      };
    }
    if (request.method === 'getAsset')
      return {
        ok: true,
        json: async () => ({ result: { token_info: { decimals: 6 } } }),
      };
    throw new Error(`Unexpected ${request.method}`);
  };
  try {
    const page = await loadV3AssetHolders(
      env({ HELIUS_API_KEY: 'h' }),
      {},
      SOL_MINT,
      2,
    );
    assert.deepEqual(page, {
      holders: [
        {
          tokenAccount: 'token-account',
          owner: 'owner',
          atomicAmount: '2500000',
          amount: '2.5',
          decimals: 6,
          frozen: false,
          delegated: null,
        },
      ],
      page: 2,
      total: 31,
      cursor: 'cursor',
    });
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('Helius largest accounts preserve atomic values, parsed owners, and two-decimal supply shares', async () => {
  const originalFetch = fetchStub.fetch;
  fetchStub.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'getTokenLargestAccounts')
      return {
        ok: true,
        json: async () => ({
          result: {
            context: { slot: 123 },
            value: [
              { address: 'account-a', amount: '333', decimals: 2 },
              { address: 'account-b', amount: '1', decimals: 2 },
            ],
          },
        }),
      };
    if (request.method === 'getTokenSupply')
      return {
        ok: true,
        json: async () => ({ result: { value: { amount: '1000' } } }),
      };
    if (request.method === 'getMultipleAccounts')
      return {
        ok: true,
        json: async () => ({
          result: {
            value: [
              {
                data: {
                  parsed: { info: { owner: 'owner-a', state: 'frozen' } },
                },
              },
              {
                data: {
                  parsed: { info: { owner: 'owner-b', state: 'initialized' } },
                },
              },
            ],
          },
        }),
      };
    throw new Error(`Unexpected ${request.method}`);
  };
  try {
    const distribution = await loadV3AssetDistribution(
      env({ HELIUS_API_KEY: 'h' }),
      {},
      SOL_MINT,
    );
    assert.deepEqual(distribution, {
      supplyAtomic: '1000',
      slot: 123,
      accounts: [
        {
          rank: 1,
          tokenAccount: 'account-a',
          owner: 'owner-a',
          atomicAmount: '333',
          amount: '3.33',
          decimals: 2,
          frozen: true,
          supplyPercent: '33.30',
        },
        {
          rank: 2,
          tokenAccount: 'account-b',
          owner: 'owner-b',
          atomicAmount: '1',
          amount: '0.01',
          decimals: 2,
          frozen: false,
          supplyPercent: '0.10',
        },
      ],
    });
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('Helius mint transaction history preserves all mint-address transactions and filters only transfer details by mint', async () => {
  const originalFetch = fetchStub.fetch;
  fetchStub.fetch = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), {
      address: SOL_MINT,
      limit: 25,
      sortOrder: 'desc',
      commitment: 'confirmed',
    });
    return {
      ok: true,
      json: async () => ({
        data: [
          {
            signature: 'mint-event',
            parserStatus: 'OK',
            parsed: {
              slot: 7,
              blockTime: 1_760_000_000,
              transactionStatus: 'OK',
              summary: {
                type: 'mint',
                description: 'Minted',
                parsedData: { protocol: 'token' },
              },
              tokenTransfers: [
                {
                  mint: SOL_MINT,
                  rawTokenAmount: '2500000',
                  decimals: 6,
                  fromUserAccount: null,
                  toUserAccount: 'recipient',
                },
                { mint: 'other', rawTokenAmount: '1', decimals: 0 },
              ],
            },
          },
          {
            signature: 'metadata-event',
            parserStatus: 'OK',
            parsed: {
              slot: 6,
              blockTime: 1_759_999_999,
              transactionStatus: 'OK',
              summary: null,
              tokenTransfers: [],
            },
          },
        ],
        paginationToken: 'next',
      }),
    };
  };
  try {
    const page = await loadV3AssetTransactions(
      env({ HELIUS_API_KEY: 'h' }),
      {},
      SOL_MINT,
    );
    assert.equal(page.nextCursor, 'next');
    assert.equal(array(page.transactions).length, 2);
    assert.deepEqual(record(array(page.transactions)[0]).transfers, [
      {
        from: null,
        to: 'recipient',
        fromTokenAccount: null,
        toTokenAccount: null,
        atomicAmount: '2500000',
        amount: '2.5',
        decimals: 6,
      },
    ]);
    assert.equal(record(array(page.transactions)[1]).action, null);
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('v3 history negative-caches unavailable Birdeye responses', async () => {
  const values = new Map();
  let calls = 0;
  const kv: SnapshotStore = {
    get: async (key) => values.get(key) || null,
    put: async (key, value) => values.set(key, JSON.parse(value)),
  };
  const originalFetch = fetchStub.fetch;
  fetchStub.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({ success: true, data: { items: [] } }),
    };
  };
  try {
    assert.equal(
      (await historyForAsset(kv, SOL_MINT, 'key')).state,
      'unavailable',
    );
    assert.equal(
      (await historyForAsset(kv, SOL_MINT, 'key')).state,
      'unavailable',
    );
    assert.equal(calls, 1);
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('v3 history preserves a stale seven-day Birdeye candle cache when the provider reports unavailable', async () => {
  const timestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const cached = {
    fetchedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    interval: '1H',
    candles: [
      {
        timestamp,
        openUsd: 1,
        highUsd: 1,
        lowUsd: 1,
        closeUsd: 1,
        volume: 1,
        volumeUsd: 1,
      },
    ],
  };
  const originalFetch = fetchStub.fetch;
  fetchStub.fetch = async () => ({
    ok: true,
    json: async () => ({ success: true, data: { items: [] } }),
  });
  try {
    const history = await historyForAsset(
      { get: async () => cached },
      SOL_MINT,
      'key',
    );
    assert.equal(history.state, 'stale');
    assert.deepEqual(history.points, [{ date: timestamp, price: 1 }]);
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('recent transaction samples batch parsed actions, preserve signature order, and retain stale data on failure', async () => {
  const cache = new Map();
  let calls = 0;
  const snapshots: SnapshotStore = {
    get: async (key) => cache.get(key) || null,
    put: async (key, value) => cache.set(key, JSON.parse(value)),
  };
  const originalFetch = fetchStub.fetch;
  fetchStub.fetch = async (_url, options) => {
    calls += 1;
    const request = JSON.parse(options.body);
    if (request.method === 'getSlot')
      return { ok: true, json: async () => ({ result: 123 }) };
    if (request.method === 'getBlock')
      return {
        ok: true,
        json: async () => ({
          result: {
            blockTime: 1_760_000_000,
            signatures: ['sig-a', 'sig-a', 'sig-b'],
          },
        }),
      };
    if (Array.isArray(request.transactions))
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              signature: 'sig-b',
              parsed: {
                summary: null,
                instructions: [{ instructionName: 'create_account' }],
              },
            },
            { signature: 'sig-a', parsed: { summary: { type: 'swap' } } },
          ],
        }),
      };
    throw new Error(`Unexpected ${request.method}`);
  };
  try {
    const now = new Date('2026-10-06T00:00:00.000Z');
    await refreshRecentTransactionSample(
      env({ SNAPSHOTS: snapshots, HELIUS_API_KEY: 'h' }),
      {},
      now,
    );
    const first = await loadRecentTransactionSample(
      env({ SNAPSHOTS: snapshots, HELIUS_API_KEY: 'h' }),
      {},
      now,
    );
    const second = await loadRecentTransactionSample(
      env({ SNAPSHOTS: snapshots, HELIUS_API_KEY: 'h' }),
      {},
      new Date(now.getTime() + 10_000),
      true,
    );
    assert.equal(first.freshness, 'fresh');
    assert.deepEqual(first.transactions, [
      {
        signature: 'sig-a',
        slot: 123,
        blockTime: '2025-10-09T08:53:20.000Z',
        status: 'confirmed',
        action: 'swap',
      },
      {
        signature: 'sig-b',
        slot: 123,
        blockTime: '2025-10-09T08:53:20.000Z',
        status: 'confirmed',
        action: 'create_account',
      },
    ]);
    assert.equal(second.freshness, 'fresh');
    assert.equal(calls, 3);
    const refreshed = await loadRecentTransactionSample(
      env({ SNAPSHOTS: snapshots, HELIUS_API_KEY: 'h' }),
      {},
      new Date(now.getTime() + 61_000),
      true,
    );
    assert.equal(refreshed.freshness, 'fresh');
    assert.equal(calls, 6);
    fetchStub.fetch = async () => {
      throw new Error('provider unavailable');
    };
    const stale = await loadRecentTransactionSample(
      env({ SNAPSHOTS: snapshots, HELIUS_API_KEY: 'h' }),
      {},
      new Date(now.getTime() + 122_000),
      true,
    );
    assert.equal(stale.freshness, 'stale');
    assert.equal(array(record(stale).transactions).length, 2);
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('recent transaction samples remain fresh when Parsed Events is unavailable', async () => {
  const cache = new Map();
  const snapshots: SnapshotStore = {
    get: async (key) => cache.get(key) || null,
    put: async (key, value) => cache.set(key, JSON.parse(value)),
  };
  const originalFetch = fetchStub.fetch;
  const originalWarn = console.warn;
  fetchStub.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'getSlot')
      return { ok: true, json: async () => ({ result: 123 }) };
    if (request.method === 'getBlock')
      return {
        ok: true,
        json: async () => ({
          result: { blockTime: 1_760_000_000, signatures: ['sig-a'] },
        }),
      };
    if (Array.isArray(request.transactions)) return { ok: false, status: 403 };
    throw new Error(`Unexpected ${request.method}`);
  };
  console.warn = () => {};
  try {
    const sample = await refreshRecentTransactionSample(
      env({ SNAPSHOTS: snapshots, HELIUS_API_KEY: 'h' }),
      {},
      new Date('2026-10-06T00:00:00.000Z'),
    );
    assert.equal(sample.source, 'helius-rpc');
    assert.equal(sample.transactions[0].action, null);
  } finally {
    fetchStub.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('Helius dashboard samples combine the 60-second transaction and requested network metrics', async () => {
  const cache = new Map();
  const snapshots: SnapshotStore = {
    get: async (key) => cache.get(key) || null,
    put: async (key, value) => cache.set(key, JSON.parse(value)),
  };
  const originalFetch = fetchStub.fetch;
  fetchStub.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'getSlot')
      return {
        ok: true,
        json: async () => ({
          result:
            request.params?.[0]?.commitment === 'processed'
              ? 120
              : request.params?.[0]?.commitment === 'finalized'
                ? 118
                : 119,
        }),
      };
    if (request.method === 'getBlockHeight')
      return { ok: true, json: async () => ({ result: 100 }) };
    if (request.method === 'getEpochInfo')
      return { ok: true, json: async () => ({ result: { epoch: 7 } }) };
    if (request.method === 'getRecentPerformanceSamples')
      return {
        ok: true,
        json: async () => ({
          result: [
            {
              numTransactions: 200,
              numNonVoteTransactions: 150,
              samplePeriodSecs: 2,
            },
            {
              numTransactions: 100,
              numNonVoteTransactions: 75,
              samplePeriodSecs: 1,
            },
          ],
        }),
      };
    if (request.method === 'getBlocksWithLimit')
      return { ok: true, json: async () => ({ result: [117] }) };
    if (request.method === 'getBlock')
      return {
        ok: true,
        json: async () => ({
          result:
            request.params?.[1]?.transactionDetails === 'signatures'
              ? { blockTime: 1_760_000_000, signatures: ['sig-a'] }
              : {
                  transactions: [
                    { meta: { fee: 100 } },
                    { meta: { fee: 300 } },
                  ],
                },
        }),
      };
    if (Array.isArray(request.transactions))
      return { ok: true, json: async () => ({ data: [] }) };
    throw new Error(`Unexpected ${request.method}`);
  };
  try {
    const now = new Date('2026-10-06T00:00:00.000Z');
    const sample = await refreshHeliusDashboardSample(
      env({ SNAPSHOTS: snapshots, HELIUS_API_KEY: 'h' }),
      {},
      null,
      now,
    );
    assert.equal(record(sample.network.chain).processedSlot, 120);
    assert.equal(record(sample.network.chain).confirmedSlot, 119);
    assert.equal(record(sample.network.chain).blockHeight, 100);
    assert.equal(record(sample.network.chain).epoch, 7);
    assert.equal(record(sample.network.performance).tps, 100);
    assert.equal(record(sample.network.performance).nonVoteTps, 75);
    assert.equal(record(sample.network.fees).averageFeeLamports, 200);
    assert.equal(sample.transactionsFreshness, 'fresh');
    assert.equal(cache.has('transactions:v3:recent'), false);
    const cached = await loadHeliusDashboardSample(
      env({ SNAPSHOTS: snapshots, HELIUS_API_KEY: 'h' }),
      {},
      new Date(now.getTime() + 10_000),
      true,
    );
    assert.equal(cached.freshness, 'fresh');
    assert.equal(array(record(cached).transactions).length, 1);
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('DAS wallet mapping preserves atomic balances, caps holdings, and reports partial valuation', () => {
  const result = {
    nativeBalance: { lamports: '1000000000' },
    items: Array.from({ length: 41 }, (_, index) => ({
      id: `Mint${index}`,
      token_info: { balance: '2500000', decimals: 6 },
    })),
  };
  const wallet = mapDasWallet('11111111111111111111111111111111', result, [
    {
      mint: SOL_MINT,
      symbol: 'SOL',
      name: 'Solana',
      decimals: 9,
      iconUrl: null,
      priceUsd: 100,
    },
    {
      mint: 'Mint0',
      symbol: 'M0',
      name: 'M0',
      decimals: 6,
      iconUrl: null,
      priceUsd: 2,
    },
  ]);
  assert.equal(wallet.balances.length, 40);
  assert.equal(wallet.holdingsTruncated, true);
  assert.equal(wallet.balances[0].atomicAmount, '1000000000');
  assert.equal(record(wallet).balancesTruncated, undefined);
  assert.equal(wallet.valuation.pricedSubtotalUsd, 105);
  assert.equal(wallet.valuation.pricedHoldingCount, 2);
  assert.equal(wallet.valuation.unpricedHoldingCount, 38);
  assert.equal(wallet.valuation.complete, false);
});

test('v3 wallet returns DAS balances as unpriced when Jupiter enrichment rejects', async () => {
  const originalFetch = fetchStub.fetch;
  const originalWarn = console.warn;
  fetchStub.fetch = async () => ({
    ok: true,
    json: async () => ({
      result: {
        nativeBalance: { lamports: '1000000000' },
        items: [
          { id: 'Mint1', token_info: { balance: '2500000', decimals: 6 } },
        ],
      },
    }),
  });
  console.warn = () => {};
  try {
    const wallet = (
      await loadV3Wallet(
        env({ HELIUS_API_KEY: 'h', JUPITER_API_KEY: 'j' }),
        {},
        SOL_MINT,
        async () => {
          throw new Error('Jupiter unavailable');
        },
      )
    ).wallet;
    assert.deepEqual(record(wallet).balances, [
      {
        mint: SOL_MINT,
        symbol: null,
        name: null,
        decimals: 9,
        iconUrl: null,
        atomicAmount: '1000000000',
        amount: '1',
        priceUsd: null,
        valueUsd: null,
      },
      {
        mint: 'Mint1',
        symbol: null,
        name: null,
        decimals: 6,
        iconUrl: null,
        atomicAmount: '2500000',
        amount: '2.5',
        priceUsd: null,
        valueUsd: null,
      },
    ]);
    assert.deepEqual(record(wallet).valuation, {
      pricedSubtotalUsd: 0,
      holdingCount: 2,
      pricedHoldingCount: 0,
      unpricedHoldingCount: 2,
      complete: false,
    });
  } finally {
    fetchStub.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('v3 wallet propagates DAS failures before attempting Jupiter enrichment', async () => {
  const originalFetch = fetchStub.fetch;
  let jupiterRequested = false;
  fetchStub.fetch = async () => ({ ok: false, status: 503 });
  try {
    await assert.rejects(
      loadV3Wallet(
        env({ HELIUS_API_KEY: 'h', JUPITER_API_KEY: 'j' }),
        {},
        SOL_MINT,
        async () => {
          jupiterRequested = true;
          return null;
        },
      ),
      /Helius RPC request failed with 503/,
    );
    assert.equal(jupiterRequested, false);
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('v3 wallet cache, transaction pagination defaults, CORS, and v2 compatibility', async () => {
  const originalFetch = fetchStub.fetch;
  const writes: { key: string; value: string }[] = [];
  const cache = new Map();
  const requests: { value: string; options: FetchStubOptions }[] = [];
  fetchStub.fetch = async (url, options) => {
    const value = String(url);
    requests.push({ value, options });
    if (value.includes('/v1/parsed-events/transaction-history'))
      return {
        ok: true,
        json: async () => ({
          data: Array.from({ length: 25 }, (_, index) => ({
            signature: `sig${index}`,
            parserStatus: 'OK',
            parsed: {
              blockTime: 1,
              transactionStatus: 'OK',
              summary: {
                type: 'transfer',
                description: 'Transferred SOL',
                parsedData: { protocol: 'system' },
              },
              nativeTransfers: [
                {
                  fromUserAccount: 'from',
                  toUserAccount: 'to',
                  amount: 9007199254740993n.toString(),
                },
              ],
              tokenTransfers: [
                {
                  mint: SOL_MINT,
                  fromUserAccount: 'from',
                  toUserAccount: 'to',
                  rawTokenAmount: '2500000',
                  decimals: 6,
                  tokenStandard: 'Fungible',
                },
              ],
            },
          })),
          paginationToken: '433950192:0',
        }),
      };
    if (value.includes('mainnet.helius-rpc.com'))
      return {
        ok: true,
        json: async () => ({
          result: { nativeBalance: { lamports: '1000000000' }, items: [] },
        }),
      };
    if (value.includes('/tokens/'))
      return {
        ok: true,
        json: async () => [
          {
            id: SOL_MINT,
            symbol: 'SOL',
            name: 'Solana',
            decimals: 9,
            usdPrice: 100,
            isVerified: true,
          },
        ],
      };
    return {
      ok: true,
      json: async () => ({ prices: [[1_760_000_000_000, 150]] }),
    };
  };
  const snapshots: SnapshotStore = {
    get: async (key) => cache.get(key) || null,
    put: async (key, value) => {
      writes.push({ key, value });
      cache.set(key, JSON.parse(value));
    },
  };
  try {
    const options = await worker.fetch(
      new Request('https://api.example/v3/wallets/x', {
        method: 'OPTIONS',
        headers: { origin: 'https://app.example' },
      }),
      env({ SNAPSHOTS: snapshots }),
      {},
    );
    assert.match(
      options.headers.get('access-control-allow-methods') ?? '',
      /POST/,
    );
    assert.match(
      options.headers.get('access-control-allow-headers') ?? '',
      /authorization/,
    );
    const first = await worker.fetch(
      new Request(`https://api.example/v3/wallets/${SOL_MINT}`),
      env({ SNAPSHOTS: snapshots, HELIUS_API_KEY: 'h', JUPITER_API_KEY: 'j' }),
      {},
    );
    const second = await worker.fetch(
      new Request(`https://api.example/v3/wallets/${SOL_MINT}`),
      env({ SNAPSHOTS: snapshots, HELIUS_API_KEY: 'h', JUPITER_API_KEY: 'j' }),
      {},
    );
    const firstBody = await first.json();
    const secondBody = await second.json();
    assert.equal(firstBody.data.cacheState, undefined);
    assert.equal(firstBody.meta.wallet.cacheState, 'miss');
    assert.equal(secondBody.meta.wallet.cacheState, 'fresh');
    assert.ok(firstBody.meta.wallet.asOf);
    assert.equal(writes.length, 1);
    const transactions = await worker.fetch(
      new Request(`https://api.example/v3/wallets/${SOL_MINT}/transactions`),
      env({ HELIUS_API_KEY: 'h' }),
      {},
    );
    const transactionBody = await transactions.json();
    const parsedRequest = requests.find((request) =>
      request.value.includes('/v1/parsed-events/transaction-history'),
    );
    assert.ok(parsedRequest);
    assert.equal(transactionBody.data.nextCursor, '433950192:0');
    assert.equal(transactionBody.data.events[0].summary, 'Transferred SOL');
    assert.equal(
      transactionBody.data.events[0].transfers.native[0].atomicAmount,
      '9007199254740993',
    );
    assert.equal(
      transactionBody.data.events[0].transfers.tokens[0].decimals,
      6,
    );
    assert.match(
      parsedRequest.value,
      /^https:\/\/mainnet\.helius-rpc\.com\/v1\/parsed-events\/transaction-history\?api-key=h$/,
    );
    assert.equal(parsedRequest.options.method, 'POST');
    assert.deepEqual(JSON.parse(parsedRequest.options.body), {
      address: SOL_MINT,
      limit: 25,
      sortOrder: 'desc',
      commitment: 'confirmed',
    });
    const dasRequest = requests.find(
      (request) =>
        request.value.includes('mainnet.helius-rpc.com') &&
        request.options.body &&
        JSON.parse(request.options.body).method === 'getAssetsByOwner',
    );
    assert.ok(dasRequest);
    assert.deepEqual(JSON.parse(dasRequest.options.body).params, {
      ownerAddress: SOL_MINT,
      page: 1,
      limit: 100,
      displayOptions: {
        showFungible: true,
        showNativeBalance: true,
        showGrandTotal: true,
      },
    });
    const eventsAlias = await worker.fetch(
      new Request(
        `https://api.example/v3/wallets/${SOL_MINT}/events?cursor=433950192%3A0`,
      ),
      env({ HELIUS_API_KEY: 'h' }),
      {},
    );
    assert.equal(eventsAlias.status, 200);
    const cursorRequest = requests
      .filter((request) =>
        request.value.includes('/v1/parsed-events/transaction-history'),
      )
      .at(-1);
    assert.ok(cursorRequest);
    assert.equal(
      JSON.parse(cursorRequest.options.body).paginationToken,
      '433950192:0',
    );
    const malformed = await worker.fetch(
      new Request(
        `https://api.example/v3/wallets/${SOL_MINT}/transactions/extra`,
      ),
      env({ HELIUS_API_KEY: 'h' }),
      {},
    );
    assert.equal(malformed.status, 404);
    assert.equal((await malformed.json()).error.code, 'NOT_FOUND');
    const v2 = await worker.fetch(
      new Request('https://api.example/v2/assets'),
      env({ SNAPSHOTS: snapshots }),
      {},
    );
    assert.equal(v2.status, 200);
    assert.ok(Array.isArray((await v2.json()).data));
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('cache-only mode serves all seeded v3 on-chain and wallet records without provider access', async () => {
  const walletAddress = '7Yk4L5M6N7P8Q9R2tB6dF8gH1jK4L5M6N7P8Q9R2tB6d';
  const now = new Date().toISOString();
  const records = new Map([
    [
      `asset:v3:onchain:${SOL_MINT}`,
      { asOf: now, profile: { mint: SOL_MINT } },
    ],
    [`asset:v3:holders:${SOL_MINT}:1`, { asOf: now, page: 1, holders: [] }],
    [`asset:v3:distribution:${SOL_MINT}`, { asOf: now, accounts: [] }],
    [
      `asset:v3:transactions:${SOL_MINT}:50:initial`,
      { asOf: now, transactions: [], nextCursor: null },
    ],
    [
      `wallet:v3:${walletAddress}`,
      {
        asOf: now,
        wallet: { address: walletAddress, balances: [], valuation: {} },
      },
    ],
    [
      `wallet:v3:events:${walletAddress}:25:initial`,
      { asOf: now, events: [], nextCursor: 'next-page' },
    ],
    [
      `wallet:v3:events:${walletAddress}:25:next-page`,
      { asOf: now, events: [], nextCursor: null },
    ],
  ]);
  const originalFetch = fetchStub.fetch;
  fetchStub.fetch = async () => {
    throw new Error('cache-only mode must not call a provider');
  };
  const seededEnv = env({
    PROVIDER_MODE: 'cache-only',
    SNAPSHOTS: { get: async (key) => records.get(key) || null },
  });
  try {
    for (const path of [
      `/v3/assets/mint/${SOL_MINT}/onchain`,
      `/v3/assets/mint/${SOL_MINT}/holders?page=1`,
      `/v3/assets/mint/${SOL_MINT}/distribution`,
      `/v3/assets/mint/${SOL_MINT}/transactions?limit=50`,
      `/v3/wallets/${walletAddress}`,
      `/v3/wallets/${walletAddress}/transactions`,
      `/v3/wallets/${walletAddress}/transactions?cursor=next-page`,
    ]) {
      const response = await worker.fetch(
        new Request(`https://api.example${path}`),
        seededEnv,
        {},
      );
      assert.equal(response.status, 200, path);
    }
  } finally {
    fetchStub.fetch = originalFetch;
  }
});
