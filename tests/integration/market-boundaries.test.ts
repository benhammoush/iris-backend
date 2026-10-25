/**
 * Regression coverage and controlled fixtures for market boundaries.
 * @packageDocumentation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCandles, mapV3Asset, refreshMarket } from '../../src/market.ts';
import { SOL_MINT } from '../../src/constants.ts';

void test('canonical market normalization preserves nulls and finite-only volume arithmetic', () => {
  const asset = mapV3Asset({
    id: SOL_MINT,
    usdPrice: null,
    mcap: 'invalid',
    stats24h: { buyVolume: 10, sellVolume: 20 },
    tags: ['verified', null, 42],
  });
  assert.equal(asset.priceUsd, null);
  assert.equal(asset.marketCapUsd, null);
  assert.equal(asset.activity.volume24hUsd, 30);
  assert.deepEqual(asset.verification.tags, ['verified']);
  assert.equal(
    mapV3Asset({ stats24h: { buyVolume: 10, sellVolume: Infinity } }).activity
      .volume24hUsd,
    null,
  );
  for (const value of [null, 42, [], 'invalid'])
    assert.equal(mapV3Asset(value).mint, null);
});

void test('market discovery ignores malformed provider items without pricing fallback assets', async (t) => {
  t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(
      Response.json([
        null,
        [],
        42,
        {
          id: SOL_MINT,
          symbol: 'SOL',
          isVerified: true,
          decimals: 9,
          usdPrice: null,
        },
      ]),
    ),
  );
  const market = await refreshMarket('test-key');
  assert.equal(market?.assets.length, 1);
  assert.equal(market?.assets[0]?.price, null);
  assert.equal(market?.assets[0]?.v3.priceUsd, null);
});

void test('candles narrow provider JSON, reject invalid OHLC, and retain timestamp order', async (t) => {
  t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(
      Response.json({
        success: true,
        data: {
          items: [
            null,
            { unix_time: 10, o: 2, h: 1, l: 1, c: 2, v: 1, v_usd: 1 },
            { unix_time: 20, o: 1, h: 2, l: 0.5, c: 1.5, v: 5, v_usd: 7.5 },
            { unix_time: 15, o: 1, h: 2, l: 0.5, c: 1.5, v: 5, v_usd: 7.5 },
          ],
        },
      }),
    ),
  );
  const result = await fetchCandles(SOL_MINT, 'test-key');
  assert.deepEqual(
    result?.candles.map((candle) => candle.timestamp),
    ['1970-01-01T00:00:15.000Z', '1970-01-01T00:00:20.000Z'],
  );
});
