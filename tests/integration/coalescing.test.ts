/**
 * Regression coverage and controlled fixtures for coalescing.
 * @packageDocumentation
 */

import test from 'node:test';
import { deferred } from '../support/deferred.ts';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import {
  fetchStub,
  testEnv,
  type FetchStubOptions,
} from '../support/support.ts';
import type { Env } from '../../src/env.ts';
import { record } from '../../src/record.ts';
import {
  SOL_MINT,
  SNAPSHOT_POINTER_KEY,
  SNAPSHOT_KEY_PREFIX,
} from '../../src/constants.ts';
import { candlesForAsset } from '../../src/routes.ts';
import {
  loadV3AssetOnchain,
  loadV3AssetHolders,
  loadV3AssetDistribution,
  loadV3AssetTransactions,
  loadV3Wallet,
  loadV3Events,
} from '../../src/v3.ts';
import { loadWalletData, refreshSnapshot } from '../../src/snapshot.ts';
import { refreshDefiLlamaDashboard } from '../../src/defillama.ts';
import {
  refreshHeliusDashboardSample,
  loadHeliusDashboardSample,
  refreshRecentTransactionSample,
} from '../../src/recentTransactions.ts';
import worker from '../../src/index.ts';

const otherMint = '11111111111111111111111111111111';
const config = { heliusApiKey: 'test-helius', jupiterApiKey: 'test-jupiter' };
/** Return the controlled unavailable-market result used by the test. */
const noMarket = async () => null;

/** Build the provider response payload for the exercised fixture case. */
function payload(url: string, options: FetchStubOptions): unknown {
  if (url.includes('/parsed-events/'))
    return { data: [], paginationToken: null };
  if (url.includes('helius-rpc')) {
    const method = JSON.parse(options.body).method;
    if (method === 'getBlock')
      return {
        result: { blockTime: 1_760_000_000, signatures: [], transactions: [] },
      };
    if (method === 'getBlocksWithLimit') return { result: [123] };
    if (method === 'getAssetsByOwner')
      return {
        result: {
          items: [],
          nativeBalance: { lamports: '9007199254740993000' },
        },
      };
    if (method === 'getAsset')
      return { result: { token_info: { decimals: 9 } } };
    if (method === 'getTokenAccounts')
      return { result: { token_accounts: [], total: 0 } };
    if (method === 'getTokenSupply')
      return { result: { value: { amount: '1000000000', decimals: 9 } } };
    if (
      method === 'getTokenLargestAccounts' ||
      method === 'getTokenAccountsByOwner'
    )
      return { result: { value: [] } };
    if (method === 'getBalance') return { result: { value: '0' } };
    return { result: 123 };
  }
  if (url.includes('birdeye'))
    return {
      success: true,
      data: {
        items: [
          { unix_time: 1_760_000_000, o: 1, h: 2, l: 1, c: 2, v: 1, v_usd: 2 },
        ],
      },
    };
  if (url.includes('/toptraded/'))
    return [
      {
        id: SOL_MINT,
        symbol: 'SOL',
        name: 'Solana',
        decimals: 9,
        isVerified: true,
      },
    ];
  if (url.includes('/search?')) {
    const mint = new URL(url).searchParams.get('query');
    return [{ id: mint, symbol: 'TOKEN', name: 'Token', decimals: 9 }];
  }
  return [];
}

