/**
 * Regression coverage and controlled fixtures for recovery.
 * @packageDocumentation
 */

/**
 * Exercises recovery against retained KV records, rather than write counters.
 * All providers are stubbed; failures cannot consume live quota or modify shared data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadHeliusDashboardSample,
  loadRecentTransactionSample,
  refreshHeliusDashboardSample,
} from '../../src/recentTransactions.ts';
import {
  STALE_AFTER_MS,
  V3_HELIUS_DASHBOARD_KEY,
  V3_RECENT_TRANSACTIONS_FRESH_AFTER_MS,
  SNAPSHOT_POINTER_KEY,
  SNAPSHOT_KEY_PREFIX,
  SOL_MINT,
  FRESH_AFTER_MS,
} from '../../src/constants.ts';
import { array, record } from '../../src/record.ts';
import {
  fetchStub,
  testEnv,
  type FetchStubOptions,
} from '../support/support.ts';
import { refreshSnapshot, resolveSnapshot } from '../../src/snapshot.ts';
import { FIXTURE_SNAPSHOT } from '../../src/fixtures.ts';
import { deferred } from '../support/deferred.ts';
import { candlesForAsset } from '../../src/routes.ts';
import {
  loadDefiLlamaDashboard,
  refreshDefiLlamaDashboard,
} from '../../src/defillama.ts';
import type { SnapshotStore } from '../../src/env.ts';
import worker from '../../src/index.ts';

const now = new Date('2026-10-14T12:00:00.000Z');

/** Models committed writes only; a rejected put leaves the preceding value intact.
 * @param entries - Initial committed JSON entries.
 * @returns Cache operations, retained records, attempted writes and a controlled failure selector.
 */
function retainedStore(entries: [string, unknown][] = []) {
  const records = new Map(entries);
  const writes: string[] = [];
  let failKey: string | null = null;
  const kv: SnapshotStore = {
    /** Read the last committed value.
     * @param key - Requested cache identity.
     * @returns Stored unknown JSON or null when absent.
     */
    get: (key) => Promise.resolve(records.get(key) ?? null),
    /** Commit only successful fixture writes.
     * @param key - Requested cache identity.
     * @param value - Complete serialized payload.
     * @returns Completion unless the selected identity is configured to fail.
     */
    put: (key, value) =>
      Promise.resolve().then(() => {
        writes.push(key);
        if (key === failKey) throw new Error('Injected KV write failure');
        records.set(key, JSON.parse(value));
      }),
  };
  return {
    kv,
    records,
    writes,
    /** Select the controlled failing cache operation for the recovery test.
     * @param key - Identity to fail, or null to restore successful writes.
     */
    fail: (key: string | null) => {
      failKey = key;
    },
  };
}

/** Independent provider outages selected by recovery assertions. */
interface RecoveryFailures {
  block?: boolean;
  network?: boolean;
  market?: boolean;
  discovery?: boolean;
}

/** Installs deterministic read-only providers, with independent failure switches.
 * @param failures - Mutable outage switches for independent provider sections.
 */
