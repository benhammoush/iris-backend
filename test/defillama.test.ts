import test from 'node:test';
import assert from 'node:assert/strict';
import { record } from '../src/record.ts';
import {
  loadDefiLlamaDashboard,
  refreshDefiLlamaDashboard,
} from '../src/defillama.ts';

test('refresh normalizes, filters, sorts, and caches Solana DefiLlama data', async () => {
  const originalFetch = globalThis.fetch;
  const writes = new Map<
    string,
    { value: string; options: { expirationTtl: number } }
  >();
  globalThis.fetch = async (url) => {
    if (String(url).includes('/overview/dexs/Solana'))
      return Response.json({
        protocols: [
          {
            name: 'Smaller',
            slug: 'smaller',
            logo: 'https://icons.example/smaller',
            total24h: 10,
            total7d: 50,
            change_1d: -2,
          },
          {
            name: 'Larger',
            slug: 'larger',
            logo: 'https://icons.example/larger',
            total24h: 20,
            total7d: 70,
            change_1d: 3,
          },
          { name: 'Invalid' },
        ],
      });
    return Response.json([
      {
        name: 'No Solana',
        slug: 'no-solana',
        chains: ['Ethereum'],
        chainTvls: { Ethereum: 100 },
      },
      { name: 'No chains', slug: 'no-chains', chainTvls: { Solana: 300 } },
      {
        name: 'Small protocol',
        slug: 'small-protocol',
        logo: 'https://icons.example/small',
        chains: ['Solana'],
        category: 'DEX',
        chainTvls: { Solana: 100 },
        change_1d: -1,
        change_7d: 4,
      },
      {
        name: 'Large protocol',
        slug: 'large-protocol',
        logo: 'https://icons.example/large',
        chains: ['Ethereum', 'Solana'],
        category: 'Lending',
        chainTvls: { Solana: 200 },
        change_1d: 2,
        change_7d: 5,
      },
      {
        name: 'Protocol three',
        slug: 'protocol-three',
        chains: ['Solana'],
        chainTvls: { Solana: 90 },
      },
      {
        name: 'Protocol four',
        slug: 'protocol-four',
        chains: ['Solana'],
        chainTvls: { Solana: 80 },
      },
      {
        name: 'Protocol five',
        slug: 'protocol-five',
        chains: ['Solana'],
        chainTvls: { Solana: 70 },
      },
      {
        name: 'Protocol six',
        slug: 'protocol-six',
        chains: ['Solana'],
        chainTvls: { Solana: 60 },
      },
    ]);
  };
  try {
    const dashboard = await refreshDefiLlamaDashboard(
      {
        put: async (key, value, options) => writes.set(key, { value, options }),
      },
      new Date('2026-10-06T00:00:00.000Z'),
    );
    assert.equal(dashboard.dexes.total24hUsd, 30);
    assert.equal(dashboard.dexes.items[0].name, 'Larger');
    assert.equal(dashboard.dexes.items[0].logo, 'https://icons.example/larger');
    assert.equal(dashboard.protocols.total, 6);
    assert.equal(dashboard.protocols.items.length, 6);
    assert.equal(dashboard.protocols.items[0].solanaTvlUsd, 200);
    assert.equal(
      dashboard.protocols.items[0].logo,
      'https://icons.example/large',
    );
    const write = writes.get('defillama:v3:dashboard');
    assert.ok(write);
    const stored: unknown = JSON.parse(write.value);
    assert.equal(record(stored).source, 'defillama');
    assert.deepEqual(write.options, {
      expirationTtl: 86_400,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('load marks stale caches and rejects expired data', async () => {
  const cached = {
    source: 'defillama',
    fetchedAt: '2026-10-06T00:00:00.000Z',
    dexes: { total24hUsd: 1, total7dUsd: 1, items: [] },
    protocols: { total: 0, items: [] },
  };
  const kv = { get: async () => cached };
  assert.equal(
    (await loadDefiLlamaDashboard(kv, Date.parse('2026-10-06T00:16:00.000Z')))
      .state,
    'fresh',
  );
  assert.equal(
    (await loadDefiLlamaDashboard(kv, Date.parse('2026-10-06T01:00:00.001Z')))
      .state,
    'stale',
  );
  assert.equal(
    (await loadDefiLlamaDashboard(kv, Date.parse('2026-10-07T01:00:00.000Z')))
      .state,
    'unavailable',
  );
});