test('on-demand loaders share identical work through cache writes, not completed results', async (t) => {
  const operations: Record<string, (env: Env) => Promise<unknown>> = {
    /** Exercise the on-chain resource through the shared-work test fixture. */
    onchain: (env) => loadV3AssetOnchain(env, config, SOL_MINT),
    /** Exercise the holder page through the shared-work test fixture. */
    holders: (env) => loadV3AssetHolders(env, config, SOL_MINT, 1),
    /** Exercise asset distribution through the shared-work test fixture. */
    distribution: (env) => loadV3AssetDistribution(env, config, SOL_MINT),
    /** Exercise the asset transaction page through the shared-work test fixture. */
    'asset transactions': (env) =>
      loadV3AssetTransactions(env, config, SOL_MINT, 25, null),
    /** Exercise the wallet resource through the shared-work test fixture. */
    wallet: (env) => loadV3Wallet(env, config, otherMint, noMarket),
    /** Exercise the wallet event page through the shared-work test fixture. */
    'wallet events': (env) => loadV3Events(env, config, otherMint, 25, null),
    /** Exercise the legacy wallet resource through the shared-work test fixture. */
    'legacy wallet': (env) => loadWalletData(env, config, otherMint),
    /** Exercise candle retrieval through the shared-work test fixture. */
    candles: (env) => candlesForAsset(env.SNAPSHOTS, SOL_MINT, 'test-birdeye'),
  };
  for (const [name, load] of Object.entries(operations)) {
    await t.test(name, async () => {
      const original = fetchStub.fetch;
      const gate = deferred<void>();
      let calls = 0;
      let writes = 0;
      const env = testEnv({
        SNAPSHOTS: {
          /** Observe or simulate the cache write requested by this test. */
          put: async () => {
            writes++;
          },
        },
      });
      fetchStub.fetch = async (url, options) => {
        calls++;
        await gate.promise;
        return {
          ok: true,
          /** Return the controlled JSON payload for this provider-response fixture. */
          json: async () => payload(url, options),
        };
      };
      try {
        const first = load(env);
        const second = load(env);
        assert.equal(first, second);
        await setImmediate();
        assert.ok(calls > 0);
        gate.resolve();
        const [a, b] = await Promise.all([first, second]);
        assert.deepEqual(a, b);
        const initialCalls = calls;
        const initialWrites = writes;
        await load(env);
        assert.equal(calls, initialCalls * 2);
        assert.equal(writes, initialWrites * 2);
      } finally {
        gate.resolve();
        fetchStub.fetch = original;
      }
    });
  }
});

test('mint, timeframe, ending page, holder page, limit, cursor and wallet dependency keys do not collide', async () => {
  const original = fetchStub.fetch;
  const gate = deferred<void>();
  const env = testEnv();
  fetchStub.fetch = async (url, options) => {
    await gate.promise;
    return {
      ok: true,
      /** Return the controlled JSON payload for this provider-response fixture. */
      json: async () => payload(url, options),
    };
  };
  try {
    const requests = [
      candlesForAsset(env.SNAPSHOTS, SOL_MINT, 'key', '1H'),
      candlesForAsset(env.SNAPSHOTS, otherMint, 'key', '1H'),
      candlesForAsset(env.SNAPSHOTS, SOL_MINT, 'key', '1D'),
      candlesForAsset(env.SNAPSHOTS, SOL_MINT, 'key', '1H', 1_760_000_000),
      loadV3AssetHolders(env, config, SOL_MINT, 1),
      loadV3AssetHolders(env, config, SOL_MINT, 2),
      loadV3AssetTransactions(env, config, SOL_MINT, 25, null),
      loadV3AssetTransactions(env, config, SOL_MINT, 50, null),
      loadV3AssetTransactions(env, config, SOL_MINT, 25, 'initial'),
      loadV3AssetTransactions(env, config, otherMint, 25, null),
      loadV3Events(env, config, otherMint, 25, null),
      loadV3Events(env, config, otherMint, 25, 'initial'),
      loadV3Events(env, config, otherMint, 50, null),
      loadV3Wallet(env, config, otherMint, noMarket),
      loadV3Wallet(env, config, otherMint, async () => null),
    ];
    assert.equal(new Set(requests).size, requests.length);
    gate.resolve();
    await Promise.all(requests);
  } finally {
    gate.resolve();
    fetchStub.fetch = original;
  }
});

