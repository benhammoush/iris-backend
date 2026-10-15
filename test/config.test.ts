import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.ts';

test('configuration preserves explicit origins, provider keys and cache-only mode', () => {
  assert.deepEqual(
    getConfig({
      CORS_ORIGINS: ' https://iris.test, ,http://localhost:5173 ',
      HELIUS_API_KEY: 'test-helius',
      JUPITER_API_KEY: 'test-jupiter',
      BIRDEYE_API_KEY: 'test-birdeye',
      PROVIDER_MODE: 'cache-only',
    }),
    {
      corsOrigins: ['https://iris.test', 'http://localhost:5173'],
      heliusApiKey: 'test-helius',
      jupiterApiKey: 'test-jupiter',
      birdeyeApiKey: 'test-birdeye',
      providerMode: 'cache-only',
    },
  );
});

test('missing provider configuration stays empty and default mode stays live', () => {
  assert.deepEqual(getConfig({}), {
    corsOrigins: [],
    heliusApiKey: '',
    jupiterApiKey: '',
    birdeyeApiKey: '',
    providerMode: 'live',
  });
});
