/**
 * Regression coverage and controlled fixtures for routes.
 * @packageDocumentation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/index.ts';
import { SOL_MINT } from '../../src/constants.ts';
import { fetchStub, testEnv } from '../support/support.ts';

const env = testEnv;

test('health preserves its request ID envelope without a snapshot', async () => {
  const response = await worker.fetch(
    new Request('https://api.example/health'),
    env(),
    {},
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.status, 'ok');
  assert.ok(body.meta.requestId);
});

test('protected refresh rejects requests without its token', async () => {
  const response = await worker.fetch(
    new Request('https://api.example/internal/refresh', { method: 'POST' }),
    env({ REFRESH_TOKEN: 'expected' }),
    {},
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'REFRESH_UNAUTHORIZED');
});

test('protected refresh publishes the snapshot when the optional dashboard cache is unavailable', async () => {
  const originalWarn = console.warn;
  const originalFetch = fetchStub.fetch;
  console.warn = () => {};
  fetchStub.fetch = async () => {
    throw new Error('provider unavailable');
  };
  try {
    const response = await worker.fetch(
      new Request('https://api.example/internal/refresh', {
        method: 'POST',
        headers: { authorization: 'Bearer expected' },
      }),
      env({ REFRESH_TOKEN: 'expected' }),
      {},
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.status, 'refreshed');
  } finally {
    console.warn = originalWarn;
    fetchStub.fetch = originalFetch;
  }
});

test('deprecated v1 and v2 asset routes remain compatibility aliases', async () => {
  const originalFetch = fetchStub.fetch;
  const timestamp = Math.floor(Date.now() / 1000);
  fetchStub.fetch = async () => ({
    ok: true,
    /** Return the controlled JSON payload for this provider-response fixture. */
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
    const v2 = await worker.fetch(
      new Request('https://api.example/v2/assets/mint/' + SOL_MINT),
      env({ BIRDEYE_API_KEY: 'birdeye-key' }),
      {},
    );
    const v1 = await worker.fetch(
      new Request('https://api.example/v1/assets/id/' + SOL_MINT),
      env({ BIRDEYE_API_KEY: 'birdeye-key' }),
      {},
    );
    const asset = (await v2.json()).data;
    assert.equal(v2.status, 200);
    assert.equal(v1.status, 200);
    assert.equal(asset.chain, 'solana');
    assert.equal(asset.mint, SOL_MINT);
    assert.equal(asset.contractId, SOL_MINT);
    assert.equal(asset.priceHistory[0].price, 150);
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('fixture responses are publicly cached with CORS-safe variation and snapshot envelopes', async () => {
  const response = await worker.fetch(
    new Request('https://api.example/v2/assets', {
      headers: { origin: 'https://app.example' },
    }),
    env(),
    {},
  );
  const body = await response.json();
  assert.equal(body.meta.snapshotState, 'fixture');
  assert.equal(body.data.length, 3);
  assert.equal(
    response.headers.get('cache-control'),
    'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
  );
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    'https://app.example',
  );
  assert.equal(response.headers.get('vary'), 'Origin');
});

test('v3 catalogs returns the snapshot-backed Jupiter list shape', async () => {
  const response = await worker.fetch(
    new Request('https://api.example/v3/catalogs'),
    env(),
    {},
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.topTraded.length, 3);
  assert.deepEqual(body.data.trending, []);
  assert.deepEqual(body.data.recent, []);
});