test('binding identity, provider configuration and cache-only mode stay isolated', async () => {
  const original = fetchStub.fetch;
  const gate = deferred<void>();
  const env = testEnv();
  let calls = 0;
  fetchStub.fetch = async (url, options) => {
    calls++;
    await gate.promise;
    return {
      ok: true,
      /** Return the controlled JSON payload for this provider-response fixture. */
      json: async () => payload(url, options),
    };
  };
  try {
    const first = loadV3AssetOnchain(env, config, SOL_MINT);
    const sameBinding = loadV3AssetOnchain({ ...env }, { ...config }, SOL_MINT);
    const otherBinding = loadV3AssetOnchain(testEnv(), config, SOL_MINT);
    const otherKey = loadV3AssetOnchain(
      env,
      { ...config, heliusApiKey: 'other-key' },
      SOL_MINT,
    );
    assert.equal(first, sameBinding);
    assert.notEqual(first, otherBinding);
    assert.notEqual(first, otherKey);
    await assert.rejects(
      loadV3AssetOnchain(
        env,
        { ...config, providerMode: 'cache-only' },
        SOL_MINT,
      ),
      /Seeded/,
    );
    await setImmediate();
    assert.equal(calls, 9);
    gate.resolve();
    await Promise.all([first, sameBinding, otherBinding, otherKey]);
  } finally {
    gate.resolve();
    fetchStub.fetch = original;
  }
});

test('provider and cache-write failures are shared and allow later retries', async () => {
  const original = fetchStub.fetch;
  const gate = deferred<void>();
  let failProvider = true;
  let failWrite = true;
  let writes = 0;
  const env = testEnv({
    SNAPSHOTS: {
      /** Observe or simulate the cache write requested by this test. */
      put: async () => {
        writes++;
        if (failWrite) throw new Error('KV failed');
      },
    },
  });
  fetchStub.fetch = async (url, options) => {
    await gate.promise;
    if (failProvider) return { ok: false, status: 400 };
    return {
      ok: true,
      /** Return the controlled JSON payload for this provider-response fixture. */
      json: async () => payload(url, options),
    };
  };
  try {
    const first = loadV3AssetOnchain(env, config, SOL_MINT);
    const second = loadV3AssetOnchain(env, config, SOL_MINT);
    assert.equal(first, second);
    const failures = Promise.allSettled([first, second]);
    gate.resolve();
    assert.ok((await failures).every((item) => item.status === 'rejected'));
    assert.equal(writes, 0);
    failProvider = false;
    await assert.rejects(
      loadV3AssetOnchain(env, config, SOL_MINT),
      /KV failed/,
    );
    failWrite = false;
    await loadV3AssetOnchain(env, config, SOL_MINT);
    assert.equal(writes, 2);
  } finally {
    gate.resolve();
    fetchStub.fetch = original;
  }
});

test('snapshot refresh shares the first timestamp and waits for complete data before pointer publication', async () => {
  const original = fetchStub.fetch;
  const dataWrite = deferred<void>();
  const writeStarted = deferred<void>();
  const writes: string[] = [];
  let discoveryCalls = 0;
  const env = testEnv({
    SNAPSHOTS: {
      /** Observe or simulate the cache write requested by this test. */
      put: async (key) => {
        writes.push(key);
        if (key.startsWith(SNAPSHOT_KEY_PREFIX)) {
          writeStarted.resolve();
          await dataWrite.promise;
        }
      },
    },
  });
  fetchStub.fetch = async (url, options) => {
    if (url.includes('/toptraded/')) discoveryCalls++;
    return {
      ok: true,
      /** Return the controlled JSON payload for this provider-response fixture. */
      json: async () => payload(url, options),
    };
  };
  try {
    const firstTime = new Date('2026-10-13T12:00:00Z');
    const first = refreshSnapshot(env, config, firstTime);
    const second = refreshSnapshot(
      env,
      config,
      new Date('2026-10-13T12:00:01Z'),
    );
    assert.equal(first, second);
    await writeStarted.promise;
    assert.deepEqual(writes, [`${SNAPSHOT_KEY_PREFIX}${firstTime.getTime()}`]);
    assert.equal(discoveryCalls, 1);
    dataWrite.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.createdAt, firstTime.toISOString());
    assert.deepEqual(a, b);
    assert.deepEqual(writes, [
      `${SNAPSHOT_KEY_PREFIX}${firstTime.getTime()}`,
      SNAPSHOT_POINTER_KEY,
    ]);
  } finally {
    dataWrite.resolve();
    fetchStub.fetch = original;
  }
});