function recoveryProvider(failures: RecoveryFailures = {}) {
  fetchStub.fetch = (url, options) => {
    if (url.includes('api.llama.fi')) return { ok: false, status: 400 };
    if (url.includes('/toptraded/'))
      return failures.market
        ? { ok: false, status: 400 }
        : Response.json([
            {
              id: SOL_MINT,
              symbol: 'SOL',
              name: 'Solana',
              decimals: 9,
              isVerified: true,
              usdPrice: 150,
            },
          ]);
    if (url.includes('/toptrending/') || url.includes('/tokens/v2/recent'))
      return failures.discovery
        ? { ok: false, status: 400 }
        : Response.json([]);
    if (url.includes('/addresses/')) return Response.json([]);
    if (url.includes('/parsed-events/')) return Response.json({ data: [] });
    const request = record(JSON.parse(options.body));
    const params = array(request.params);
    const sampleBlock =
      request.method === 'getBlock' &&
      record(params[1]).transactionDetails === 'signatures';
    const confirmed =
      request.method === 'getSlot' &&
      record(params[0]).commitment === 'confirmed';
    if (
      (sampleBlock && failures.block) ||
      (!sampleBlock && !confirmed && failures.network)
    )
      return { ok: false, status: 400 };
    if (sampleBlock)
      return Response.json({
        result: { blockTime: 1_760_000_000, signatures: ['new-signature'] },
      });
    // Snapshot-only RPC groups may return unavailable metrics; this fixture proves
    // valid dashboard groups and core publication, not fabricated chain analytics.
    const known = [
      'getSlot',
      'getBlockHeight',
      'getEpochInfo',
      'getRecentPerformanceSamples',
      'getBlocksWithLimit',
      'getBlock',
    ];
    return Response.json(
      typeof request.method === 'string' && known.includes(request.method)
        ? networkOnlyPayload(options)
        : { result: null },
    );
  };
}

/** Returns valid network metrics while failing only the signatures-only block read.
 * @param options - Serialized RPC request selecting controlled network evidence.
 * @returns Supported provider JSON without fabricating unsupported method results.
 */
function networkOnlyPayload(options: FetchStubOptions): unknown {
  const request = record(JSON.parse(options.body));
  if (request.method === 'getSlot') return { result: 123 };
  if (request.method === 'getBlockHeight') return { result: 100 };
  if (request.method === 'getEpochInfo') return { result: { epoch: 7 } };
  if (request.method === 'getRecentPerformanceSamples')
    return {
      result: [
        {
          numTransactions: 200,
          numNonVoteTransactions: 150,
          samplePeriodSecs: 2,
        },
      ],
    };
  if (request.method === 'getBlocksWithLimit') return { result: [123] };
  if (request.method === 'getBlock')
    return { result: { transactions: [{ meta: { fee: 100 } }] } };
  throw new Error(
    `Unexpected test RPC: ${typeof request.method === 'string' ? request.method : 'invalid'}`,
  );
}

/** Builds a dashboard with an independently dated transaction sample.
 * @param asOf - Envelope and network observation timestamp.
 * @param transactionAsOf - Independent original transaction observation timestamp.
 * @returns A fixture whose independently dated sections permit retention-boundary assertions.
 */
function dashboard(asOf: string, transactionAsOf = asOf) {
  return {
    asOf,
    slot: 100,
    transactionAsOf,
    transactionsFreshness: 'fresh',
    transactions: [
      {
        signature: 'preceding',
        slot: 100,
        blockTime: null,
        status: 'confirmed',
        action: null,
      },
    ],
    network: {
      chain: { state: 'fresh', asOf, processedSlot: 100 },
      performance: { state: 'fresh', asOf, tps: 1 },
      fees: { state: 'fresh', asOf, averageFeeLamports: 1 },
    },
  };
}

void test('a fresh network refresh cannot revive a transaction sample older than 24 hours', async () => {
  const original = fetchStub.fetch;
  const oldTime = new Date(now.getTime() - STALE_AFTER_MS - 1).toISOString();
  // A previous partial refresh renewed the envelope, but not the transactions.
  const cached = dashboard(
    new Date(now.getTime() - 60_001).toISOString(),
    oldTime,
  );
  const writes = new Map<string, unknown>();
  const env = testEnv({
    HELIUS_API_KEY: 'test-helius',
    SNAPSHOTS: {
      /** Read the preceding independently dated dashboard.
       * @returns Its unchanged original observation timestamps.
       */
      get: () => Promise.resolve(cached),
      /** Capture replacement publication.
       * @param key - Requested cache identity.
       * @param value - Complete serialized dashboard.
       * @returns Completion after recording the replacement.
       */
      put: (key, value) =>
        Promise.resolve(writes.set(key, JSON.parse(value) as unknown)),
    },
  });
  fetchStub.fetch = (_url, options) => {
    const request = record(JSON.parse(options.body));
    if (
      request.method === 'getBlock' &&
      record(array(request.params)[1]).transactionDetails === 'signatures'
    )
      return { ok: false, status: 400 };
    return Response.json(networkOnlyPayload(options));
  };
  try {
    const result = await loadHeliusDashboardSample(env, {}, now, true);
    assert.equal(result.freshness, 'fresh');
    assert.equal(record(record(result.network).chain).state, 'fresh');
    assert.deepEqual(result.transactions, []);
    assert.equal(result.transactionsFreshness, 'unavailable');
    assert.equal(result.transactionAsOf, null);
    assert.deepEqual(
      record(writes.get(V3_HELIUS_DASHBOARD_KEY)).transactions,
      [],
    );
  } finally {
    fetchStub.fetch = original;
  }
});

