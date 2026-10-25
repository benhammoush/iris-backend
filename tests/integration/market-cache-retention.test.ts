/**
 * Regression coverage and controlled fixtures for market cache retention.
 * @packageDocumentation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../../src/index.ts';
import { resolveSnapshot } from '../../src/snapshot.ts';
import { loadDefiLlamaDashboard } from '../../src/defillama.ts';
import {
  DEFILLAMA_DASHBOARD_KEY,
  SNAPSHOT_POINTER_KEY,
  STALE_AFTER_MS,
  SOL_MINT,
} from '../../src/constants.ts';
import { record } from '../../src/record.ts';
import { testEnv } from '../support/support.ts';

const oldDate = '2026-01-01T00:00:00.000Z';
const oldSnapshot = {
  createdAt: oldDate,
  market: { source: 'jupiter', asOf: oldDate },
  assets: [],
  wallets: {},
  swaps: [],
};
const oldDefi = {
  source: 'defillama',
  fetchedAt: oldDate,
  dexes: { items: [{ name: 'Retained DEX' }] },
  protocols: { total: 1, items: [{ name: 'Retained protocol' }] },
};

void test('only hosted dev enables indefinite market retention in checked-in configuration', () => {
  const configuration = readFileSync(
    new URL('../../wrangler.toml', import.meta.url),
    'utf8',
  );
  const section = configuration.split('[env.dev.vars]')[1]?.split('[')[0];
  assert.match(section ?? '', /RETAIN_STALE_MARKET_DATA = "true"/);
  assert.equal(configuration.match(/RETAIN_STALE_MARKET_DATA/g)?.length, 1);
});

void test('dev routes retain old market data and original timestamps without renewing freshness', async () => {
  for (const flag of ['true', undefined, 'false', 'TRUE']) {
    const env = testEnv({
      RETAIN_STALE_MARKET_DATA: flag,
      SNAPSHOTS: {
        /** Read the old snapshot or independent market dashboard.
         * @param key - Requested resource identity.
         * @returns Unchanged old evidence, never a renewed observation timestamp.
         */
        get: (key) =>
          Promise.resolve().then(() => {
            if (key === SNAPSHOT_POINTER_KEY) return { key: 'old-snapshot' };
            if (key === 'old-snapshot') return oldSnapshot;
            if (key === DEFILLAMA_DASHBOARD_KEY) return oldDefi;
            return null;
          }),
      },
    });
    const retained = flag === 'true';
    for (const path of [
      '/ready',
      '/v3/status',
      '/v3/catalogs',
      '/v3/defillama',
    ]) {
      const response = await worker.fetch(
        new Request(`https://worker.example${path}`),
        env,
      );
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get('x-snapshot-state'),
        retained ? 'stale' : 'fixture',
      );
      const payload = record(await response.json());
      if (path !== '/ready' && retained) {
        assert.equal(record(payload.meta).snapshotCreatedAt, oldDate);
        assert.equal(record(payload.meta).marketDataAsOf, oldDate);
      }
      if (path === '/v3/defillama') {
        assert.equal(
          record(record(payload.meta).defillama).freshness,
          retained ? 'stale' : 'unavailable',
        );
        assert.equal(record(payload.data).fetchedAt, retained ? oldDate : null);
      }
    }
  }
});

void test('retention still rejects missing, malformed and future-dated records', async () => {
  const now = Date.parse(oldDate);
  for (const value of [
    null,
    {},
    { ...oldSnapshot, createdAt: 'invalid' },
    {
      ...oldSnapshot,
      createdAt: new Date(now + 1).toISOString(),
    },
  ]) {
    const cache = {
      /** Read a controlled malformed or future-dated snapshot.
       * @param key - Pointer or snapshot cache identity.
       * @returns The fixed pointer or invalid snapshot payload.
       */
      get: (key: string) =>
        Promise.resolve(key === SNAPSHOT_POINTER_KEY ? { key: 'test' } : value),
    };
    assert.equal((await resolveSnapshot(cache, now, true)).state, 'fixture');
  }
  for (const value of [
    null,
    {},
    { ...oldDefi, fetchedAt: 'invalid' },
    {
      ...oldDefi,
      fetchedAt: new Date(now + 1).toISOString(),
    },
  ]) {
    assert.equal(
      (
        await loadDefiLlamaDashboard(
          {
            /** Read a controlled invalid dashboard.
             * @returns The malformed or future-dated payload under test.
             */
            get: () => Promise.resolve(value),
          },
          now,
          true,
        )
      ).state,
      'unavailable',
    );
  }
});

void test('authenticated refresh persists dev market caches without TTL and preserves production expiry', async (t) => {
  t.mock.method(globalThis, 'fetch', (url: string | URL | Request) =>
    Promise.resolve().then(() => {
      const path = url instanceof Request ? url.url : url.toString();
      if (path.includes('/toptraded/'))
        return Response.json([
          { id: SOL_MINT, symbol: 'SOL', name: 'Solana', usdPrice: 150 },
        ]);
      if (path.includes('/overview/dexs/'))
        return Response.json({ protocols: [] });
      if (path.includes('api.llama.fi') || path.includes('/tokens/v2/'))
        return Response.json([]);
      if (path.includes('/addresses/')) return Response.json([]);
      return Response.json({ result: null });
    }),
  );
  for (const flag of ['true', undefined]) {
    const records = new Map<string, unknown>();
    const writes: { key: string; expirationTtl?: number }[] = [];
    const env = testEnv({
      HELIUS_API_KEY: 'test-key',
      JUPITER_API_KEY: 'test-key',
      REFRESH_TOKEN: 'test-token',
      RETAIN_STALE_MARKET_DATA: flag,
      SNAPSHOTS: {
        /** Read the isolated in-memory cache.
         * @param key - Resource identity.
         * @returns The stored unknown JSON or null when absent.
         */
        get: (key) => Promise.resolve(records.get(key) ?? null),
        /** Capture publication and expiration policy.
         * @param key - Resource identity being published.
         * @param value - Complete serialized resource.
         * @param options - Expiration policy retained for assertions.
         * @returns Completion after recording the publication and expiration policy.
         */
        put: (key, value, options) => {
          records.set(key, JSON.parse(value));
          writes.push({ key, ...options });
          return Promise.resolve();
        },
      },
    });
    const response = await worker.fetch(
      new Request('https://worker.example/internal/refresh', {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' },
      }),
      env,
    );
    assert.equal(response.status, 200);
    const pointer = record(records.get(SNAPSHOT_POINTER_KEY));
    assert.equal(typeof pointer.key, 'string');
    for (const key of [String(pointer.key), DEFILLAMA_DASHBOARD_KEY]) {
      const write = writes.find((entry) => entry.key === key);
      assert.ok(write, key);
      assert.equal(write.expirationTtl, flag === 'true' ? undefined : 86_400);
    }
    assert.ok(
      writes.findIndex((entry) => entry.key === pointer.key) <
        writes.findIndex((entry) => entry.key === SNAPSHOT_POINTER_KEY),
    );
    const later = Date.now() + 30 * STALE_AFTER_MS;
    const retained = flag === 'true';
    assert.equal(
      (await resolveSnapshot(env.SNAPSHOTS, later, retained)).state,
      retained ? 'stale' : 'fixture',
    );
    assert.equal(
      (await loadDefiLlamaDashboard(env.SNAPSHOTS, later, retained)).state,
      retained ? 'stale' : 'unavailable',
    );
  }
});