test('failed snapshot data write never advances the pointer and the refresh can retry', async () => {
  const original = fetchStub.fetch;
  const writes: string[] = [];
  let failWrite = true;
  const env = testEnv({
    SNAPSHOTS: {
      /** Observe or simulate the cache write requested by this test. */
      put: async (key) => {
        writes.push(key);
        if (failWrite) throw new Error('data write failed');
      },
    },
  });
  fetchStub.fetch = async (url, options) => ({
    ok: true,
    /** Return the controlled JSON payload for this provider-response fixture. */
    json: async () => payload(url, options),
  });
  try {
    const first = refreshSnapshot(env, config);
    const second = refreshSnapshot(env, config);
    assert.equal(first, second);
    assert.ok(
      (await Promise.allSettled([first, second])).every(
        (item) => item.status === 'rejected',
      ),
    );
    assert.equal(writes.length, 1);
    assert.equal(writes.includes(SNAPSHOT_POINTER_KEY), false);
    failWrite = false;
    await refreshSnapshot(env, config);
    assert.equal(writes.length, 3);
    assert.equal(writes[2], SNAPSHOT_POINTER_KEY);
  } finally {
    fetchStub.fetch = original;
  }
});

test('direct and on-traffic dashboard refreshes share work, while bindings and sample options remain separate', async () => {
  const original = fetchStub.fetch;
  const gate = deferred<void>();
  const env = testEnv();
  let confirmedCalls = 0;
  fetchStub.fetch = async (url, options) => {
    if (url.includes('helius-rpc') && !url.includes('/parsed-events/')) {
      const body = JSON.parse(options.body);
      if (
        body.method === 'getSlot' &&
        body.params[0].commitment === 'confirmed'
      )
        confirmedCalls++;
    }
    await gate.promise;
    return {
      ok: true,
      /** Return the controlled JSON payload for this provider-response fixture. */
      json: async () => payload(url, options),
    };
  };
  try {
    const direct = refreshHeliusDashboardSample(env, config);
    const traffic = loadHeliusDashboardSample(env, config, new Date(), true);
    await setImmediate();
    assert.equal(confirmedCalls, 1);
    const differentBinding = refreshHeliusDashboardSample(testEnv(), config);
    const differentKey = refreshHeliusDashboardSample(env, {
      heliusApiKey: 'other',
    });
    assert.notEqual(direct, differentBinding);
    assert.notEqual(direct, differentKey);
    const samples = [
      refreshRecentTransactionSample(env, config, new Date(), 123, true),
      refreshRecentTransactionSample(env, config, new Date(), 123, false),
      refreshRecentTransactionSample(env, config, new Date(), 124, true),
    ];
    assert.equal(new Set(samples).size, 3);
    gate.resolve();
    const [a, b] = await Promise.all([direct, traffic]);
    assert.deepEqual(record(b).transactions, a.transactions);
    await Promise.all([differentBinding, differentKey, ...samples]);
  } finally {
    gate.resolve();
    fetchStub.fetch = original;
  }
});