void test('transaction fallback expires at its own exact boundary, even in a renewed envelope', async (t) => {
  const original = fetchStub.fetch;
  recoveryProvider({ block: true });
  try {
    for (const age of [STALE_AFTER_MS, STALE_AFTER_MS + 1, -1]) {
      await t.test(`transaction age ${age}ms`, async () => {
        const cached = dashboard(
          new Date(now.getTime() - 60_001).toISOString(),
          new Date(now.getTime() - age).toISOString(),
        );
        const env = testEnv({
          HELIUS_API_KEY: 'test',
          SNAPSHOTS: {
            /** Read the original independently dated dashboard.
             * @returns Fixture evidence without renewing either timestamp.
             */
            get: () => Promise.resolve(cached),
          },
        });
        const result = await loadHeliusDashboardSample(env, {}, now, true);
        assert.equal(
          result.transactionsFreshness,
          age === STALE_AFTER_MS ? 'stale' : 'unavailable',
        );
        assert.deepEqual(
          result.transactions,
          age === STALE_AFTER_MS ? cached.transactions : [],
        );
      });
    }
    const cached = dashboard(
      now.toISOString(),
      new Date(now.getTime() - STALE_AFTER_MS - 1).toISOString(),
    );
    const result = await loadHeliusDashboardSample(
      testEnv({
        SNAPSHOTS: {
          /** Read the unchanged dashboard fixture.
           * @returns The renewed envelope with its expired original transaction sample.
           */
          get: () => Promise.resolve(cached),
        },
      }),
      {},
      now,
    );
    assert.equal(result.freshness, 'fresh');
    assert.deepEqual(result.transactions, []);
    assert.equal(result.transactionsFreshness, 'unavailable');
    assert.equal(result.transactionAsOf, null);
  } finally {
    fetchStub.fetch = original;
  }
});

void test('legacy dashboard timestamps remain bounded without overriding explicit unavailable timestamps', async () => {
  const original = fetchStub.fetch;
  recoveryProvider({ block: true });
  try {
    const legacy = record(
      dashboard(new Date(now.getTime() - 60_001).toISOString()),
    );
    delete legacy.transactionAsOf;
    for (const [sample, expected] of [
      [legacy, 'stale'],
      [{ ...legacy, transactionAsOf: null }, 'unavailable'],
      [{ ...legacy, transactionAsOf: 'not-a-date' }, 'unavailable'],
      [{ ...legacy, transactionAsOf: 123 }, 'unavailable'],
    ] as const) {
      const store = retainedStore([[V3_HELIUS_DASHBOARD_KEY, sample]]);
      const result = await loadHeliusDashboardSample(
        testEnv({ HELIUS_API_KEY: 'test', SNAPSHOTS: store.kv }),
        {},
        now,
        true,
      );
      assert.equal(result.transactionsFreshness, expected);
      assert.deepEqual(
        result.transactions,
        expected === 'stale' ? legacy.transactions : [],
      );
      assert.equal(
        result.transactionAsOf,
        expected === 'stale' ? legacy.asOf : null,
      );
    }
  } finally {
    fetchStub.fetch = original;
  }
});

