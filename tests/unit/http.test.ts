/**
 * Regression coverage and controlled fixtures for http.
 * @packageDocumentation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { error, json, requestId } from '../../src/http.ts';

void test('HTTP helpers preserve request IDs, CORS and explicit cache headers', async () => {
  const request = new Request('https://iris.test/health', {
    headers: { 'cf-ray': 'ray-test' },
  });
  assert.equal(requestId(request), 'ray-test');
  const response = json(
    { data: { atomicAmount: '9007199254740993123', priceUsd: null } },
    200,
    'ray-test',
    'https://iris.test',
    { 'cache-control': 'public, max-age=60' },
  );
  assert.equal(response.headers.get('x-request-id'), 'ray-test');
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    'https://iris.test',
  );
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
  const body: unknown = await response.json();
  assert.deepEqual(body, {
    data: { atomicAmount: '9007199254740993123', priceUsd: null },
  });
});

void test('HTTP errors preserve the public envelope without adding an origin', async () => {
  const response = error('NOT_FOUND', 'Unavailable', 404, 'request-test');
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body: unknown = await response.json();
  assert.deepEqual(body, {
    error: {
      code: 'NOT_FOUND',
      message: 'Unavailable',
      requestId: 'request-test',
    },
  });
});