test('overlapping dashboard refreshes preserve the first caller fallback and timestamp on partial failure', async () => {
  const original = fetchStub.fetch;
  const gate = deferred<void>();
  const env = testEnv();
  fetchStub.fetch = async (url, options) => {
    await gate.promise;
    if (url.includes('helius-rpc') && !url.includes('/parsed-events/')) {
      const body = JSON.parse(options.body);
      if (
        body.method === 'getEpochInfo' ||
        (body.method === 'getBlock' &&
          body.params[1].transactionDetails === 'signatures')
      ) {
        return { ok: false, status: 400 };
      }
    }
    return {
      ok: true,
      /** Return the controlled JSON payload for this provider-response fixture. */
      json: async () => payload(url, options),
    };
  };
  try {
    const previous = {
      transactions: [{ signature: 'first-caller' }],
      transactionAsOf: '2026-10-13T11:59:00.000Z',
      network: { chain: { state: 'fresh', processedSlot: 111 } },
    };
    const firstTime = new Date('2026-10-13T12:00:00.000Z');
    const first = refreshHeliusDashboardSample(
      env,
      config,
      previous,
      firstTime,
    );
    const second = refreshHeliusDashboardSample(
      env,
      config,
      {
        transactions: [{ signature: 'second-caller' }],
        network: { chain: { state: 'fresh', processedSlot: 222 } },
      },
      new Date('2026-10-13T12:00:01.000Z'),
    );
    assert.equal(first, second);
    gate.resolve();
    const result = await first;
    assert.equal(result.asOf, firstTime.toISOString());
    assert.equal(result.transactionsFreshness, 'stale');
    assert.deepEqual(result.transactions, previous.transactions);
    assert.equal(result.transactionAsOf, previous.transactionAsOf);
    assert.equal(record(result.network.chain).processedSlot, 111);
    assert.equal(result.network.chain.state, 'stale');
  } finally {
    gate.resolve();
    fetchStub.fetch = original;
  }
});

test('DefiLlama refreshes share reads and publication only in the same binding', async () => {
  const original = fetchStub.fetch;
  const gate = deferred<void>();
  let calls = 0;
  let writes = 0;
  const env = testEnv({
    SNAPSHOTS: {
      /** Observe or simulate the cache write requested by this test. */
      put: async () => {
        writes++;
      },
    },
  });
  fetchStub.fetch = async (url) => {
    calls++;
    await gate.promise;
    return {
      ok: true,
      /** Return the controlled JSON payload for this provider-response fixture. */
      json: async () => (url.includes('/overview/') ? { protocols: [] } : []),
    };
  };
  try {
    const first = refreshDefiLlamaDashboard(env.SNAPSHOTS);
    const second = refreshDefiLlamaDashboard(env.SNAPSHOTS);
    const other = refreshDefiLlamaDashboard(testEnv().SNAPSHOTS);
    assert.equal(first, second);
    assert.notEqual(first, other);
    await setImmediate();
    assert.equal(calls, 4);
    gate.resolve();
    await Promise.all([first, second, other]);
    assert.equal(writes, 1);
  } finally {
    gate.resolve();
    fetchStub.fetch = original;
  }
});

test('concurrent mint-detail responses keep request IDs separate while sharing Jupiter lookup', async () => {
  const original = fetchStub.fetch;
  const gate = deferred<void>();
  let calls = 0;
  const env = testEnv({ JUPITER_API_KEY: 'test-jupiter' });
  fetchStub.fetch = async (url, options) => {
    calls++;
    await gate.promise;
    return {
      ok: true,
      /** Return the controlled JSON payload for this provider-response fixture. */
      json: async () => payload(url, options),
    };
  };
  try {
    const url = `https://api.example/v3/assets/mint/${otherMint}?includeHistory=false`;
    const first = worker.fetch(
      new Request(url, { headers: { 'cf-ray': 'first' } }),
      env,
    );
    const second = worker.fetch(
      new Request(url, { headers: { 'cf-ray': 'second' } }),
      env,
    );
    await setImmediate();
    assert.equal(calls, 1);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const [bodyA, bodyB] = await Promise.all([a.json(), b.json()]);
    assert.deepEqual(bodyA.data, bodyB.data);
    assert.equal(bodyA.meta.requestId, 'first');
    assert.equal(bodyB.meta.requestId, 'second');
  } finally {
    gate.resolve();
    fetchStub.fetch = original;
  }
});