void test('recent and dashboard caches enforce exact fresh/stale expiry and reject malformed envelopes', async (t) => {
  const original = fetchStub.fetch;
  fetchStub.fetch = () => {
    throw new Error('Cache-only reads must not call providers');
  };
  try {
    for (const [age, expected] of [
      [V3_RECENT_TRANSACTIONS_FRESH_AFTER_MS, 'fresh'],
      [V3_RECENT_TRANSACTIONS_FRESH_AFTER_MS + 1, 'stale'],
      [STALE_AFTER_MS, 'stale'],
      [STALE_AFTER_MS + 1, 'unavailable'],
      [-1, 'unavailable'],
    ] as const) {
      await t.test(`age ${age}ms`, async () => {
        const cached = dashboard(new Date(now.getTime() - age).toISOString());
        const env = testEnv({
          SNAPSHOTS: {
            /** Read the exact-boundary sample unchanged.
             * @returns Fixture evidence used by both independent cache readers.
             */
            get: () => Promise.resolve(cached),
          },
        });
        for (const load of [
          loadRecentTransactionSample,
          loadHeliusDashboardSample,
        ]) {
          const result = await load(env, {}, now);
          assert.equal(result.freshness, expected);
          assert.deepEqual(
            result.transactions,
            expected === 'unavailable' ? [] : cached.transactions,
          );
        }
      });
    }
    for (const cached of [
      null,
      {},
      { ...dashboard(now.toISOString()), asOf: 'bad-date' },
      { ...dashboard(now.toISOString()), slot: '100' },
      { ...dashboard(now.toISOString()), transactions: {} },
    ]) {
      const env = testEnv({
        SNAPSHOTS: {
          /** Read one malformed fixture envelope.
           * @returns The controlled invalid JSON payload.
           */
          get: () => Promise.resolve(cached),
        },
      });
      for (const load of [
        loadRecentTransactionSample,
        loadHeliusDashboardSample,
      ]) {
        const result = await load(env, {}, now);
        assert.equal(result.freshness, 'unavailable');
        assert.deepEqual(result.transactions, []);
      }
    }
  } finally {
    fetchStub.fetch = original;
  }
});

void test('partial dashboard recovery never republishes malformed, future or expired envelopes', async () => {
  const original = fetchStub.fetch;
  recoveryProvider({ block: true, network: true });
  try {
    for (const cached of [
      { ...dashboard(now.toISOString()), slot: 'not-a-slot' },
      { ...dashboard(now.toISOString()), network: {} },
      dashboard(new Date(now.getTime() + 1).toISOString()),
      dashboard(new Date(now.getTime() - STALE_AFTER_MS - 1).toISOString()),
    ]) {
      const store = retainedStore([[V3_HELIUS_DASHBOARD_KEY, cached]]);
      const result = await loadHeliusDashboardSample(
        testEnv({ HELIUS_API_KEY: 'test', SNAPSHOTS: store.kv }),
        {},
        now,
        true,
      );
      assert.deepEqual(result.transactions, []);
      assert.equal(result.transactionAsOf, null);
      assert.equal(result.transactionsFreshness, 'unavailable');
      for (const key of ['chain', 'performance', 'fees']) {
        assert.equal(record(record(result.network)[key]).state, 'unavailable');
        assert.equal(record(record(result.network)[key]).asOf, null);
      }
      assert.deepEqual(
        record(store.records.get(V3_HELIUS_DASHBOARD_KEY)).transactions,
        [],
      );
    }
  } finally {
    fetchStub.fetch = original;
  }
});

