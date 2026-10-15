import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWalletData, refreshSnapshot } from '../src/snapshot.ts';
import { SOL_MINT } from '../src/constants.ts';
import { FIXTURE_SNAPSHOT } from '../src/fixtures.ts';
import { fetchStub, testEnv } from './support.ts';
import type { SnapshotStore } from '../src/env.ts';

const wallet = {
  address: '11111111111111111111111111111111',
  label: 'Demo',
  description: 'Test wallet',
};
const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('arbitrary public wallet lookup uses Helius without numeric raw balances', async () => {
  const originalFetch = fetchStub.fetch;
  const requests: string[] = [];
  fetchStub.fetch = async (url, options) => {
    const value = String(url);
    requests.push(value);
    if (value.includes('helius-rpc')) {
      const method = JSON.parse(options.body).method;
      if (method === 'getBalance')
        return {
          ok: true,
          json: async () => ({
            result: { value: 9007199254740993000n.toString() },
          }),
        };
      if (options.body.includes('TokenzQdYQneH1k9i7gNJYkC7V3Tv1ALb6TrC3CFQeX'))
        return { ok: true, json: async () => ({ result: { value: [] } }) };
      return {
        ok: true,
        json: async () => ({
          result: {
            value: [
              {
                account: {
                  data: {
                    parsed: {
                      info: {
                        mint: usdc,
                        tokenAmount: { amount: '2500000', decimals: 6 },
                      },
                    },
                  },
                },
              },
            ],
          },
        }),
      };
    }
    if (value.includes('/addresses/'))
      return {
        ok: true,
        json: async () => [
          {
            signature: 'signature',
            timestamp: 1760000000,
            slot: 123,
            type: 'SWAP',
            source: 'RAYDIUM',
            accountData: [
              { account: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2' },
            ],
            tokenTransfers: [
              {
                mint: usdc,
                rawTokenAmount: { tokenAmount: '2500000', decimals: 6 },
              },
            ],
          },
        ],
      };
    if (value.includes('/tokens/'))
      return {
        ok: true,
        json: async () => [
          {
            address: value.includes(encodeURIComponent(usdc)) ? usdc : SOL_MINT,
            symbol: value.includes(encodeURIComponent(usdc)) ? 'USDC' : 'SOL',
            name: 'Token',
            decimals: 6,
          },
        ],
      };
    return {
      ok: true,
      json: async () => ({
        [SOL_MINT]: { usdPrice: 150 },
        [usdc]: { usdPrice: 1 },
      }),
    };
  };
  try {
    const data = await loadWalletData(
      testEnv(),
      { heliusApiKey: 'helius-key', jupiterApiKey: 'jupiter-key' },
      wallet.address,
    );
    assert.equal(data.address, wallet.address);
    assert.equal(data.assets[0].rawBalance, '9007199254740993000');
    assert.equal(typeof data.assets[0].rawBalance, 'string');
    assert.equal(data.assets[1].balance, '2.5');
    assert.equal(data.transactions[0].chain, 'solana');
    assert.equal(
      requests.some((url) => url.includes('hiro')),
      false,
    );
  } finally {
    fetchStub.fetch = originalFetch;
  }
});

test('refresh does not publish a new fixture when Helius is not configured', async () => {
  const writes = new Map<string, string>();
  const snapshot = await refreshSnapshot(
    {
      SNAPSHOTS: {
        get: async () => null,
        put: async (key, value) => writes.set(key, value),
      },
    },
    {},
    new Date('2026-10-02T12:00:00.000Z'),
  );
  assert.equal(snapshot.source, 'fixture');
  assert.equal(snapshot.assets[0].mint, SOL_MINT);
  assert.equal(writes.size, 0);
});

test('refresh preserves reviewed swaps when a tracked Helius pool refresh fails', async () => {
  const previous = {
    ...FIXTURE_SNAPSHOT,
    createdAt: '2026-10-02T12:00:00.000Z',
    source: 'helius-jupiter',
    market: { ...FIXTURE_SNAPSHOT.market, asOf: '2026-10-02T12:00:00.000Z' },
    swaps: [{ id: 'previous-swap' }],
  };
  const writes = new Map<
    string,
    { value: string; options?: { expirationTtl?: number } }
  >();
  const snapshots: SnapshotStore = {
    get: async (key) =>
      key === 'snapshot:current' ? { key: 'snapshot:previous' } : previous,
    put: async (key, value, options) => writes.set(key, { value, options }),
  };
  const originalFetch = fetchStub.fetch;
  fetchStub.fetch = async (url) => {
    const value = String(url);
    if (value.includes('/addresses/')) throw new Error('Helius unavailable');
    if (value.includes('helius-rpc'))
      return { ok: true, json: async () => ({ result: 123 }) };
    if (value.includes('/toptraded/'))
      return {
        ok: true,
        json: async () => [
          {
            id: SOL_MINT,
            symbol: 'SOL',
            name: 'Solana',
            decimals: 9,
            isVerified: true,
          },
        ],
      };
    if (value.includes('/search?')) return { ok: true, json: async () => [] };
    return { ok: true, json: async () => [] };
  };
  try {
    const refreshed = await refreshSnapshot(
      {
        SNAPSHOTS: snapshots,
        HELIUS_API_KEY: 'helius',
        JUPITER_API_KEY: 'jupiter',
      },
      { heliusApiKey: 'helius', jupiterApiKey: 'jupiter' },
      new Date('2026-10-02T12:01:00.000Z'),
    );
    assert.deepEqual(refreshed.swaps, previous.swaps);
    assert.equal(writes.size, 2);
    const snapshotEntry = [...writes.entries()].find(([key]) =>
      key.startsWith('snapshot:v2:'),
    );
    assert.ok(snapshotEntry);
    const snapshotWrite = snapshotEntry[1];
    assert.deepEqual(snapshotWrite.options, { expirationTtl: 86_400 });
  } finally {
    fetchStub.fetch = originalFetch;
  }
});
