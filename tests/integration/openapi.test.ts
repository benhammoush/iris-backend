/**
 * Regression coverage and controlled fixtures for openapi.
 * @packageDocumentation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'yaml';
import { API_VERSION } from '../../src/constants.ts';

const document = yaml.parse(
  await readFile(new URL('../../openapi.yaml', import.meta.url), 'utf8'),
) as {
  openapi: string;
  info: { version: string };
  paths: Record<
    string,
    Record<
      string,
      { deprecated?: boolean; security?: Record<string, unknown>[] }
    >
  >;
};
const canonicalPaths = [
  '/v3/status',
  '/v3/network',
  '/v3/assets',
  '/v3/catalogs',
  '/v3/defillama',
  '/v3/swaps',
  '/v3/transactions/recent',
  '/v3/assets/mint/{mint}',
  '/v3/assets/mint/{mint}/history',
  '/v3/assets/mint/{mint}/candles',
  '/v3/assets/mint/{mint}/onchain',
  '/v3/assets/mint/{mint}/holders',
  '/v3/assets/mint/{mint}/distribution',
  '/v3/assets/mint/{mint}/transactions',
  '/v3/wallets/{address}',
  '/v3/wallets/{address}/transactions',
];
const legacyPaths = [
  '/v1/status',
  '/v1/market',
  '/v1/assets',
  '/v1/assets/mint/{mint}',
  '/v1/assets/id/{id}',
  '/v1/assets/{symbol}',
  '/v1/swaps',
  '/v1/wallets',
  '/v1/wallets/{address}',
  '/v2/status',
  '/v2/market',
  '/v2/assets',
  '/v2/assets/mint/{mint}',
  '/v2/assets/id/{id}',
  '/v2/assets/{symbol}',
  '/v2/swaps',
  '/v2/wallets',
  '/v2/wallets/{address}',
];

void test('OpenAPI documents every canonical route and the current Worker version', () => {
  assert.equal(document.openapi, '3.1.0');
  assert.equal(document.info.version, API_VERSION);
  for (const path of canonicalPaths) {
    assert.ok(
      document.paths[path]?.get,
      `${path} must be documented as a GET operation`,
    );
    assert.notEqual(
      document.paths[path].get.deprecated,
      true,
      `${path} must not be deprecated`,
    );
  }
  assert.equal(
    document.paths['/v3/wallets/{address}/events'].get.deprecated,
    true,
  );
  assert.deepEqual(document.paths['/internal/refresh'].post.security, [
    { refreshToken: [] },
  ]);
});

void test('OpenAPI marks every v1 and v2 operation as deprecated', () => {
  for (const path of legacyPaths) {
    assert.equal(
      document.paths[path]?.get?.deprecated,
      true,
      `${path} must be deprecated`,
    );
  }
});