void test('dashboard component failures preserve independent stale groups and recover on the next read', async (t) => {
  const original = fetchStub.fetch;
  try {
    for (const failures of [
      { block: true },
      { network: true },
      { block: true, network: true },
    ]) {
      await t.test(JSON.stringify(failures), async () => {
        const cached = dashboard(
          new Date(now.getTime() - 60_001).toISOString(),
        );
        const store = retainedStore([[V3_HELIUS_DASHBOARD_KEY, cached]]);
        const env = testEnv({ HELIUS_API_KEY: 'test', SNAPSHOTS: store.kv });
        recoveryProvider(failures);
        const result = await loadHeliusDashboardSample(env, {}, now, true);
        assert.equal(
          result.transactionsFreshness,
          failures.block ? 'stale' : 'fresh',
        );
        assert.deepEqual(
          result.transactions,
          failures.block
            ? cached.transactions
            : [
                {
                  signature: 'new-signature',
                  slot: 123,
                  blockTime: new Date(1_760_000_000_000).toISOString(),
                  status: 'confirmed',
                  action: null,
                },
              ],
        );
        for (const key of ['chain', 'performance', 'fees']) {
          const group = record(record(result.network)[key]);
          assert.equal(group.state, failures.network ? 'stale' : 'fresh');
          assert.equal(
            group.asOf,
            failures.network ? cached.asOf : now.toISOString(),
          );
        }
        recoveryProvider();
        const recovered = await loadHeliusDashboardSample(
          env,
          {},
          new Date(now.getTime() + 60_001),
          true,
        );
        assert.equal(recovered.transactionsFreshness, 'fresh');
        assert.equal(record(record(recovered.network).performance).tps, 100);
        assert.equal(
          record(record(recovered.network).fees).averageFeeLamports,
          100,
        );
      });
    }
  } finally {
    fetchStub.fetch = original;
  }
});

void test('dashboard write failures retain preceding cache and do not poison a later refresh', async () => {
  const original = fetchStub.fetch;
  recoveryProvider();
  try {
    const cached = dashboard(new Date(now.getTime() - 60_001).toISOString());
    const store = retainedStore([[V3_HELIUS_DASHBOARD_KEY, cached]]);
    const env = testEnv({ HELIUS_API_KEY: 'test', SNAPSHOTS: store.kv });
    store.fail(V3_HELIUS_DASHBOARD_KEY);
    await assert.rejects(
      refreshHeliusDashboardSample(env, {}, cached, now),
      /Injected KV/,
    );
    assert.deepEqual(store.records.get(V3_HELIUS_DASHBOARD_KEY), cached);
    const fallback = await loadHeliusDashboardSample(env, {}, now, true);
    assert.equal(fallback.freshness, 'stale');
    assert.deepEqual(fallback.transactions, cached.transactions);
    store.fail(null);
    const recovered = await loadHeliusDashboardSample(env, {}, now, true);
    assert.equal(recovered.freshness, 'fresh');
    assert.equal(
      record(array(recovered.transactions)[0]).signature,
      'new-signature',
    );
    assert.equal(
      record(store.records.get(V3_HELIUS_DASHBOARD_KEY)).asOf,
      now.toISOString(),
    );
  } finally {
    fetchStub.fetch = original;
  }
});

void test('public transaction metadata preserves explicit unavailable timestamps', async () => {
  const original = fetchStub.fetch;
  recoveryProvider({ block: true });
  try {
    for (const transactionAsOf of [
      null,
      'not-a-date',
      new Date(Date.now() - STALE_AFTER_MS - 1_000).toISOString(),
    ]) {
      const cached = {
        ...dashboard(new Date().toISOString()),
        transactionAsOf,
      };
      const store = retainedStore([[V3_HELIUS_DASHBOARD_KEY, cached]]);
      const response = await worker.fetch(
        new Request('https://api.example/v3/transactions/recent'),
        testEnv({ HELIUS_API_KEY: 'test', SNAPSHOTS: store.kv }),
      );
      const body = record(await response.json());
      assert.equal(response.status, 200);
      assert.deepEqual(record(body.data).transactions, []);
      assert.equal(
        record(record(body.meta).recentTransactions).freshness,
        'unavailable',
      );
      assert.equal(record(record(body.meta).recentTransactions).asOf, null);
    }
  } finally {
    fetchStub.fetch = original;
  }
});

