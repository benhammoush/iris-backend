/**
 * Regression coverage and controlled fixtures for defillama boundaries.
 * @packageDocumentation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isUsableDefiLlamaDashboard,
  loadDefiLlamaDashboard,
  refreshDefiLlamaDashboard,
} from '../../src/defillama.ts';
import {
  DEFILLAMA_FRESH_AFTER_MS,
  STALE_AFTER_MS,
} from '../../src/constants.ts';

void test('cache envelope narrowing does not claim cached item fields are validated', async () => {
  const dashboard = {
    source: 'defillama',
    fetchedAt: '2026-10-06T00:00:00.000Z',
    dexes: { items: [null, { malformed: true }] },
    protocols: { items: [] },
  };
  assert.equal(isUsableDefiLlamaDashboard(dashboard), true);
  const fetchedAt = Date.parse(dashboard.fetchedAt);
  const cache = {
    /** Read the controlled cache envelope.
     * @returns Fixture metadata whose item fields intentionally remain unvalidated.
     */
    get: () => Promise.resolve(dashboard),
  };
  assert.equal(
    (await loadDefiLlamaDashboard(cache, fetchedAt + DEFILLAMA_FRESH_AFTER_MS))
      .state,
    'fresh',
  );
  assert.equal(
    (
      await loadDefiLlamaDashboard(
        cache,
        fetchedAt + DEFILLAMA_FRESH_AFTER_MS + 1,
      )
    ).state,
    'stale',
  );
  assert.equal(
    (await loadDefiLlamaDashboard(cache, fetchedAt + STALE_AFTER_MS)).state,
    'stale',
  );
  assert.equal(
    (await loadDefiLlamaDashboard(cache, fetchedAt + STALE_AFTER_MS + 1)).state,
    'unavailable',
  );
  assert.equal(
    (await loadDefiLlamaDashboard(cache, fetchedAt - 1)).state,
    'unavailable',
  );
});

void test('malformed cache envelopes return unavailable rather than asserting a dashboard', async () => {
  for (const value of [
    null,
    [],
    {},
    { source: 'defillama', fetchedAt: 'invalid' },
    {
      source: 'defillama',
      fetchedAt: '2026-10-06T00:00:00.000Z',
      dexes: { items: {} },
      protocols: { items: [] },
    },
  ]) {
    assert.equal(isUsableDefiLlamaDashboard(value), false);
    assert.deepEqual(
      await loadDefiLlamaDashboard({
        /** Read one malformed fixture envelope.
         * @returns The controlled invalid cache value.
         */
        get: () => Promise.resolve(value),
      }),
      {
        dashboard: null,
        state: 'unavailable',
      },
    );
  }
});

void test('provider normalization preserves existing numeric coercion and rejects invalid item shapes', async (t) => {
  t.mock.method(globalThis, 'fetch', (url: string | URL | Request) =>
    Promise.resolve(
      Response.json(
        (url instanceof Request ? url.url : url.toString()).includes(
          '/overview/',
        )
          ? {
              protocols: [
                null,
                42,
                [],
                { name: 'Bad' },
                {
                  name: 'DEX',
                  slug: 'dex',
                  total24h: '12.5',
                  total7d: null,
                  change_1d: 'not-a-number',
                },
              ],
            }
          : [
              null,
              42,
              [],
              {
                name: 'Protocol',
                slug: 'protocol',
                chains: ['Solana'],
                chainTvls: { Solana: '100.5' },
                change_1d: null,
              },
            ],
      ),
    ),
  );
  const dashboard = await refreshDefiLlamaDashboard(
    null,
    new Date('2026-10-06T00:00:00.000Z'),
  );
  assert.equal(dashboard.dexes.items.length, 1);
  assert.equal(dashboard.dexes.total24hUsd, 12.5);
  // Preserve the existing Number(null) behavior; don't alter formulas during typing.
  assert.equal(dashboard.dexes.items[0]?.total7dUsd, 0);
  assert.equal(dashboard.dexes.items[0]?.change1dPct, null);
  assert.equal(dashboard.protocols.items[0]?.solanaTvlUsd, 100.5);
});

void test('invalid provider envelopes and HTTP failures never publish a cache record', async (t) => {
  let writes = 0;
  const cache = {
    /** Observe or simulate the cache write requested by this test.
     * @returns Completion after incrementing the attempted-write counter.
     */
    put: () => {
      writes += 1;
      return Promise.resolve();
    },
  };
  const fetchMock = t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(Response.json({ invalid: true })),
  );
  await assert.rejects(refreshDefiLlamaDashboard(cache), /payload is invalid/);
  fetchMock.mock.mockImplementation(() =>
    Promise.resolve(new Response('Unavailable', { status: 503 })),
  );
  await assert.rejects(
    refreshDefiLlamaDashboard(cache),
    /request failed with 503/,
  );
  assert.equal(writes, 0);
});