test('v3 asset on-chain and holder routes expose Helius data separately from market data', async () => {
  const originalFetch = fetchStub.fetch;
  fetchStub.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'getAsset')
      return {
        ok: true,
        /** Return the controlled JSON payload for this provider-response fixture. */
        json: async () => ({
          result: {
            interface: 'FungibleToken',
            content: { metadata: { name: 'Solana' } },
            token_info: { decimals: 9, supply: '1', token_program: 'Tokenkeg' },
          },
        }),
      };
    if (request.method === 'getTokenSupply')
      return {
        ok: true,
        /** Return the controlled JSON payload for this provider-response fixture. */
        json: async () => ({ result: { value: { amount: '1' } } }),
      };
    if (request.method === 'getAccountInfo')
      return {
        ok: true,
        /** Return the controlled JSON payload for this provider-response fixture. */
        json: async () => ({
          result: { value: { data: { parsed: { info: { decimals: 9 } } } } },
        }),
      };
    if (request.method === 'getTokenAccounts')
      return {
        ok: true,
        /** Return the controlled JSON payload for this provider-response fixture. */
        json: async () => ({ result: { total: 1, items: [] } }),
      };
    throw new Error(`Unexpected ${request.method}`);
  };
  try {
    const onchain = await worker.fetch(
      new Request(`https://api.example/v3/assets/mint/${SOL_MINT}/onchain`),
      env({ HELIUS_API_KEY: 'h' }),
      {},
    );
    const holders = await worker.fetch(
      new Request(
        `https://api.example/v3/assets/mint/${SOL_MINT}/holders?page=1`,
      ),
      env({ HELIUS_API_KEY: 'h' }),
      {},
    );
    assert.equal(onchain.status, 200);
    assert.equal((await onchain.json()).meta.onchain.source, 'helius');
    assert.equal(holders.status, 200);
    assert.equal((await holders.json()).meta.holders.derived, false);
    const invalid = await worker.fetch(
      new Request(
        `https://api.example/v3/assets/mint/${SOL_MINT}/holders?page=0`,
      ),
      env({ HELIUS_API_KEY: 'h' }),
      {},
    );
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'INVALID_HOLDER_PAGE');
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('v3 DefiLlama returns its independently cached dashboard data', async () => {
  const dashboard = {
    source: 'defillama',
    fetchedAt: new Date().toISOString(),
    dexes: {
      total24hUsd: 10,
      total7dUsd: 20,
      items: [
        {
          name: 'Raydium',
          slug: 'raydium',
          total24hUsd: 10,
          total7dUsd: 20,
          change1dPct: 1,
        },
      ],
    },
    protocols: {
      total: 1,
      items: [
        {
          name: 'Jupiter',
          slug: 'jupiter',
          category: 'DEX',
          solanaTvlUsd: 30,
          change1dPct: 2,
          change7dPct: 3,
        },
      ],
    },
  };
  const response = await worker.fetch(
    new Request('https://api.example/v3/defillama'),
    env({
      SNAPSHOTS: {
        /** Read the controlled cache or boundary value used by this assertion. */
        get: async (key) =>
          key === 'defillama:v3:dashboard' ? dashboard : null,
      },
    }),
    {},
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.dexes.items[0].slug, 'raydium');
  assert.equal(body.meta.defillama.freshness, 'fresh');
  assert.equal(
    response.headers.get('cache-control'),
    'public, max-age=300, s-maxage=300, stale-while-revalidate=900',
  );
});

test('v3 network returns an explicit unavailable fixture without fabricating metrics', async () => {
  const response = await worker.fetch(
    new Request('https://api.example/v3/network'),
    env(),
    {},
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.chain.state, 'unavailable');
  assert.equal(body.data.chain.finalizedSlot, undefined);
});

test('v3 recent transactions returns a bounded cached feed without calling Helius', async () => {
  const originalFetch = fetchStub.fetch;
  let calls = 0;
  fetchStub.fetch = async () => {
    calls += 1;
    throw new Error('The public route must not call Helius.');
  };
  try {
    const sample = {
      source: 'helius-rpc',
      asOf: new Date().toISOString(),
      slot: 123,
      network: {
        source: 'helius-rpc',
        fetchedAt: new Date().toISOString(),
        chain: {
          state: 'fresh',
          processedSlot: 121,
          confirmedSlot: 123,
          blockHeight: 100,
          epoch: 1,
        },
        performance: { state: 'fresh', tps: 100, nonVoteTps: 80 },
        fees: { state: 'fresh', averageFeeLamports: 5000 },
      },
      transactions: Array.from({ length: 20 }, (_, index) => ({
        signature: `sig-${index}`,
        slot: 123,
        blockTime: '2026-10-06T00:00:00.000Z',
        status: 'confirmed',
        action: index === 0 ? 'swap' : null,
      })),
    };
    const response = await worker.fetch(
      new Request('https://api.example/v3/transactions/recent?limit=15'),
      env({
        HELIUS_API_KEY: 'h',
        SNAPSHOTS: {
          /** Read the controlled cache or boundary value used by this assertion. */
          get: async (key) => (key === 'helius:v3:dashboard' ? sample : null),
          /** Observe or simulate the cache write requested by this test. */
          put: async () => {},
        },
      }),
      {},
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.transactions.length, 15);
    assert.equal(body.data.transactions[0].action, 'swap');
    assert.equal(body.data.network.chain.confirmedSlot, 123);
    assert.equal(body.meta.recentTransactions.sampled, true);
    assert.equal(calls, 0);
    assert.equal(
      response.headers.get('cache-control'),
      'public, max-age=60, s-maxage=60, stale-while-revalidate=60',
    );
    const invalid = await worker.fetch(
      new Request('https://api.example/v3/transactions/recent?limit=21'),
      env(),
      {},
    );
    assert.equal(invalid.status, 400);
    assert.equal(
      (await invalid.json()).error.code,
      'INVALID_RECENT_TRANSACTION_LIMIT',
    );
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('invalid mint and wallet paths return the existing not-found envelopes', async () => {
  const asset = await worker.fetch(
    new Request('https://api.example/v2/assets/mint/not-a-mint'),
    env(),
    {},
  );
  const wallet = await worker.fetch(
    new Request('https://api.example/v2/wallets/not-a-wallet'),
    env(),
    {},
  );
  assert.equal((await asset.json()).error.code, 'ASSET_NOT_FOUND');
  assert.equal((await wallet.json()).error.code, 'INVALID_WALLET_ADDRESS');
});

test('valid public wallets are not restricted to a configured list', async () => {
  const response = await worker.fetch(
    new Request(`https://api.example/v2/wallets/${SOL_MINT}`),
    env(),
    {},
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'WALLET_LOOKUP_UNAVAILABLE');
});