void test('scheduled and authenticated refreshes retain bounded prior samples despite partial and optional outages', async (t) => {
  const original = fetchStub.fetch;
  recoveryProvider({ block: true });
  try {
    for (const entrypoint of ['scheduled', 'authenticated']) {
      await t.test(entrypoint, async () => {
        const cached = dashboard(new Date(Date.now() - 60_001).toISOString());
        const store = retainedStore([[V3_HELIUS_DASHBOARD_KEY, cached]]);
        const env = testEnv({
          HELIUS_API_KEY: 'test',
          JUPITER_API_KEY: 'test',
          REFRESH_TOKEN: 'local-test-only',
          SNAPSHOTS: store.kv,
        });
        if (entrypoint === 'scheduled') await worker.scheduled({}, env);
        else {
          const response = await worker.fetch(
            new Request('https://api.example/internal/refresh', {
              method: 'POST',
              headers: { authorization: 'Bearer local-test-only' },
            }),
            env,
          );
          assert.equal(response.status, 200);
          assert.equal(
            record(record(await response.json()).data).status,
            'refreshed',
          );
        }
        const persisted = record(store.records.get(V3_HELIUS_DASHBOARD_KEY));
        assert.equal(persisted.transactionsFreshness, 'stale');
        assert.deepEqual(persisted.transactions, cached.transactions);
        assert.equal(persisted.transactionAsOf, cached.transactionAsOf);
        assert.equal(
          record(record(persisted.network).performance).state,
          'fresh',
        );
        assert.equal(record(record(persisted.network).performance).tps, 100);
        assert.notEqual(persisted.asOf, cached.asOf);
        assert.equal((await resolveSnapshot(store.kv)).state, 'fresh');
        // Both optional DefiLlama reads failed, but valid core data published.
        assert.equal(store.records.has('defillama:v3:dashboard'), false);
      });
    }
  } finally {
    fetchStub.fetch = original;
  }
});

void test('complete Helius outages keep usable dashboard data stale without renewing it', async () => {
  const original = fetchStub.fetch;
  fetchStub.fetch = () => ({ ok: false, status: 400 });
  try {
    for (const age of [60_001, STALE_AFTER_MS, STALE_AFTER_MS + 1]) {
      const cached = dashboard(new Date(now.getTime() - age).toISOString());
      const store = retainedStore([[V3_HELIUS_DASHBOARD_KEY, cached]]);
      const result = await loadHeliusDashboardSample(
        testEnv({ HELIUS_API_KEY: 'test', SNAPSHOTS: store.kv }),
        {},
        now,
        true,
      );
      assert.equal(
        result.freshness,
        age <= STALE_AFTER_MS ? 'stale' : 'unavailable',
      );
      assert.deepEqual(
        result.transactions,
        age <= STALE_AFTER_MS ? cached.transactions : [],
      );
      assert.equal(store.writes.length, 0);
      assert.deepEqual(store.records.get(V3_HELIUS_DASHBOARD_KEY), cached);
    }
  } finally {
    fetchStub.fetch = original;
  }
});

void test('snapshot publication failures keep readers on the preceding complete record, then recover', async (t) => {
  const original = fetchStub.fetch;
  recoveryProvider();
  try {
    for (const failedKey of [
      `${SNAPSHOT_KEY_PREFIX}${now.getTime()}`,
      SNAPSHOT_POINTER_KEY,
    ]) {
      await t.test(failedKey, async () => {
        const previous = {
          ...FIXTURE_SNAPSHOT,
          createdAt: new Date(now.getTime() - 60_000).toISOString(),
        };
        const oldKey = `${SNAPSHOT_KEY_PREFIX}previous`;
        const store = retainedStore([
          [SNAPSHOT_POINTER_KEY, { key: oldKey }],
          [oldKey, previous],
        ]);
        const env = testEnv({
          SNAPSHOTS: store.kv,
          HELIUS_API_KEY: 'test',
          JUPITER_API_KEY: 'test',
        });
        store.fail(failedKey);
        await assert.rejects(refreshSnapshot(env, {}, now), /Injected KV/);
        assert.deepEqual(record(store.records.get(SNAPSHOT_POINTER_KEY)), {
          key: oldKey,
        });
        assert.deepEqual(
          (await resolveSnapshot(store.kv, now.getTime())).snapshot,
          previous,
        );
        assert.deepEqual(
          store.writes,
          failedKey === SNAPSHOT_POINTER_KEY
            ? [`${SNAPSHOT_KEY_PREFIX}${now.getTime()}`, SNAPSHOT_POINTER_KEY]
            : [failedKey],
        );
        store.fail(null);
        const recovered = await refreshSnapshot(
          env,
          {},
          new Date(now.getTime() + 1),
        );
        assert.deepEqual(
          (await resolveSnapshot(store.kv, now.getTime() + 1)).snapshot,
          recovered,
        );
        assert.equal(
          record(store.records.get(SNAPSHOT_POINTER_KEY)).key,
          `${SNAPSHOT_KEY_PREFIX}${now.getTime() + 1}`,
        );
      });
    }
  } finally {
    fetchStub.fetch = original;
  }
});

void test('readers remain on the old snapshot while its replacement data write is pending', async () => {
  const original = fetchStub.fetch;
  recoveryProvider();
  const gate = deferred<void>();
  const started = deferred<void>();
  const previous = { ...FIXTURE_SNAPSHOT, createdAt: now.toISOString() };
  const oldKey = `${SNAPSHOT_KEY_PREFIX}previous`;
  const store = retainedStore([
    [SNAPSHOT_POINTER_KEY, { key: oldKey }],
    [oldKey, previous],
  ]);
  const put = store.kv.put.bind(store.kv);
  store.kv.put = async (key, value, options) => {
    if (key.startsWith(SNAPSHOT_KEY_PREFIX)) {
      started.resolve();
      await gate.promise;
    }
    await put(key, value, options);
  };
  try {
    const pending = refreshSnapshot(
      testEnv({
        SNAPSHOTS: store.kv,
        HELIUS_API_KEY: 'test',
        JUPITER_API_KEY: 'test',
      }),
      {},
      now,
    );
    await started.promise;
    assert.deepEqual(
      (await resolveSnapshot(store.kv, now.getTime())).snapshot,
      previous,
    );
    assert.equal(store.writes.length, 0);
    gate.resolve();
    const published = await pending;
    assert.deepEqual(
      (await resolveSnapshot(store.kv, now.getTime())).snapshot,
      published,
    );
  } finally {
    gate.resolve();
    fetchStub.fetch = original;
  }
});

void test('market outages preserve usable snapshots without renewing their age or publishing fixtures', async () => {
  const original = fetchStub.fetch;
  recoveryProvider({ market: true });
  try {
    for (const age of [60_000, STALE_AFTER_MS, STALE_AFTER_MS + 1]) {
      const previous = {
        ...FIXTURE_SNAPSHOT,
        createdAt: new Date(now.getTime() - age).toISOString(),
      };
      const store = retainedStore([
        [SNAPSHOT_POINTER_KEY, { key: 'snapshot:previous' }],
        ['snapshot:previous', previous],
      ]);
      const env = testEnv({
        SNAPSHOTS: store.kv,
        HELIUS_API_KEY: 'test',
        JUPITER_API_KEY: 'test',
      });
      if (age <= STALE_AFTER_MS)
        assert.deepEqual(await refreshSnapshot(env, {}, now), previous);
      else {
        await assert.rejects(
          refreshSnapshot(env, {}, now),
          /no usable snapshot/,
        );
        assert.equal(
          (await resolveSnapshot(store.kv, now.getTime())).state,
          'fixture',
        );
      }
      assert.equal(store.writes.length, 0);
    }
  } finally {
    fetchStub.fetch = original;
  }
});

void test('optional discovery failures publish an honest complete core snapshot with empty categories', async () => {
  const original = fetchStub.fetch;
  recoveryProvider({ discovery: true });
  try {
    const store = retainedStore();
    const result = await refreshSnapshot(
      testEnv({
        SNAPSHOTS: store.kv,
        HELIUS_API_KEY: 'test',
        JUPITER_API_KEY: 'test',
      }),
      {},
      now,
    );
    assert.equal(result.assets.length, 1);
    assert.deepEqual(record(result.catalogs).trending, []);
    assert.deepEqual(record(result.catalogs).recent, []);
    assert.deepEqual(
      (await resolveSnapshot(store.kv, now.getTime())).snapshot,
      result,
    );
    assert.deepEqual(store.writes, [
      `${SNAPSHOT_KEY_PREFIX}${now.getTime()}`,
      SNAPSHOT_POINTER_KEY,
    ]);
  } finally {
    fetchStub.fetch = original;
  }
});

void test('DefiLlama provider and write failures leave preceding cache readable until expiry', async () => {
  const original = fetchStub.fetch;
  const cached = {
    source: 'defillama',
    fetchedAt: new Date(now.getTime() - 3_600_001).toISOString(),
    dexes: { items: [] },
    protocols: { items: [] },
  };
  const store = retainedStore([['defillama:v3:dashboard', cached]]);
  try {
    fetchStub.fetch = () => ({ ok: false, status: 400 });
    await assert.rejects(refreshDefiLlamaDashboard(store.kv, now));
    assert.deepEqual(
      (await loadDefiLlamaDashboard(store.kv, now.getTime())).dashboard,
      cached,
    );
    fetchStub.fetch = (url) =>
      Response.json(url.includes('/overview/') ? { protocols: [] } : []);
    store.fail('defillama:v3:dashboard');
    await assert.rejects(
      refreshDefiLlamaDashboard(store.kv, now),
      /Injected KV/,
    );
    assert.equal(
      (await loadDefiLlamaDashboard(store.kv, now.getTime())).state,
      'stale',
    );
    assert.equal(
      (
        await loadDefiLlamaDashboard(
          store.kv,
          Date.parse(cached.fetchedAt) + STALE_AFTER_MS + 1,
        )
      ).state,
      'unavailable',
    );
    store.fail(null);
    await refreshDefiLlamaDashboard(store.kv, now);
    assert.equal(
      (await loadDefiLlamaDashboard(store.kv, now.getTime())).state,
      'fresh',
    );
  } finally {
    fetchStub.fetch = original;
  }
});

void test('failed candle writes fall back to usable preceding candles, never expired or malformed records', async () => {
  const original = fetchStub.fetch;
  fetchStub.fetch = () =>
    Response.json({
      success: true,
      data: {
        items: [
          { unix_time: 1_760_000_000, o: 1, h: 2, l: 1, c: 2, v: 1, v_usd: 2 },
        ],
      },
    });
  try {
    for (const cached of [
      {
        fetchedAt: new Date(Date.now() - FRESH_AFTER_MS - 1_000).toISOString(),
        candles: [{ timestamp: 'preceding' }],
      },
      {
        fetchedAt: new Date(Date.now() - STALE_AFTER_MS - 1_000).toISOString(),
        candles: [{ timestamp: 'expired' }],
      },
      { fetchedAt: 'invalid', candles: [] },
    ]) {
      const kv = {
        /** Read preceding candle evidence without renewing it.
         * @returns The controlled stale, expired or malformed candle envelope.
         */
        get: () => Promise.resolve(cached),
        /** Reject replacement publication before changing preceding candles.
         * @returns The controlled cache-write rejection.
         */
        put: () => Promise.reject(new Error('Injected KV write failure')),
      };
      const result = await candlesForAsset(kv, SOL_MINT, 'test');
      const usable =
        cached.fetchedAt !== 'invalid' &&
        Date.now() - Date.parse(cached.fetchedAt) <= STALE_AFTER_MS;
      assert.equal(result.state, usable ? 'stale' : 'unavailable');
      assert.deepEqual(result.candles, usable ? cached.candles : null);
    }
  } finally {
    fetchStub.fetch = original;
  }
});
